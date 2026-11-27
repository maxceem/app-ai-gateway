import Foundation

#if canImport(UIKit)
import UIKit
#endif

public typealias IssuerTokenProvider = @Sendable (_ forceRefresh: Bool) async throws -> String
public typealias IssuerRejectionRecovery = @Sendable () async throws -> Void

/// The provider part of a proxy URL: `/v2/apps/{app}/proxy/{slug}/…`.
///
/// A slug names one *provider connection* in your account, not a provider
/// type. The first connection of each type usually takes its type name as its
/// slug, which is what the constants below spell; another connection has a
/// slug of its own, e.g. `.custom("openai-dev")`.
public struct ProviderSlug: RawRepresentable, Hashable, Sendable,
    ExpressibleByStringLiteral, CustomStringConvertible {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public init(stringLiteral value: StringLiteralType) {
        self.rawValue = value
    }

    /// Any slug a connection in your account has, including a custom provider's.
    public static func custom(_ slug: String) -> ProviderSlug {
        ProviderSlug(rawValue: slug)
    }

    public static let openai: ProviderSlug = "openai"
    public static let anthropic: ProviderSlug = "anthropic"
    public static let gemini: ProviderSlug = "gemini"
    public static let xai: ProviderSlug = "xai"
    public static let perplexity: ProviderSlug = "perplexity"
    public static let deepseek: ProviderSlug = "deepseek"
    public static let groq: ProviderSlug = "groq"
    public static let mistral: ProviderSlug = "mistral"
    public static let together: ProviderSlug = "together"
    public static let fireworks: ProviderSlug = "fireworks"
    public static let cerebras: ProviderSlug = "cerebras"
    public static let moonshot: ProviderSlug = "moonshot"
    public static let bytedance: ProviderSlug = "bytedance"
    public static let baseten: ProviderSlug = "baseten"
    public static let huggingface: ProviderSlug = "huggingface"
    public static let openrouter: ProviderSlug = "openrouter"
    public static let vercel: ProviderSlug = "vercel"
    public static let elevenlabs: ProviderSlug = "elevenlabs"
    public static let deepgram: ProviderSlug = "deepgram"
    public static let fal: ProviderSlug = "fal"

    public var description: String { rawValue }
}

public enum GatewayAuthMode: Sendable {
    /// App Attest proves the client installation and the issuer token proves the user.
    case appAttest(issuerTokenProvider: IssuerTokenProvider)

    /// App Attest alone: the attested key identifies the installation, and the
    /// installation is the end user. No sign-in, and so no issuer token — match
    /// this to an application configured with the `app_install` source, which
    /// refuses a token rather than ignoring one.
    ///
    /// The key lives in the Secure Enclave for one install of one app, so it
    /// does not survive reinstalling or clearing the app's data. Per-install
    /// limits and blocks hold, but a user can shed one by starting over.
    /// The exchange also sends the app's App Store transaction, so an
    /// application that measures its budget per Apple Account keeps counting
    /// the same person after a reinstall.
    case appAttestInstall

    /// With an issuer provider, the API key is exchanged for a per-user gateway token.
    /// Without one, the key is sent directly and is valid only for issuer-less apps.
    case apiKey(key: String, issuerTokenProvider: IssuerTokenProvider? = nil)
}

public actor AppAIGatewayClient {
    private struct AccessToken: Sendable {
        let value: String
        /// When to replace it: well before it expires, so a refresh that fails
        /// or is slow is ridden out with this one.
        let refreshAt: Date
        /// Until when it is still sent: its expiry, less a margin for the
        /// request to reach the gateway. Past this, the next request waits for
        /// a new token.
        let usableUntil: Date
        /// How long a failed refresh waits before it is tried again.
        let retryInterval: TimeInterval
        /// The App Attest key the token is bound to, in the App Attest modes:
        /// the key that signs the requests it is sent with, where any are.
        let keyID: String?
        /// Whether every request sent with this token carries an
        /// `X-AppAttest-Proof`: only when the gateway answered the exchange
        /// with `verify_on: "every_request"`.
        let signsEveryRequest: Bool
    }

    private struct TokenResponse: Decodable {
        let access_token: String
        let expires_in: TimeInterval
        /// When the gateway verifies the install's App Attest assertion:
        /// `every_request` or `token_exchange`. Absent from an older gateway,
        /// which verifies it on the exchange alone, and from API-key apps.
        let verify_on: String?
    }

    /// The `verify_on` value under which every request is signed.
    static let verifyOnEveryRequest = "every_request"

    private struct ChallengeResponse: Decodable {
        let challenge: String
        /// Whether the gateway that issued the challenge reads an App Store
        /// transaction in the exchange. Absent from an older gateway, which
        /// ignores the body field but rebuilds the three-key client data, so
        /// a four-key assertion would fail there.
        let accepts_app_transaction: Bool?
    }

    private let appID: String
    private let baseURL: URL
    private let authMode: GatewayAuthMode
    private let endUserId: String?
    private let endUserHeader: String
    private let issuerRejectionRecovery: IssuerRejectionRecovery?
    /// The signed-in user this client is for, as the app names them, when it
    /// gave one: which of the install's keys is theirs.
    private let signedInUserID: String?
    /// The app's key share, sent at the App Attest token exchange when the
    /// app's account has split keys on.
    private let keyShare: String?
    private let attestProvider: any AppAttestProviding
    private let appTransactionProvider: any AppTransactionProviding
    private let credentialStore: any GatewayCredentialStoring
    private let session: URLSession
    private var accessToken: AccessToken?
    private var tokenExchangeTask: Task<AccessToken, Error>?
    /// Bumped by `discardAccessToken()`. An exchange keeps the generation it
    /// started in, and its token becomes the cached one only if no discard
    /// came in between: a discarded exchange may answer an older `verify_on`.
    private var tokenGeneration = 0
    private var refreshTask: Task<Void, Never>?
    /// Set when a refresh behind a still-usable token failed: no request starts
    /// another before then, so an outage does not cost each request an exchange.
    private var nextRefreshAttempt: Date?
    private var rateLimitHold: RateLimitHold?
    /// Failure reports still being sent, by an id of their own, so a test can
    /// wait for them; each removes itself once sent.
    private var failureReports: [UUID: Task<Void, Never>] = [:]
    /// Set by `invalidate()`: the client is ended.
    private var invalidated = false
    /// The replacement for a key the gateway refused, while it is registered:
    /// every request refused with that key waits for this one.
    private var keyReplacement: (refused: String, task: Task<String, Error>)?
    /// The last replacement that finished, so a refusal of the same key that
    /// arrives later reuses it instead of registering another.
    private var finishedReplacement: (refused: String, replacement: String)?
    /// Set once a replacement key was itself refused: no more keys are made
    /// until a signed request succeeds, so a gateway that refuses every key
    /// does not cost an attestation with Apple on each request.
    private var replacementHeld = false
    /// Whether a signed request has succeeded since the last replacement: a
    /// replacement that has worked may be replaced when it is refused later.
    private var replacementProven = false

    /// A refusal the gateway timed, and the instant its window closes.
    ///
    /// In memory and per client: this enforces nothing, it only stops this
    /// client from spending a window it has already been told about.
    private struct RateLimitHold {
        let until: Date
        let error: GatewayError
    }

    public init(
        appID: String,
        baseURL: URL,
        authMode: GatewayAuthMode,
        endUserId: String? = nil,
        endUserHeader: String = "X-End-User-ID",
        issuerRejectionRecovery: IssuerRejectionRecovery? = nil,
        signedInUserID: String? = nil,
        keyShare: String? = nil,
        attestProvider: any AppAttestProviding = SystemAppAttestProvider(),
        appTransactionProvider: any AppTransactionProviding = SystemAppTransactionProvider(),
        credentialStore: any GatewayCredentialStoring = KeychainGatewayCredentialStore(),
        session: URLSession = .shared
    ) {
        self.appID = appID
        self.baseURL = baseURL
        self.authMode = authMode
        self.endUserId = endUserId
        self.endUserHeader = endUserHeader
        self.issuerRejectionRecovery = issuerRejectionRecovery
        self.signedInUserID = signedInUserID
        self.keyShare = keyShare
        self.attestProvider = attestProvider
        self.appTransactionProvider = appTransactionProvider
        self.credentialStore = credentialStore
        self.session = session
    }

    deinit {
        tokenExchangeTask?.cancel()
        refreshTask?.cancel()
    }

    /// A token already in hand is still a token: a hold is only ever consulted
    /// where an exchange would otherwise be started, never in front of the
    /// cache, so a rate-limited window does not strand a client that is holding
    /// a perfectly good token.
    public func gatewayAccessToken() async throws -> String {
        try ensureLive()
        if case .apiKey(let key, nil) = authMode { return key }
        return try await currentAccessToken().value
    }

    /// The cached token while it is fresh, a new one otherwise. Callers use the
    /// token returned rather than reading the cache afterwards: an exchange
    /// that a discard overtook returns its token without caching it.
    private func currentAccessToken() async throws -> AccessToken {
        if let accessToken {
            if accessToken.refreshAt.timeIntervalSinceNow > 0 { return accessToken }
            // Due for replacement but still accepted: refresh behind it rather
            // than in front of it, so neither a slow exchange nor a failed one
            // holds the request. Only a token about to expire is waited for.
            if accessToken.usableUntil.timeIntervalSinceNow > 0 {
                refreshBehind()
                return accessToken
            }
        }
        return try await refreshGatewayAccessToken()
    }

    /// Starts a refresh without waiting for it, unless one is in flight or a
    /// failed one is waiting to be tried again.
    private func refreshBehind() {
        guard tokenExchangeTask == nil else { return }
        if let nextRefreshAttempt, nextRefreshAttempt.timeIntervalSinceNow > 0 { return }
        Task { await self.attemptRefresh() }
    }

    /// One refresh that fails nobody. When it fails, the current token stays
    /// in use for as long as the gateway still accepts it. A failure that may
    /// pass — the gateway or the network unavailable — is tried again after the
    /// token's retry interval, so an outage shorter than the time left on the
    /// token goes unnoticed by the app. Any other is not tried again behind the
    /// token: retrying would only repeat it, and some of its recoveries cost
    /// the app a purchase sync or an Apple attestation each. The next exchange
    /// is then the one a request waits for once the token runs out, as before.
    /// The gateway still judges every request the token is sent with.
    private func attemptRefresh() async {
        let generation = tokenGeneration
        do {
            _ = try await refreshGatewayAccessToken()
            nextRefreshAttempt = nil
        } catch {
            // A discard since this began has settled what the client holds.
            guard tokenGeneration == generation,
                  let accessToken,
                  accessToken.usableUntil.timeIntervalSinceNow > 0
            else { return }
            guard Self.mayPass(error) else {
                nextRefreshAttempt = accessToken.usableUntil
                return
            }
            let next = Date().addingTimeInterval(accessToken.retryInterval)
            nextRefreshAttempt = next
            scheduleRefresh(at: next)
        }
    }

    /// Whether a failed refresh is worth trying again shortly: the gateway said
    /// so, or the network failed before it could say anything.
    static func mayPass(_ error: Error) -> Bool {
        if let error = error as? GatewayError { return error.isRetryable }
        return error is URLError
    }

    /// Refuses, without a request, while a window the gateway timed is still
    /// open, and re-raises the refusal that opened it with the time that is
    /// actually left.
    ///
    /// Without this a rate-limited window costs an Apple attestation on every
    /// call the app makes. A refused `register` leaves no key stored, so the
    /// next call finds none, generates one and attests it with Apple — against
    /// Apple's own attestation limits — only for the gateway to refuse it
    /// again, for as long as the window lasts. This is not a retry: nothing is
    /// scheduled and nothing is attempted again. It only declines to spend a
    /// window the gateway has already said is spent.
    private func heldRateLimit() throws {
        guard let hold = rateLimitHold else { return }
        let remaining = hold.until.timeIntervalSinceNow
        guard remaining > 0 else {
            rateLimitHold = nil
            return
        }
        throw GatewayError(
            code: hold.error.code,
            message: hold.error.message,
            statusCode: hold.error.statusCode,
            data: hold.error.data,
            retryAfter: remaining
        )
    }

    /// One exchange at a time per generation. Concurrent callers join the one
    /// in flight; a caller after `discardAccessToken()` starts its own, and the
    /// overtaken one finishes for those already waiting on it without becoming
    /// the cached token or scheduling a refresh.
    private func refreshGatewayAccessToken() async throws -> AccessToken {
        try ensureLive()
        try heldRateLimit()
        if let tokenExchangeTask {
            let token = try await liveResult(of: tokenExchangeTask)
            // Ended while it waited: the token may be the next user's.
            try ensureLive()
            return token
        }
        let generation = tokenGeneration
        let task = Task {
            let token = try await self.exchangeToken(forceIssuerRefresh: false, retryIssuerOnce: true)
            if self.tokenGeneration == generation {
                self.accessToken = token
                self.scheduleRefresh(at: token.refreshAt)
            }
            return token
        }
        tokenExchangeTask = task
        defer {
            // A discard has already cleared it, and may have started another.
            if tokenGeneration == generation { tokenExchangeTask = nil }
        }
        let token = try await liveResult(of: task)
        try ensureLive()
        return token
    }

    /// The exchange's token, or, where the client was ended meanwhile and the
    /// exchange cancelled, ``GatewayClientInvalidated`` rather than the
    /// cancellation's own error.
    private func liveResult<Value: Sendable>(of task: Task<Value, Error>) async throws -> Value {
        do {
            return try await task.value
        } catch {
            try ensureLive()
            throw error
        }
    }

    /// `provider` is a connection's slug, not a provider type. See ``ProviderSlug``.
    public func proxyURL(provider: String, providerPath: String) -> URL {
        appURL("proxy/\(provider)").appending(path: providerPath)
    }

    /// `/v2/apps/{app}/<path>` under the gateway's base URL.
    private func appURL(_ path: String) -> URL {
        baseURL.appending(path: "v2/apps/\(appID)/\(path)")
    }

    public func proxyURL(provider: ProviderSlug, providerPath: String) -> URL {
        proxyURL(provider: provider.rawValue, providerPath: providerPath)
    }

    /// A request to a provider through the gateway, ready to send.
    ///
    /// The returned request carries `body` and, when given, `contentType`.
    /// When the app verifies App Attest on every request — the gateway says
    /// so in its token response, as `verify_on: "every_request"` — it also
    /// carries `X-AppAttest-Proof`: an assertion the device's App Attest key
    /// signed over exactly this method, URL, body and token. Send it as it is.
    /// Changing the body or the URL afterwards invalidates the proof, and the
    /// gateway refuses the request with `attest_failed`; headers other than
    /// `Authorization` may be added freely. Each proof is good for one
    /// request: build a new one per send. When the app verifies App Attest on
    /// the token exchange instead, the request carries the token alone.
    public func authorizedRequest(
        provider: String,
        providerPath: String,
        method: String = "POST",
        body: Data? = nil,
        contentType: String? = nil
    ) async throws -> URLRequest {
        try await built(
            url: proxyURL(provider: provider, providerPath: providerPath),
            method: method,
            body: body,
            contentType: contentType
        ).request
    }

    /// A request to a provider through the gateway, signed over its body and
    /// URL where the app verifies App Attest on every request: pass the body
    /// here, and change neither afterwards. See the `provider: String` form.
    public func authorizedRequest(
        provider: ProviderSlug,
        providerPath: String,
        method: String = "POST",
        body: Data? = nil,
        contentType: String? = nil
    ) async throws -> URLRequest {
        try await authorizedRequest(
            provider: provider.rawValue,
            providerPath: providerPath,
            method: method,
            body: body,
            contentType: contentType
        )
    }

    /// A preset, `/v2/apps/{app}/presets/{name}`. The connection, model and
    /// any fixed parameters are set on the app, so the caller sends only the
    /// body the preset's format expects, and the query that format documents:
    /// `alt=sse` streams a preset in Gemini's format, as Gemini's own API does.
    public func presetURL(name: String, query: [URLQueryItem] = []) -> URL {
        let url = appURL("presets/\(name)")
        return query.isEmpty ? url : url.appending(queryItems: query)
    }

    /// A request to a preset, ready to send. Signed over its body and URL
    /// exactly as the provider form is, where the app verifies App Attest on
    /// every request: pass the body and the query here, and change neither
    /// afterwards.
    public func authorizedRequest(
        preset: String,
        query: [URLQueryItem] = [],
        method: String = "POST",
        body: Data? = nil,
        contentType: String? = nil
    ) async throws -> URLRequest {
        try await built(url: presetURL(name: preset, query: query), method: method, body: body, contentType: contentType).request
    }

    /// A request to a link the gateway answered with, such as a job's status,
    /// result or cancel link, ready to send and signed like any other. A
    /// cancel link takes `method: "PUT"`.
    ///
    /// Only a link to this app on this gateway is accepted, so the gateway
    /// token is never sent anywhere else: any other URL throws
    /// ``GatewayErrorCode/invalidRequest`` without a request.
    ///
    /// A status link can answer with a redirect to the result. Its target is
    /// a gateway link too, and needs a proof of its own, so send these with
    /// redirects turned off — ``GatewayRedirectBlocker`` does that for
    /// `URLSession` — and follow the `Location` with a new request built
    /// here. `withAuthorizedRequest(gatewayLink:)` follows it for you.
    public func authorizedRequest(
        gatewayLink: URL,
        method: String = "GET",
        body: Data? = nil,
        contentType: String? = nil
    ) async throws -> URLRequest {
        try await built(url: checkedLink(gatewayLink), method: method, body: body, contentType: contentType).request
    }

    /// `link` when it is to this app on this gateway; refuses any other.
    private func checkedLink(_ link: URL) throws -> URL {
        guard isLinkToThisApp(link) else {
            throw GatewayError(
                code: .invalidRequest,
                message: "The link is not to this app on this gateway",
                statusCode: 0
            )
        }
        return link
    }

    /// Whether `url` is under `/v2/apps/{app}/` on this client's gateway: the
    /// same scheme, host and port, after the base URL's own path.
    func isLinkToThisApp(_ url: URL) -> Bool {
        let link = URLComponents(url: url, resolvingAgainstBaseURL: true)
        let base = URLComponents(url: baseURL, resolvingAgainstBaseURL: true)
        guard let link, let base,
              link.scheme?.lowercased() == base.scheme?.lowercased(),
              link.host?.lowercased() == base.host?.lowercased(),
              link.port == base.port,
              link.user == nil, link.password == nil
        else { return false }
        // Built as text: how `URL.appending(path:)` treats a trailing `/`
        // differs between Foundation releases, and so between iOS versions.
        var basePath = base.percentEncodedPath
        while basePath.hasSuffix("/") { basePath.removeLast() }
        let prefix = "\(basePath)/v2/apps/\(appID)/"
        let path = Self.whatwgPath(link.percentEncodedPath)
        return path.hasPrefix(prefix) && path.count > prefix.count
    }

    /// The gateway's own `/me` route for this app: where the calling install
    /// or user stands against the limits the app sets.
    public func currentUserURL() -> URL {
        appURL("me")
    }

    /// A `GET /v2/apps/{app}/me` request, ready to send: the limits that apply
    /// to the caller, its requests today, the month's spend against its
    /// budget, and whether it is blocked. Signed like every other gateway
    /// request where the app verifies App Attest on every request, with the
    /// same key recovery, so build it here rather than from a URL of your own:
    /// there a request without a proof is refused with `401 assertion_required`, and
    /// a signed request whose URL was changed afterwards with
    /// `403 attest_failed`.
    public func currentUserRequest() async throws -> URLRequest {
        try await built(url: currentUserURL(), method: "GET", body: nil, contentType: nil).request
    }

    /// The gateway's route that starts a live session on one provider
    /// connection: `POST /v2/apps/{app}/sessions/{provider}`.
    private func sessionURL(provider: String) -> URL {
        appURL("sessions/\(provider)")
    }

    /// Asks the gateway for a live session, such as a voice session, and
    /// answers its ticket. Open it with ``LiveSession``.
    ///
    /// - `path` is the provider's own live-session path, as the app would
    ///   call it, such as `v1/realtime`.
    /// - `model` is the model the session runs, where the provider names it.
    /// - `takesOver` names a session this one replaces, such as one whose
    ///   network dropped and that can't be taken back.
    ///
    /// A refusal throws ``GatewayError``. It is built, signed and recovered
    /// exactly as `withAuthorizedRequest` does for a call, and sent with
    /// `send`.
    public func startSession(
        provider: String,
        path: String,
        model: String? = nil,
        takesOver: String? = nil,
        send: @Sendable (URLRequest) async throws -> (Data, URLResponse) = { try await URLSession.shared.data(for: $0) }
    ) async throws -> LiveSessionTicket {
        var fields: [String: String] = ["path": path]
        if let model { fields["model"] = model }
        if let takesOver { fields["takes_over"] = takesOver }
        let body = try JSONEncoder().encode(fields)
        let url = sessionURL(provider: provider)
        let (data, response) = try await recovering(send: send) {
            try await self.built(url: url, method: "POST", body: body, contentType: "application/json")
        }
        guard let http = response as? HTTPURLResponse else {
            throw GatewayError(code: .unknown, message: "No HTTP answer", statusCode: 0)
        }
        if let refusal = GatewayError(response: http, body: data) { throw refusal }
        do {
            return try JSONDecoder().decode(LiveSessionTicket.self, from: data)
        } catch {
            throw GatewayError(code: .unknown, message: "The session answer could not be read", statusCode: http.statusCode)
        }
    }

    /// Builds a request to a provider through the gateway, hands it to `send`,
    /// and builds it again where the gateway itself refused it in a way a
    /// fresh token or a fresh proof can fix.
    ///
    /// The recommended way to send a gateway request. The client never
    /// performs the request: `send` does, with any session, configuration or
    /// networking library. Both of these fit it:
    ///
    /// ```swift
    /// { try await URLSession.shared.data(for: $0) }
    /// { try await URLSession.shared.bytes(for: $0) }
    /// ```
    ///
    /// `bytes(for:)` makes streaming work: it returns as soon as the response
    /// headers arrive, before the body, so the status is known while the
    /// stream is still unread.
    ///
    /// Only a refusal the gateway marked as its own, with `X-AGW-Error`, is
    /// acted on, and the body is never read for it, so a stream stays yours.
    /// A provider's answer never carries that header, so a provider's `401`
    /// or `403` comes back as it is, never sent again.
    ///
    /// - `401 auth_required`, an expired gateway token or one that names no
    ///   install, and `401 assertion_required`, an unsigned request on an app
    ///   switched to verify every request after the token was cached: the
    ///   token the request was sent with is forgotten, and the request is
    ///   built again — a fresh exchange, which picks up the app's current
    ///   `verify_on`, and a fresh proof — and sent once more.
    /// - `403 attest_failed` on a signed request: sent once more with a fresh
    ///   proof. If that is refused the same way, a new key is registered, a
    ///   token is got for it, and the request is sent a third time. A new key
    ///   costs an attestation with Apple and starts a new request count for
    ///   the install, so it is never the first step.
    ///
    /// Whatever the last send returns is returned. Nothing else is retried: an
    /// error `send` throws is rethrown, and every other status is returned as
    /// it is. Read a refusal with ``GatewayError/init(response:body:)``.
    /// After ``invalidate()``, a refused request is not sent again.
    ///
    /// `provider` is a connection's slug, not a provider type. See
    /// ``ProviderSlug``. The request is built, and signed over its body and
    /// URL, exactly as `authorizedRequest` builds it: headers other than
    /// `Authorization` may be added to it inside `send`, but its body and URL
    /// must stay as they are.
    public func withAuthorizedRequest<Body: Sendable>(
        provider: String,
        providerPath: String,
        method: String = "POST",
        body: Data? = nil,
        contentType: String? = nil,
        send: @Sendable (URLRequest) async throws -> (Body, URLResponse)
    ) async throws -> (Body, URLResponse) {
        let url = proxyURL(provider: provider, providerPath: providerPath)
        return try await recovering(send: send) {
            try await self.built(url: url, method: method, body: body, contentType: contentType)
        }
    }

    /// Sends a request to a provider through the gateway, built again where the
    /// gateway refused it in a way that can be fixed. See the `provider:
    /// String` form.
    public func withAuthorizedRequest<Body: Sendable>(
        provider: ProviderSlug,
        providerPath: String,
        method: String = "POST",
        body: Data? = nil,
        contentType: String? = nil,
        send: @Sendable (URLRequest) async throws -> (Body, URLResponse)
    ) async throws -> (Body, URLResponse) {
        try await withAuthorizedRequest(
            provider: provider.rawValue,
            providerPath: providerPath,
            method: method,
            body: body,
            contentType: contentType,
            send: send
        )
    }

    /// Sends a request to a preset. See the `provider: String` form.
    public func withAuthorizedRequest<Body: Sendable>(
        preset: String,
        query: [URLQueryItem] = [],
        method: String = "POST",
        body: Data? = nil,
        contentType: String? = nil,
        send: @Sendable (URLRequest) async throws -> (Body, URLResponse)
    ) async throws -> (Body, URLResponse) {
        let url = presetURL(name: preset, query: query)
        return try await recovering(send: send) {
            try await self.built(url: url, method: method, body: body, contentType: contentType)
        }
    }

    /// Sends a request to a link the gateway answered with, such as a job's
    /// status or result link, or its cancel link with `method: "PUT"`. See
    /// `authorizedRequest(gatewayLink:)` and the `provider: String` form.
    ///
    /// A redirect `send` hands back is followed here, up to three times, when
    /// its `Location` is a gateway link: each hop is a new `GET` with a proof
    /// of its own. A redirect anywhere else comes back to you. For this,
    /// `send` must not follow redirects itself: pass
    /// ``GatewayRedirectBlocker`` to `URLSession`. A transport that follows
    /// them sends the next hop without a proof of its own, and the gateway
    /// refuses it.
    public func withAuthorizedRequest<Body: Sendable>(
        gatewayLink: URL,
        method: String = "GET",
        body: Data? = nil,
        contentType: String? = nil,
        send: @Sendable (URLRequest) async throws -> (Body, URLResponse)
    ) async throws -> (Body, URLResponse) {
        var link = try checkedLink(gatewayLink)
        var method = method
        var body = body
        var contentType = contentType
        var hops = 0
        while true {
            let (to, how, what, type) = (link, method, body, contentType)
            let answer = try await recovering(send: send) {
                try await self.built(url: to, method: how, body: what, contentType: type)
            }
            guard hops < 3,
                  let http = answer.1 as? HTTPURLResponse,
                  [301, 302, 303, 307, 308].contains(http.statusCode),
                  let location = http.value(forHTTPHeaderField: "Location"),
                  let next = URL(string: location, relativeTo: link)?.absoluteURL,
                  isLinkToThisApp(next)
            else { return answer }
            hops += 1
            link = next
            // A redirect to a result is read with `GET`, and carries no body.
            if http.statusCode != 307 && http.statusCode != 308 {
                method = "GET"
                body = nil
                contentType = nil
            }
        }
    }

    /// Sends ``currentUserRequest()``. See the `provider: String` form of
    /// `withAuthorizedRequest`.
    public func withCurrentUserRequest<Body: Sendable>(
        send: @Sendable (URLRequest) async throws -> (Body, URLResponse)
    ) async throws -> (Body, URLResponse) {
        let url = currentUserURL()
        return try await recovering(send: send) {
            try await self.built(url: url, method: "GET", body: nil, contentType: nil)
        }
    }

    /// The name of the header in which the gateway names the code of an error
    /// it answers itself. A provider's answer never carries it.
    public static let errorCodeHeaderField = "X-AGW-Error"

    /// The recovery every `with…Request` form shares; see the `provider:
    /// String` form. Each send is a request built afresh, never one already
    /// sent.
    private func recovering<Body: Sendable>(
        send: @Sendable (URLRequest) async throws -> (Body, URLResponse),
        build: () async throws -> (request: URLRequest, token: AccessToken?)
    ) async throws -> (Body, URLResponse) {
        let first = try await build()
        let answer = try await send(first.request)
        noteSignedSuccess(first.request, answer.1)
        // An answer from another URL is a redirect the transport followed,
        // its next hop sent with this request's proof: a refusal there is
        // not one a new token or key can fix.
        guard Self.sameTarget(first.request, answer.1) else { return answer }
        switch Self.gatewayRefusal(answer.1) {
        case "auth_required" where Self.status(answer.1) == 401,
             "assertion_required" where Self.status(answer.1) == 401:
            guard !invalidated else { return answer }
            forget(first.token)
            return try await send(try await build().request)
        case "attest_failed" where Self.status(answer.1) == 403:
            guard !invalidated, first.request.value(forHTTPHeaderField: Self.proofHeaderField) != nil else {
                return answer
            }
            let second = try await build()
            let again = try await send(second.request)
            noteSignedSuccess(second.request, again.1)
            guard Self.sameTarget(second.request, again.1),
                  Self.gatewayRefusal(again.1) == "attest_failed", !invalidated,
                  let refused = second.token?.keyID
            else { return again }
            do {
                try await recoverFromRefusedKey(refused)
            } catch is ReplacementHeld {
                return again
            }
            let third = try await build()
            let last = try await send(third.request)
            noteSignedSuccess(third.request, last.1)
            return last
        default:
            return answer
        }
    }

    /// Whether `response` answers `request`'s own URL, not one a transport
    /// redirected it to.
    private static func sameTarget(_ request: URLRequest, _ response: URLResponse) -> Bool {
        guard let answered = response.url, let asked = request.url else { return true }
        let path = { (url: URL) in URLComponents(url: url, resolvingAgainstBaseURL: true)?.percentEncodedPath ?? url.path }
        return path(answered) == path(asked) && answered.host?.lowercased() == asked.host?.lowercased()
    }

    /// A signed request that succeeded lifts the brake on key replacement.
    /// An exchange the gateway accepted lifts the brake on key replacement
    /// where requests are not signed (`verify_on: token_exchange`): there the
    /// exchange is the only place a key is checked, so its success is the
    /// proof. Where every request is signed, only a signed request that
    /// succeeds lifts it: an exchange can succeed with a key every request is
    /// then refused with, and lifting there would cost an attestation per
    /// request again.
    private func noteAcceptedExchange(_ response: TokenResponse) {
        guard response.verify_on != Self.verifyOnEveryRequest else { return }
        replacementHeld = false
        replacementProven = true
    }

    private func noteSignedSuccess(_ request: URLRequest, _ response: URLResponse) {
        guard request.value(forHTTPHeaderField: Self.proofHeaderField) != nil,
              (200..<300).contains(Self.status(response))
        else { return }
        replacementHeld = false
        replacementProven = true
    }

    /// The code in `X-AGW-Error`: present only where the gateway itself
    /// refused the request.
    private static func gatewayRefusal(_ response: URLResponse) -> String? {
        (response as? HTTPURLResponse)?.value(forHTTPHeaderField: errorCodeHeaderField)
    }

    private static func status(_ response: URLResponse) -> Int {
        (response as? HTTPURLResponse)?.statusCode ?? 0
    }

    static let proofHeaderField = "X-AppAttest-Proof"

    /// Forgets `token`, the one a refused request was sent with, unless it has
    /// already been replaced: a refusal that arrives late must not throw away
    /// the token another request already got. A replacement already being
    /// fetched is joined by the next build.
    private func forget(_ token: AccessToken?) {
        guard let token, accessToken?.value == token.value else { return }
        discardAccessToken()
    }

    /// Replaces a key the gateway refused, and forgets the token bound to it,
    /// so the next build exchanges the replacement.
    private func recoverFromRefusedKey(_ refused: String) async throws {
        // The token bound to the refused key is no use either way: forgotten
        // even when no replacement could be made, so the next request runs an
        // exchange, with its own recovery, instead of the same refusal again.
        // Kept while replacement is held: a new exchange would only bring back
        // the same key, and cost a challenge on every request.
        do {
            _ = try await replaceKey(refused: refused)
        } catch is ReplacementHeld {
            throw ReplacementHeld()
        } catch {
            if accessToken?.keyID == refused { discardAccessToken() }
            throw error
        }
        if accessToken?.keyID == refused { discardAccessToken() }
    }

    /// Forgets the gateway token this client holds, so the next request runs
    /// the exchange again. For an app that sent a request itself and was
    /// refused with `auth_required`, `attest_failed` or `assertion_required`:
    /// a fresh exchange registers a new App Attest key if the gateway no
    /// longer accepts the old one, and picks up the app's current
    /// `verify_on`, so a request rebuilt after an app was switched to verify
    /// every request is signed. Rebuild the request once; a second refusal is
    /// real. The `with…Request` forms do this themselves.
    ///
    /// An exchange already in flight is not joined afterwards: the next request
    /// starts a new one, so it cannot pick up a `verify_on` answered before the
    /// discard. The one in flight is left to finish for whoever already awaits
    /// it, and its token is never cached.
    public func discardAccessToken() {
        accessToken = nil
        nextRefreshAttempt = nil
        tokenGeneration += 1
        tokenExchangeTask = nil
        refreshTask?.cancel()
        refreshTask = nil
    }

    /// Ends this client. Use one client per signed-in session: when the user
    /// signs out or another signs in, call this on the old client and make a
    /// new one.
    ///
    /// Afterwards the client builds no request, exchanges no token and sends
    /// nothing again: every call throws ``GatewayClientInvalidated``, and a
    /// request already in flight comes back with its own answer, never sent
    /// again with anyone's credentials. The keys kept on the device stay, so
    /// a user who signs in again uses theirs.
    public func invalidate() {
        invalidated = true
        // Cancelled, as `deinit` does: an exchange still running must not
        // spend a challenge or an attestation for a client that has ended.
        tokenExchangeTask?.cancel()
        discardAccessToken()
        keyReplacement?.task.cancel()
        keyReplacement = nil
        finishedReplacement = nil
    }

    private func ensureLive() throws {
        if invalidated { throw GatewayClientInvalidated() }
    }

    /// Whether this client exchanges an App Attest assertion for its token,
    /// and so may have to sign the requests it sends with it.
    private var usesAppAttest: Bool {
        switch authMode {
        case .appAttest, .appAttestInstall: return true
        case .apiKey: return false
        }
    }

    /// The request, and the token it carries where it carries one.
    private func built(
        url: URL,
        method: String,
        body: Data?,
        contentType: String?
    ) async throws -> (request: URLRequest, token: AccessToken?) {
        try ensureLive()
        // Sent exactly as the gateway's URL parser will read it, so the path
        // and query this client signs are the ones the gateway rebuilds.
        var request = URLRequest(url: Self.whatwgNormalized(url))
        request.httpMethod = method
        request.httpBody = body
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if case .apiKey(_, nil) = authMode, let endUserId {
            // Whatever the application configured. The gateway *requires* the
            // header once a header source is set, so a mismatched name here is
            // a 400 on every request rather than a silently unattributed one.
            request.setValue(endUserId, forHTTPHeaderField: endUserHeader)
        }
        Self.identifyClient(&request)
        if case .apiKey(let key, nil) = authMode {
            request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
            return (request, nil)
        }
        let token = try await currentAccessToken()
        // Ended while the token was fetched: build nothing with it.
        try ensureLive()
        // The app verifies App Attest on the token exchange, an API key app,
        // or a gateway older than `verify_on`: the assertion was checked when
        // the token was minted, and the token alone is the request's
        // credential.
        guard usesAppAttest, token.signsEveryRequest else {
            request.setValue("Bearer \(token.value)", forHTTPHeaderField: "Authorization")
            return (request, token)
        }
        do {
            let signedRequest = try await signed(request, with: token)
            try ensureLive()
            return (signedRequest, token)
        } catch let failure as LocalSigningFailure {
            // The key the token is bound to cannot sign on this device any more —
            // the app was reinstalled or restored, and its Secure Enclave key
            // went with the old install. Register a replacement, exchange it for
            // a token bound to it, and sign once more; a second failure is real.
            if let refused = token.keyID {
                do {
                    try await recoverFromRefusedKey(refused)
                } catch is ReplacementHeld {
                    throw failure.underlying
                }
            }
            let replacement = try await currentAccessToken()
            try ensureLive()
            // The replacement's answer decides, should the app have changed
            // its setting in between.
            guard replacement.signsEveryRequest else {
                request.setValue("Bearer \(replacement.value)", forHTTPHeaderField: "Authorization")
                return (request, replacement)
            }
            do {
                let signedRequest = try await signed(request, with: replacement)
                try ensureLive()
                return (signedRequest, replacement)
            } catch let failure as LocalSigningFailure {
                throw failure.underlying
            }
        }
    }

    /// A replacement key was itself refused, and no other is made until a
    /// signed request succeeds.
    private struct ReplacementHeld: Error {}

    /// `generateAssertion` failing on the device, kept apart from every other
    /// failure so only it triggers a key replacement.
    private struct LocalSigningFailure: Error {
        let underlying: any Error
    }

    /// The request with its token and its proof.
    private func signed(_ request: URLRequest, with token: AccessToken) async throws -> URLRequest {
        let stored = token.keyID == nil ? try credentialStore.appAttestKeyID(for: appID) : nil
        guard let keyID = token.keyID ?? stored else {
            throw GatewayError(code: .attestFailed, message: "No App Attest key to sign the request with", statusCode: 0)
        }
        var request = request
        request.setValue("Bearer \(token.value)", forHTTPHeaderField: "Authorization")
        let timestamp = Int(Date().timeIntervalSince1970)
        let nonce = Self.randomNonce()
        let clientData = Self.requestClientData(
            appID: appID,
            method: request.httpMethod ?? "GET",
            pathAndQuery: Self.pathAndQuery(of: request.url!),
            body: request.httpBody,
            token: token.value,
            timestamp: timestamp,
            nonce: nonce
        )
        let assertion: Data
        do {
            assertion = try await attestProvider.generateAssertion(keyID, clientDataHash: clientData.sha256)
        } catch {
            throw LocalSigningFailure(underlying: error)
        }
        request.setValue(
            Self.proofHeader(timestamp: timestamp, nonce: nonce, assertion: assertion),
            forHTTPHeaderField: Self.proofHeaderField
        )
        return request
    }

    /// The first line of every signed request's client data, naming the format.
    static let requestProofDomain = "appaigateway-request-v1"

    /// What the device signs for one request: these lines joined by `\n`,
    /// with no trailing newline. The gateway rebuilds the same bytes from the
    /// request it receives; the golden test pins them on both sides.
    static func requestClientData(
        appID: String,
        method: String,
        pathAndQuery: String,
        body: Data?,
        token: String,
        timestamp: Int,
        nonce: String
    ) -> Data {
        let lines = [
            requestProofDomain,
            appID,
            method.uppercased(),
            pathAndQuery,
            (body ?? Data()).sha256.base64URLEncodedString(),
            Data(token.utf8).sha256.base64URLEncodedString(),
            String(timestamp),
            nonce,
        ]
        return Data(lines.joined(separator: "\n").utf8)
    }

    /// The URL's path and query as the gateway reads them: Foundation's
    /// percent-encoded form, normalized the way the WHATWG URL parser
    /// normalizes it. An empty query is no query.
    static func pathAndQuery(of url: URL) -> String {
        let components = URLComponents(url: url, resolvingAgainstBaseURL: true)
        let path = whatwgPath(components?.percentEncodedPath ?? url.path)
        guard let query = components?.percentEncodedQuery, !query.isEmpty else { return path }
        return "\(path)?\(whatwgQuery(query))"
    }

    /// The URL rewritten so its path and query are exactly what the WHATWG URL
    /// parser makes of them: the gateway's runtime reads every request that
    /// way, and Foundation's own encoding differs on a few bytes — `'` in a
    /// query, `^` in a path, dot segments. Returned unchanged if it cannot be
    /// rebuilt.
    static func whatwgNormalized(_ url: URL) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: true) else { return url }
        components.percentEncodedPath = ""
        components.percentEncodedQuery = nil
        components.fragment = nil
        guard let origin = components.string else { return url }
        return URL(string: origin + pathAndQuery(of: url)) ?? url
    }

    /// The WHATWG path percent-encode set beyond controls and non-ASCII:
    /// space, `"`, `#`, `<`, `>`, `?`, `^`, `` ` ``, `{` and `}`.
    private static let pathEncodeSet: Set<UInt8> = [0x20, 0x22, 0x23, 0x3C, 0x3E, 0x3F, 0x5E, 0x60, 0x7B, 0x7D]
    /// The WHATWG special-scheme query percent-encode set beyond controls and
    /// non-ASCII: space, `"`, `#`, `<`, `>` and `'`.
    private static let queryEncodeSet: Set<UInt8> = [0x20, 0x22, 0x23, 0x3C, 0x3E, 0x27]

    /// Percent-encodes what the WHATWG parser would, byte by byte. `%` is never
    /// encoded, so an escape already present — valid or not — is left as is.
    private static func whatwgEncode(_ value: Substring, extra: Set<UInt8>) -> String {
        var output = ""
        for byte in value.utf8 {
            if byte < 0x20 || byte > 0x7E || extra.contains(byte) {
                output += String(format: "%%%02X", byte)
            } else {
                output.unicodeScalars.append(Unicode.Scalar(byte))
            }
        }
        return output
    }

    /// A path as the WHATWG parser leaves it for an `https` URL: `\` read as
    /// `/`, `.` and `..` segments (`%2e` spelled or not) resolved, and the
    /// path percent-encode set applied to what remains.
    static func whatwgPath(_ path: String) -> String {
        var segments = path.replacingOccurrences(of: "\\", with: "/")
            .split(separator: "/", omittingEmptySubsequences: false)
        if segments.first == "" { segments.removeFirst() }
        var output: [String] = []
        for (index, segment) in segments.enumerated() {
            let lowered = segment.lowercased()
            let isLast = index == segments.count - 1
            if lowered == "." || lowered == "%2e" {
                if isLast { output.append("") }
            } else if ["..", ".%2e", "%2e.", "%2e%2e"].contains(lowered) {
                if !output.isEmpty { output.removeLast() }
                if isLast { output.append("") }
            } else {
                output.append(whatwgEncode(segment, extra: pathEncodeSet))
            }
        }
        return "/" + output.joined(separator: "/")
    }

    /// A query as the WHATWG parser leaves it for an `https` URL.
    static func whatwgQuery(_ query: String) -> String {
        whatwgEncode(query[...], extra: queryEncodeSet)
    }

    /// `v1.<timestamp>.<nonce>.<assertion>`, the value of `X-AppAttest-Proof`.
    static func proofHeader(timestamp: Int, nonce: String, assertion: Data) -> String {
        "v1.\(timestamp).\(nonce).\(assertion.base64URLEncodedString())"
    }

    /// Sixteen random bytes, base64url without padding.
    static func randomNonce() -> String {
        var generator = SystemRandomNumberGenerator()
        let bytes = (0..<16).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
        return Data(bytes).base64URLEncodedString()
    }

    /// Mints a token; `refreshGatewayAccessToken` decides whether it is cached.
    private func exchangeToken(forceIssuerRefresh: Bool, retryIssuerOnce: Bool) async throws -> AccessToken {
        // The gateway counts the token's lifetime from when it mints it, so it
        // is measured here from before the request: a slow exchange then never
        // lets the token be sent past the gateway's own expiry.
        let started = Date()
        do {
            let response: TokenResponse
            var keyID: String?
            switch authMode {
            case .apiKey(let key, .some(let issuerTokenProvider)):
                let issuerToken = try await issuerTokenProvider(forceIssuerRefresh)
                response = try await postJSON(
                    path: "auth/token",
                    body: Self.apiKeyTokenBody(issuerToken: issuerToken, apiKey: key)
                )
            case .apiKey(let key, nil):
                // Never reached: `gatewayAccessToken` returns the key itself.
                return AccessToken(
                    value: key,
                    refreshAt: .distantFuture,
                    usableUntil: .distantFuture,
                    retryInterval: 0,
                    keyID: nil,
                    signsEveryRequest: false
                )
            case .appAttest, .appAttestInstall:
                (response, keyID) = try await productionExchange(forceIssuerRefresh: forceIssuerRefresh)
            }
            let leeway = Self.refreshLeeway(for: response.expires_in)
            let token = AccessToken(
                value: response.access_token,
                refreshAt: started.addingTimeInterval(Self.refreshDelay(for: response.expires_in)),
                usableUntil: started.addingTimeInterval(response.expires_in - Self.usableMargin(forLeeway: leeway)),
                retryInterval: Self.refreshRetryInterval(forLeeway: leeway),
                keyID: keyID,
                signsEveryRequest: keyID != nil && response.verify_on == Self.verifyOnEveryRequest
            )
            return token
        } catch let error as GatewayError
            where error.code == .issuerClaimsMissing && retryIssuerOnce {
            // The token verified; an entitlement claim has not landed on it yet.
            // This is the case `issuerRejectionRecovery` exists for — it is where
            // an app re-syncs a purchase — and a refreshed token is what carries
            // the claim once the sync completes.
            try await issuerRejectionRecovery?()
            return try await exchangeToken(forceIssuerRefresh: true, retryIssuerOnce: false)
        } catch let error as GatewayError
            where error.code == .issuerTokenRejected && retryIssuerOnce {
            // A token that did not verify at all. Worth one forced refresh, in
            // case the cached one had simply expired — but deliberately *not*
            // worth running the app's purchase-sync machinery, which has nothing
            // to do with an invalid credential and can cost the user a
            // store round trip for a stale token.
            return try await exchangeToken(forceIssuerRefresh: true, retryIssuerOnce: false)
        }
        // `.issuerVerificationUnavailable` is caught by neither: the gateway
        // never reached a verdict, so there is nothing to recover from and
        // nothing a fresh token would change. It surfaces to the caller as a
        // retryable error — see `GatewayError.isRetryable`.
    }

    /// The token, and the key it is bound to: the gateway mints it for the
    /// install whose key signed the exchange, and where it verifies every
    /// request, refuses each one that another key signed.
    ///
    /// The app's App Store transaction is fetched once, up front, and every
    /// assertion this exchange signs — a replacement key's included — is bound
    /// to that same value, so the body never names a transaction other than
    /// the one signed over. Each assertion carries it only where its own
    /// challenge says the gateway reads one: an older gateway would check a
    /// four-key client data against the three keys it knows and refuse the
    /// exchange. Fetching it before any challenge keeps a slow StoreKit from
    /// eating into a challenge's lifetime.
    private func productionExchange(forceIssuerRefresh: Bool) async throws -> (TokenResponse, String) {
        guard attestProvider.isSupported else {
            throw GatewayError(code: .attestFailed, message: "App Attest is unavailable on this device", statusCode: 0)
        }
        let appTransaction = await appTransactionProvider.jwsRepresentation()
        // The user comes first: on an app with signed-in users, each user on
        // this install has a key of their own, and the gateway refuses a token
        // for one user signed by another's key.
        let issuerToken = try await reportedIssuerToken(forceRefresh: forceIssuerRefresh)
        // Ended while the token was fetched: it may be the next user's.
        try ensureLive()
        let slot = keySlot(issuerToken: issuerToken)
        var keyID = try storedKeyID(slot: slot)
        if keyID == nil {
            keyID = try await registerKey(issuerToken: issuerToken)
        }
        guard let keyID else {
            throw GatewayError(code: .attestFailed, message: "App Attest key registration failed", statusCode: 0)
        }
        let signed = try await signedAssertion(for: keyID, appTransaction: appTransaction, issuerToken: issuerToken)
        do {
            let response: TokenResponse = try await postJSON(path: "auth/token", body: tokenBody(issuerToken, signed))
            try keep(signed.keyID, slot: slot)
            noteAcceptedExchange(response)
            return (response, signed.keyID)
        } catch let error as GatewayError where error.code == .attestFailed {
            // First once more with the same key and a fresh challenge: a
            // refusal can pass, and a new key costs an attestation with Apple
            // and starts a new request count for the install.
            let again = try await sign(with: signed.keyID, appTransaction: appTransaction)
            do {
                let response: TokenResponse = try await postJSON(path: "auth/token", body: tokenBody(issuerToken, again))
                try keep(again.keyID, slot: slot)
                noteAcceptedExchange(response)
                return (response, again.keyID)
            } catch let error as GatewayError where error.code == .attestFailed {
                // The gateway does not accept this key: it does not know it,
                // or it belongs to another user. A new one is registered.
                let replacement: String
                do {
                    replacement = try await replaceKey(refused: again.keyID, issuerToken: issuerToken)
                } catch is ReplacementHeld {
                    throw error
                }
                let retry = try await sign(with: replacement, appTransaction: appTransaction)
                do {
                    let response: TokenResponse = try await postJSON(path: "auth/token", body: tokenBody(issuerToken, retry))
                    try keep(retry.keyID, slot: slot)
                    noteAcceptedExchange(response)
                    return (response, retry.keyID)
                } catch {
                    reportFailure(challenge: retry.challenge, step: .token, error: error)
                    throw error
                }
            } catch {
                reportFailure(challenge: again.challenge, step: .token, error: error)
                throw error
            }
        } catch {
            reportFailure(challenge: signed.challenge, step: .token, error: error)
            throw error
        }
    }

    /// Where the install's key is kept: one place per app, and on an app with
    /// signed-in users one place per user. The user is the `signedInUserID`
    /// the app gave, or else a hash of the sign-in token's `iss` and `sub`. A
    /// token that is not a JWT naming both, such as one of an app's own
    /// format, uses the app's one place.
    func keySlot(issuerToken: String?) -> String {
        guard issuerToken != nil else { return appID }
        if let signedInUserID, !signedInUserID.isEmpty {
            return "\(appID)#id-\(Data(signedInUserID.utf8).sha256.base64URLEncodedString())"
        }
        guard let issuerToken, let user = Self.issuerUser(issuerToken) else { return appID }
        return "\(appID)#\(user)"
    }

    /// A short, stable name for the user an issuer token is about: the
    /// unpadded base64url SHA-256 of `iss` and `sub`, read from the JWT's
    /// payload without checking its signature. Only this device's key store
    /// uses it; the gateway checks the token itself.
    static func issuerUser(_ token: String) -> String? {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3,
              let payload = try? base64URLData(String(parts[1])),
              let claims = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
              let issuer = claims["iss"] as? String, !issuer.isEmpty,
              let subject = claims["sub"] as? String, !subject.isEmpty
        else { return nil }
        return Data("\(issuer)\n\(subject)".utf8).sha256.base64URLEncodedString()
    }

    /// The key kept for `slot`.
    ///
    /// A user's own place empty, a key an earlier release kept in the app's one
    /// place, before keys were kept per user, is moved to this user: taken
    /// out of the app's place first, then kept as theirs. So it is offered to
    /// one user only. If it cannot be taken out, it is not used, and this user
    /// gets a key of their own.
    private func storedKeyID(slot: String) throws -> String? {
        if let keyID = try credentialStore.appAttestKeyID(for: slot) { return keyID }
        guard slot != appID, let earlier = try credentialStore.appAttestKeyID(for: appID) else { return nil }
        do {
            try credentialStore.setAppAttestKeyID(nil, for: appID)
        } catch {
            return nil
        }
        try? credentialStore.setAppAttestKeyID(earlier, for: slot)
        return earlier
    }

    /// Keeps a key the gateway accepted in its user's place.
    private func keep(_ keyID: String, slot: String) throws {
        try ensureLive()
        guard slot != appID, try credentialStore.appAttestKeyID(for: slot) != keyID else { return }
        try credentialStore.setAppAttestKeyID(keyID, for: slot)
    }

    /// A replacement for `refused`, a key the gateway or the device refused.
    ///
    /// One per refused key: every request refused with it waits for the same
    /// registration, and one that comes in after it finished reuses its
    /// result. Each registration costs an attestation with Apple and starts a
    /// new request count for the install, so parallel refusals must never
    /// make one each. A timed refusal of the sign-in routes is waited out
    /// before a key is generated.
    ///
    /// `issuerToken` is the sign-in token the caller already holds. Without
    /// one, it is fetched only once a new registration really starts.
    private func replaceKey(refused: String, issuerToken known: String?? = .none) async throws -> String {
        if let done = finishedReplacement, done.refused == refused { return done.replacement }
        if let running = keyReplacement, running.refused == refused { return try await liveResult(of: running.task) }
        if finishedReplacement?.replacement == refused, !replacementProven { replacementHeld = true }
        if replacementHeld { throw ReplacementHeld() }
        try ensureLive()
        try heldRateLimit()
        replacementProven = false
        let task = Task {
            let issuerToken: String?
            if let known { issuerToken = known } else { issuerToken = try await self.reportedIssuerToken(forceRefresh: false) }
            return try await self.registerKey(issuerToken: issuerToken)
        }
        keyReplacement = (refused, task)
        defer { if keyReplacement?.refused == refused { keyReplacement = nil } }
        let replacement = try await liveResult(of: task)
        finishedReplacement = (refused, replacement)
        return replacement
    }

    private struct SignedAssertion {
        let keyID: String
        let challenge: String
        let assertion: Data
        /// The App Store transaction the assertion is bound to, sent beside it.
        let appTransaction: String?
    }

    /// Signs a challenge, replacing the key first if this device can no longer
    /// sign with the one on file.
    ///
    /// The stored key id outlives the key itself. Deleting the app destroys its
    /// App Attest key in the Secure Enclave, but the keychain entry naming that
    /// key survives deletion — so the next install reads back an id it cannot
    /// sign with, and `generateAssertion` fails locally with
    /// `DCError.invalidInput` before any request leaves the device. Restoring to
    /// a new device leaves the same wreckage.
    ///
    /// Recovering from the gateway rejecting a key was never enough, because
    /// this failure happens a step earlier and never reaches the gateway at all.
    /// Treating the two the same way is what makes a reinstall something the app
    /// heals from on its next request rather than something that ends it.
    ///
    /// Only the signing call is guarded. Fetching a challenge is a network
    /// request, and a flight-mode failure there must not be mistaken for a dead
    /// key and cost the user a perfectly good one.
    private func signedAssertion(
        for keyID: String,
        appTransaction: String?,
        issuerToken: String?
    ) async throws -> SignedAssertion {
        let issued = try await challengeResponse()
        let bound = Self.boundAppTransaction(appTransaction, to: issued)
        let clientData = Self.assertionClientData(
            app: appID,
            challenge: issued.challenge,
            keyID: keyID,
            appTransaction: bound
        )
        do {
            let assertion = try await attestProvider.generateAssertion(keyID, clientDataHash: clientData.sha256)
            return SignedAssertion(
                keyID: keyID,
                challenge: issued.challenge,
                assertion: assertion,
                appTransaction: bound
            )
        } catch {
            // Reported once the replacement settles, so the gateway hears
            // whether the device got past it: the replacement's own failure,
            // if it has one, is reported or recorded under its own challenge.
            do {
                let replacement = try await replaceKey(refused: keyID, issuerToken: issuerToken)
                let signed = try await sign(with: replacement, appTransaction: appTransaction)
                reportFailure(challenge: issued.challenge, step: .generateAssertion, error: error, recovered: true)
                return signed
            } catch let replacementError {
                reportFailure(challenge: issued.challenge, step: .generateAssertion, error: error)
                throw replacementError is ReplacementHeld ? error : replacementError
            }
        }
    }

    private func sign(with keyID: String, appTransaction: String?) async throws -> SignedAssertion {
        let issued = try await challengeResponse()
        let bound = Self.boundAppTransaction(appTransaction, to: issued)
        let clientData = Self.assertionClientData(
            app: appID,
            challenge: issued.challenge,
            keyID: keyID,
            appTransaction: bound
        )
        let assertion: Data
        do {
            assertion = try await attestProvider.generateAssertion(keyID, clientDataHash: clientData.sha256)
        } catch {
            reportFailure(challenge: issued.challenge, step: .generateAssertion, error: error)
            throw error
        }
        return SignedAssertion(
            keyID: keyID,
            challenge: issued.challenge,
            assertion: assertion,
            appTransaction: bound
        )
    }

    /// The transaction an assertion over `issued` may carry: none unless the
    /// gateway that issued the challenge said it reads one. Decided per
    /// challenge, since each is the gateway's answer at the moment it signs.
    private static func boundAppTransaction(_ appTransaction: String?, to issued: ChallengeResponse) -> String? {
        issued.accepts_app_transaction == true ? appTransaction : nil
    }

    /// Omits `issuer_token` entirely in install mode. The gateway refuses one
    /// there rather than ignoring it, because a client presenting a token
    /// believes it is authenticating a person.
    ///
    /// `app_transaction` is sent only beside an assertion bound to it: the
    /// gateway checks the one against the other, so a transaction lifted from
    /// another device cannot be swapped in to borrow its Apple Account.
    private func tokenBody(_ issuerToken: String?, _ signed: SignedAssertion) -> [String: String] {
        var body = [
            "key_id": signed.keyID,
            "assertion": signed.assertion.base64EncodedString(),
            "challenge": signed.challenge,
        ]
        if let issuerToken { body["issuer_token"] = issuerToken }
        if let appTransaction = signed.appTransaction { body["app_transaction"] = appTransaction }
        // Split keys: the gateway opens the account's provider keys for this
        // install only with the app's share. A gateway or an account without
        // split keys ignores it.
        if let keyShare { body["key_share"] = keyShare }
        return body
    }

    /// Generates a key, has Apple attest it, registers it with the gateway
    /// for the user `issuerToken` names, if any, and keeps it in that user's
    /// place once the gateway has accepted it.
    ///
    /// The old id is deliberately *not* cleared first. Clearing up front is only
    /// free when the registration that follows succeeds; when it fails — and a
    /// rate-limited one above all — it leaves nothing stored at all, and every
    /// later call then starts from no key and attests a brand-new one with
    /// Apple. Keeping the old id until a new one replaces it costs at most one
    /// refused attempt on the next call, and saves the one case where the id was
    /// never the problem: `generateAssertion` can fail for a reason that has
    /// nothing to do with the key, and a device that threw its working key away
    /// for one of those can never get it back.
    private func registerKey(issuerToken given: String?) async throws -> String {
        var issuerToken = given
        let keyID = try await attestProvider.generateKey()
        let challenge = try await challenge()
        // Every step from here until the gateway answers can fail on the
        // device, and the gateway would otherwise only learn that the
        // challenge went unused.
        var step = ChallengeStep.attestKey
        do {
            let challengeData = try Self.base64URLData(challenge)
            let attestation = try await attestProvider.attestKey(keyID, clientDataHash: challengeData.sha256)
            struct RegisterResponse: Decodable { let user_id: String }
            var body = [
                "key_id": keyID,
                "attestation": attestation.base64EncodedString(),
                "challenge": challenge,
            ]
            if let issuerToken { body["issuer_token"] = issuerToken }
            step = .register
            do {
                let _: RegisterResponse = try await postJSON(path: "auth/register", body: body)
            } catch let error as GatewayError
                where issuerToken != nil && (error.code == .issuerTokenRejected || error.code == .issuerClaimsMissing) {
                // The gateway checks the sign-in token before it spends the
                // challenge, so the same attestation is sent again with a fresh
                // token: no second attestation with Apple. Recovered as the
                // exchange recovers: a missing claim runs the app's recovery
                // first, as a purchase sync may be what adds it.
                if error.code == .issuerClaimsMissing { try await issuerRejectionRecovery?() }
                step = .issuerToken
                issuerToken = try await optionalIssuerToken(forceRefresh: true)
                if let issuerToken { body["issuer_token"] = issuerToken }
                step = .register
                let _: RegisterResponse = try await postJSON(path: "auth/register", body: body)
            }
        } catch {
            reportFailure(challenge: challenge, step: step, error: error)
            throw error
        }
        // Ended while this key was registered: the token it was registered
        // with may be the next user's, so it is kept for no one.
        try ensureLive()
        try credentialStore.setAppAttestKeyID(keyID, for: keySlot(issuerToken: issuerToken))
        return keyID
    }

    /// A step after a challenge was issued, as `/auth/failure` names it.
    enum ChallengeStep: String {
        case attestKey = "attest_key"
        case generateAssertion = "generate_assertion"
        case issuerToken = "issuer_token"
        case register
        case token
    }

    /// Tells the gateway why a challenge it issued will not be spent, so the
    /// app's auth events can say what failed on the device rather than only
    /// that nothing came back.
    ///
    /// Sent in the background and never waited for: the caller gets its error
    /// at once, and a report that cannot be sent is simply lost. Nothing is
    /// sent for an error the gateway answered with, which the gateway has
    /// recorded already, nor for a cancelled call, which is not a failure.
    /// Only the error's domain and code are sent, never its text.
    private func reportFailure(challenge: String, step: ChallengeStep, error: Error, recovered: Bool = false) {
        guard Self.isReportable(error) else { return }
        let report = Self.failureReport(challenge: challenge, step: step, error: error, recovered: recovered)
        guard let body = try? JSONSerialization.data(withJSONObject: report) else { return }
        var request = URLRequest(url: appURL("auth/failure"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        Self.identifyClient(&request)
        request.httpBody = body
        let session = self.session
        let id = UUID()
        failureReports[id] = Task { [weak self] in
            _ = try? await session.data(for: request)
            await self?.reportSent(id)
        }
    }

    /// Reports a failure that happened before any challenge was fetched,
    /// under a challenge fetched for the report alone. In the background,
    /// like every report.
    private func reportFailureUnderNewChallenge(step: ChallengeStep, error: Error) {
        guard Self.isReportable(error) else { return }
        let id = UUID()
        failureReports[id] = Task { [weak self] in
            guard let self else { return }
            if let issued = try? await self.challengeResponse() {
                await self.reportFailure(challenge: issued.challenge, step: step, error: error)
            }
            await self.reportSent(id)
        }
    }

    private func reportSent(_ id: UUID) {
        failureReports[id] = nil
    }

    /// Waits for every failure report already started. For tests. Each report
    /// removes itself as its last step, so the loop ends once all are sent.
    func settleFailureReports() async {
        while let report = failureReports.values.first {
            await report.value
        }
    }

    static func isReportable(_ error: Error) -> Bool {
        // An ended client reports nothing: its sign-in stopped on purpose.
        if error is GatewayError || error is CancellationError || error is GatewayClientInvalidated { return false }
        if let urlError = error as? URLError, urlError.code == .cancelled { return false }
        return true
    }

    /// The `/auth/failure` body: the step, and the error's domain and code,
    /// with the error it wraps where there is one.
    static func failureReport(
        challenge: String,
        step: ChallengeStep,
        error: Error,
        recovered: Bool = false
    ) -> [String: Any] {
        let failure = error as NSError
        var report: [String: Any] = [
            "challenge": challenge,
            "step": step.rawValue,
            "error": ["domain": failure.domain, "code": failure.code],
        ]
        if let underlying = failure.userInfo[NSUnderlyingErrorKey] as? NSError {
            report["underlying_error"] = ["domain": underlying.domain, "code": underlying.code]
        }
        if recovered { report["recovered"] = true }
        return report
    }

    private func challenge() async throws -> String {
        try await challengeResponse().challenge
    }

    private func challengeResponse() async throws -> ChallengeResponse {
        try await postJSON(path: "auth/challenge", body: [:])
    }

    /// The issuer token this mode presents, or `nil` where the mode has no user
    /// to prove — which is a valid state, unlike the API-key case below where a
    /// caller asked for an exchange without supplying a provider.
    /// The sign-in token, with a failure to fetch it reported as 1.x reported
    /// it, under a challenge: here one fetched for the report alone, since
    /// the token is now fetched before any challenge, so that none is left
    /// unused on the way to a successful exchange.
    private func reportedIssuerToken(forceRefresh: Bool) async throws -> String? {
        do {
            return try await optionalIssuerToken(forceRefresh: forceRefresh)
        } catch {
            reportFailureUnderNewChallenge(step: .issuerToken, error: error)
            throw error
        }
    }

    private func optionalIssuerToken(forceRefresh: Bool) async throws -> String? {
        if case .appAttestInstall = authMode { return nil }
        return try await issuerToken(forceRefresh: forceRefresh)
    }

    private func issuerToken(forceRefresh: Bool) async throws -> String {
        switch authMode {
        case .appAttest(let issuerTokenProvider):
            return try await issuerTokenProvider(forceRefresh)
        case .appAttestInstall:
            throw GatewayError(
                code: .unknown,
                message: "App-install mode identifies the user by its attested key and has no issuer token",
                statusCode: 0
            )
        case .apiKey(_, .some(let issuerTokenProvider)):
            return try await issuerTokenProvider(forceRefresh)
        case .apiKey(_, nil):
            throw GatewayError(
                code: .unknown,
                message: "This API-key mode has no issuer token provider",
                statusCode: 0
            )
        }
    }

    private func postJSON<Response: Decodable>(path: String, body: [String: String]) async throws -> Response {
        var request = URLRequest(url: appURL(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        Self.identifyClient(&request)
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data)
            let rawCode = envelope?.error.code ?? "unknown"
            let error = GatewayError(
                code: GatewayErrorCode(rawValue: rawCode) ?? .unknown,
                message: envelope?.error.message ?? "Gateway request failed",
                statusCode: http.statusCode,
                data: envelope?.error.data ?? [:],
                retryAfter: GatewayError.retryAfter(from: http)
            )
            // Every request this method sends is one of the three
            // authentication routes the gateway counts, so this is the one
            // place a timed refusal can be caught for all of them. Any `429`
            // that names a wait is honoured, whatever its code: the gateway has
            // said when to come back, and a client that calls sooner is only
            // spending the window it was asked to wait out.
            if http.statusCode == 429, let seconds = error.retryAfter, seconds > 0 {
                rateLimitHold = RateLimitHold(
                    until: Date().addingTimeInterval(seconds),
                    error: error
                )
            }
            throw error
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }

    private func scheduleRefresh(at date: Date) {
        refreshTask?.cancel()
        let delay = max(1, date.timeIntervalSinceNow)
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.attemptRefresh()
        }
    }

    /// How long before expiry a token is replaced: a quarter of its lifetime,
    /// at least 15 seconds and at most 15 minutes. For the gateway's one-hour
    /// token that is fifteen minutes, which a regional outage of the gateway's
    /// storage rarely outlasts.
    static func refreshLeeway(for lifetime: TimeInterval) -> TimeInterval {
        min(900, max(15, lifetime * 0.25))
    }

    static func refreshDelay(for lifetime: TimeInterval) -> TimeInterval {
        max(1, lifetime - refreshLeeway(for: lifetime))
    }

    /// How long a failed refresh waits before the next try: a minute for a
    /// one-hour token, proportionally less for a shorter one.
    static func refreshRetryInterval(forLeeway leeway: TimeInterval) -> TimeInterval {
        min(60, max(1, leeway / 15))
    }

    /// How close to expiry a token is still sent: thirty seconds for a
    /// one-hour token, proportionally less for a shorter one.
    static func usableMargin(forLeeway leeway: TimeInterval) -> TimeInterval {
        min(30, leeway / 30)
    }

    /// What the token exchange's assertion is signed over: JSON written by
    /// hand, because the gateway rebuilds it byte for byte and Foundation
    /// promises neither key order nor how `/` is escaped. No value needs
    /// escaping: an app id is a slug, a challenge base64url, a key id
    /// standard base64.
    ///
    /// With an App Store transaction, a fourth key closes it: the
    /// transaction's SHA-256, base64url without padding. Without one it is the
    /// three-key form, byte for byte, that it has always been.
    static func assertionClientData(
        app: String,
        challenge: String,
        keyID: String,
        appTransaction: String? = nil
    ) -> Data {
        var json = "{\"app\":\"\(app)\",\"challenge\":\"\(challenge)\",\"key_id\":\"\(keyID)\""
        if let appTransaction {
            json += ",\"app_transaction\":\"\(appTransactionHash(appTransaction))\""
        }
        return Data((json + "}").utf8)
    }

    /// SHA-256 of the transaction's UTF-8 bytes, base64url without padding:
    /// what the exchange's client data binds the transaction by.
    static func appTransactionHash(_ appTransaction: String) -> String {
        Data(appTransaction.utf8).sha256.base64URLEncodedString()
    }

    static func apiKeyTokenBody(issuerToken: String, apiKey: String) -> [String: String] {
        ["issuer_token": issuerToken, "api_key": apiKey]
    }

    static func base64URLData(_ value: String) throws -> Data {
        var normalized = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        normalized += String(repeating: "=", count: (4 - normalized.count % 4) % 4)
        guard let data = Data(base64Encoded: normalized) else { throw URLError(.cannotDecodeRawData) }
        return data
    }

    private static var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
    }

    /// The headers every request this client sends or builds names itself
    /// with: the app's version and this package's. Neither is signed: a
    /// request proof covers the method, URL, body and token, never a header.
    private static func identifyClient(_ request: inout URLRequest) {
        request.setValue(appVersion, forHTTPHeaderField: "X-App-Version")
        request.setValue(ClientSDK.headerValue, forHTTPHeaderField: ClientSDK.headerField)
    }
}

/// Thrown by every call on a client ended with
/// ``AppAIGatewayClient/invalidate()``. Make a new client for the user who is
/// signed in now.
public struct GatewayClientInvalidated: Error, Sendable, LocalizedError {
    public init() {}
    public var errorDescription: String? {
        "This gateway client was ended with invalidate(); make a new one for the signed-in user"
    }
}

/// Turns off following redirects for the `URLSession` tasks it is given to:
///
/// ```swift
/// { try await URLSession.shared.data(for: $0, delegate: GatewayRedirectBlocker()) }
/// ```
///
/// A redirect a signed gateway request answers with, such as a job status
/// link's redirect to the result, then comes back to the client, which
/// follows it with a request signed for the new URL.
public final class GatewayRedirectBlocker: NSObject, URLSessionTaskDelegate, Sendable {
    public override init() {}

    public func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        nil
    }
}
