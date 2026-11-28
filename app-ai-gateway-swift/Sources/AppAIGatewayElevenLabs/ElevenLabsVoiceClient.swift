import AppAIGateway
import Foundation

/// A voice call with one of your ElevenLabs agents, through the gateway's relay.
///
/// It records the microphone, sends it to the agent, and plays the agent's
/// answers. It speaks ElevenLabs' own WebSocket messages over a
/// ``LiveSession``. ElevenLabs' official Swift SDK speaks WebRTC only, so it
/// can't go through the relay.
///
/// ```swift
/// let voice = ElevenLabsVoiceClient(gateway: gateway, agentID: "agent_7201…")
/// try await voice.start()
/// for await event in voice.events {
///     if case .ended(let ending) = event, ending.connectionLost {
///         // A new conversation: tell the agent what was said before.
///         try await voice.start(
///             firstMessage: "Sorry, the line dropped.",
///             context: ElevenLabsVoiceClient.contextualUpdate(for: voice.transcript)
///         )
///     }
/// }
/// ```
///
/// Use one client for one call the user makes. Its ``transcript`` keeps
/// every turn of the call, also across new conversations after a lost
/// connection.
///
/// How it handles the agent's audio:
/// - ElevenLabs sends a whole answer much faster than it plays, so minutes of
///   audio can be queued. On an `interruption`, the queue is cleared, and late
///   audio of the cut answer is dropped: only audio whose `event_id` is lower
///   than the interruption's. The reply to the interrupting turn has the same
///   `event_id` as the interruption, so it plays.
/// - ``stopSpeaking()`` is the stop button. ElevenLabs often ignores a short
///   spoken "stop" while the agent talks.
/// - Audio already received plays to its end when the conversation ends, so
///   a goodbye is heard in full. Starting a new conversation clears it first,
///   so the new greeting is not heard late.
/// - When iOS changes the audio setup (a new route, another app taking the
///   audio), the audio engine is rebuilt. Queued audio is lost then, and the
///   agent is told the user didn't hear the rest of its answer.
@MainActor
public final class ElevenLabsVoiceClient {
    public enum Event: Sendable, Equatable {
        /// ``start(firstMessage:dynamicVariables:context:)`` asked the gateway for a session.
        case connecting
        /// ElevenLabs started the conversation and sent its metadata.
        /// `conversationID` is ElevenLabs' id for it. A call ElevenLabs holds in
        /// its queue is connected too: a `queue_status` ``message(_:)`` follows.
        case connected(conversationID: String)
        /// The link dropped, and the client is trying to keep the same conversation.
        case reconnecting
        /// The link came back to the same conversation.
        case resumed
        /// What ElevenLabs heard the user say.
        case userTranscript(String)
        /// The agent's answer as text.
        case agentResponse(String)
        /// The part of the last answer the user heard before they interrupted it.
        case agentResponseCorrected(String)
        /// The user talked over the agent: its queued audio was cleared.
        case interrupted
        /// Any other ElevenLabs message, as JSON text, such as `client_tool_call`.
        case message(String)
        /// The conversation is over. The client can start a new one.
        case ended(Ending)
    }

    /// How a conversation ended.
    public struct Ending: Sendable, Equatable {
        /// The relay's close code, 0 when the link was lost, or 1003 when the
        /// agent's audio format can't be played.
        public let code: Int
        public let reason: String

        public init(code: Int, reason: String) {
            self.code = code
            self.reason = reason
        }

        /// Whether the connection was lost, rather than ended on purpose by
        /// the app, the agent or a limit. The conversation can't be taken back:
        /// start a new one if the user goes on.
        public var connectionLost: Bool {
            switch code {
            case 0, 1011: return true
            case 4000: return ["session_ended", "ticket_expired", "heartbeat_timeout", "client_too_slow"].contains(reason)
            default: return false
            }
        }
    }

    /// One turn of the call.
    public struct Turn: Sendable, Equatable {
        public enum Role: Sendable, Equatable {
            case user
            case agent
        }

        public let role: Role
        public var text: String

        public init(role: Role, text: String) {
            self.role = role
            self.text = text
        }
    }

    /// A value for one of the agent's dynamic variables.
    public enum DynamicVariable: Sendable, Equatable, ExpressibleByStringLiteral,
        ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral, ExpressibleByBooleanLiteral {
        case string(String)
        case number(Double)
        case bool(Bool)

        public init(stringLiteral value: String) { self = .string(value) }
        public init(integerLiteral value: Int) { self = .number(Double(value)) }
        public init(floatLiteral value: Double) { self = .number(value) }
        public init(booleanLiteral value: Bool) { self = .bool(value) }

        var json: Any {
            switch self {
            case .string(let value): return value
            case .number(let value): return value
            case .bool(let value): return value
            }
        }
    }

    /// The call's events, for the client's whole life. One reader only.
    public nonisolated let events: AsyncStream<Event>
    /// Every turn of the call, oldest first, across its conversations.
    public private(set) var transcript: [Turn] = []
    /// Whether a conversation is starting or on.
    public var isActive: Bool { starting || session != nil }
    /// Mutes the microphone, for push-to-talk or a mute button. Other people
    /// talking near the phone keep the user's turn open on ElevenLabs' side
    /// (T17b). Silence is sent instead, so ElevenLabs still sees a turn end.
    ///
    /// One rule: every microphone chunk that overlaps muted time is sent as
    /// silence, up to the first chunk that starts fully unmuted. So speech
    /// captured while muted is never sent; up to 100 ms after unmuting may be
    /// lost.
    public var isMicrophoneMuted = false {
        didSet { if isMicrophoneMuted { chunkOverlapsMute = true } }
    }
    /// Whether the chunk being built started while muted, or was muted since.
    private var chunkOverlapsMute = false

    private nonisolated let continuation: AsyncStream<Event>.Continuation
    private let open: @MainActor (_ takesOver: String?) async throws -> any AgentSession
    private let audio: any AgentAudio

    /// Bumped for each conversation and by ``end()``: events from an older
    /// session are ignored.
    private var generation = 0
    private var starting = false
    private var session: (any AgentSession)?
    /// The session's send queue: one task sends its messages in order.
    private var outbox: AsyncStream<String>.Continuation?
    /// The last session's id: a new conversation takes its place.
    private var lastSessionID: String?
    /// The microphone goes to the agent only while the conversation is on and the link is up.
    private var micOn = false
    private var conversationStarted = false
    /// Agent audio with a lower `event_id` is dropped: the answer it belongs to was cut.
    private var dropBelow = 0
    /// The `event_id` of the last agent audio received.
    private var lastAudioID: Int?
    /// Sent once the conversation started.
    private var pendingContext: String?

    /// A client that starts a session with `agentID` through `gateway`.
    /// `provider` is the ElevenLabs connection's slug.
    ///
    /// The app must have microphone permission, an
    /// `NSMicrophoneUsageDescription`, and the `audio` background mode to keep
    /// talking while the screen is locked.
    public convenience init(gateway: AppAIGatewayClient, agentID: String, provider: String = "elevenlabs") {
        self.init(audio: AgentAudioEngine()) { takesOver in
            let ticket = try await gateway.startElevenLabsAgentSession(agentID: agentID, provider: provider, takesOver: takesOver)
            return LiveSession(ticket: ticket)
        }
    }

    init(audio: any AgentAudio, open: @escaping @MainActor (_ takesOver: String?) async throws -> any AgentSession) {
        self.audio = audio
        self.open = open
        (events, continuation) = AsyncStream.makeStream(of: Event.self)
        audio.onDrained = { [weak self] in self?.stopAudioIfIdle() }
        audio.onLostAudio = { [weak self] lost in self?.cutAnswer(lost: lost) }
        let mic = audio.mic
        Task { [weak self] in
            for await chunk in mic { self?.micChunk(chunk) }
        }
    }

    /// A client let go during a call ends it: otherwise the send task would
    /// keep the session, and the relay the call.
    deinit {
        outbox?.finish()
        if let session { Task { await session.close() } }
        // The same teardown as `end()`: the audio session goes, and its observers.
        let audio = audio
        Task { @MainActor in audio.stop() }
        continuation.finish()
    }

    // MARK: - The app's controls

    /// Starts a conversation with the agent. Call it again after a
    /// conversation ended to start a new one in the same call: the old one's
    /// audio is cleared first, and the new session takes the old one's place.
    ///
    /// - `firstMessage` replaces the agent's greeting, such as a short
    ///   "Sorry, the line dropped." for a new conversation after a lost one.
    ///   It is the only setting of the agent the relay lets the app change.
    /// - `dynamicVariables` fill the placeholders in the agent's prompt.
    /// - `context` is sent to the agent as a `contextual_update` once the
    ///   conversation starts. See ``contextualUpdate(for:)``.
    ///
    /// Throws the gateway's refusal, or an audio error: then no conversation
    /// started, and no ``Event/ended(_:)`` follows. Does nothing while a
    /// conversation is already on.
    public func start(
        firstMessage: String? = nil,
        dynamicVariables: [String: DynamicVariable] = [:],
        context: String? = nil
    ) async throws {
        guard !isActive else { return }
        starting = true
        generation += 1
        let current = generation
        // Audio left from an earlier conversation goes first: played on, it
        // made a new greeting about 50 s late (T17a).
        audio.flush()
        do {
            try audio.start()
        } catch {
            starting = false
            throw error
        }
        dropBelow = 0
        lastAudioID = nil
        conversationStarted = false
        pendingContext = context
        continuation.yield(.connecting)
        let session: any AgentSession
        do {
            session = try await open(lastSessionID)
        } catch {
            // `end()`, and maybe a newer start, took over meanwhile: then they own `starting`.
            if generation == current {
                starting = false
                stopAudioIfIdle()
            }
            throw error
        }
        // The app ended the call meanwhile: the session is never opened, and its ticket expires.
        guard generation == current else { return }
        starting = false
        self.session = session
        lastSessionID = session.sessionID
        let (queue, outbox) = AsyncStream.makeStream(of: String.self)
        self.outbox = outbox
        Task {
            for await text in queue { await session.send(text: text) }
        }
        let events = session.events
        Task { [weak self] in
            for await event in events { self?.handle(event, of: current) }
        }
        // First of all: the session holds it until the relay has started the session.
        outbox.yield(Self.firstMessage(greeting: firstMessage, dynamicVariables: dynamicVariables))
        await session.start()
    }

    /// The stop button: the agent stops talking at once. Its queued audio is
    /// cleared, the rest of the answer is dropped, and the agent is told the
    /// user didn't hear it. The conversation goes on.
    public func stopSpeaking() {
        cutAnswer()
        stopAudioIfIdle()
    }

    /// Ends the call: the session is closed and the agent's audio stops.
    public func end() {
        let wasActive = isActive
        generation += 1
        // A start still waiting for its session gives up: a new one may begin at once.
        starting = false
        let session = self.session
        finishConversation()
        audio.flush()
        audio.stop()
        if let session { Task { await session.close() } }
        if wasActive { continuation.yield(.ended(Ending(code: 1000, reason: "client_closed"))) }
    }

    /// Sends the agent text it should know, without making it answer, such
    /// as what the app shows on screen.
    public func sendContextualUpdate(_ text: String) {
        send(json: ["type": "contextual_update", "text": text])
    }

    /// Sends one of ElevenLabs' own messages as JSON text, such as a
    /// `client_tool_result`. The relay refuses one that changes the agent's
    /// settings.
    public func send(text: String) {
        outbox?.yield(text)
    }

    /// The earlier turns as one `contextual_update` text, for a new
    /// conversation after a lost one. The newest turns are kept when there
    /// are too many.
    public static func contextualUpdate(for turns: [Turn], limit: Int = 4000) -> String {
        var lines: [String] = []
        var size = 0
        for turn in turns.reversed() {
            let line = (turn.role == .user ? "User: " : "You: ") + turn.text.prefix(300)
            if size + line.count > limit { break }
            size += line.count + 1
            lines.append(line)
        }
        return "The connection dropped and was restored. This continues the same conversation with the same user. "
            + "Earlier turns, oldest first:\n" + lines.reversed().joined(separator: "\n")
    }

    // MARK: - Messages

    /// The relay lets the first message carry only the greeting override and
    /// the dynamic variables. It sets `user_id` itself.
    static func firstMessage(greeting: String?, dynamicVariables: [String: DynamicVariable]) -> String {
        var message: [String: Any] = ["type": "conversation_initiation_client_data"]
        if let greeting { message["conversation_config_override"] = ["agent": ["first_message": greeting]] }
        if !dynamicVariables.isEmpty { message["dynamic_variables"] = dynamicVariables.mapValues(\.json) }
        return json(message)
    }

    private static func json(_ object: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    private func send(json object: [String: Any]) {
        send(text: Self.json(object))
    }

    private func micChunk(_ pcm: Data) {
        let silent = chunkOverlapsMute
        // The next chunk starts now: muted still, or fully unmuted.
        chunkOverlapsMute = isMicrophoneMuted
        guard micOn, let outbox else { return }
        let pcm = silent ? Data(count: pcm.count) : pcm
        // Written exactly so: the relay passes an audio chunk alone without reading it.
        outbox.yield(#"{"user_audio_chunk":""# + pcm.base64EncodedString() + #""}"#)
    }

    private func handle(_ event: LiveSession.Event, of current: Int) {
        guard current == generation else { return }
        switch event {
        case .started, .data:
            break // ElevenLabs' messages are JSON text
        case .reconnecting:
            // Queued audio plays on: the same conversation may come back.
            micOn = false
            continuation.yield(.reconnecting)
        case .resumed:
            micOn = conversationStarted
            continuation.yield(.resumed)
        case .text(let text):
            message(text)
        case .ended(let code, let reason):
            conversationEnded(Ending(code: code, reason: reason))
        }
    }

    private func message(_ text: String) {
        guard let object = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any],
              let type = object["type"] as? String
        else {
            continuation.yield(.message(text))
            return
        }
        let body = { (key: String) in object[key] as? [String: Any] ?? [:] }
        switch type {
        case "conversation_initiation_metadata":
            let metadata = body("conversation_initiation_metadata_event")
            guard let input = Self.pcmRate(metadata["user_input_audio_format"]),
                  let output = Self.pcmRate(metadata["agent_output_audio_format"])
            else { return fail(code: 1003, reason: "unsupported_audio_format") }
            audio.use(inputRate: input, outputRate: output)
            conversationStarted = true
            micOn = true
            if let context = pendingContext {
                pendingContext = nil
                sendContextualUpdate(context)
            }
            continuation.yield(.connected(conversationID: metadata["conversation_id"] as? String ?? ""))
        case "audio":
            let audioEvent = body("audio_event")
            let id = audioEvent["event_id"] as? Int
            if let id, id < dropBelow { return }
            guard let base64 = audioEvent["audio_base_64"] as? String, let pcm = Data(base64Encoded: base64) else { return }
            if let id { lastAudioID = id }
            audio.play(pcm16: pcm)
        case "interruption":
            if let id = body("interruption_event")["event_id"] as? Int { dropBelow = max(dropBelow, id) }
            audio.flush()
            continuation.yield(.interrupted)
        case "ping":
            let id = body("ping_event")["event_id"] as? Int ?? 0
            send(text: #"{"type":"pong","event_id":"# + String(id) + "}")
        case "user_transcript":
            let text = body("user_transcription_event")["user_transcript"] as? String ?? ""
            transcript.append(Turn(role: .user, text: text))
            continuation.yield(.userTranscript(text))
        case "agent_response":
            let text = body("agent_response_event")["agent_response"] as? String ?? ""
            transcript.append(Turn(role: .agent, text: text))
            continuation.yield(.agentResponse(text))
        case "agent_response_correction":
            let text = body("agent_response_correction_event")["corrected_agent_response"] as? String ?? ""
            if let last = transcript.lastIndex(where: { $0.role == .agent }) { transcript[last].text = text }
            continuation.yield(.agentResponseCorrected(text))
        default:
            continuation.yield(.message(text))
        }
    }

    /// `pcm_16000` gives 16000. Other formats, such as `ulaw_8000`, are not played.
    static func pcmRate(_ format: Any?) -> Double? {
        guard let format = format as? String, format.hasPrefix("pcm_"), let rate = Double(format.dropFirst(4)), rate > 0 else { return nil }
        return rate
    }

    /// Clears the agent's queued audio and drops the rest of its answer. If
    /// any was lost, the agent is told: otherwise it believes the user heard it all (T17b).
    /// `lost` is what a rebuild of the audio engine already threw away.
    private func cutAnswer(lost alreadyLost: TimeInterval = 0) {
        let lost = max(alreadyLost, audio.flush())
        if let lastAudioID { dropBelow = max(dropBelow, lastAudioID + 1) }
        if lost > 0, conversationStarted {
            sendContextualUpdate("The user did not hear the rest of your last answer.")
        }
    }

    /// Ends the conversation for a reason that trying again can't fix, so
    /// `connectionLost` is false.
    private func fail(code: Int, reason: String) {
        let session = self.session
        generation += 1
        if let session { Task { await session.close() } }
        conversationEnded(Ending(code: code, reason: reason))
    }

    private func conversationEnded(_ ending: Ending) {
        finishConversation()
        continuation.yield(.ended(ending))
        stopAudioIfIdle()
    }

    private func finishConversation() {
        session = nil
        outbox?.finish()
        outbox = nil
        micOn = false
        conversationStarted = false
        pendingContext = nil
    }

    /// Audio left when a conversation ends plays out, then the audio stops.
    private func stopAudioIfIdle() {
        if !isActive, audio.queuedSeconds == 0 { audio.stop() }
    }
}

/// What the voice client needs from a live session: ``LiveSession`` in an app.
protocol AgentSession: AnyObject, Sendable {
    var sessionID: String { get }
    var events: AsyncStream<LiveSession.Event> { get }
    func start() async
    func send(text: String) async
    func close() async
}

extension LiveSession: AgentSession {
    nonisolated var sessionID: String { ticket.sessionID }
}
