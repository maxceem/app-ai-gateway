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
/// event. When it ends a session the app still wants, start a new session
/// with `takesOver` naming this one: for example `session_ended` (the relay
/// let it go, such as after iOS suspended the app for longer than the relay
/// holds a session), `heartbeat_timeout` or `reconnect_failed`.
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
    /// The session's ticket. `endsAt` says when the session ends at the latest.
    public nonisolated let ticket: LiveSessionTicket

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
        /// How long a heartbeat may go unanswered before the link counts as
        /// dead. The relay answers each heartbeat at once.
        var heartbeatAnswerWithin: TimeInterval = 10
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
    /// The link's send queue: one task, `writer`, sends its frames in order.
    private var outbox: AsyncStream<URLSessionWebSocketTask.Message>.Continuation?
    private var writer: Task<Void, Never>?
    /// The link `reconnect()` moved away from. It stays open until the new
    /// link has taken the session over: the relay closes it then with
    /// `1000 reconnected`. A close from this side could end the session first.
    private var retiring: (any LiveSessionLink)?
    /// The retiring link's generation: what it still delivers reaches the app.
    private var retiringGeneration = 0
    /// The current link's id. Each new link, and each drop, takes a fresh one
    /// from `lastID`: frames and closes from an older link are ignored.
    private var generation = 0
    private var lastID = 0
    /// A try to come back that `reconnect()` let go of while it hung, still
    /// read. The relay lets the later of two tries win: if this one takes the
    /// session over after all, it becomes the session's link.
    private struct Attempt {
        let link: any LiveSessionLink
        let outbox: AsyncStream<URLSessionWebSocketTask.Message>.Continuation
        let writer: Task<Void, Never>
    }
    private var letGo: [Int: Attempt] = [:]
    /// The highest handoff number the relay sent in `agw.session.resumed`.
    /// Two links' `resumed` can arrive in either order: the higher number is
    /// the link the relay kept. An older relay sends none.
    private var highestLink = 0
    /// Held from a hang-up during a handoff until the new link has ended the
    /// session, so an app that lets the session go at `.ended` doesn't cut it short.
    private var keepAlive: LiveSession?
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
    /// When a full send queue last made the client come back on a new link.
    private var overflowedAt: Date?
    private var finished = false
    /// `close()` came during a handoff: the app has its `.ended`, and the new
    /// link only finishes coming back so it can end the session with 1000.
    /// The old link may be dead, so its own close may never reach the relay.
    private var hangingUp = false
    /// When the last heartbeat went out, until anything arrives on the link.
    private var heartbeatSentAt: Date?
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
        if !finished {
            link?.close()
            retiring?.close()
            for attempt in letGo.values { attempt.writer.cancel(); attempt.link.close() }
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
    /// While the client is already coming back, it starts a fresh try at once,
    /// in place of one that may hang.
    public func reconnect() {
        guard !finished, !hangingUp, secret != nil else { return }
        if ready {
            handOff()
        } else if droppedAt != nil {
            // The try under way is let go without a close: if the relay took it
            // over after all, the new one takes the session from it, and the
            // relay closes it with `1000 reconnected`. A close from here could
            // end the session instead.
            if let link, let outbox, let writer {
                letGo[generation] = Attempt(link: link, outbox: outbox, writer: writer)
                self.outbox = nil
                self.writer = nil
            }
            attempts = 0
            newGeneration()
            retry()
        }
    }

    /// Ends the session. The relay counts the session's time until now.
    /// During a handoff the old link is closed at once, and the new one ends
    /// the session as soon as the relay has handed it over: the old link may
    /// be dead already, and then only the new one can end it.
    public func close() {
        guard !finished, !hangingUp else { return }
        guard droppedAt != nil, secret != nil else {
            return finish(code: 1000, reason: "client_closed")
        }
        hangingUp = true
        keepAlive = self
        pending.removeAll()
        retiring?.close()
        retiring = nil
        continuation.yield(.ended(code: 1000, reason: "client_closed"))
        continuation.finish()
    }

    /// The old link stays open until the new one has taken the session over:
    /// the relay closes it then with `1000 reconnected`. A close from this
    /// side could end the session first.
    private func handOff() {
        retiring = link
        retiringGeneration = generation
        dropped()
    }

    // MARK: - Links

    @discardableResult
    private func newGeneration() -> Int {
        lastID += 1
        generation = lastID
        return lastID
    }

    /// A let-go try took the session over: it becomes the session's link, and
    /// the link it replaced is read on as a let-go one, as the relay closes it.
    private func adopt(_ id: Int) {
        guard let attempt = letGo.removeValue(forKey: id) else { return }
        if let link, let outbox, let writer {
            letGo[generation] = Attempt(link: link, outbox: outbox, writer: writer)
        }
        link = attempt.link
        outbox = attempt.outbox
        writer = attempt.writer
        generation = id
    }

    private func openLink(comingBack: Bool) {
        let current = newGeneration()
        ready = false
        var request = URLRequest(url: ticket.relayURL)
        request.setValue("Bearer \(ticket.ticket)", forHTTPHeaderField: "Authorization")
        request.setValue("1", forHTTPHeaderField: "x-agw-relay-messages")
        let link = makeLink(request)
        self.link = link
        outbox?.finish()
        writer?.cancel()
        // Bounded: room for the frames held while away and as many fresh ones.
        // A link that stops taking frames is given up, never memory without end.
        let (queue, outbox) = AsyncStream.makeStream(
            of: URLSessionWebSocketTask.Message.self,
            bufferingPolicy: .bufferingOldest(2 * Self.pendingLimit)
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
        guard !finished else { return }
        // Until the new link takes over, the relay still sends the provider's
        // frames to the old one, such as the end of an answer: the app gets
        // them, but they don't count in the new link's reports.
        if current != generation, letGo[current] != nil {
            // Only its taking the session over matters: then it is the session's link,
            // unless the relay already handed the session on to a later one.
            guard case .string(let text) = message, text.hasPrefix(#"{"type":"agw.session.resumed""#) else { return }
            if let number = Self.linkNumber(text), number <= highestLink { return }
            adopt(current)
        }
        if current != generation {
            guard retiring != nil, current == retiringGeneration else { return }
            switch message {
            case .string(let text) where !text.hasPrefix(Self.relayPrefix): continuation.yield(.text(text))
            case .data(let data): continuation.yield(.data(data))
            default: break
            }
            return
        }
        // Anything from the relay shows the link is alive.
        heartbeatSentAt = nil
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
            secret = object["reconnect_secret"] as? String
            becameReady()
            continuation.yield(.started)
        case "agw.session.resumed":
            // The app hung up during the handoff: this link now owns the session, so it ends it.
            if hangingUp { return finish(code: 1000, reason: "client_closed") }
            if let number = object["link"] as? Int {
                // A link the relay already replaced: its `resumed` came late.
                guard number > highestLink else { return }
                highestLink = number
            }
            // Reports count only what came on this link, held frames included.
            received = 0
            reported = 0
            droppedAt = nil
            attempts = 0
            retiring?.close()
            retiring = nil
            becameReady()
            continuation.yield(.resumed)
        default:
            break // the relay's answer to a heartbeat, or a message this release does not know
        }
    }

    static func linkNumber(_ text: String) -> Int? {
        let object = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
        return object?["link"] as? Int
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
        if let attempt = letGo.removeValue(forKey: current) {
            attempt.writer.cancel()
            attempt.outbox.finish()
            return
        }
        guard current == generation, !finished, let link else { return }
        let code = link.closeCode
        let reason = link.closeReason
        // A let-go try took the session over, and its `resumed` is still on the
        // way: wait for it, within the usual cutoff, rather than end the session.
        if code == 1000, reason == "reconnected", !letGo.isEmpty {
            ready = false
            if droppedAt == nil { droppedAt = now() }
            outbox?.finish()
            writer?.cancel()
            self.link = nil
            outbox = nil
            writer = nil
            return
        }
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
        heartbeatSentAt = nil
        // What the old link still says is not this session's any more.
        newGeneration()
        if droppedAt == nil {
            droppedAt = now()
            continuation.yield(.reconnecting)
        }
        retry()
    }

    /// The tick ends the session once the relay would have let it go.
    private func retry() {
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
        guard !finished, !hangingUp else { return }
        guard ready else {
            if pending.count >= Self.pendingLimit { pending.removeFirst() }
            pending.append(message)
            return
        }
        forward(message)
    }

    /// `relay` marks the client's own reports and heartbeats: they belong to
    /// this link, so they are never carried over to a new one.
    private func forward(_ message: URLSessionWebSocketTask.Message, relay: Bool = false) {
        guard let outbox else { return }
        let time = now()
        lastSentAt = time
        guard case .dropped = outbox.yield(message) else { return }
        // The link stopped taking frames: most likely it died without a word.
        // A second time within the relay's window means the link is too slow
        // for what the app sends, and coming back would only loop.
        if secret == nil || overflowedAt.map({ time.timeIntervalSince($0) < timing.reconnectFor }) == true {
            return finish(code: 0, reason: "send_queue_full")
        }
        overflowedAt = time
        if !relay { pending.append(message) }
        // The same handoff as reconnect(): the old link stays open until the
        // new one has taken the session over, so the relay never sees it end.
        handOff()
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
        // A heartbeat the relay never answered: the link died without a word,
        // which reading alone can't tell while the app only listens.
        if let heartbeatSentAt, time.timeIntervalSince(heartbeatSentAt) >= timing.heartbeatAnswerWithin {
            return handOff()
        }
        if received != reported, time.timeIntervalSince(lastReportAt) >= timing.reportEvery {
            reported = received
            lastReportAt = time
            forward(.string(#"{"type":"agw.received","bytes":"# + String(received) + "}"), relay: true)
        }
        if time.timeIntervalSince(lastSentAt) >= timing.heartbeatAfter {
            // The oldest unanswered one counts.
            if heartbeatSentAt == nil { heartbeatSentAt = time }
            forward(.string(#"{"type":"agw.heartbeat"}"#), relay: true)
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
        link?.close()
        retiring?.close()
        retiring = nil
        for attempt in letGo.values {
            attempt.outbox.finish()
            attempt.writer.cancel()
            attempt.link.close()
        }
        letGo.removeAll()
        continuation.yield(.ended(code: code, reason: reason))
        continuation.finish()
        keepAlive = nil
    }

}

/// One WebSocket link to the relay.
protocol LiveSessionLink: AnyObject, Sendable {
    func send(_ message: URLSessionWebSocketTask.Message) async throws
    func receive() async throws -> URLSessionWebSocketTask.Message
    /// A normal close. The relay ends the session on it, unless a newer link
    /// has taken the session over. (A plain cancel would send a close with no
    /// code, which the relay reads as 1005: also a deliberate end.)
    func close()
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
    func close() { task.cancel(with: .normalClosure, reason: nil) }
    var closeCode: Int {
        let code = task.closeCode
        return code == .invalid ? 0 : code.rawValue
    }
    var closeReason: String {
        task.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
}
