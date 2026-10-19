import Foundation
import Observation

/// One realtime voice conversation at a time, written into the history as it goes.
///
/// The conversation is one WebSocket through the gateway, in OpenAI's own
/// realtime events. The microphone streams the whole time; the provider's voice
/// detection hears where each of your turns ends, and the gateway admits the
/// response to it against the app's limits, as one request.
@MainActor @Observable
final class VoiceConversation {
    enum Phase: Equatable {
        case idle, connecting, listening, hearing, thinking, speaking
    }

    private(set) var phase: Phase = .idle
    /// The history item the conversation writes into.
    private(set) var itemID: UUID?
    /// The responses admitted so far: each one counts as one request.
    private(set) var responses = 0
    /// How loud you are in the microphone, and the answer in the speaker; 0...1.
    /// Kept apart, so talking over an answer shows your voice at once.
    private(set) var inputLevel: CGFloat = 0
    private(set) var outputLevel: CGFloat = 0
    var isActive: Bool { phase != .idle }

    private let history: HistoryStore
    private let settings: AppSettings
    private var task: Task<Void, Never>?
    private var audio: VoiceAudio?
    private var meter: Timer?
    /// The answer being spoken, and where your current turn began in the audio.
    private var answerID: UUID?
    private var speechStart: Int?
    private var turnLength: TimeInterval?

    init(history: HistoryStore, settings: AppSettings) {
        self.history = history
        self.settings = settings
    }

    /// Starts a conversation in a new history item and returns the item.
    func start(model: ModelChoice) -> UUID {
        stop()
        let id = history.start(.voice, title: "Voice chat")
        itemID = id
        responses = 0
        phase = .connecting
        task = Task { await run(id, model: model) }
        return id
    }

    func stop() {
        task?.cancel()
        task = nil
        end()
    }

    // MARK: Private

    private func run(_ id: UUID, model: ModelChoice) async {
        var failure: Failure?
        let audio = VoiceAudio()
        self.audio = audio
        do {
            let socket = try await settings.backend().voice(model: model)
            try await withTaskCancellationHandler {
                try await converse(socket, audio: audio, in: id, model: model)
            } onCancel: {
                socket.close()
            }
        } catch is CancellationError {
        } catch let error as URLError where error.code == .cancelled {
        } catch {
            failure = Failure(error)
        }
        guard !Task.isCancelled else { return }
        if let failure {
            history.append(Entry(role: .assistant, model: model, failure: failure), to: id)
        }
        end()
    }

    private func converse(_ socket: any RealtimeSocket, audio: VoiceAudio, in id: UUID, model: ModelChoice) async throws {
        var configured = false
        var sender: Task<Void, Never>?
        defer { sender?.cancel() }

        while let event = try await socket.receive() {
            switch event["type"] as? String {
            case "session.updated" where !configured:
                // The gateway's own configuration has taken; only now may the
                // session be changed. Ask for voice detection and a voice.
                configured = true
                try await socket.send(Self.configuration)

            case "session.updated" where sender == nil:
                // Ours has taken: start streaming the microphone.
                try await audio.start()
                startMeter()
                phase = .listening
                // snippet voice: Stream the microphone, in OpenAI's own realtime events
                sender = Task {
                    for await pcm in audio.chunks {
                        try? await socket.send(["type": "input_audio_buffer.append", "audio": pcm.base64EncodedString()])
                    }
                }
                // snippet end

            case "input_audio_buffer.speech_started":
                // Talking over an answer interrupts it: the gateway cancels the
                // response, and what is left of its audio is dropped here.
                audio.flush()
                speechStart = event["audio_start_ms"] as? Int
                phase = .hearing

            case "input_audio_buffer.speech_stopped":
                if let start = speechStart, let end = event["audio_end_ms"] as? Int {
                    turnLength = TimeInterval(end - start) / 1000
                }
                phase = .thinking

            case "input_audio_buffer.committed":
                history.append(Entry(role: .user, duration: turnLength ?? 0), to: id)
                turnLength = nil

            case "response.created":
                responses += 1
                answerID = history.append(Entry(role: .assistant, model: model, pending: true), to: id)

            // snippet voice: Play the answer as it arrives
            case "response.output_audio.delta":
                // While you talk over an answer, what is still in flight of it
                // belongs to the response the gateway is cancelling.
                if phase != .hearing, let pcm = (event["delta"] as? String).flatMap({ Data(base64Encoded: $0) }) {
                    audio.play(pcm)
                }
            // snippet end

            case "response.output_audio_transcript.delta", "response.output_text.delta":
                if let answerID, let delta = event["delta"] as? String {
                    history.update(answerID, in: id, persist: false) { $0.text += delta }
                }

            case "response.done":
                let response = event["response"] as? [String: Any]
                finishAnswer(response, in: id)
                if Self.endsConversation(response) {
                    // Let the goodbye finish playing, then hang up as the X button would.
                    while audio.isPlaying { try await Task.sleep(for: .milliseconds(100)) }
                    socket.close()
                    return
                }

            case "error":
                // Talking over an answer just as it finishes sends a cancel that
                // crosses its end on the wire; OpenAI answers it with this error,
                // which changes nothing. Any other provider error ends the session.
                let error = event["error"] as? [String: Any]
                if error?["code"] as? String == "response_cancel_not_active" { break }
                throw ProviderError(status: 0, message: error?["message"] as? String ?? "The provider ended the conversation.")

            default:
                break
            }
        }
    }

    private func finishAnswer(_ response: [String: Any]?, in id: UUID) {
        guard let answerID else { return }
        self.answerID = nil
        let status = response?["status"] as? String
        let text = history.item(id)?.entries.first { $0.id == answerID }?.text ?? ""
        if text.isEmpty && status != "failed" {
            history.remove(answerID, in: id)
            return
        }
        history.update(answerID, in: id) { entry in
            entry.pending = false
            if status == "cancelled" { entry.text += "…" }
            if status == "failed" {
                let error = (response?["status_details"] as? [String: Any])?["error"] as? [String: Any]
                entry.failure = Failure(code: "failed", message: error?["message"] as? String ?? "The response failed.")
            }
        }
        if history.item(id)?.title == "Voice chat" {
            history.rename(id, to: text)
        }
    }

    /// Whether the model asked to end the conversation, through the one tool it has.
    private static func endsConversation(_ response: [String: Any]?) -> Bool {
        let output = response?["output"] as? [[String: Any]] ?? []
        return output.contains { $0["type"] as? String == "function_call" && $0["name"] as? String == "end_conversation" }
    }

    /// Server voice detection, with the gateway answering each turn and
    /// stopping an answer you talk over. Input transcription is off: the
    /// gateway does not offer it yet, so your turns show as their length.
    /// The one tool runs here in the app: the model calls it to hang up.
    private static let configuration: [String: Any] = [
        "type": "session.update",
        "session": [
            "type": "realtime",
            "instructions": "You are a friendly voice assistant in a demo of App AI Gateway. Keep answers short and conversational. "
                + "When the user wants to stop talking, say a short goodbye and call end_conversation.",
            "tools": [[
                "type": "function",
                "name": "end_conversation",
                "description": "Ends this voice conversation. Call it when the user says they are done, such as \"that's it\" or \"let's stop\".",
                "parameters": ["type": "object", "properties": [String: Any]()],
            ]],
            "output_modalities": ["audio"],
            "audio": [
                "input": [
                    "format": ["type": "audio/pcm", "rate": 24_000],
                    "noise_reduction": ["type": "near_field"],
                    "turn_detection": ["type": "server_vad", "silence_duration_ms": 600],
                ],
                "output": [
                    "format": ["type": "audio/pcm", "rate": 24_000],
                    "voice": "marin",
                ],
            ],
        ],
    ]

    private func startMeter() {
        meter = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    private func tick() {
        guard let audio else { return }
        let levels = audio.levels
        let playing = audio.isPlaying
        if playing, phase == .listening || phase == .thinking { phase = .speaking }
        if !playing, phase == .speaking, answerID == nil { phase = .listening }
        inputLevel += (CGFloat(levels.input) - inputLevel) * 0.35
        outputLevel += (CGFloat(levels.output) - outputLevel) * 0.35
    }

    private func end() {
        meter?.invalidate()
        meter = nil
        audio?.stop()
        audio = nil
        if let answerID, let itemID {
            history.update(answerID, in: itemID) { $0.pending = false }
        }
        answerID = nil
        speechStart = nil
        turnLength = nil
        inputLevel = 0
        outputLevel = 0
        phase = .idle
    }
}
