import Foundation

/// A realtime conversation on the device: it hears when you speak and stop,
/// and answers each turn in text, as the gateway's OpenAI events would. It
/// makes no sound.
final class SimulatedVoice: RealtimeSocket, @unchecked Sendable {
    private let model: String
    private let lock = NSLock()
    private var outbox: [[String: Any]] = []
    private var waiter: CheckedContinuation<[String: Any]?, Never>?
    private var closed = false
    /// Milliseconds of audio heard, and where the current speech began.
    private var heard = 0
    private var speechStart: Int?
    private var lastLoud = 0
    private var turns = 0

    init(model: String) {
        self.model = model
        emit(["type": "session.updated"])
    }

    func send(_ event: [String: Any]) async throws {
        switch event["type"] as? String {
        case "session.update":
            emit(["type": "session.updated"])
        case "input_audio_buffer.append":
            guard let audio = (event["audio"] as? String).flatMap({ Data(base64Encoded: $0) }) else { return }
            hear(audio)
        default:
            break
        }
    }

    func receive() async throws -> [String: Any]? {
        await withCheckedContinuation { continuation in
            lock.lock()
            if !outbox.isEmpty {
                let event = outbox.removeFirst()
                lock.unlock()
                continuation.resume(returning: event)
            } else if closed {
                lock.unlock()
                continuation.resume(returning: nil)
            } else {
                waiter = continuation
                lock.unlock()
            }
        }
    }

    func close() {
        lock.lock()
        closed = true
        let waiter = waiter
        self.waiter = nil
        lock.unlock()
        waiter?.resume(returning: nil)
    }

    /// Voice activity from loudness alone: speech starts on a loud chunk and
    /// stops after 700 ms of quiet, as the provider's server VAD would.
    private func hear(_ pcm: Data) {
        let samples = pcm.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
        guard !samples.isEmpty else { return }
        let rms = sqrt(samples.reduce(0) { $0 + Double($1) * Double($1) } / Double(samples.count)) / Double(Int16.max)
        lock.lock()
        heard += samples.count * 1000 / 24_000
        let now = heard
        let loud = rms > 0.02
        if loud { lastLoud = now }
        let started = speechStart == nil && loud
        if started { speechStart = now }
        let stopped = speechStart != nil && !loud && now - lastLoud > 700
        let begin = speechStart ?? 0
        let end = lastLoud
        if stopped { speechStart = nil; turns += 1 }
        let turn = turns
        lock.unlock()

        if started { emit(["type": "input_audio_buffer.speech_started", "audio_start_ms": now]) }
        if stopped {
            emit(["type": "input_audio_buffer.speech_stopped", "audio_start_ms": begin, "audio_end_ms": end])
            emit(["type": "input_audio_buffer.committed", "item_id": "item_\(turn)"])
            Task { await answer(turn) }
        }
    }

    private func answer(_ turn: Int) async {
        let id = "resp_\(turn)"
        emit(["type": "response.created", "response": ["id": id]])
        let reply = "This is a simulated answer from \(model). With simulated responses off, your voice "
            + "streams to the gateway over one WebSocket, and every answer counts as one request."
        for word in reply.split(separator: " ") {
            try? await Task.sleep(for: .milliseconds(60))
            emit(["type": "response.output_audio_transcript.delta", "response_id": id, "delta": word + " "])
        }
        emit(["type": "response.done", "response": ["id": id, "status": "completed"]])
    }

    private func emit(_ event: [String: Any]) {
        lock.lock()
        if let waiter {
            self.waiter = nil
            lock.unlock()
            waiter.resume(returning: event)
        } else {
            outbox.append(event)
            lock.unlock()
        }
    }
}

extension SimulatedBackend {
    func voice(model: ModelChoice) async throws -> any RealtimeSocket {
        SimulatedVoice(model: model.model)
    }
}
