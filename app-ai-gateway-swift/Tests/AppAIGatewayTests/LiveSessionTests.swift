import Foundation
import Testing
@testable import AppAIGateway

/// A link to a pretend relay: the test hands it frames and closes, and reads
/// what the client sent.
final class FakeLink: LiveSessionLink, @unchecked Sendable {
    private let lock = NSLock()
    private var inbox: [Result<URLSessionWebSocketTask.Message, Error>] = []
    private var waiter: CheckedContinuation<URLSessionWebSocketTask.Message, Error>?
    private var _sent: [String] = []
    private var _closeCode = 0
    private var _closeReason = ""
    private(set) var request: URLRequest
    private(set) var abandoned = false
    private(set) var closedWith: Int?

    init(request: URLRequest) { self.request = request }

    var sent: [String] { lock.withLock { _sent } }
    var closeCode: Int { lock.withLock { _closeCode } }
    var closeReason: String { lock.withLock { _closeReason } }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        lock.withLock {
            if case .string(let text) = message { _sent.append(text) } else { _sent.append("<binary>") }
        }
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if !inbox.isEmpty {
                let next = inbox.removeFirst()
                lock.unlock()
                continuation.resume(with: next)
            } else {
                waiter = continuation
                lock.unlock()
            }
        }
    }

    func close(code: Int) { lock.withLock { closedWith = code } }
    func abandon() { lock.withLock { abandoned = true } }

    /// The relay sends a frame.
    func deliver(_ text: String) { push(.success(.string(text))) }
    func deliver(_ data: Data) { push(.success(.data(data))) }
    /// The relay closes the link with a code, or the network loses it (code 0).
    func end(code: Int = 0, reason: String = "") {
        lock.withLock {
            _closeCode = code
            _closeReason = reason
        }
        push(.failure(URLError(.networkConnectionLost)))
    }

    private func push(_ item: Result<URLSessionWebSocketTask.Message, Error>) {
        lock.lock()
        if let waiter {
            self.waiter = nil
            lock.unlock()
            waiter.resume(with: item)
        } else {
            inbox.append(item)
            lock.unlock()
        }
    }
}

/// Every link the session opened, in order.
final class Links: @unchecked Sendable {
    private let lock = NSLock()
    private var all: [FakeLink] = []
    func make(_ request: URLRequest) -> any LiveSessionLink {
        let link = FakeLink(request: request)
        lock.withLock { all.append(link) }
        return link
    }
    var count: Int { lock.withLock { all.count } }
    subscript(index: Int) -> FakeLink { lock.withLock { all[index] } }
}

private let ticket = LiveSessionTicket(
    sessionID: "s1",
    ticket: "ticket-1",
    relayURL: URL(string: "wss://relay.test/v2/relay/session")!,
    expiresAt: "2026-11-27T00:01:00Z",
    endsAt: "2026-11-27T00:30:00Z"
)

private let started = #"{"type":"agw.session.started","reconnect_secret":"c2VjcmV0LXNlY3JldA","deadline":1795000000000}"#

private func fast(heartbeat: TimeInterval = 60, report: TimeInterval = 60) -> LiveSession.Timing {
    LiveSession.Timing(heartbeatAfter: heartbeat, reportEvery: report, tick: 0.01, reconnectFor: 5, retryAtMost: 0.05)
}

/// Waits until `condition` holds, for at most two seconds.
private func eventually(_ condition: () async -> Bool) async -> Bool {
    for _ in 0..<200 {
        if await condition() { return true }
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
    return false
}

/// Reads events until one matches.
private func next(_ events: inout AsyncStream<LiveSession.Event>.Iterator, where match: (LiveSession.Event) -> Bool) async -> LiveSession.Event? {
    while let event = await events.next() {
        if match(event) { return event }
    }
    return nil
}

@Suite(.serialized)
struct LiveSessionTests {
    @Test
    func opensTheRelayWithTheTicketInAHeaderAndAsksForRelayMessages() async {
        let links = Links()
        let session = LiveSession(ticket: ticket, timing: fast(), now: { Date() }, makeLink: links.make)
        await session.start()
        #expect(links.count == 1)
        let request = links[0].request
        #expect(request.url == ticket.relayURL)
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ticket-1")
        #expect(request.value(forHTTPHeaderField: "x-agw-relay-messages") == "1")
        #expect(request.url?.query == nil)
    }

    @Test
    func keepsRelayMessagesOutOfTheEventsAndHoldsFramesUntilTheSessionStarts() async {
        let links = Links()
        let session = LiveSession(ticket: ticket, timing: fast(), now: { Date() }, makeLink: links.make)
        var events = session.events.makeAsyncIterator()
        await session.start()
        await session.send(text: #"{"type":"session.update"}"#)
        // Nothing goes out before the relay started the session.
        #expect(links[0].sent.isEmpty)
        links[0].deliver(started)
        #expect(await events.next() == .started)
        #expect(await eventually { links[0].sent == [#"{"type":"session.update"}"#] })
        links[0].deliver(#"{"type":"agw.heartbeat"}"#)
        links[0].deliver(#"{"type":"session.created"}"#)
        #expect(await events.next() == .text(#"{"type":"session.created"}"#))
        #expect(await session.deadline == Date(timeIntervalSince1970: 1_795_000_000))
    }

    @Test
    func reportsTheProviderBytesItReceivedInUTF16UnitsAndBytes() async {
        let links = Links()
        let session = LiveSession(ticket: ticket, timing: fast(report: 0.02), now: { Date() }, makeLink: links.make)
        var events = session.events.makeAsyncIterator()
        await session.start()
        links[0].deliver(started)
        _ = await events.next()
        // "é" is one UTF-16 unit, "😀" two: JavaScript's `length` counts these.
        links[0].deliver(#"{"a":"é😀"}"#)
        links[0].deliver(Data([1, 2, 3, 4]))
        _ = await events.next()
        _ = await events.next()
        let expected = #"{"a":"é😀"}"#.utf16.count + 4
        #expect(await eventually { links[0].sent.contains(#"{"type":"agw.received","bytes":\#(expected)}"#) })
        // A report only when something new came.
        let reports = links[0].sent.filter { $0.hasPrefix(#"{"type":"agw.received""#) }.count
        try? await Task.sleep(nanoseconds: 100_000_000)
        #expect(links[0].sent.filter { $0.hasPrefix(#"{"type":"agw.received""#) }.count == reports)
    }

    @Test
    func sendsAHeartbeatOnlyAfterAQuietSpell() async {
        let links = Links()
        let session = LiveSession(ticket: ticket, timing: fast(heartbeat: 0.1), now: { Date() }, makeLink: links.make)
        var events = session.events.makeAsyncIterator()
        await session.start()
        links[0].deliver(started)
        _ = await events.next()
        #expect(await eventually { links[0].sent.contains(#"{"type":"agw.heartbeat"}"#) })
    }

    @Test
    func comesBackToTheSameSessionWithTheSecretFirstAfterALostLink() async {
        let links = Links()
        let session = LiveSession(ticket: ticket, timing: fast(report: 0.02), now: { Date() }, makeLink: links.make)
        var events = session.events.makeAsyncIterator()
        await session.start()
        links[0].deliver(started)
        _ = await events.next()
        links[0].deliver("abcdef")
        _ = await events.next()
        links[0].end(code: 0)
        #expect(await events.next() == .reconnecting)
        // Sent while away: it goes out after the client is back.
        await session.send(text: #"{"type":"input_audio_buffer.append","audio":"AAAA"}"#)
        #expect(await eventually { links.count == 2 })
        let second = links[1]
        #expect(second.request.value(forHTTPHeaderField: "Authorization") == "Bearer ticket-1")
        #expect(await eventually { second.sent.first == #"{"type":"agw.reconnect","secret":"c2VjcmV0LXNlY3JldA"}"# })
        #expect(second.sent.count == 1)
        second.deliver(#"{"type":"agw.session.resumed","deadline":1795000000000}"#)
        #expect(await events.next() == .resumed)
        #expect(await eventually { second.sent.contains(#"{"type":"input_audio_buffer.append","audio":"AAAA"}"#) })
        // Reports start again from zero on the new link.
        second.deliver("xy")
        _ = await events.next()
        #expect(await eventually { second.sent.contains(#"{"type":"agw.received","bytes":2}"#) })
        // A late frame from the old link is not this session's any more.
        links[0].deliver("late")
        second.deliver("now")
        #expect(await events.next() == .text("now"))
    }

    @Test
    func reconnectLetsTheOldLinkGoAndComesBackAtOnce() async {
        let links = Links()
        let session = LiveSession(ticket: ticket, timing: fast(), now: { Date() }, makeLink: links.make)
        var events = session.events.makeAsyncIterator()
        await session.start()
        links[0].deliver(started)
        _ = await events.next()
        await session.reconnect()
        #expect(links[0].abandoned)
        #expect(await events.next() == .reconnecting)
        #expect(await eventually { links.count == 2 && links[1].sent.first?.hasPrefix(#"{"type":"agw.reconnect""#) == true })
    }

    @Test
    func aRefusedSecretOnARunningSessionIsTriedAgain() async {
        let links = Links()
        let session = LiveSession(ticket: ticket, timing: fast(), now: { Date() }, makeLink: links.make)
        var events = session.events.makeAsyncIterator()
        await session.start()
        links[0].deliver(started)
        _ = await events.next()
        links[0].end(code: 0)
        _ = await events.next()
        #expect(await eventually { links.count == 2 })
        links[1].end(code: 4000, reason: "session_active")
        #expect(await eventually { links.count == 3 })
        links[2].deliver(#"{"type":"agw.session.resumed","deadline":1795000000000}"#)
        #expect(await events.next() == .resumed)
    }

    @Test
    func aSessionThatCantBeTakenBackEndsAndTellsWhy() async {
        let links = Links()
        let session = LiveSession(ticket: ticket, timing: fast(), now: { Date() }, makeLink: links.make)
        var events = session.events.makeAsyncIterator()
        await session.start()
        links[0].deliver(started)
        _ = await events.next()
        links[0].end(code: 0)
        _ = await events.next()
        #expect(await eventually { links.count == 2 })
        links[1].end(code: 4000, reason: "session_ended")
        #expect(await events.next() == .ended(code: 4000, reason: "session_ended"))
        #expect(await events.next() == nil)
        #expect(links.count == 2)
    }

    @Test
    func aCloseTheRelayChoseEndsTheSessionWithoutComingBack() async {
        for (code, reason) in [(1000, "time_cap"), (4000, "client_too_slow"), (1008, "rate_limited"), (4000, "session_active")] {
            let links = Links()
            let session = LiveSession(ticket: ticket, timing: fast(), now: { Date() }, makeLink: links.make)
            var events = session.events.makeAsyncIterator()
            await session.start()
            links[0].deliver(started)
            _ = await events.next()
            links[0].end(code: code, reason: reason)
            #expect(await events.next() == .ended(code: code, reason: reason))
            #expect(links.count == 1)
        }
    }

    @Test
    func givesUpComingBackOnceTheRelayHasLetTheSessionGo() async {
        let links = Links()
        let clock = Clock()
        let session = LiveSession(ticket: ticket, timing: fast(), now: { clock.now }, makeLink: links.make)
        var events = session.events.makeAsyncIterator()
        await session.start()
        links[0].deliver(started)
        _ = await events.next()
        links[0].end(code: 0)
        _ = await events.next()
        #expect(await eventually { links.count == 2 })
        clock.advance(10)
        links[1].end(code: 0)
        let last = await next(&events) { if case .ended = $0 { return true } else { return false } }
        #expect(last == .ended(code: 0, reason: "reconnect_failed"))
    }

    @Test
    func closeEndsTheSessionNormally() async {
        let links = Links()
        let session = LiveSession(ticket: ticket, timing: fast(), now: { Date() }, makeLink: links.make)
        var events = session.events.makeAsyncIterator()
        await session.start()
        links[0].deliver(started)
        _ = await events.next()
        await session.close()
        #expect(links[0].closedWith == 1000)
        #expect(await events.next() == .ended(code: 1000, reason: "client_closed"))
    }

    @Test
    func onlyASafeSecretIsEverSent() {
        #expect(LiveSession.safeSecret("abc-_XYZ09") == "abc-_XYZ09")
        #expect(LiveSession.safeSecret(#"a","x":"b"#) == nil)
        #expect(LiveSession.safeSecret("") == nil)
    }

    @Test
    func startSessionPostsThePathAndModelAndReadsTheTicket() async throws {
        let seen = LockedBox<URLRequest>()
        StubProtocol.handler = { request in
            seen.set(request)
            let body = #"{"session_id":"s1","ticket":"t","relay_url":"wss://relay.test/v2/relay/session","expires_at":"a","ends_at":"b"}"#
            return (HTTPURLResponse(url: request.url!, statusCode: 201, httpVersion: nil, headerFields: nil)!, Data(body.utf8))
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let urlSession = URLSession(configuration: configuration)
        let client = AppAIGatewayClient(
            appID: "app-1",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .apiKey(key: "agw_key"),
            endUserId: "user-1",
            session: urlSession
        )
        let answer = try await client.startSession(provider: "xai", path: "v1/realtime", model: "grok-voice-3.0") {
            try await urlSession.data(for: $0)
        }
        #expect(answer.sessionID == "s1")
        #expect(answer.relayURL.absoluteString == "wss://relay.test/v2/relay/session")
        let request = try #require(seen.get())
        #expect(request.url?.absoluteString == "https://gateway.test/v2/apps/app-1/sessions/xai")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer agw_key")
        #expect(request.value(forHTTPHeaderField: "X-End-User-ID") == "user-1")
    }

    @Test
    func startSessionThrowsTheGatewaysRefusal() async throws {
        StubProtocol.handler = { request in
            let body = #"{"error":{"code":"rate_limited","message":"The user has the most live sessions it allows"}}"#
            return (HTTPURLResponse(url: request.url!, statusCode: 429, httpVersion: nil, headerFields: ["X-AGW-Error": "rate_limited"])!, Data(body.utf8))
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let urlSession = URLSession(configuration: configuration)
        let client = AppAIGatewayClient(appID: "app-1", baseURL: URL(string: "https://gateway.test")!, authMode: .apiKey(key: "agw_key"), session: urlSession)
        do {
            _ = try await client.startSession(provider: "xai", path: "v1/realtime") { try await urlSession.data(for: $0) }
            Issue.record("a refusal must throw")
        } catch let error as GatewayError {
            #expect(error.statusCode == 429)
            #expect(error.code == .rateLimited)
        }
    }
}

final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date()
    var now: Date { lock.withLock { current } }
    func advance(_ seconds: TimeInterval) { lock.withLock { current += seconds } }
}

final class LockedBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value?
    func set(_ value: Value) { lock.withLock { self.value = value } }
    func get() -> Value? { lock.withLock { value } }
}

/// Its own stub, so these tests don't share `MockURLProtocol`'s handler with
/// the client tests, which run one at a time.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw URLError(.badServerResponse) }
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
}
