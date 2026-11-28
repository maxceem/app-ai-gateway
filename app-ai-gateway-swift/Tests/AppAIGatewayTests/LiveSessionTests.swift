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
    private(set) var closed = false
    /// A link that stopped taking frames: each send waits until this is cleared, or it is cancelled.
    var stallSends: Bool {
        get { lock.withLock { _stallSends } }
        set { lock.withLock { _stallSends = newValue } }
    }
    private var _stallSends = false
    private var _sendsStarted = 0
    /// Sends the writer has begun, stalled or not.
    var sendsStarted: Int { lock.withLock { _sendsStarted } }

    init(request: URLRequest) { self.request = request }

    var sent: [String] { lock.withLock { _sent } }
    var closeCode: Int { lock.withLock { _closeCode } }
    var closeReason: String { lock.withLock { _closeReason } }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        lock.withLock { _sendsStarted += 1 }
        while stallSends { try await Task.sleep(nanoseconds: 1_000_000) }
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

    func close() { lock.withLock { closed = true } }

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

private func fast(heartbeat: TimeInterval = 60, report: TimeInterval = 60, heartbeatAnswer: TimeInterval = 60) -> LiveSession.Timing {
    LiveSession.Timing(heartbeatAfter: heartbeat, reportEvery: report, tick: 0.01, reconnectFor: 5, retryAtMost: 0.05, heartbeatAnswerWithin: heartbeatAnswer, hungAfter: 1)
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
    func reconnectKeepsTheOldLinkOpenUntilTheNewOneHasTakenOver() async {
        let links = Links()
        let session = LiveSession(ticket: ticket, timing: fast(), now: { Date() }, makeLink: links.make)
        var events = session.events.makeAsyncIterator()
        await session.start()
        links[0].deliver(started)
        _ = await events.next()
        await session.reconnect()
        #expect(await events.next() == .reconnecting)
        #expect(await eventually { links.count == 2 && links[1].sent.first?.hasPrefix(#"{"type":"agw.reconnect""#) == true })
        // A close from this side now would end the session before the new link takes it over.
        #expect(!links[0].closed)
        links[1].deliver(#"{"type":"agw.session.resumed","deadline":1795000000000}"#)
        #expect(await events.next() == .resumed)
        #expect(links[0].closed)
    }

    @Test
    func whatTheOldLinkStillDeliversDuringAHandoffReachesTheAppButIsNotCountedOnTheNewOne() async {
        let links = Links()
        let session = LiveSession(ticket: ticket, timing: fast(report: 0.02), now: { Date() }, makeLink: links.make)
        var events = session.events.makeAsyncIterator()
        await session.start()
        links[0].deliver(started)
        _ = await events.next()
        await session.reconnect()
        #expect(await events.next() == .reconnecting)
        #expect(await eventually { links.count == 2 })
        // The relay still sends to the old link until the new one takes over: the end of an answer.
        links[0].deliver(#"{"type":"response.done"}"#)
        #expect(await events.next() == .text(#"{"type":"response.done"}"#))
        links[1].deliver(#"{"type":"agw.session.resumed","deadline":1795000000000}"#)
        #expect(await events.next() == .resumed)
        links[1].deliver("xy")
        #expect(await events.next() == .text("xy"))
        // The new link's report counts only what came on it.
        #expect(await eventually { links[1].sent.contains(#"{"type":"agw.received","bytes":2}"#) })
        // Once the new link took over, the old one is not this session's any more.
        links[0].deliver("late")
        links[1].deliver("now")
        #expect(await events.next() == .text("now"))
    }

    @Test
    func framesGoOutInTheOrderTheAppSentThem() async {
        let links = Links()
        let session = LiveSession(ticket: ticket, timing: fast(), now: { Date() }, makeLink: links.make)
        var events = session.events.makeAsyncIterator()
        await session.start()
        // Some wait for the start, the rest go out as they come.
        for index in 0..<50 { await session.send(text: "frame-\(index)") }
        links[0].deliver(started)
        _ = await events.next()
        for index in 50..<200 { await session.send(text: "frame-\(index)") }
        #expect(await eventually { links[0].sent.count == 200 })
        #expect(links[0].sent == (0..<200).map { "frame-\($0)" })
    }

    @Test
    func aNewLinkThatNeverAnswersEndsTheSessionWhenTheRelayWouldHaveLetItGo() async {
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
        // The new link stays silent: no answer, no close.
        clock.advance(10)
        let last = await next(&events) { if case .ended = $0 { return true } else { return false } }
        #expect(last == .ended(code: 0, reason: "reconnect_failed"))
        #expect(links[1].closed)
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
        for (code, reason) in [(1000, "time_cap"), (4000, "client_too_slow"), (4000, "heartbeat_timeout"), (1008, "rate_limited"), (4000, "session_active")] {
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
    func closeEndsTheSessionNormally() async {
        let links = Links()
        let session = LiveSession(ticket: ticket, timing: fast(), now: { Date() }, makeLink: links.make)
        var events = session.events.makeAsyncIterator()
        await session.start()
        links[0].deliver(started)
        _ = await events.next()
        await session.close()
        #expect(links[0].closed)
        #expect(await events.next() == .ended(code: 1000, reason: "client_closed"))
    }

    @Test
    func aLinkThatStopsTakingFramesIsGivenUpAndTheClientComesBack() async {
        let links = Links()
        let session = LiveSession(ticket: ticket, timing: fast(), now: { Date() }, makeLink: links.make)
        var events = session.events.makeAsyncIterator()
        await session.start()
        links[0].deliver(started)
        _ = await events.next()
        links[0].stallSends = true
        for index in 0..<(2 * LiveSession.pendingLimit + 10) { await session.send(text: "audio-\(index)") }
        // Most likely the link died without a word: a new one comes back to the session.
        #expect(await events.next() == .reconnecting)
        #expect(await eventually { links.count == 2 && links[1].sent.first?.hasPrefix(#"{"type":"agw.reconnect""#) == true })
        // The old link stays open until the new one has taken over: a close now could end the session.
        #expect(!links[0].closed)
        links[1].deliver(#"{"type":"agw.session.resumed","deadline":1795000000000}"#)
        #expect(await events.next() == .resumed)
        #expect(links[0].closed)
        // The frame that found the queue full, and what came after it, go out on the new link, in order.
        let last = 2 * LiveSession.pendingLimit + 9
        #expect(await eventually { links[1].sent.last == "audio-\(last)" })
        let resent = Array(links[1].sent.dropFirst())
        #expect(resent.count >= 9)
        #expect(resent == ((last - resent.count + 1)...last).map { "audio-\($0)" })
    }

    @Test
    func aSecondFullQueueSoonAfterEndsTheSessionInsteadOfLooping() async {
        let links = Links()
        let session = LiveSession(ticket: ticket, timing: fast(), now: { Date() }, makeLink: links.make)
        var events = session.events.makeAsyncIterator()
        await session.start()
        links[0].deliver(started)
        _ = await events.next()
        links[0].stallSends = true
        for index in 0..<(2 * LiveSession.pendingLimit + 10) { await session.send(text: "a-\(index)") }
        #expect(await events.next() == .reconnecting)
        #expect(await eventually { links.count == 2 })
        links[1].stallSends = true
        links[1].deliver(#"{"type":"agw.session.resumed","deadline":1795000000000}"#)
        #expect(await events.next() == .resumed)
        // The new link is just as slow: the app's frames fill it again.
        for index in 0..<(2 * LiveSession.pendingLimit + 10) { await session.send(text: "b-\(index)") }
        #expect(await events.next() == .ended(code: 0, reason: "send_queue_full"))
        #expect(links.count == 2)
    }

    @Test
    func aReportThatFindsTheQueueFullIsNotCarriedToTheNewLink() async {
        let links = Links()
        let session = LiveSession(ticket: ticket, timing: fast(report: 0.01), now: { Date() }, makeLink: links.make)
        var events = session.events.makeAsyncIterator()
        await session.start()
        links[0].deliver(started)
        _ = await events.next()
        links[0].stallSends = true
        // One frame in the writer's hands, then the queue exactly full.
        await session.send(text: "first")
        #expect(await eventually { links[0].sendsStarted == 1 })
        for index in 0..<(2 * LiveSession.pendingLimit) { await session.send(text: "app-\(index)") }
        // Something arrives, so the next tick sends a report: it finds the queue full.
        links[0].deliver("provider")
        _ = await events.next()
        #expect(await events.next() == .reconnecting)
        #expect(await eventually { links.count == 2 })
        links[1].deliver(#"{"type":"agw.session.resumed","deadline":1795000000000}"#)
        #expect(await events.next() == .resumed)
        try? await Task.sleep(nanoseconds: 100_000_000)
        // Reports on the new link count from zero: the old link's report never goes there.
        #expect(!links[1].sent.contains { $0.hasPrefix(#"{"type":"agw.received""#) })
    }

    @Test
    func aSessionLetGoWithoutCloseLetsItsLinkGo() async {
        let links = Links()
        weak var released: LiveSession?
        do {
            let session = LiveSession(ticket: ticket, timing: fast(), now: { Date() }, makeLink: links.make)
            released = session
            await session.start()
            links[0].deliver(started)
            links[0].stallSends = true
            await session.send(text: "stuck")
        }
        #expect(await eventually { released == nil })
        #expect(links[0].closed)
    }

    @Test
    func aFullBacklogAfterAGapNeverCountsAgainstTheLiveQueue() async {
        let links = Links()
        let session = LiveSession(ticket: ticket, timing: fast(report: 0.01), now: { Date() }, makeLink: links.make)
        var events = session.events.makeAsyncIterator()
        await session.start()
        links[0].deliver(started)
        _ = await events.next()
        links[0].end(code: 0)
        _ = await events.next()
        // About ten seconds of 20 ms audio, sent while away.
        for index in 0..<LiveSession.pendingLimit { await session.send(text: "away-\(index)") }
        #expect(await eventually { links.count == 2 })
        // The new link takes its first frames a moment late, as a real one may.
        links[1].stallSends = true
        links[1].deliver(#"{"type":"agw.session.resumed","deadline":1795000000000}"#)
        #expect(await events.next() == .resumed)
        // Fresh frames and a report right after: the link is healthy, so the session goes on.
        links[1].deliver("provider")
        for index in 0..<20 { await session.send(text: "fresh-\(index)") }
        links[1].stallSends = false
        let expected = 1 + LiveSession.pendingLimit + 20
        #expect(await eventually { links[1].sent.filter { !$0.hasPrefix(#"{"type":"agw.received""#) }.count == expected })
        let sent = links[1].sent.filter { !$0.hasPrefix(#"{"type":"agw.received""#) }
        #expect(Array(sent.dropFirst()) == (0..<LiveSession.pendingLimit).map { "away-\($0)" } + (0..<20).map { "fresh-\($0)" })
        #expect(!links[1].closed)
        #expect(await events.next() == .text("provider"))
    }

    @Test
    func closeDuringAHandoffClosesTheOldLinkAtOnceAndTheNewOneOnceItTookOver() async {
        let links = Links()
        let session = LiveSession(ticket: ticket, timing: fast(), now: { Date() }, makeLink: links.make)
        var events = session.events.makeAsyncIterator()
        await session.start()
        links[0].deliver(started)
        _ = await events.next()
        await session.reconnect()
        _ = await events.next()
        #expect(await eventually { links.count == 2 })
        await session.close()
        // The old link still owns the session at the relay: its close ends it, if it gets through.
        #expect(links[0].closed)
        #expect(await events.next() == .ended(code: 1000, reason: "client_closed"))
        #expect(await events.next() == nil)
        // A close of the new link before the relay took it over would only end the try.
        #expect(!links[1].closed)
        links[1].deliver(#"{"type":"agw.session.resumed","deadline":1795000000000}"#)
        #expect(await eventually { links[1].closed })
    }

    @Test
    func aHangUpWhileComingBackFromADeadLinkEndsTheSessionThroughTheNewLink() async {
        let links = Links()
        let session = LiveSession(ticket: ticket, timing: fast(), now: { Date() }, makeLink: links.make)
        var events = session.events.makeAsyncIterator()
        await session.start()
        links[0].deliver(started)
        _ = await events.next()
        // Wi-Fi to cellular: the old link is gone, its close would never reach the relay.
        links[0].end(code: 0)
        #expect(await events.next() == .reconnecting)
        #expect(await eventually { links.count == 2 })
        await session.close()
        #expect(await events.next() == .ended(code: 1000, reason: "client_closed"))
        // Nothing the app sends now goes anywhere.
        await session.send(text: "late")
        #expect(!links[1].closed)
        links[1].deliver(#"{"type":"agw.session.resumed","deadline":1795000000000}"#)
        #expect(await eventually { links[1].closed })
        #expect(!links[1].sent.contains("late"))
    }

    @Test
    func aHeartbeatTheRelayNeverAnswersMovesTheSessionToANewLink() async {
        let links = Links()
        let session = LiveSession(ticket: ticket, timing: fast(heartbeat: 0.05, heartbeatAnswer: 0.1), now: { Date() }, makeLink: links.make)
        var events = session.events.makeAsyncIterator()
        await session.start()
        links[0].deliver(started)
        _ = await events.next()
        // The app only listens, and the link died without a word: the heartbeat gets no answer.
        #expect(await eventually { links[0].sent.contains(#"{"type":"agw.heartbeat"}"#) })
        #expect(await events.next() == .reconnecting)
        #expect(await eventually { links.count == 2 && links[1].sent.first?.hasPrefix(#"{"type":"agw.reconnect""#) == true })
        // The same handoff as reconnect(): the old link is not closed from this side.
        #expect(!links[0].closed)
    }

    @Test
    func anAppThatAlwaysSendsStillNoticesALinkThatDiedSilently() async {
        let links = Links()
        let session = LiveSession(ticket: ticket, timing: fast(heartbeat: 0.1, heartbeatAnswer: 0.1), now: { Date() }, makeLink: links.make)
        var events = session.events.makeAsyncIterator()
        await session.start()
        links[0].deliver(started)
        _ = await events.next()
        // A microphone sends all the time, so the link is never quiet on this side.
        let microphone = Task {
            while !Task.isCancelled {
                await session.send(text: #"{"user_audio_chunk":"AAAA"}"#)
                try? await Task.sleep(nanoseconds: 10_000_000)
            }
        }
        defer { microphone.cancel() }
        // Nothing comes back: the heartbeat asks, gets no answer, and the session moves on.
        #expect(await eventually { links[0].sent.contains(#"{"type":"agw.heartbeat"}"#) })
        #expect(await events.next() == .reconnecting)
        #expect(await eventually { links.count == 2 })
        // One heartbeat while it waited for the answer, not one a tick.
        #expect(links[0].sent.filter { $0 == #"{"type":"agw.heartbeat"}"# }.count == 1)
    }

    @Test
    func anAnsweredHeartbeatKeepsTheLink() async {
        let links = Links()
        let session = LiveSession(ticket: ticket, timing: fast(heartbeat: 0.05, heartbeatAnswer: 0.1), now: { Date() }, makeLink: links.make)
        var events = session.events.makeAsyncIterator()
        await session.start()
        links[0].deliver(started)
        _ = await events.next()
        // The relay answers every heartbeat at once.
        for _ in 0..<5 {
            let before = links[0].sent.filter { $0 == #"{"type":"agw.heartbeat"}"# }.count
            #expect(await eventually { links[0].sent.filter { $0 == #"{"type":"agw.heartbeat"}"# }.count > before })
            links[0].deliver(#"{"type":"agw.heartbeat"}"#)
        }
        #expect(links.count == 1)
    }

    @Test
    func reconnectWhileComingBackReplacesOnlyATryThatHasWaitedAWhile() async {
        let links = Links()
        let clock = Clock()
        let session = LiveSession(ticket: ticket, timing: fast(), now: { clock.now }, makeLink: links.make)
        var events = session.events.makeAsyncIterator()
        await session.start()
        links[0].deliver(started)
        _ = await events.next()
        links[0].end(code: 0)
        #expect(await events.next() == .reconnecting)
        #expect(await eventually { links.count == 2 })
        // A network monitor calls reconnect() right after the automatic try began:
        // two tries at once would both be taken over, so it is left alone.
        await session.reconnect()
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(links.count == 2)
        // The try hangs: no answer for a while.
        clock.advance(2)
        await session.reconnect()
        #expect(await eventually { links.count == 3 && links[2].sent.first?.hasPrefix(#"{"type":"agw.reconnect""#) == true })
        // The hung try is let go without a close: if the relay took it over after all, the new one takes it from it.
        #expect(!links[1].closed)
        links[2].deliver(Self.resumed)
        #expect(await events.next() == .resumed)
        links[2].deliver("now")
        #expect(await events.next() == .text("now"))
        await session.close()
        // Ended, the let-go try is closed too.
        #expect(links[1].closed)
    }

    /// A session whose first try to come back hung for a while, and was let go for a second one.
    private func letGoAfterAWhile() async -> (LiveSession, Links, AsyncStream<LiveSession.Event>.Iterator) {
        let links = Links()
        let clock = Clock()
        let session = LiveSession(ticket: ticket, timing: fast(), now: { clock.now }, makeLink: links.make)
        var events = session.events.makeAsyncIterator()
        await session.start()
        links[0].deliver(started)
        _ = await events.next()
        links[0].end(code: 0)
        _ = await events.next()
        _ = await eventually { links.count == 2 }
        clock.advance(2)
        await session.reconnect()
        _ = await eventually { links.count == 3 }
        return (session, links, events)
    }

    @Test
    func aHangUpAlsoClosesTriesThatWereLetGo() async {
        var (session, links, events) = await letGoAfterAWhile()
        await session.close()
        #expect(await events.next() == .ended(code: 1000, reason: "client_closed"))
        // A let-go try may own the session at the relay: it is closed with 1000 too.
        #expect(links[1].closed)
        // The current try stays, so it can still end the session if it is handed over.
        #expect(!links[2].closed)
        links[2].deliver(Self.resumed)
        #expect(await eventually { links[2].closed })
    }

    @Test
    func aReconnectedCloseAfterTheLetGoLinkEndedAndTheSessionResumedStillComesBack() async {
        var (session, links, events) = await letGoAfterAWhile()
        // The superseded try's reader ends before the fresh link's resumed is handled.
        links[1].end(code: 0)
        try? await Task.sleep(nanoseconds: 50_000_000)
        links[2].deliver(Self.resumed)
        #expect(await events.next() == .resumed)
        // Its takeover's close of the fresh link arrives after: come back, never end.
        links[2].end(code: 1000, reason: "reconnected")
        #expect(await events.next() == .reconnecting)
        #expect(await eventually { links.count == 4 && links[3].sent.first?.hasPrefix(#"{"type":"agw.reconnect""#) == true })
        links[3].deliver(Self.resumed)
        #expect(await events.next() == .resumed)
        await session.close()
    }

    @Test
    func aLetGoTryThatTookOverAndClosedBeforeTheResumedStillMakesTheClientComeBack() async {
        var (session, links, events) = await letGoAfterAWhile()
        // The let-go try took the session over, then its own link closed.
        links[1].end(code: 0)
        links[2].end(code: 1000, reason: "reconnected")
        #expect(await eventually { links.count == 4 && links[3].sent.first?.hasPrefix(#"{"type":"agw.reconnect""#) == true })
        links[3].deliver(Self.resumed)
        #expect(await next(&events) { $0 == .resumed } == .resumed)
        await session.close()
    }

    @Test
    func aLetGoTryThatTookTheSessionOverMakesTheClientComeBackAgain() async {
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
        clock.advance(2)
        await session.reconnect()
        #expect(await eventually { links.count == 3 })
        links[2].deliver(Self.resumed)
        #expect(await events.next() == .resumed)
        // The let-go try got through later, and the relay closed the new link: come back again.
        links[2].end(code: 1000, reason: "reconnected")
        #expect(await events.next() == .reconnecting)
        #expect(await eventually { links.count == 4 && links[3].sent.first?.hasPrefix(#"{"type":"agw.reconnect""#) == true })
        links[3].deliver(Self.resumed)
        #expect(await events.next() == .resumed)
        links[3].deliver("now")
        #expect(await events.next() == .text("now"))
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

    private static let resumed = #"{"type":"agw.session.resumed","deadline":1795000000000}"#

    @Test
    func aSessionLetGoAtItsEndedStillEndsThroughTheNewLink() async {
        let links = Links()
        var session: LiveSession? = LiveSession(ticket: ticket, timing: fast(), now: { Date() }, makeLink: links.make)
        var events = session!.events.makeAsyncIterator()
        await session!.start()
        links[0].deliver(started)
        _ = await events.next()
        links[0].end(code: 0)
        _ = await events.next()
        #expect(await eventually { links.count == 2 })
        await session!.close()
        #expect(await events.next() == .ended(code: 1000, reason: "client_closed"))
        // The app lets the session go at once; the new link must still end it.
        session = nil
        #expect(!links[1].closed)
        links[1].deliver(Self.resumed)
        #expect(await eventually { links[1].closed })
    }

    @Test
    func providerHelpersAskForTheProvidersOwnLiveSessionPath() async throws {
        let bodies = LockedBox<[String]>()
        bodies.set([])
        StubProtocol.handler = { request in
            let body = request.httpBodyStream.map { stream -> Data in
                stream.open()
                defer { stream.close() }
                var data = Data()
                var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable {
                    let read = stream.read(&buffer, maxLength: buffer.count)
                    if read <= 0 { break }
                    data.append(buffer, count: read)
                }
                return data
            } ?? request.httpBody ?? Data()
            bodies.set((bodies.get() ?? []) + ["\(request.url!.lastPathComponent) " + String(decoding: body, as: UTF8.self)])
            let answer = #"{"session_id":"s1","ticket":"t","relay_url":"wss://relay.test/v2/relay/session","expires_at":"a","ends_at":"b"}"#
            return (HTTPURLResponse(url: request.url!, statusCode: 201, httpVersion: nil, headerFields: nil)!, Data(answer.utf8))
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let urlSession = URLSession(configuration: configuration)
        let client = AppAIGatewayClient(appID: "app-1", baseURL: URL(string: "https://gateway.test")!, authMode: .apiKey(key: "agw_key"), session: urlSession)
        let send: @Sendable (URLRequest) async throws -> (Data, URLResponse) = { try await urlSession.data(for: $0) }
        _ = try await client.startOpenAIRealtimeSession(model: "gpt-realtime-2.1", send: send)
        _ = try await client.startXAIVoiceSession(model: "grok-voice-3.0", send: send)
        _ = try await client.startGeminiLiveSession(model: "gemini-3.1-flash-live-preview", send: send)
        _ = try await client.startGPTLiveSession(send: send)
        _ = try await client.startElevenLabsAgentSession(agentID: "agent_1", takesOver: "s0", send: send)
        let seen = try #require(bodies.get())
        #expect(seen.count == 5)
        let decoded = try seen.map { line -> (String, [String: String]) in
            let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
            return (parts[0], try JSONDecoder().decode([String: String].self, from: Data(parts[1].utf8)))
        }
        #expect(decoded[0].0 == "openai")
        #expect(decoded[0].1 == ["path": "v1/realtime", "model": "gpt-realtime-2.1"])
        #expect(decoded[1].0 == "xai")
        #expect(decoded[1].1 == ["path": "v1/realtime", "model": "grok-voice-3.0"])
        #expect(decoded[2].0 == "gemini")
        #expect(decoded[2].1 == ["path": "ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent", "model": "gemini-3.1-flash-live-preview"])
        #expect(decoded[3].0 == "openai")
        #expect(decoded[3].1 == ["path": "v1/live/sessions", "model": "gpt-live-1"])
        #expect(decoded[4].0 == "elevenlabs")
        #expect(decoded[4].1 == ["path": "v1/convai/conversation", "model": "agent_1", "takes_over": "s0"])
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
