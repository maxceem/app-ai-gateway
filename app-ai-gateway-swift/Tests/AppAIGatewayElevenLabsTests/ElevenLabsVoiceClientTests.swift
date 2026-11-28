import AppAIGateway
import Foundation
import Testing
@testable import AppAIGatewayElevenLabs

/// A pretend session: the test hands it the relay's events and reads what the client sent.
final class FakeSession: AgentSession, @unchecked Sendable {
    let sessionID: String
    let events: AsyncStream<LiveSession.Event>
    private let input: AsyncStream<LiveSession.Event>.Continuation
    private let lock = NSLock()
    private var _sent: [String] = []
    private var _started = false
    private var _closed = false

    init(id: String) {
        sessionID = id
        (events, input) = AsyncStream.makeStream(of: LiveSession.Event.self)
    }

    var sent: [String] { lock.withLock { _sent } }
    var started: Bool { lock.withLock { _started } }
    var closed: Bool { lock.withLock { _closed } }
    /// What the client sent, without its microphone chunks.
    var messages: [String] { sent.filter { !$0.hasPrefix(#"{"user_audio_chunk""#) } }
    var micChunks: Int { sent.count - messages.count }

    func start() async { lock.withLock { _started = true } }
    func send(text: String) async { lock.withLock { _sent.append(text) } }
    func close() async { lock.withLock { _closed = true } }

    func deliver(_ event: LiveSession.Event) { input.yield(event) }
    func deliver(_ text: String) { input.yield(.text(text)) }
    /// ElevenLabs' first message, with its audio formats.
    func connect(conversation: String = "conv_1", output: String = "pcm_16000") {
        deliver(.started)
        deliver(#"{"conversation_initiation_metadata_event":{"conversation_id":"\#(conversation)","agent_output_audio_format":"\#(output)","user_input_audio_format":"pcm_16000"},"type":"conversation_initiation_metadata"}"#)
    }
    /// One chunk of agent audio: `samples` 16-bit samples, each with the value `mark`.
    func audio(id: Int, mark: Int16 = 1, samples: Int = 1600) {
        var data = Data()
        for _ in 0..<samples { withUnsafeBytes(of: mark.littleEndian) { data.append(contentsOf: $0) } }
        deliver(#"{"audio_event":{"audio_base_64":"\#(data.base64EncodedString())","event_id":\#(id)},"type":"audio"}"#)
    }
    func end(code: Int, reason: String) {
        input.yield(.ended(code: code, reason: reason))
        input.finish()
    }
}

/// Pretend audio: records what was played and cleared, and plays nothing on its own.
@MainActor
final class FakeAudio: AgentAudio {
    let mic: AsyncStream<Data>
    let micIn: AsyncStream<Data>.Continuation
    var onDrained: (() -> Void)?
    var onLostAudio: (() -> Void)?
    var running = false
    var starts = 0
    var rates: (input: Double, output: Double) = (16000, 16000)
    /// The first sample of each chunk played, in order.
    var played: [Int16] = []
    var queuedSeconds: TimeInterval = 0
    var flushes = 0

    init() {
        (mic, micIn) = AsyncStream.makeStream(of: Data.self)
    }

    func start() throws {
        starts += 1
        running = true
    }
    func use(inputRate: Double, outputRate: Double) { rates = (inputRate, outputRate) }
    func play(pcm16: Data) {
        played.append(pcm16.withUnsafeBytes { Int16(littleEndian: $0.load(as: Int16.self)) })
        queuedSeconds += Double(pcm16.count / 2) / rates.output
    }
    @discardableResult func flush() -> TimeInterval {
        flushes += 1
        defer { queuedSeconds = 0 }
        return queuedSeconds
    }
    func stop() {
        running = false
        queuedSeconds = 0
    }
    /// The queue played to its end.
    func drain() {
        queuedSeconds = 0
        onDrained?()
    }
}

/// Every session the client opened, and the `takes_over` each was asked with.
@MainActor
final class Opened {
    var sessions: [FakeSession] = []
    var takesOver: [String?] = []
    var refuse: Error?
    func open(_ takesOver: String?) throws -> any AgentSession {
        if let refuse { throw refuse }
        let session = FakeSession(id: "s\(sessions.count + 1)")
        sessions.append(session)
        self.takesOver.append(takesOver)
        return session
    }
}

/// Waits until `condition` holds, for at most two seconds.
@MainActor
private func eventually(_ condition: () -> Bool) async -> Bool {
    for _ in 0..<200 {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
    return false
}

private func object(_ text: String) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] ?? [:]
}

@MainActor
@Suite
struct ElevenLabsVoiceClientTests {
    let audio = FakeAudio()
    let opened = Opened()
    let client: ElevenLabsVoiceClient

    init() {
        let opened = opened
        client = ElevenLabsVoiceClient(audio: audio) { try opened.open($0) }
    }

    /// Starts a conversation and waits until ElevenLabs' metadata was read.
    private func connected(_ start: () async throws -> Void = {}) async throws -> FakeSession {
        let index = opened.sessions.count
        try await start()
        let session = opened.sessions[index]
        session.connect(conversation: "conv_\(index + 1)")
        #expect(await eventually { !session.messages.isEmpty })
        // The metadata turns the microphone on: one chunk shows it was read.
        audio.micIn.yield(Data(count: 3200))
        #expect(await eventually { session.micChunks > 0 })
        return session
    }

    private func started() async throws -> FakeSession {
        try await connected { try await client.start() }
    }

    @Test
    func firstMessageCarriesOnlyWhatTheRelayAllows() async throws {
        #expect(ElevenLabsVoiceClient.firstMessage(greeting: nil, dynamicVariables: [:]) == #"{"type":"conversation_initiation_client_data"}"#)
        let message = object(ElevenLabsVoiceClient.firstMessage(greeting: "I am back.", dynamicVariables: ["name": "Ann", "visits": 3, "pro": true]))
        #expect(Set(message.keys) == ["type", "conversation_config_override", "dynamic_variables"])
        #expect(message["conversation_config_override"] as? [String: [String: String]] == ["agent": ["first_message": "I am back."]])
        let variables = try #require(message["dynamic_variables"] as? [String: Any])
        #expect(variables["name"] as? String == "Ann")
        #expect(variables["visits"] as? Int == 3)
        #expect(variables["pro"] as? Bool == true)

        let session = try await started()
        #expect(session.started)
        #expect(session.messages.first == #"{"type":"conversation_initiation_client_data"}"#)
        #expect(opened.takesOver == [nil])
    }

    @Test
    func interruptionDropsOnlyAudioWithALowerEventID() async throws {
        let session = try await started()
        session.audio(id: 1, mark: 1)
        session.audio(id: 2, mark: 2)
        #expect(await eventually { audio.played == [1, 2] })
        session.deliver(#"{"interruption_event":{"event_id":3},"type":"interruption"}"#)
        // Late audio of the cut answer, then the reply to the interrupting turn, which has the interruption's id.
        session.audio(id: 2, mark: 20)
        session.audio(id: 3, mark: 3)
        session.audio(id: 4, mark: 4)
        #expect(await eventually { audio.played == [1, 2, 3, 4] })
        #expect(audio.flushes == 2) // one at start, one at the interruption
    }

    @Test
    func pingIsAnsweredWithItsEventID() async throws {
        let session = try await started()
        session.deliver(#"{"ping_event":{"event_id":7,"ping_ms":250},"type":"ping"}"#)
        #expect(await eventually { session.messages.contains(#"{"type":"pong","event_id":7}"#) })
    }

    @Test
    func stopButtonClearsTheAnswerAndTellsTheAgent() async throws {
        let session = try await started()
        session.audio(id: 5, mark: 5)
        #expect(await eventually { audio.played == [5] })
        client.stopSpeaking()
        #expect(audio.queuedSeconds == 0)
        // The rest of the stopped answer is dropped; the next answer plays.
        session.audio(id: 5, mark: 50)
        session.audio(id: 6, mark: 6)
        #expect(await eventually { audio.played == [5, 6] })
        let told = session.messages.filter { $0.contains("contextual_update") }
        #expect(told.count == 1)
        #expect(object(told[0])["text"] as? String == "The user did not hear the rest of your last answer.")
        // Nothing queued: nothing to tell.
        audio.queuedSeconds = 0
        client.stopSpeaking()
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(session.messages.filter { $0.contains("contextual_update") }.count == 1)
        #expect(!session.closed)
    }

    @Test
    func audioLostInARebuildCutsTheAnswerLikeTheStopButton() async throws {
        let session = try await started()
        session.audio(id: 2, mark: 2)
        #expect(await eventually { audio.played == [2] })
        audio.onLostAudio?()
        session.audio(id: 2, mark: 20)
        session.audio(id: 3, mark: 3)
        #expect(await eventually { audio.played == [2, 3] })
        #expect(session.messages.contains { $0.contains("did not hear the rest") })
    }

    @Test
    func audioLeftAfterADropPlaysOutAndTheMicrophoneStops() async throws {
        let session = try await started()
        var events = client.events.makeAsyncIterator()
        session.audio(id: 1)
        #expect(await eventually { audio.played.count == 1 })
        session.deliver(.reconnecting)
        // While the client tries to come back, queued audio plays on, and the microphone waits.
        let chunks = session.micChunks
        audio.micIn.yield(Data(count: 3200))
        session.end(code: 4000, reason: "session_ended")
        var ending: ElevenLabsVoiceClient.Ending?
        while let event = await events.next() {
            if case .ended(let value) = event { ending = value; break }
        }
        #expect(ending == .init(code: 4000, reason: "session_ended"))
        #expect(ending?.connectionLost == true)
        #expect(!client.isActive)
        #expect(session.micChunks == chunks)
        #expect(audio.queuedSeconds > 0)
        #expect(audio.running)
        // It has played: now the audio stops.
        audio.drain()
        #expect(!audio.running)
    }

    @Test
    func aNewConversationClearsOldAudioAndTakesTheOldSessionsPlace() async throws {
        let first = try await started()
        first.deliver(#"{"user_transcription_event":{"user_transcript":"Tell me a story."},"type":"user_transcript"}"#)
        first.deliver(#"{"agent_response_event":{"agent_response":"Once upon a time."},"type":"agent_response"}"#)
        first.deliver(#"{"interruption_event":{"event_id":9},"type":"interruption"}"#)
        first.audio(id: 9, mark: 9)
        #expect(await eventually { audio.played == [9] && client.transcript.count == 2 })
        first.end(code: 0, reason: "reconnect_failed")
        #expect(await eventually { !client.isActive })
        let flushes = audio.flushes

        let context = ElevenLabsVoiceClient.contextualUpdate(for: client.transcript)
        let second = try await connected {
            try await client.start(firstMessage: "Sorry, the line dropped.", context: context)
        }
        #expect(audio.flushes == flushes + 1)
        #expect(opened.takesOver == [nil, "s1"])
        let greeting = object(second.messages[0])
        #expect(greeting["conversation_config_override"] as? [String: [String: String]] == ["agent": ["first_message": "Sorry, the line dropped."]])
        // The earlier turns go once the new conversation started.
        #expect(object(second.messages[1]) as? [String: String] == ["type": "contextual_update", "text": context])
        // Event ids start again in a new conversation: the old interruption drops nothing.
        second.audio(id: 1, mark: 1)
        #expect(await eventually { audio.played == [9, 1] })
        // Frames from the old session are ignored.
        first.audio(id: 10, mark: 10)
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(audio.played == [9, 1])
    }

    @Test
    func contextualUpdateHelperKeepsTheNewestTurnsOldestFirst() {
        let turns = [
            ElevenLabsVoiceClient.Turn(role: .user, text: "What is the capital of France?"),
            ElevenLabsVoiceClient.Turn(role: .agent, text: "Paris."),
            ElevenLabsVoiceClient.Turn(role: .user, text: String(repeating: "a", count: 1000)),
        ]
        let text = ElevenLabsVoiceClient.contextualUpdate(for: turns)
        #expect(text.hasSuffix("oldest first:\nUser: What is the capital of France?\nYou: Paris.\nUser: " + String(repeating: "a", count: 300)))
        let short = ElevenLabsVoiceClient.contextualUpdate(for: turns, limit: 320)
        #expect(!short.contains("France"))
        #expect(short.contains("User: aaa"))
    }

    @Test
    func correctionReplacesTheAgentsLastTurn() async throws {
        let session = try await started()
        session.deliver(#"{"agent_response_event":{"agent_response":"A long story about a cat."},"type":"agent_response"}"#)
        session.deliver(#"{"agent_response_correction_event":{"original_agent_response":"A long story about a cat.","corrected_agent_response":"A long story"},"type":"agent_response_correction"}"#)
        #expect(await eventually { client.transcript == [.init(role: .agent, text: "A long story")] })
        client.sendContextualUpdate("The user opened the settings screen.")
        #expect(await eventually {
            session.messages.contains { object($0) as? [String: String] == ["type": "contextual_update", "text": "The user opened the settings screen."] }
        })
    }

    @Test
    func reconnectingKeepsTheConversationAndAudio() async throws {
        let session = try await started()
        session.audio(id: 1)
        #expect(await eventually { audio.played.count == 1 })
        let flushes = audio.flushes
        session.deliver(.reconnecting)
        try await Task.sleep(nanoseconds: 20_000_000)
        let chunks = session.micChunks
        audio.micIn.yield(Data(count: 3200))
        try await Task.sleep(nanoseconds: 20_000_000)
        #expect(session.micChunks == chunks)
        session.deliver(.resumed)
        try await Task.sleep(nanoseconds: 20_000_000)
        audio.micIn.yield(Data(count: 3200))
        #expect(await eventually { session.micChunks == chunks + 1 })
        #expect(audio.flushes == flushes)
        #expect(client.isActive)
    }

    @Test
    func aMutedMicrophoneSendsSilence() async throws {
        let session = try await started()
        client.isMicrophoneMuted = true
        audio.micIn.yield(Data(repeating: 7, count: 3200))
        let silence = #"{"user_audio_chunk":""# + Data(count: 3200).base64EncodedString() + #""}"#
        #expect(await eventually { session.sent.last == silence })
    }

    @Test
    func endClosesTheSessionAndStopsTheAudio() async throws {
        let session = try await started()
        var events = client.events.makeAsyncIterator()
        session.audio(id: 1)
        #expect(await eventually { audio.played.count == 1 })
        client.end()
        #expect(await eventually { session.closed })
        #expect(!audio.running)
        #expect(!client.isActive)
        var last: ElevenLabsVoiceClient.Event?
        while let event = await events.next() {
            last = event
            if case .ended = event { break }
        }
        #expect(last == .ended(.init(code: 1000, reason: "client_closed")))
    }

    @Test
    func anAudioFormatItCannotPlayEndsTheConversation() async throws {
        try await client.start()
        let session = opened.sessions[0]
        session.connect(output: "ulaw_8000")
        #expect(await eventually { session.closed && !client.isActive })
        #expect(ElevenLabsVoiceClient.pcmRate("pcm_24000") == 24000)
        #expect(ElevenLabsVoiceClient.pcmRate("ulaw_8000") == nil)
    }

    @Test
    func aRefusedStartThrowsAndStopsTheAudio() async throws {
        opened.refuse = URLError(.notConnectedToInternet)
        await #expect(throws: URLError.self) { try await client.start() }
        #expect(!client.isActive)
        #expect(!audio.running)
    }

    @Test
    func endingTellsALostConnectionFromAnEndOnPurpose() {
        typealias Ending = ElevenLabsVoiceClient.Ending
        #expect(Ending(code: 0, reason: "link_lost").connectionLost)
        #expect(Ending(code: 4000, reason: "heartbeat_timeout").connectionLost)
        #expect(Ending(code: 4000, reason: "ticket_expired").connectionLost)
        #expect(!Ending(code: 1000, reason: "provider_closed").connectionLost)
        #expect(!Ending(code: 1000, reason: "time_cap").connectionLost)
        #expect(!Ending(code: 1000, reason: "budget_stop").connectionLost)
        #expect(!Ending(code: 1008, reason: "override_not_allowed").connectionLost)
    }
}
