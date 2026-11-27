import Foundation

/// The gateway's answer to ``AppAIGatewayClient/startSession(provider:path:model:takesOver:send:)``:
/// where to open the session, and the ticket that opens it.
public struct LiveSessionTicket: Sendable, Decodable, Equatable {
    public let sessionID: String
    /// Sent to the relay in `Authorization`, never in a URL.
    public let ticket: String
    public let relayURL: URL
    /// When the ticket stops starting a session (ISO 8601).
    public let expiresAt: String
    /// When the session ends at the latest (ISO 8601).
    public let endsAt: String

    enum CodingKeys: String, CodingKey {
        case sessionID = "session_id"
        case ticket
        case relayURL = "relay_url"
        case expiresAt = "expires_at"
        case endsAt = "ends_at"
    }
}

/// One live session through the gateway's relay, such as a voice session.
///
/// The provider's frames pass through as they are, both ways. This client
/// adds only the relay's own rules:
/// - it asks for the relay's messages, and keeps them out of ``events``;
/// - it sends a heartbeat after 30 s without other frames;
/// - it reports the bytes it received every few seconds, so the relay can
///   tell a slow client from a live one;
/// - when the link drops, it comes back to the same session with the
///   session's reconnect secret, and sends what the app sent meanwhile.
///
/// Read ``events`` to the end. ``Event/ended(code:reason:)`` is the last
/// event. When the reason is `session_ended`, start a new session with
/// `takesOver` naming this one.
public actor LiveSession {
    public enum Event: Sendable, Equatable {
        /// The relay started the session. Provider frames follow.
        case started
        /// The link dropped, and the client is coming back to the session.
        case reconnecting
        /// The client came back to the same session. Frames the relay held
        /// meanwhile follow.
        case resumed
        /// A provider text frame.
        case text(String)
        /// A provider binary frame.
        case data(Data)
        /// The session is over. `code` is the relay's close code, or 0 when
        /// the link was lost and could not be taken back.
        case ended(code: Int, reason: String)
    }

    public nonisolated let events: AsyncStream<Event>
    public nonisolated let ticket: LiveSessionTicket

    /// When the session ends at the latest, once the relay said so.
    public private(set) var deadline: Date?

    /// How often things happen. Tests make them short.
    struct Timing: Sendable {
        var heartbeatAfter: TimeInterval = 30
        var reportEvery: TimeInterval = 2
        var tick: TimeInterval = 1
        /// How long after a drop the client keeps trying to come back. The
        /// relay keeps the session 90–120 s after the client's last frame.
        var reconnectFor: TimeInterval = 90
        /// The longest wait between two tries to come back.
        var retryAtMost: TimeInterval = 4
    }

    private let timing: Timing
    /// The relay holds at most this many frames for a client that is away;
    /// the client holds as many for the relay.
    static let pendingLimit = 512
    static let relayPrefix = #"{"type":"agw."#

    private let continuation: AsyncStream<Event>.Continuation
    private let makeLink: @Sendable (URLRequest) -> any LiveSessionLink
    private let now: @Sendable () -> Date
    private var link: (any LiveSessionLink)?
    /// The link's send queue: one task sends its frames, in order.
    private var outbox: AsyncStream<URLSessionWebSocketTask.Message>.Continuation?
    /// The task that sends the link's queue, and the one of the link
    /// `reconnect()` moved away from, until the new link takes over.
    private var writer: Task<Void, Never>?
    private var retiringWriter: Task<Void, Never>?
    /// The link `reconnect()` moved away from. It stays open until the new
    /// link has taken the session over: the relay closes it then with
    /// `1000 reconnected`. A close from this side could end the session first.
    private var retiring: (any LiveSessionLink)?
    /// Bumped for each new link: frames and closes from an older one are ignored.
    private var generation = 0
    /// Whether frames may go out: the session started or resumed on this link.
    private var ready = false
    private var secret: String?
    /// Frames the app sent while no link was ready, sent once one is.
    private var pending: [URLSessionWebSocketTask.Message] = []
    /// Provider bytes received on this link (UTF-16 units for text).
    private var received = 0
    private var reported = 0
    private var lastReportAt: Date
    private var lastSentAt: Date
    private var droppedAt: Date?
    private var attempts = 0
    private var finished = false
    private var timer: Task<Void, Never>?

    public init(ticket: LiveSessionTicket, session: URLSession = .shared) {
        self.init(ticket: ticket, timing: Timing(), now: { Date() }) { request in
            URLSessionLink(task: session.webSocketTask(with: request))
        }
    }

    init(
        ticket: LiveSessionTicket,
        timing: Timing,
        now: @escaping @Sendable () -> Date,
        makeLink: @escaping @Sendable (URLRequest) -> any LiveSessionLink
    ) {
        self.ticket = ticket
        self.timing = timing
        self.now = now
        self.makeLink = makeLink
        let start = now()
        lastReportAt = start
        lastSentAt = start
        (events, continuation) = AsyncStream.makeStream(of: Event.self)
    }

    /// A session the app let go without `close()` lets its links go too.
    deinit {
        timer?.cancel()
        writer?.cancel()
        retiringWriter?.cancel()
        if !finished {
            link?.abandon()
            retiring?.abandon()
        }
        continuation.finish()
    }

    /// Opens the session's link. Call once.
    public func start() {
        guard link == nil, !finished else { return }
        openLink(comingBack: false)
        let tick = UInt64(timing.tick * 1_000_000_000)
        timer = Task { [weak self] in
            while !Task.isCancelled {
                // Holds the session only while it ticks, so a session the app let go is freed.
                try? await Task.sleep(nanoseconds: tick)
                guard let self else { return }
                await self.onTick()
            }
        }
    }

    /// Sends a text frame to the provider, such as a JSON event. While the
    /// link is down it waits, and goes out once the client is back.
    public func send(text: String) async {
        await send(.string(text))
    }

    /// Sends a binary frame to the provider.
    public func send(data: Data) async {
        await send(.data(data))
    }

    /// Moves the session to a new link now, for example when the network
    /// changed: the old link is let go without waiting for it to time out.
    public func reconnect() {
        guard !finished, ready, secret != nil else { return }
        retiring = link
        retiringWriter = writer
        writer = nil
        dropped()
    }

    /// Ends the session. The relay counts the session's time until now.
    public func close() {
        guard !finished else { return }
        link?.close(code: 1000)
        finish(code: 1000, reason: "client_closed")
    }

    // MARK: - Links

    private func openLink(comingBack: Bool) {
        generation += 1
        let current = generation
        ready = false
        var request = URLRequest(url: ticket.relayURL)
        request.setValue("Bearer \(ticket.ticket)", forHTTPHeaderField: "Authorization")
        request.setValue("1", forHTTPHeaderField: "x-agw-relay-messages")
        let link = makeLink(request)
        self.link = link
        outbox?.finish()
        writer?.cancel()
        // Bounded like the frames held while away: a link that stopped taking
        // frames ends the session, never memory that grows without end.
        let (queue, outbox) = AsyncStream.makeStream(
            of: URLSessionWebSocketTask.Message.self,
            bufferingPolicy: .bufferingOldest(Self.pendingLimit)
        )
        self.outbox = outbox
        writer = Task {
            for await message in queue {
                if Task.isCancelled { return }
                try? await link.send(message)
            }
        }
        if comingBack, let secret {
            // The first message, and only here: never in a URL or a header.
            outbox.yield(.string(#"{"type":"agw.reconnect","secret":""# + secret + #""}"#))
        }
        Task { [weak self] in
            while true {
                do {
                    let message = try await link.receive()
                    await self?.handle(message, on: current)
                } catch {
                    await self?.lost(current)
                    return
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message, on current: Int) {
        guard current == generation, !finished else { return }
        switch message {
        case .string(let text):
            if text.hasPrefix(Self.relayPrefix) {
                relayMessage(text)
            } else {
                received += text.utf16.count
                continuation.yield(.text(text))
            }
        case .data(let data):
            received += data.count
            continuation.yield(.data(data))
        @unknown default:
            break
        }
    }

    private func relayMessage(_ text: String) {
        guard let object = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any],
              let type = object["type"] as? String
        else { return }
        switch type {
        case "agw.session.started":
            secret = (object["reconnect_secret"] as? String).flatMap(Self.safeSecret)
            noteDeadline(object["deadline"])
            becameReady()
            continuation.yield(.started)
        case "agw.session.resumed":
            noteDeadline(object["deadline"])
            // Reports count only what came on this link, held frames included.
            received = 0
            reported = 0
            droppedAt = nil
            attempts = 0
            retiring?.abandon()
            retiring = nil
            retiringWriter?.cancel()
            retiringWriter = nil
            becameReady()
            continuation.yield(.resumed)
        default:
            break // the relay's answer to a heartbeat, or a message this release does not know
        }
    }

    private func noteDeadline(_ value: Any?) {
        if let milliseconds = value as? Double { deadline = Date(timeIntervalSince1970: milliseconds / 1000) }
    }

    private func becameReady() {
        ready = true
        let queued = pending
        pending.removeAll()
        for message in queued { forward(message) }
    }

    /// The link closed or failed. Only a lost link is taken back: any close
    /// the relay chose ends the session, except a refused secret on a session
    /// that still runs, which is tried again.
    private func lost(_ current: Int) {
        guard current == generation, !finished, let link else { return }
        let code = link.closeCode
        let reason = link.closeReason
        if code == 0 {
            guard secret != nil else { return finish(code: 0, reason: "link_lost") }
            return dropped()
        }
        if code == 4000, reason == "session_active", droppedAt != nil {
            return retry()
        }
        finish(code: code, reason: reason)
    }

    private func dropped() {
        ready = false
        if droppedAt == nil {
            droppedAt = now()
            continuation.yield(.reconnecting)
        }
        retry()
    }

    private func retry() {
        guard let droppedAt, now().timeIntervalSince(droppedAt) < timing.reconnectFor else {
            return finish(code: 0, reason: "reconnect_failed")
        }
        attempts += 1
        // At once, then a little longer each time, at most 4 s apart.
        let wait = attempts == 1 ? 0 : min(timing.retryAtMost, 0.25 * pow(2, Double(attempts - 2)))
        let expected = generation
        Task { [weak self] in
            if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
            await self?.comeBack(expected)
        }
    }

    private func comeBack(_ expected: Int) {
        guard !finished, generation == expected else { return }
        openLink(comingBack: true)
    }

    // MARK: - Sending

    private func send(_ message: URLSessionWebSocketTask.Message) async {
        guard !finished else { return }
        guard ready else {
            if pending.count >= Self.pendingLimit { pending.removeFirst() }
            pending.append(message)
            return
        }
        forward(message)
    }

    private func forward(_ message: URLSessionWebSocketTask.Message) {
        guard let outbox else { return }
        lastSentAt = now()
        if case .dropped = outbox.yield(message) {
            // The link stopped taking frames: what the app sends can't go out.
            link?.abandon()
            finish(code: 0, reason: "send_queue_full")
        }
    }

    private func onTick() {
        guard !finished else { return }
        let time = now()
        // A new link that never answers must not keep the session past the
        // time the relay holds it.
        if let droppedAt, time.timeIntervalSince(droppedAt) >= timing.reconnectFor {
            return finish(code: 0, reason: "reconnect_failed")
        }
        guard ready else { return }
        if received != reported, time.timeIntervalSince(lastReportAt) >= timing.reportEvery {
            reported = received
            lastReportAt = time
            forward(.string(#"{"type":"agw.received","bytes":"# + String(received) + "}"))
        }
        if time.timeIntervalSince(lastSentAt) >= timing.heartbeatAfter {
            forward(.string(#"{"type":"agw.heartbeat"}"#))
        }
    }

    private func finish(code: Int, reason: String) {
        guard !finished else { return }
        finished = true
        ready = false
        timer?.cancel()
        pending.removeAll()
        outbox?.finish()
        writer?.cancel()
        retiringWriter?.cancel()
        if droppedAt != nil { link?.abandon() }
        retiring?.abandon()
        retiring = nil
        continuation.yield(.ended(code: code, reason: reason))
        continuation.finish()
    }

    /// The relay's secrets are base64url. Anything else is not sent, so it
    /// can never break the message it goes in.
    static func safeSecret(_ secret: String) -> String? {
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        return !secret.isEmpty && secret.count <= 128 && secret.allSatisfy(allowed.contains) ? secret : nil
    }
}

/// One WebSocket link to the relay.
protocol LiveSessionLink: AnyObject, Sendable {
    func send(_ message: URLSessionWebSocketTask.Message) async throws
    func receive() async throws -> URLSessionWebSocketTask.Message
    /// A normal close with this code.
    func close(code: Int)
    /// Lets the link go without a close: the relay sees a dropped link.
    func abandon()
    /// The close code the relay sent, or 0 when none came.
    var closeCode: Int { get }
    var closeReason: String { get }
}

final class URLSessionLink: LiveSessionLink, @unchecked Sendable {
    private let task: URLSessionWebSocketTask

    init(task: URLSessionWebSocketTask) {
        self.task = task
        task.maximumMessageSize = 16 * 1024 * 1024
        task.resume()
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws { try await task.send(message) }
    func receive() async throws -> URLSessionWebSocketTask.Message { try await task.receive() }
    func close(code: Int) {
        task.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure, reason: nil)
    }
    func abandon() { task.cancel() }
    var closeCode: Int {
        let code = task.closeCode
        return code == .invalid ? 0 : code.rawValue
    }
    var closeReason: String {
        task.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
}
