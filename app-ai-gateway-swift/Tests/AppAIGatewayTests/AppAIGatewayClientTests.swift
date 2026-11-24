import Foundation
import Testing
@testable import AppAIGateway

final class MockURLProtocol: URLProtocol, @unchecked Sendable {
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

struct MockAttestProvider: AppAttestProviding {
    /// Key ids this device can no longer sign with — what a reinstall leaves
    /// behind, the Secure Enclave key having gone with the old install while
    /// the keychain entry naming it stayed.
    var deadKeyIDs: Set<String> = []
    /// Counts the attestations Apple would have been asked for. A reference so
    /// the provider can stay the value type the client takes.
    var attestations: LockedCounter?
    /// Keys that stop signing part way through a test, for a reinstall that
    /// happens after a token was already minted.
    var dying: DyingKeys?
    /// Every assertion signed, with the key and the client data hash it was over.
    var signatures: SignatureLog?
    /// What Apple's attestation answers with instead of an attestation, such
    /// as a device App Review tests on failing to reach Apple.
    var attestFailure: NSError?
    /// When set, each new key gets a name of its own: `generated-key-1`, …
    var numberedKeys: LockedCounter?

    var isSupported: Bool { true }
    func generateKey() async throws -> String {
        guard let numberedKeys else { return "generated-key" }
        return "generated-key-\(numberedKeys.increment())"
    }
    func attestKey(_ keyID: String, clientDataHash: Data) async throws -> Data {
        attestations?.increment()
        if let attestFailure { throw attestFailure }
        return Data("attestation".utf8)
    }
    func generateAssertion(_ keyID: String, clientDataHash: Data) async throws -> Data {
        // `DCError.invalidInput` is what iOS actually raises here.
        if deadKeyIDs.contains(keyID) || dying?.isDead(keyID) == true {
            throw URLError(.userAuthenticationRequired)
        }
        signatures?.record(keyID: keyID, hash: clientDataHash)
        return Data("assertion".utf8)
    }
}

final class DyingKeys: @unchecked Sendable {
    private let lock = NSLock()
    private var dead: Set<String> = []
    func kill(_ keyID: String) { lock.withLock { _ = dead.insert(keyID) } }
    func isDead(_ keyID: String) -> Bool { lock.withLock { dead.contains(keyID) } }
}

final class SignatureLog: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [(keyID: String, hash: Data)] = []
    func record(keyID: String, hash: Data) { lock.withLock { entries.append((keyID, hash)) } }
    func snapshot() -> [(keyID: String, hash: Data)] { lock.withLock { entries } }
}

/// Keys by the place the client names. `keyID` seeds the app's one place,
/// whatever the app's id: a key an earlier release kept.
final class MemoryCredentialStore: GatewayCredentialStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var seed: String?
    private var keys: [String: String] = [:]

    init(keyID: String? = nil) { self.seed = keyID }

    func appAttestKeyID(for place: String) throws -> String? {
        lock.withLock { keys[place] ?? (place.contains("#") ? nil : seed) }
    }

    func setAppAttestKeyID(_ keyID: String?, for place: String) throws {
        lock.withLock {
            if !place.contains("#") { seed = nil }
            keys[place] = keyID
        }
    }

    /// Every place that holds a key.
    func places() -> [String: String] {
        lock.withLock {
            var all = keys
            if let seed, !all.keys.contains(where: { !$0.contains("#") }) { all["*"] = seed }
            return all
        }
    }
}

final class LockedValue<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value
    init(_ value: Value) { self.value = value }
    func get() -> Value { lock.withLock { value } }
    func set(_ newValue: Value) { lock.withLock { value = newValue } }
}

final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    @discardableResult
    func increment() -> Int {
        lock.withLock {
            value += 1
            return value
        }
    }

    func snapshot() -> Int { lock.withLock { value } }
}

actor RefreshRecorder {
    private var values: [Bool] = []
    func record(_ value: Bool) { values.append(value) }
    func snapshot() -> [Bool] { values }
}

actor RecoveryRecorder {
    private var count = 0
    func record() { count += 1 }
    func snapshot() -> Int { count }
}

/// Hands out `jws-1`, `jws-2`, … one per call, so a test can tell whether an
/// exchange fetched the transaction once or again part way through.
struct FakeAppTransactionProvider: AppTransactionProviding {
    var returnsNil = false
    var calls = LockedCounter()

    func jwsRepresentation() async -> String? {
        let call = calls.increment()
        return returnsNil ? nil : "jws-\(call)"
    }
}

/// Every `auth/token` body sent, decoded.
final class TokenBodyLog: @unchecked Sendable {
    private let lock = NSLock()
    private var bodies: [[String: String]] = []
    func record(_ request: URLRequest) {
        let object = (try? JSONSerialization.jsonObject(with: requestBody(request))) as? [String: String]
        lock.withLock { bodies.append(object ?? [:]) }
    }
    func snapshot() -> [[String: String]] { lock.withLock { bodies } }
}

/// Every `auth/failure` report sent, decoded.
final class FailureReportLog: @unchecked Sendable {
    private let lock = NSLock()
    private var reports: [Data] = []
    func record(_ request: URLRequest) { lock.withLock { reports.append(requestBody(request)) } }
    func snapshot() -> [[String: Any]] {
        lock.withLock { reports }.map { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] ?? [:] }
    }
}

/// The body a `URLProtocol` sees: `URLSession` moves `httpBody` into a stream
/// before the request reaches it.
private func requestBody(_ request: URLRequest) -> Data {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return Data() }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
        let read = stream.read(&buffer, maxLength: buffer.count)
        guard read > 0 else { break }
        data.append(buffer, count: read)
    }
    return data
}

private func session() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [MockURLProtocol.self]
    return URLSession(configuration: configuration)
}

private func response(_ request: URLRequest, status: Int, body: String) -> (HTTPURLResponse, Data) {
    (
        HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!,
        Data(body.utf8)
    )
}

@Suite(.serialized)
struct AppAIGatewayClientTests {
    @Test
    func issuerBackedAPIKeyExchangeCachesTokenAndBuildsProxyRequest() async throws {
        let tokenCalls = LockedCounter()
        MockURLProtocol.handler = { request in
            tokenCalls.increment()
            return response(request, status: 200, body: #"{"access_token":"gateway-token","expires_in":3600}"#)
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .apiKey(
                key: "agw_test-key",
                issuerTokenProvider: { _ in "firebase-token" }
            ),
            session: session()
        )
        #expect(try await client.gatewayAccessToken() == "gateway-token")
        #expect(try await client.gatewayAccessToken() == "gateway-token")
        #expect(tokenCalls.snapshot() == 1)
        let request = try await client.authorizedRequest(provider: "openai", providerPath: "v1/responses")
        #expect(request.url?.absoluteString == "https://gateway.test/v2/apps/test-app/proxy/openai/v1/responses")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer gateway-token")
        #expect(request.value(forHTTPHeaderField: "X-App-Version") != nil)
        #expect(
            AppAIGatewayClient.apiKeyTokenBody(
                issuerToken: "firebase-token",
                apiKey: "agw_test-key"
            ) == ["issuer_token": "firebase-token", "api_key": "agw_test-key"]
        )
    }

    /// A preset sets the connection and model on the app, so the URL carries
    /// only its name and the request is otherwise identical to a proxy call.
    @Test
    func presetRequestsUseThePresetURL() async throws {
        MockURLProtocol.handler = { request in
            response(request, status: 200, body: #"{"access_token":"gateway-token","expires_in":3600}"#)
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .apiKey(
                key: "agw_test-key",
                issuerTokenProvider: { _ in "firebase-token" }
            ),
            session: session()
        )
        #expect(
            await client.presetURL(name: "chat").absoluteString
                == "https://gateway.test/v2/apps/test-app/presets/chat"
        )
        let request = try await client.authorizedRequest(preset: "transcribe")
        #expect(request.url?.absoluteString == "https://gateway.test/v2/apps/test-app/presets/transcribe")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer gateway-token")
        #expect(request.value(forHTTPHeaderField: "X-App-Version") != nil)
    }

    /// A base URL with a path prefix keeps it, for presets and the proxy alike.
    @Test
    func presetAndProxyURLsSharePrefixHandling() async {
        let client = AppAIGatewayClient(
            appID: "calorie-tracker",
            baseURL: URL(string: "https://gateway.test/base")!,
            authMode: .apiKey(
                key: "agw_test-key",
                issuerTokenProvider: { _ in "firebase-token" }
            ),
            session: session()
        )
        #expect(
            await client.presetURL(name: "chat").absoluteString
                == "https://gateway.test/base/v2/apps/calorie-tracker/presets/chat"
        )
        #expect(
            await client.proxyURL(provider: "openai", providerPath: "v1/responses").absoluteString
                == "https://gateway.test/base/v2/apps/calorie-tracker/proxy/openai/v1/responses"
        )
        #expect(
            await client.proxyURL(provider: .openai, providerPath: "v1/responses").absoluteString
                == "https://gateway.test/base/v2/apps/calorie-tracker/proxy/openai/v1/responses"
        )
        // A second instance of a provider type is addressed by its own slug.
        #expect(
            await client.proxyURL(provider: .custom("openai-dev"), providerPath: "v1/responses")
                .absoluteString
                == "https://gateway.test/base/v2/apps/calorie-tracker/proxy/openai-dev/v1/responses"
        )
    }

    /// The codes v2 adds decode, and v1's removed ones read as `.unknown`.
    @Test
    func v2CodesDecodeFromTheGatewayEnvelope() {
        for (wire, code) in [
            ("preset_not_found", GatewayErrorCode.presetNotFound),
            ("job_not_found", .jobNotFound),
            ("pricing_not_configured", .pricingNotConfigured),
            ("max_output_tokens_exceeded", .maxOutputTokensExceeded),
            ("provider_not_configured", .providerNotConfigured),
            ("provider_disabled", .providerDisabled),
            ("provider_unavailable", .providerUnavailable),
            ("service_unavailable", .serviceUnavailable),
            ("not_found", .notFound),
        ] {
            #expect(GatewayErrorCode(rawValue: wire) == code)
        }
        for removed in ["endpoint_not_found", "unclaimed_access_expired", "account_expired", "billing_unavailable"] {
            #expect(GatewayErrorCode(rawValue: removed) == nil)
        }
    }

    /// A connection that is missing, turned off or unusable arrives as a
    /// `502`, but waiting does not fix it.
    @Test
    func aConnectionProblemIsNotRetryableThoughItIsA502() throws {
        for code in ["provider_not_configured", "provider_disabled", "provider_unavailable"] {
            let error = try #require(GatewayError(
                response: HTTPURLResponse(
                    url: URL(string: "https://gateway.example.test/v2/apps/a/proxy/openai/v1/responses")!,
                    statusCode: 502, httpVersion: nil, headerFields: ["X-AGW-Error": "marked"]
                )!,
                body: Data("{\"error\":{\"code\":\"\(code)\",\"message\":\"x\"}}".utf8)
            ))
            #expect(error.isRetryable == false, "\(code)")
        }
        let failed = try #require(GatewayError(
            response: HTTPURLResponse(
                url: URL(string: "https://gateway.example.test/v2/apps/a/proxy/openai/v1/responses")!,
                statusCode: 502, httpVersion: nil, headerFields: ["X-AGW-Error": "marked"]
            )!,
            body: Data(#"{"error":{"code":"provider_error","message":"x"}}"#.utf8)
        ))
        #expect(failed.isRetryable)
    }

    /// Every provider type v2 serves has a constant, spelled as its default slug.
    @Test
    func everyProviderTypeHasASlugConstant() {
        let slugs: [ProviderSlug] = [
            .openai, .anthropic, .gemini, .xai, .perplexity, .deepseek, .groq, .mistral, .together,
            .fireworks, .cerebras, .moonshot, .bytedance, .baseten, .huggingface, .openrouter, .vercel,
            .elevenlabs, .deepgram, .fal,
        ]
        #expect(Set(slugs.map(\.rawValue)) == [
            "openai", "anthropic", "gemini", "xai", "perplexity", "deepseek", "groq", "mistral", "together",
            "fireworks", "cerebras", "moonshot", "bytedance", "baseten", "huggingface", "openrouter", "vercel",
            "elevenlabs", "deepgram", "fal",
        ])
    }

    /// The entitlement-sync case: the claim is missing, so the app's recovery
    /// closure runs and a refreshed token is what finally carries the claim.
    @Test
    func claimsMissingRunsRecoveryThenRetriesWithAFreshIssuerToken() async throws {
        let tokenCalls = LockedCounter()
        let refreshRecorder = RefreshRecorder()
        let recoveryRecorder = RecoveryRecorder()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            if tokenCalls.increment() == 1 {
                return response(
                    request,
                    status: 403,
                    body: #"{"error":{"code":"issuer_claims_missing","message":"still syncing"}}"#
                )
            }
            return response(request, status: 200, body: #"{"access_token":"fresh-token","expires_in":3600}"#)
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttest(issuerTokenProvider: { forceRefresh in
                await refreshRecorder.record(forceRefresh)
                return forceRefresh ? "issuer-fresh" : "issuer-old"
            }),
            issuerRejectionRecovery: {
                await recoveryRecorder.record()
            },
            attestProvider: MockAttestProvider(),
            credentialStore: MemoryCredentialStore(keyID: "existing-key"),
            session: session()
        )
        #expect(try await client.gatewayAccessToken() == "fresh-token")
        #expect(tokenCalls.snapshot() == 2)
        #expect(await refreshRecorder.snapshot() == [false, true])
        #expect(await recoveryRecorder.snapshot() == 1)
    }

    @Test
    func claimsMissingOnAnIssuerBackedAPIKeyRecoversTheSameWay() async throws {
        let tokenCalls = LockedCounter()
        let refreshRecorder = RefreshRecorder()
        let recoveryRecorder = RecoveryRecorder()
        MockURLProtocol.handler = { request in
            if tokenCalls.increment() == 1 {
                return response(
                    request,
                    status: 403,
                    body: #"{"error":{"code":"issuer_claims_missing","message":"still syncing"}}"#
                )
            }
            return response(request, status: 200, body: #"{"access_token":"fresh-token","expires_in":3600}"#)
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .apiKey(
                key: "agw_test-key",
                issuerTokenProvider: { forceRefresh in
                    await refreshRecorder.record(forceRefresh)
                    return forceRefresh ? "issuer-fresh" : "issuer-old"
                }
            ),
            issuerRejectionRecovery: {
                await recoveryRecorder.record()
            },
            session: session()
        )
        #expect(try await client.gatewayAccessToken() == "fresh-token")
        #expect(tokenCalls.snapshot() == 2)
        #expect(await refreshRecorder.snapshot() == [false, true])
        #expect(await recoveryRecorder.snapshot() == 1)
    }

    /// A token that did not verify is refreshed once, but must not drag the
    /// app's purchase-sync machinery in: nothing about a bad credential is an
    /// entitlement problem.
    @Test
    func rejectedIssuerTokenRetriesOnceWithoutRunningRecovery() async throws {
        let tokenCalls = LockedCounter()
        let refreshRecorder = RefreshRecorder()
        let recoveryRecorder = RecoveryRecorder()
        MockURLProtocol.handler = { request in
            if tokenCalls.increment() == 1 {
                return response(
                    request,
                    status: 403,
                    body: #"{"error":{"code":"issuer_token_rejected","message":"refresh"}}"#
                )
            }
            return response(request, status: 200, body: #"{"access_token":"fresh-token","expires_in":3600}"#)
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .apiKey(
                key: "agw_test-key",
                issuerTokenProvider: { forceRefresh in
                    await refreshRecorder.record(forceRefresh)
                    return forceRefresh ? "issuer-fresh" : "issuer-old"
                }
            ),
            issuerRejectionRecovery: {
                await recoveryRecorder.record()
            },
            session: session()
        )
        #expect(try await client.gatewayAccessToken() == "fresh-token")
        #expect(tokenCalls.snapshot() == 2)
        #expect(await refreshRecorder.snapshot() == [false, true])
        #expect(await recoveryRecorder.snapshot() == 0)
    }

    /// The gateway could not verify anything, so there is nothing to recover
    /// from and nothing a fresh token would change: one call, one error, and the
    /// caller is told it is worth trying again later.
    @Test
    func verificationUnavailableNeitherRecoversNorRefreshes() async throws {
        let tokenCalls = LockedCounter()
        let refreshRecorder = RefreshRecorder()
        let recoveryRecorder = RecoveryRecorder()
        MockURLProtocol.handler = { request in
            tokenCalls.increment()
            return response(
                request,
                status: 503,
                body: #"{"error":{"code":"issuer_verification_unavailable","message":"Issuer keys are temporarily unavailable"}}"#
            )
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .apiKey(
                key: "agw_test-key",
                issuerTokenProvider: { forceRefresh in
                    await refreshRecorder.record(forceRefresh)
                    return forceRefresh ? "issuer-fresh" : "issuer-old"
                }
            ),
            issuerRejectionRecovery: {
                await recoveryRecorder.record()
            },
            session: session()
        )

        var surfaced: GatewayError?
        do {
            _ = try await client.gatewayAccessToken()
        } catch let error as GatewayError {
            surfaced = error
        }
        #expect(surfaced?.code == .issuerVerificationUnavailable)
        #expect(surfaced?.isRetryable == true)
        #expect(tokenCalls.snapshot() == 1)
        #expect(await refreshRecorder.snapshot() == [false])
        #expect(await recoveryRecorder.snapshot() == 0)
    }

    @Test
    func newIssuerCodesDecodeFromTheGatewayEnvelope() {
        #expect(GatewayErrorCode(rawValue: "issuer_claims_missing") == .issuerClaimsMissing)
        #expect(GatewayErrorCode(rawValue: "issuer_verification_unavailable") == .issuerVerificationUnavailable)
        // A rejected token is not something waiting fixes.
        #expect(
            GatewayError(code: .issuerTokenRejected, message: "", statusCode: 403).isRetryable == false
        )
    }

    /// An outage of the gateway's billing service must not read as an unpaid
    /// customer. Both refuse the request, but only one is the customer's to fix,
    /// and an app that confuses them shows a subscriber an upsell mid-outage.
    @Test
    func billingOutageIsRetryableWhileAnUnpaidSubscriptionIsNot() throws {
        let unpaid = try #require(GatewayError(
            response: HTTPURLResponse(
                url: URL(string: "https://gateway.example.test/v2/apps/a/proxy/openai/v1/responses")!,
                statusCode: 402,
                httpVersion: nil,
                headerFields: ["X-AGW-Error": "marked"]
            )!,
            body: Data(#"{"error":{"code":"billing_payment_required","message":"subscribe"}}"#.utf8)
        ))
        #expect(unpaid.code == .billingPaymentRequired)
        #expect(unpaid.isRetryable == false)

        let outage = try #require(GatewayError(
            response: HTTPURLResponse(
                url: URL(string: "https://gateway.example.test/v2/apps/a/proxy/openai/v1/responses")!,
                statusCode: 503,
                httpVersion: nil,
                headerFields: ["X-AGW-Error": "marked", "Retry-After": "5"]
            )!,
            body: Data(#"{"error":{"code":"service_unavailable","message":"unreachable"}}"#.utf8)
        ))
        #expect(outage.code == .serviceUnavailable)
        #expect(outage.isRetryable)
        #expect(outage.monthlyRequestQuota == nil)
    }

    @Test
    func anUnverifiedOwnerEmailRequiresOwnerAction() throws {
        for (wireCode, expected) in [
            ("email_unverified", GatewayErrorCode.emailUnverified),
        ] {
            let error = try #require(GatewayError(
                response: HTTPURLResponse(
                    url: URL(string: "https://gateway.example.test/v2/apps/a/proxy/openai/v1/responses")!,
                    statusCode: 403, httpVersion: nil, headerFields: ["X-AGW-Error": "marked"]
                )!,
                body: Data("{\"error\":{\"code\":\"\(wireCode)\",\"message\":\"Account action required\"}}".utf8)
            ))
            #expect(error.code == expected)
            #expect(error.isRetryable == false)
            #expect(error.monthlyRequestQuota == nil)
        }
    }

    /// The gateway's only quota. Before it was listed, an exhausted month
    /// reached the app as `.unknown`, which says nothing an app could act on.
    @Test
    func billingRequestQuotaCodeIsRecognisedRatherThanUnknown() {
        #expect(
            GatewayErrorCode(rawValue: "billing_request_quota_exceeded")
                == .billingRequestQuotaExceeded
        )
        let error = GatewayError(
            code: .billingRequestQuotaExceeded,
            message: "exhausted",
            statusCode: 429
        )
        // It comes back only in the next period, so it is not retryable,
        // unlike a rate limit's 429; and neither is a spent app budget.
        #expect(error.isRetryable == false)
        #expect(GatewayError(code: .appBudgetExhausted, message: "spent", statusCode: 429).isRetryable == false)
        #expect(GatewayError(code: .appRateLimited, message: "slow down", statusCode: 429).isRetryable)
    }

    /// The two quota systems, told apart at the point a client has to act.
    ///
    /// Both arrive as a 429 and both are worth waiting on, but only one is the
    /// app's own doing: an ``GatewayErrorCode/appRateLimited`` refusal is a
    /// limit the operator set and can change, and it says which scope refused.
    @Test
    func anApplicationRateLimitIsToldApartFromThePlanAllowance() throws {
        let url = URL(string: "https://gateway.test/v2/apps/a/proxy/openai/v1/responses")!
        let http = HTTPURLResponse(
            url: url,
            statusCode: 429,
            httpVersion: nil,
            headerFields: ["X-AGW-Error": "marked", "Retry-After": "37"]
        )!
        let error = try #require(GatewayError(
            response: http,
            body: Data(#"""
            {"error":{"code":"app_rate_limited","message":"too fast","data":{"scope":"user"}}}
            """#.utf8)
        ))

        #expect(error.code == .appRateLimited)
        #expect(error.limitScope == "user")
        #expect(error.retryAfter == 37)
        // Not the plan's allowance, so there is none of it to read.
        #expect(error.monthlyRequestQuota == nil)
        #expect(error.isRetryable)
    }

    @Test
    func anApplicationBudgetRejectionCarriesItsScopeAndRetryInstant() throws {
        let url = URL(string: "https://gateway.test/v2/apps/a/presets/chat")!
        let http = HTTPURLResponse(
            url: url,
            statusCode: 429,
            httpVersion: nil,
            headerFields: ["X-AGW-Error": "marked", "Retry-After": "86400"]
        )!
        let error = try #require(GatewayError(
            response: http,
            body: Data(#"""
            {"error":{"code":"app_budget_exhausted","message":"spent","data":{"scope":"app"}}}
            """#.utf8)
        ))

        #expect(error.code == .appBudgetExhausted)
        // An app-scoped refusal is somebody else's traffic: backing this user
        // off does not help, and a client should be able to tell.
        #expect(error.limitScope == "app")
        #expect(error.retryAfter == 86_400)
    }

    /// Only application limits carry a scope; nothing else should invent one.
    @Test
    func onlyAnApplicationLimitReportsAScope() {
        let quota = GatewayError(
            code: .billingRequestQuotaExceeded,
            message: "exhausted",
            statusCode: 429,
            data: ["scope": .string("user")]
        )
        #expect(quota.limitScope == nil)
    }

    @Test
    func aQuotaRejectionCarriesTheAllowanceTheCountAndTheResetInstant() throws {
        let body = Data(#"""
        {"error":{"code":"billing_request_quota_exceeded",
                  "message":"exhausted until 2026-10-01T00:00:00.000Z",
                  "data":{"limit":10000,"used":10000,"resetAt":"2026-10-01T00:00:00.000Z"}}}
        """#.utf8)
        let http = HTTPURLResponse(
            url: URL(string: "https://gateway.test/v2/apps/a/proxy/openai/v1/responses")!,
            statusCode: 429,
            httpVersion: nil,
            headerFields: ["X-AGW-Error": "marked", "Retry-After": "2419200"]
        )!

        let error = try #require(GatewayError(response: http, body: body))
        #expect(error.code == .billingRequestQuotaExceeded)
        #expect(error.statusCode == 429)
        let quota = try #require(error.monthlyRequestQuota)
        #expect(quota.limit == 10_000)
        #expect(quota.used == 10_000)
        #expect(quota.resetAt == Date(timeIntervalSince1970: 1_790_812_800))
    }

    /// A successful response is not a rejection, and a rejection that carries no
    /// `data` still reads — the accessor simply has nothing to answer with.
    @Test
    func rejectionParsingIgnoresSuccessAndToleratesAMissingDataObject() throws {
        let url = URL(string: "https://gateway.test/v2/apps/a/proxy/openai/v1/responses")!
        let success = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        #expect(GatewayError(response: success, body: Data("{}".utf8)) == nil)

        let refusal = HTTPURLResponse(url: url, statusCode: 403, httpVersion: nil, headerFields: ["X-AGW-Error": "marked"])!
        let error = try #require(GatewayError(
            response: refusal,
            body: Data(#"{"error":{"code":"model_not_allowed","message":"nope"}}"#.utf8)
        ))
        #expect(error.code == .modelNotAllowed)
        #expect(error.data.isEmpty)
        #expect(error.monthlyRequestQuota == nil)

        // An unparseable body still yields a rejection, just an unnamed one.
        let garbled = try #require(GatewayError(response: refusal, body: Data("not json".utf8)))
        #expect(garbled.code == .unknown)
        #expect(garbled.statusCode == 403)
    }

    /// JSON has one number type, so a count may arrive written either way.
    @Test
    func quotaCountsReadBackWhicheverWayJSONWroteThem() throws {
        let url = URL(string: "https://gateway.test/v2/apps/a/presets/chat")!
        let http = HTTPURLResponse(url: url, statusCode: 429, httpVersion: nil, headerFields: ["X-AGW-Error": "marked"])!
        let error = try #require(GatewayError(
            response: http,
            body: Data(#"""
            {"error":{"code":"billing_request_quota_exceeded","message":"exhausted",
                      "data":{"limit":10000.0,"used":10000,"resetAt":"2026-10-01T00:00:00Z"}}}
            """#.utf8)
        ))
        let quota = try #require(error.monthlyRequestQuota)
        #expect(quota.limit == 10_000)
        // Seconds-precision instants parse too; the gateway sends milliseconds.
        #expect(quota.resetAt == Date(timeIntervalSince1970: 1_790_812_800))
    }

    /// A key the Secure Enclave has forgotten is registered afresh rather than
    /// ending the session. Signing fails on the device, before any request is
    /// made, so the gateway never gets the chance to reject it — which is why
    /// recovering from a rejection alone left a reinstalled app stuck.
    @Test
    func aKeyThisDeviceCannotSignWithIsReplaced() async throws {
        let registerCalls = LockedCounter()
        let tokenCalls = LockedCounter()
        let reports = FailureReportLog()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            if request.url!.path.hasSuffix("/auth/register") {
                registerCalls.increment()
                return response(request, status: 200, body: #"{"user_id":"user-1"}"#)
            }
            if request.url!.path.hasSuffix("/auth/failure") {
                reports.record(request)
                return response(request, status: 200, body: #"{"recorded":true}"#)
            }
            tokenCalls.increment()
            return response(request, status: 200, body: #"{"access_token":"recovered","expires_in":3600}"#)
        }
        let store = MemoryCredentialStore(keyID: "key-from-previous-install")
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttest(issuerTokenProvider: { _ in "issuer" }),
            attestProvider: MockAttestProvider(deadKeyIDs: ["key-from-previous-install"]),
            credentialStore: store,
            session: session()
        )
        #expect(try await client.gatewayAccessToken() == "recovered")
        // Registered once, and the replacement is what gets stored.
        #expect(registerCalls.snapshot() == 1)
        #expect(tokenCalls.snapshot() == 1)
        #expect(try store.appAttestKeyID(for: "test-app") == "generated-key")
        // The lost key is reported, as something the package got past itself,
        // so the challenge it was handed is not left looking abandoned.
        await client.settleFailureReports()
        let report = try #require(reports.snapshot().first)
        #expect(reports.snapshot().count == 1)
        #expect(report["step"] as? String == "generate_assertion")
        #expect(report["recovered"] as? Bool == true)
        #expect(report["challenge"] as? String == "Y2hhbGxlbmdl")
    }

    /// App Attest failing on the device leaves the gateway holding a challenge
    /// nobody came back for. The app gets its error at once, and the gateway is
    /// told which step failed and why, by domain and code alone.
    @Test
    func anAttestationThatFailsOnTheDeviceIsReported() async throws {
        let reports = FailureReportLog()
        let registerCalls = LockedCounter()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            if request.url!.path.hasSuffix("/auth/failure") {
                reports.record(request)
                return response(request, status: 200, body: #"{"recorded":true}"#)
            }
            registerCalls.increment()
            return response(request, status: 500, body: "{}")
        }
        let timeout = NSError(domain: NSURLErrorDomain, code: -1001)
        let failure = NSError(
            domain: "com.apple.devicecheck.error",
            code: 3,
            userInfo: [NSLocalizedDescriptionKey: "text that is never sent", NSUnderlyingErrorKey: timeout]
        )
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            attestProvider: MockAttestProvider(attestFailure: failure),
            credentialStore: MemoryCredentialStore(),
            session: session()
        )

        var thrown: NSError?
        do {
            _ = try await client.gatewayAccessToken()
        } catch {
            thrown = error as NSError
        }
        #expect(thrown?.domain == "com.apple.devicecheck.error")
        #expect(registerCalls.snapshot() == 0)

        await client.settleFailureReports()
        let report = try #require(reports.snapshot().first)
        #expect(report["challenge"] as? String == "Y2hhbGxlbmdl")
        #expect(report["step"] as? String == "attest_key")
        #expect((report["error"] as? [String: Any])?["domain"] as? String == "com.apple.devicecheck.error")
        #expect((report["error"] as? [String: Any])?["code"] as? Int == 3)
        #expect((report["underlying_error"] as? [String: Any])?["domain"] as? String == NSURLErrorDomain)
        #expect((report["underlying_error"] as? [String: Any])?["code"] as? Int == -1001)
        #expect(report["recovered"] == nil)
        let sent = try #require(String(data: try JSONSerialization.data(withJSONObject: report), encoding: .utf8))
        #expect(!sent.contains("never sent"))
    }

    /// A registration the gateway refused is recorded by the gateway itself,
    /// so the package sends nothing more about it.
    @Test
    func aRefusalTheGatewayAnsweredIsNotReportedAgain() async throws {
        let reports = FailureReportLog()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            if request.url!.path.hasSuffix("/auth/failure") {
                reports.record(request)
                return response(request, status: 200, body: #"{"recorded":true}"#)
            }
            return response(request, status: 403, body: #"{"error":{"code":"attest_failed","message":"no"}}"#)
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            attestProvider: MockAttestProvider(),
            credentialStore: MemoryCredentialStore(),
            session: session()
        )

        await #expect(throws: GatewayError.self) { _ = try await client.gatewayAccessToken() }
        await client.settleFailureReports()
        #expect(reports.snapshot().isEmpty)
    }

    /// An exchange that never got an answer — the network went away after the
    /// challenge — is reported under the step it was on.
    @Test
    func anExchangeThatNeverReachedTheGatewayIsReported() async throws {
        let reports = FailureReportLog()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            if request.url!.path.hasSuffix("/auth/failure") {
                reports.record(request)
                return response(request, status: 200, body: #"{"recorded":true}"#)
            }
            throw URLError(.networkConnectionLost)
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            attestProvider: MockAttestProvider(),
            credentialStore: MemoryCredentialStore(keyID: "key-in-good-standing"),
            session: session()
        )

        await #expect(throws: (any Error).self) { _ = try await client.gatewayAccessToken() }
        await client.settleFailureReports()
        let report = try #require(reports.snapshot().first)
        #expect(report["step"] as? String == "token")
        #expect((report["error"] as? [String: Any])?["domain"] as? String == NSURLErrorDomain)
    }

    @Test
    func shortLivedTokensUseProportionalRefreshLeewayWithoutLooping() async throws {
        let tokenCalls = LockedCounter()
        MockURLProtocol.handler = { request in
            let call = tokenCalls.increment()
            return response(
                request,
                status: 200,
                body: "{\"access_token\":\"token-\(call)\",\"expires_in\":120}"
            )
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .apiKey(
                key: "agw_test-key",
                issuerTokenProvider: { _ in "firebase-token" }
            ),
            session: session()
        )
        #expect(try await client.gatewayAccessToken() == "token-1")
        #expect(try await client.gatewayAccessToken() == "token-1")
        try await Task.sleep(for: .seconds(1.2))
        #expect(tokenCalls.snapshot() == 1)
        #expect(AppAIGatewayClient.refreshDelay(for: 120) == 90)
        // The gateway's one-hour token is replaced fifteen minutes early.
        #expect(AppAIGatewayClient.refreshDelay(for: 3600) == 2700)
        _ = client
    }

    /// A token of 16 seconds: replaced after 1 second, still sent until 15.5,
    /// and a failed refresh is tried again every second.
    private static let shortToken = 16

    private static func timedClient() -> AppAIGatewayClient {
        AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .apiKey(
                key: "agw_test-key",
                issuerTokenProvider: { _ in "firebase-token" }
            ),
            session: session()
        )
    }

    /// Polls `condition` until it holds, for up to `seconds`.
    private static func eventually(within seconds: Double, _ condition: () -> Bool) async throws -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            try await Task.sleep(for: .milliseconds(50))
        }
        return condition()
    }

    /// Polls `token()` until it answers `expected`, for up to `seconds`.
    private static func eventually(
        _ expected: String,
        within seconds: Double,
        _ token: () async throws -> String
    ) async throws -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if try await token() == expected { return true }
            try await Task.sleep(for: .milliseconds(100))
        }
        return false
    }

    @Test
    func keepsTheCurrentTokenWhileARefreshFailsAndRetriesIt() async throws {
        let tokenCalls = LockedCounter()
        MockURLProtocol.handler = { request in
            let call = tokenCalls.increment()
            if call == 1 {
                return response(request, status: 200, body: "{\"access_token\":\"token-1\",\"expires_in\":\(Self.shortToken)}")
            }
            if call <= 3 {
                return response(request, status: 503, body: #"{"error":{"code":"service_unavailable","message":"retry"}}"#)
            }
            return response(request, status: 200, body: #"{"access_token":"token-2","expires_in":3600}"#)
        }
        let client = Self.timedClient()
        #expect(try await client.gatewayAccessToken() == "token-1")

        // The refresh behind it has failed: the token it was replacing is
        // still accepted, so requests keep it, without waiting for an exchange.
        #expect(try await Self.eventually(within: 3) { tokenCalls.snapshot() == 2 })
        let started = Date()
        #expect(try await client.gatewayAccessToken() == "token-1")
        #expect(Date().timeIntervalSince(started) < 0.5)

        // It is tried again, about once a second here, until it succeeds.
        #expect(try await Self.eventually("token-2", within: 6) { try await client.gatewayAccessToken() })
        #expect(tokenCalls.snapshot() == 4)
    }

    @Test
    func doesNotHoldARequestBehindASlowRefresh() async throws {
        let tokenCalls = LockedCounter()
        MockURLProtocol.handler = { request in
            if tokenCalls.increment() == 1 {
                return response(request, status: 200, body: "{\"access_token\":\"token-1\",\"expires_in\":\(Self.shortToken)}")
            }
            Thread.sleep(forTimeInterval: 2)
            return response(request, status: 200, body: #"{"access_token":"token-2","expires_in":3600}"#)
        }
        let client = Self.timedClient()
        #expect(try await client.gatewayAccessToken() == "token-1")

        // The refresh behind it is under way and slow; the request does not wait for it.
        #expect(try await Self.eventually(within: 3) { tokenCalls.snapshot() == 2 })
        let started = Date()
        #expect(try await client.gatewayAccessToken() == "token-1")
        #expect(Date().timeIntervalSince(started) < 0.5)
        #expect(try await Self.eventually("token-2", within: 5) { try await client.gatewayAccessToken() })
        #expect(tokenCalls.snapshot() == 2)
    }

    @Test
    func doesNotRetryARefreshTheGatewayRefusedForGood() async throws {
        let tokenCalls = LockedCounter()
        MockURLProtocol.handler = { request in
            if tokenCalls.increment() == 1 {
                return response(request, status: 200, body: "{\"access_token\":\"token-1\",\"expires_in\":\(Self.shortToken)}")
            }
            return response(request, status: 403, body: #"{"error":{"code":"auth_required","message":"User is blocked"}}"#)
        }
        let client = Self.timedClient()
        #expect(try await client.gatewayAccessToken() == "token-1")
        #expect(try await Self.eventually(within: 3) { tokenCalls.snapshot() == 2 })
        // A refusal no wait would change is not tried again behind the token,
        // which the gateway goes on judging request by request.
        try await Task.sleep(for: .seconds(2.5))
        #expect(tokenCalls.snapshot() == 2)
        #expect(try await client.gatewayAccessToken() == "token-1")
        #expect(tokenCalls.snapshot() == 2)
    }

    @Test
    func waitsForAndSurfacesAFailedExchangeOnceTheTokenRunsOut() async throws {
        let tokenCalls = LockedCounter()
        MockURLProtocol.handler = { request in
            if tokenCalls.increment() == 1 {
                return response(request, status: 200, body: #"{"access_token":"token-1","expires_in":3}"#)
            }
            return response(request, status: 503, body: #"{"error":{"code":"service_unavailable","message":"retry"}}"#)
        }
        let client = Self.timedClient()
        #expect(try await client.gatewayAccessToken() == "token-1")
        // Past `usableUntil` (2.5 s for a 3 s token) the request waits for the
        // exchange, and its failure is the request's.
        try await Task.sleep(for: .seconds(2.8))
        var failed = false
        do {
            _ = try await client.gatewayAccessToken()
        } catch let error as GatewayError {
            failed = error.statusCode == 503
        }
        #expect(failed)
    }

    @Test
    func aDiscardDoesNotWaitOutAFailedRefresh() async throws {
        let tokenCalls = LockedCounter()
        MockURLProtocol.handler = { request in
            let call = tokenCalls.increment()
            if call == 1 {
                return response(request, status: 200, body: "{\"access_token\":\"token-1\",\"expires_in\":\(Self.shortToken)}")
            }
            if call == 2 {
                return response(request, status: 503, body: #"{"error":{"code":"service_unavailable","message":"retry"}}"#)
            }
            return response(request, status: 200, body: #"{"access_token":"token-2","expires_in":3600}"#)
        }
        let client = Self.timedClient()
        #expect(try await client.gatewayAccessToken() == "token-1")
        #expect(try await Self.eventually(within: 3) { tokenCalls.snapshot() == 2 })
        // A discarded token — the gateway refused it — is replaced at once,
        // not after the failed refresh's retry interval.
        await client.discardAccessToken()
        #expect(try await client.gatewayAccessToken() == "token-2")
    }

    @Test
    func onlyAFailureThatMayPassIsRetriedBehindTheToken() {
        #expect(AppAIGatewayClient.mayPass(URLError(.timedOut)))
        #expect(AppAIGatewayClient.mayPass(GatewayError(code: .unknown, message: "", statusCode: 503)))
        #expect(!AppAIGatewayClient.mayPass(GatewayError(code: .unknown, message: "", statusCode: 403)))
        #expect(!AppAIGatewayClient.mayPass(CancellationError()))
    }

    @Test
    func waitsForANewTokenOnceTheCurrentOneIsNoLongerAccepted() {
        // Past `usableUntil` a request waits for the exchange, as it always
        // did: the margins here are what decide when that is.
        #expect(AppAIGatewayClient.refreshLeeway(for: 3600) == 900)
        #expect(AppAIGatewayClient.usableMargin(forLeeway: 900) == 30)
        #expect(AppAIGatewayClient.refreshRetryInterval(forLeeway: 900) == 60)
        #expect(AppAIGatewayClient.refreshLeeway(for: 16) == 15)
        #expect(AppAIGatewayClient.refreshRetryInterval(forLeeway: 15) == 1)
    }

    @Test
    func concurrentTokenRequestsShareOneExchange() async throws {
        let tokenCalls = LockedCounter()
        MockURLProtocol.handler = { request in
            tokenCalls.increment()
            return response(request, status: 200, body: #"{"access_token":"shared-token","expires_in":3600}"#)
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .apiKey(
                key: "agw_test-key",
                issuerTokenProvider: { _ in "firebase-token" }
            ),
            session: session()
        )

        async let first = client.gatewayAccessToken()
        async let second = client.gatewayAccessToken()
        #expect(try await [first, second] == ["shared-token", "shared-token"])
        #expect(tokenCalls.snapshot() == 1)
    }

    @Test
    func failedSingleFlightReleasesTheNextExchange() async throws {
        let tokenCalls = LockedCounter()
        MockURLProtocol.handler = { request in
            if tokenCalls.increment() == 1 {
                return response(
                    request,
                    status: 503,
                    body: #"{"error":{"code":"provider_error","message":"retry"}}"#
                )
            }
            return response(request, status: 200, body: #"{"access_token":"recovered","expires_in":3600}"#)
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .apiKey(
                key: "agw_test-key",
                issuerTokenProvider: { _ in "firebase-token" }
            ),
            session: session()
        )

        var firstFailed = false
        do {
            _ = try await client.gatewayAccessToken()
        } catch {
            firstFailed = true
        }
        #expect(firstFailed)
        #expect(try await client.gatewayAccessToken() == "recovered")
        #expect(tokenCalls.snapshot() == 2)
    }

    @Test
    func assertionClientDataMatchesServerCanonicalForm() {
        let value = AppAIGatewayClient.assertionClientData(app: "app", challenge: "challenge", keyID: "key")
        #expect(String(data: value, encoding: .utf8) == #"{"app":"app","challenge":"challenge","key_id":"key"}"#)
    }

    // MARK: App Store transaction in the token exchange

    /// The gateway rebuilds these bytes to check the exchange's assertion. The
    /// hash is the SHA-256 of the JWS's UTF-8 bytes, base64url without
    /// padding, worked out apart from the client (`openssl dgst -sha256`).
    @Test
    func assertionClientDataWithAnAppTransactionAppendsItsHashLast() {
        let jws = "eyJhbGciOiJFUzI1NiJ9.eyJhcHBUcmFuc2FjdGlvbklkIjoiNzA0In0.c2lnbmF0dXJl"
        #expect(AppAIGatewayClient.appTransactionHash(jws) == "JOSPw8U8KLYYI52foPZXbaeHPFAeHPmUQtE5iEcwn0g")
        let value = AppAIGatewayClient.assertionClientData(
            app: "my-app",
            challenge: "Y2hhbGxlbmdl",
            keyID: "a+b/c=",
            appTransaction: jws
        )
        #expect(
            String(data: value, encoding: .utf8)
                == #"{"app":"my-app","challenge":"Y2hhbGxlbmdl","key_id":"a+b/c=","app_transaction":"JOSPw8U8KLYYI52foPZXbaeHPFAeHPmUQtE5iEcwn0g"}"#
        )
        // No transaction is the three-key form, unchanged.
        #expect(
            AppAIGatewayClient.assertionClientData(app: "app", challenge: "challenge", keyID: "key", appTransaction: nil)
                == AppAIGatewayClient.assertionClientData(app: "app", challenge: "challenge", keyID: "key")
        )
    }

    /// The transaction travels in the body and is bound into the assertion,
    /// so it cannot be swapped for another device's.
    @Test
    func theExchangeSendsTheAppTransactionAndSignsOverIt() async throws {
        let tokenBodies = TokenBodyLog()
        let signatures = SignatureLog()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(
                    request,
                    status: 200,
                    body: #"{"challenge":"Y2hhbGxlbmdl","accepts_app_transaction":true}"#
                )
            }
            tokenBodies.record(request)
            return response(request, status: 200, body: #"{"access_token":"token","expires_in":3600}"#)
        }
        let transactions = FakeAppTransactionProvider()
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            attestProvider: MockAttestProvider(signatures: signatures),
            appTransactionProvider: transactions,
            credentialStore: MemoryCredentialStore(keyID: "existing-key"),
            session: session()
        )
        #expect(try await client.gatewayAccessToken() == "token")

        let body = try #require(tokenBodies.snapshot().first)
        #expect(body["app_transaction"] == "jws-1")
        #expect(body["key_id"] == "existing-key")
        let expected = Data(
            #"{"app":"test-app","challenge":"Y2hhbGxlbmdl","key_id":"existing-key","app_transaction":"\#(AppAIGatewayClient.appTransactionHash("jws-1"))"}"#.utf8
        )
        #expect(signatures.snapshot().map(\.hash) == [expected.sha256])
        #expect(transactions.calls.snapshot() == 1)
    }

    /// Without a transaction — offline, no App Store, a simulator — the
    /// exchange goes ahead exactly as it always has.
    @Test
    func anExchangeWithoutAnAppTransactionKeepsTheThreeKeyForm() async throws {
        let tokenBodies = TokenBodyLog()
        let signatures = SignatureLog()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(
                    request,
                    status: 200,
                    body: #"{"challenge":"Y2hhbGxlbmdl","accepts_app_transaction":true}"#
                )
            }
            tokenBodies.record(request)
            return response(request, status: 200, body: #"{"access_token":"token","expires_in":3600}"#)
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            attestProvider: MockAttestProvider(signatures: signatures),
            appTransactionProvider: FakeAppTransactionProvider(returnsNil: true),
            credentialStore: MemoryCredentialStore(keyID: "existing-key"),
            session: session()
        )
        #expect(try await client.gatewayAccessToken() == "token")

        let body = try #require(tokenBodies.snapshot().first)
        #expect(body["app_transaction"] == nil)
        #expect(Set(body.keys) == ["key_id", "assertion", "challenge"])
        let expected = AppAIGatewayClient.assertionClientData(
            app: "test-app",
            challenge: "Y2hhbGxlbmdl",
            keyID: "existing-key"
        )
        #expect(signatures.snapshot().map(\.hash) == [expected.sha256])
    }

    /// An older gateway ignores the body field but checks the assertion over
    /// the three keys it knows, so a transaction is sent only where the
    /// challenge says the gateway reads one.
    @Test
    func aGatewayThatDoesNotAcceptTheAppTransactionIsSentNone() async throws {
        let tokenBodies = TokenBodyLog()
        let signatures = SignatureLog()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            tokenBodies.record(request)
            return response(request, status: 200, body: #"{"access_token":"token","expires_in":3600}"#)
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            attestProvider: MockAttestProvider(signatures: signatures),
            appTransactionProvider: FakeAppTransactionProvider(),
            credentialStore: MemoryCredentialStore(keyID: "existing-key"),
            session: session()
        )
        #expect(try await client.gatewayAccessToken() == "token")

        let body = try #require(tokenBodies.snapshot().first)
        #expect(body["app_transaction"] == nil)
        let expected = AppAIGatewayClient.assertionClientData(
            app: "test-app",
            challenge: "Y2hhbGxlbmdl",
            keyID: "existing-key"
        )
        #expect(signatures.snapshot().map(\.hash) == [expected.sha256])
    }

    /// The gateway refuses the key twice: once more with a fresh challenge,
    /// then a replacement. Every try signs over the same transaction the
    /// exchange fetched, not a second one.
    @Test
    func aReplacementKeyIsSignedOverTheSameAppTransaction() async throws {
        let tokenBodies = TokenBodyLog()
        let signatures = SignatureLog()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(
                    request,
                    status: 200,
                    body: #"{"challenge":"Y2hhbGxlbmdl","accepts_app_transaction":true}"#
                )
            }
            if request.url!.path.hasSuffix("/auth/register") {
                return response(request, status: 200, body: #"{"user_id":"user-1"}"#)
            }
            tokenBodies.record(request)
            if tokenBodies.snapshot().count <= 2 {
                return response(
                    request,
                    status: 403,
                    body: #"{"error":{"code":"attest_failed","message":"unknown key"}}"#
                )
            }
            return response(request, status: 200, body: #"{"access_token":"token","expires_in":3600}"#)
        }
        let transactions = FakeAppTransactionProvider()
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            attestProvider: MockAttestProvider(signatures: signatures),
            appTransactionProvider: transactions,
            credentialStore: MemoryCredentialStore(keyID: "rejected-key"),
            session: session()
        )
        #expect(try await client.gatewayAccessToken() == "token")

        let bodies = tokenBodies.snapshot()
        #expect(bodies.map { $0["key_id"] } == ["rejected-key", "rejected-key", "generated-key"])
        #expect(bodies.map { $0["app_transaction"] } == ["jws-1", "jws-1", "jws-1"])
        let hashes = ["rejected-key", "rejected-key", "generated-key"].map {
            AppAIGatewayClient.assertionClientData(
                app: "test-app",
                challenge: "Y2hhbGxlbmdl",
                keyID: $0,
                appTransaction: "jws-1"
            ).sha256
        }
        #expect(signatures.snapshot().map(\.keyID) == ["rejected-key", "rejected-key", "generated-key"])
        #expect(signatures.snapshot().map(\.hash) == hashes)
        #expect(transactions.calls.snapshot() == 1)
    }

    /// A refusal that passes costs no new key: the same key signs a fresh
    /// challenge, and a new key is made only if that is refused too.
    @Test
    func aKeyRefusedOnceIsTriedAgainBeforeItIsReplaced() async throws {
        let tokenBodies = TokenBodyLog()
        let challenges = LockedCounter()
        let attestations = LockedCounter()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: "{\"challenge\":\"Y2hhbGxlbmdl\(challenges.increment())\"}")
            }
            tokenBodies.record(request)
            if tokenBodies.snapshot().count == 1 {
                return response(request, status: 403, body: #"{"error":{"code":"attest_failed","message":"replayed"}}"#)
            }
            return response(request, status: 200, body: #"{"access_token":"token","expires_in":3600}"#)
        }
        let store = MemoryCredentialStore(keyID: "kept-key")
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            attestProvider: MockAttestProvider(attestations: attestations),
            credentialStore: store,
            session: session()
        )
        #expect(try await client.gatewayAccessToken() == "token")
        let bodies = tokenBodies.snapshot()
        #expect(bodies.map { $0["key_id"] } == ["kept-key", "kept-key"])
        #expect(bodies.map { $0["challenge"] } == ["Y2hhbGxlbmdl1", "Y2hhbGxlbmdl2"])
        #expect(attestations.snapshot() == 0)
        #expect(try store.appAttestKeyID(for: "test-app") == "kept-key")
    }

    /// A StoreKit that never answers must not hold up the exchange.
    @Test
    func aSlowAppTransactionIsGivenUpOn() async {
        let late = await SystemAppTransactionProvider.first(within: .milliseconds(50)) {
            try? await Task.sleep(for: .seconds(2))
            return "late"
        }
        #expect(late == nil)
        let prompt = await SystemAppTransactionProvider.first(within: .seconds(2)) { "prompt" }
        #expect(prompt == "prompt")
    }

    @Test
    func issuerlessAPIKeyIsAttachedDirectlyWithOptionalEndUserID() async throws {
        let networkCalls = LockedCounter()
        MockURLProtocol.handler = { request in
            networkCalls.increment()
            return response(request, status: 500, body: "{}")
        }
        let client = AppAIGatewayClient(
            appID: "machine-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .apiKey(key: "agw_machine-key"),
            endUserId: "customer-42",
            session: session()
        )

        #expect(try await client.gatewayAccessToken() == "agw_machine-key")
        let request = try await client.authorizedRequest(preset: "chat")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer agw_machine-key")
        #expect(request.value(forHTTPHeaderField: "X-End-User-ID") == "customer-42")
        #expect(networkCalls.snapshot() == 0)
    }

    /// The gateway's own protection of its authentication endpoints is not one
    /// of the limits an application sets on its users, so it carries no scope
    /// to read — but it is still something waiting fixes.
    @Test
    func theGatewaysOwnAuthenticationLimitIsReadAndCarriesNoScope() throws {
        #expect(GatewayErrorCode(rawValue: "rate_limited") == .rateLimited)
        let url = URL(string: "https://gateway.test/v2/apps/a/auth/token")!
        let http = HTTPURLResponse(
            url: url,
            statusCode: 429,
            httpVersion: nil,
            headerFields: ["X-AGW-Error": "marked", "Retry-After": "45"]
        )!
        let error = try #require(GatewayError(
            response: http,
            body: Data(#"""
            {"error":{"code":"rate_limited","message":"too many",
                      "data":{"scope":"app_auth_token"}}}
            """#.utf8)
        ))

        #expect(error.code == .rateLimited)
        #expect(error.retryAfter == 45)
        #expect(error.isRetryable)
        // `scope` names the endpoint here, not a limit the application set, so
        // `limitScope` must not answer with it.
        #expect(error.limitScope == nil)
        #expect(error.monthlyRequestQuota == nil)
    }

    /// A refused registration must not cost an Apple attestation per call.
    ///
    /// Registering is where this bites hardest: the gateway refuses before a key
    /// is stored, so without a hold the next call finds no key, generates one
    /// and attests it with Apple all over again.
    @Test
    func aRateLimitedRegistrationIsWaitedOutWithoutAnotherAttestation() async throws {
        let attestations = LockedCounter()
        let requests = LockedCounter()
        MockURLProtocol.handler = { request in
            requests.increment()
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            return (
                HTTPURLResponse(
                    url: request.url!,
                    statusCode: 429,
                    httpVersion: nil,
                    headerFields: ["Retry-After": "1"]
                )!,
                Data(#"""
                {"error":{"code":"rate_limited","message":"too many",
                          "data":{"scope":"app_auth_register"}}}
                """#.utf8)
            )
        }
        let store = MemoryCredentialStore()
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttest(issuerTokenProvider: { _ in "issuer" }),
            attestProvider: MockAttestProvider(attestations: attestations),
            credentialStore: store,
            session: session()
        )

        var first: GatewayError?
        do {
            _ = try await client.gatewayAccessToken()
        } catch let error as GatewayError {
            first = error
        }
        #expect(first?.code == .rateLimited)
        #expect(first?.retryAfter == 1)
        let spent = requests.snapshot()
        #expect(attestations.snapshot() == 1)
        // Nothing was stored, which is exactly the state that would otherwise
        // send the next call back to Apple for another key.
        #expect(try store.appAttestKeyID(for: "test-app") == nil)

        var second: GatewayError?
        do {
            _ = try await client.gatewayAccessToken()
        } catch let error as GatewayError {
            second = error
        }
        #expect(second?.code == .rateLimited)
        // Re-raised with what is left of the window rather than what it began as.
        #expect((second?.retryAfter ?? 0) > 0)
        #expect((second?.retryAfter ?? .infinity) <= 1)
        // The whole point: no second attestation, and no second request.
        #expect(attestations.snapshot() == 1)
        #expect(requests.snapshot() == spent)

        // Once the window closes the client goes back to the gateway by itself.
        try await Task.sleep(for: .milliseconds(1_200))
        _ = try? await client.gatewayAccessToken()
        #expect(requests.snapshot() > spent)
    }

    /// A refused token exchange is not a rejected key, so nothing about the key
    /// may change: no registration, no attestation, and the stored id stays.
    @Test
    func aRateLimitedTokenExchangeDoesNotReRegisterTheKey() async throws {
        let registerCalls = LockedCounter()
        let attestations = LockedCounter()
        let requests = LockedCounter()
        MockURLProtocol.handler = { request in
            requests.increment()
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            if request.url!.path.hasSuffix("/auth/register") {
                registerCalls.increment()
                return response(request, status: 200, body: #"{"user_id":"user-1"}"#)
            }
            return (
                HTTPURLResponse(
                    url: request.url!,
                    statusCode: 429,
                    httpVersion: nil,
                    headerFields: ["Retry-After": "30"]
                )!,
                Data(#"""
                {"error":{"code":"rate_limited","message":"too many",
                          "data":{"scope":"app_auth_token"}}}
                """#.utf8)
            )
        }
        let store = MemoryCredentialStore(keyID: "key-in-good-standing")
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttest(issuerTokenProvider: { _ in "issuer" }),
            attestProvider: MockAttestProvider(attestations: attestations),
            credentialStore: store,
            session: session()
        )

        var surfaced: GatewayError?
        do {
            _ = try await client.gatewayAccessToken()
        } catch let error as GatewayError {
            surfaced = error
        }
        #expect(surfaced?.code == .rateLimited)
        #expect(surfaced?.retryAfter == 30)
        #expect(registerCalls.snapshot() == 0)
        #expect(attestations.snapshot() == 0)
        #expect(try store.appAttestKeyID(for: "test-app") == "key-in-good-standing")

        let spent = requests.snapshot()
        _ = try? await client.gatewayAccessToken()
        #expect(requests.snapshot() == spent)
        #expect(registerCalls.snapshot() == 0)
    }

    // MARK: Per-request App Attest proofs

    /// The exact bytes the gateway rebuilds for one request; its own golden
    /// test in `test/request-proof.test.ts` pins the same string.
    @Test
    func requestClientDataMatchesTheGatewayByteForByte() {
        let data = AppAIGatewayClient.requestClientData(
            appID: "my-app",
            method: "post",
            pathAndQuery: "/v2/apps/my-app/proxy/openai/v1/responses?x=1",
            body: Data(#"{"model":"gpt-5.6-sol"}"#.utf8),
            token: "token-value",
            timestamp: 1_767_225_600,
            nonce: "AAAAAAAAAAAAAAAAAAAAAA"
        )
        #expect(String(data: data, encoding: .utf8) == [
            "appaigateway-request-v1",
            "my-app",
            "POST",
            "/v2/apps/my-app/proxy/openai/v1/responses?x=1",
            "-PUEzjp5RIbD6WFR4AYaosj8uORXKjdf9GqkXTE8ZjY",
            "5sAqV0LqnU3liOubnee-1D3BcBFVIYa-0-mLLFlY_0o",
            "1767225600",
            "AAAAAAAAAAAAAAAAAAAAAA",
        ].joined(separator: "\n"))
    }

    @Test
    func anAbsentOrEmptyBodyHashesAsTheEmptyString() {
        let emptyHash = "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"
        for body in [nil, Data()] as [Data?] {
            let data = AppAIGatewayClient.requestClientData(
                appID: "a", method: "GET", pathAndQuery: "/", body: body,
                token: "t", timestamp: 1, nonce: "AAAAAAAAAAAAAAAAAAAAAA"
            )
            let lines = String(data: data, encoding: .utf8)!.split(separator: "\n", omittingEmptySubsequences: false)
            #expect(lines[4] == Substring(emptyHash))
        }
    }

    @Test
    func pathAndQueryAreReadAsSent() {
        #expect(
            AppAIGatewayClient.pathAndQuery(of: URL(string: "https://g.test/v2/apps/a/proxy/openai/v1/responses?x=1&y=%20")!)
                == "/v2/apps/a/proxy/openai/v1/responses?x=1&y=%20"
        )
        #expect(AppAIGatewayClient.pathAndQuery(of: URL(string: "https://g.test/v2/apps/a/me?")!) == "/v2/apps/a/me")
    }

    @Test
    func appAttestRequestsCarryAWellFormedProofOverTheirBody() async throws {
        let signatures = SignatureLog()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            return response(request, status: 200, body: #"{"access_token":"gateway-token","expires_in":3600,"verify_on":"every_request"}"#)
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            attestProvider: MockAttestProvider(signatures: signatures),
            credentialStore: MemoryCredentialStore(keyID: "existing-key"),
            session: session()
        )
        let body = Data(#"{"model":"gpt-5.6-sol","input":"hi"}"#.utf8)
        let request = try await client.authorizedRequest(
            provider: .openai,
            providerPath: "v1/responses",
            body: body,
            contentType: "application/json"
        )
        #expect(request.httpBody == body)
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer gateway-token")
        let proof = try #require(request.value(forHTTPHeaderField: "X-AppAttest-Proof"))
        let parts = proof.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        #expect(parts.count == 4)
        #expect(parts[0] == "v1")
        let timestamp = try #require(Int(parts[1]))
        #expect(abs(Double(timestamp) - Date().timeIntervalSince1970) < 60)
        #expect(parts[2].count == 22)
        #expect(parts[2].allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
        #expect(parts[3] == Data("assertion".utf8).base64URLEncodedString())

        // The last signature is the request's, over exactly what was sent.
        let signed = try #require(signatures.snapshot().last)
        #expect(signed.keyID == "existing-key")
        let expected = AppAIGatewayClient.requestClientData(
            appID: "test-app",
            method: "POST",
            pathAndQuery: "/v2/apps/test-app/proxy/openai/v1/responses",
            body: body,
            token: "gateway-token",
            timestamp: timestamp,
            nonce: parts[2]
        ).sha256
        #expect(signed.hash == expected)

        // Each request is signed afresh: a proof is good for one send.
        let second = try await client.authorizedRequest(preset: "chat", body: body)
        #expect(second.value(forHTTPHeaderField: "X-AppAttest-Proof") != proof)
    }

    /// A query an endpoint's format documents, `alt=sse` on a Gemini one, is
    /// part of the URL the proof is signed over, so it is passed before signing.
    @Test
    func endpointRequestsSignTheirQuery() async throws {
        let signatures = SignatureLog()
        let client = numberedTokenClient(tokens: LockedCounter(), signatures: signatures)
        #expect(
            await client.presetURL(name: "gemini", query: [URLQueryItem(name: "alt", value: "sse")]).absoluteString
                == "https://gateway.test/v2/apps/test-app/presets/gemini?alt=sse"
        )
        let body = Data(#"{"contents":[]}"#.utf8)
        let transport = FakeTransport(statuses: [200])
        _ = try await client.withAuthorizedRequest(
            preset: "gemini",
            query: [URLQueryItem(name: "alt", value: "sse")],
            body: body,
            send: transport.send
        )
        let sent = try #require(transport.snapshot().first)
        #expect(sent.url?.absoluteString == "https://gateway.test/v2/apps/test-app/presets/gemini?alt=sse")
        let proof = try #require(sent.value(forHTTPHeaderField: "X-AppAttest-Proof"))
        let parts = proof.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        let signed = try #require(signatures.snapshot().last)
        #expect(signed.hash == AppAIGatewayClient.requestClientData(
            appID: "test-app",
            method: "POST",
            pathAndQuery: "/v2/apps/test-app/presets/gemini?alt=sse",
            body: body,
            token: "token-1",
            timestamp: try #require(Int(parts[1])),
            nonce: parts[2]
        ).sha256)
    }

    /// An app that verifies App Attest on the token exchange, and an older
    /// gateway that says nothing about it: the token alone, nothing signed.
    @Test
    func requestsCarryOnlyTheTokenUnlessTheGatewayVerifiesEveryRequest() async throws {
        for tokenBody in [
            #"{"access_token":"gateway-token","expires_in":3600,"verify_on":"token_exchange"}"#,
            #"{"access_token":"gateway-token","expires_in":3600}"#,
        ] {
            let signatures = SignatureLog()
            MockURLProtocol.handler = { request in
                if request.url!.path.hasSuffix("/auth/challenge") {
                    return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
                }
                return response(request, status: 200, body: tokenBody)
            }
            let client = AppAIGatewayClient(
                appID: "test-app",
                baseURL: URL(string: "https://gateway.test")!,
                authMode: .appAttestInstall,
                attestProvider: MockAttestProvider(signatures: signatures),
                credentialStore: MemoryCredentialStore(keyID: "existing-key"),
                session: session()
            )
            let body = Data("{}".utf8)
            let request = try await client.authorizedRequest(provider: .openai, providerPath: "v1/responses", body: body)
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer gateway-token")
            #expect(request.value(forHTTPHeaderField: "X-AppAttest-Proof") == nil)
            #expect(request.httpBody == body)
            let me = try await client.currentUserRequest()
            #expect(me.value(forHTTPHeaderField: "Authorization") == "Bearer gateway-token")
            #expect(me.value(forHTTPHeaderField: "X-AppAttest-Proof") == nil)
            // The exchange's own assertion is the only one the key signed.
            #expect(signatures.snapshot().count == 1)
        }
    }

    /// The app is switched to verify every request while this client holds a
    /// token issued under token_exchange: its requests go unsigned and are
    /// refused with `assertion_required`, until the app discards the token and
    /// rebuilds the request, which re-exchanges and signs.
    @Test
    func aDiscardedTokenPicksUpASwitchToEveryRequest() async throws {
        let signatures = SignatureLog()
        let tokens = LockedCounter()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            let issued = tokens.increment()
            let verifyOn = issued == 1 ? "token_exchange" : "every_request"
            return response(
                request,
                status: 200,
                body: "{\"access_token\":\"token-\(issued)\",\"expires_in\":3600,\"verify_on\":\"\(verifyOn)\"}"
            )
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            attestProvider: MockAttestProvider(signatures: signatures),
            credentialStore: MemoryCredentialStore(keyID: "existing-key"),
            session: session()
        )
        let body = Data("{}".utf8)
        let unsigned = try await client.authorizedRequest(provider: .openai, providerPath: "v1/responses", body: body)
        #expect(unsigned.value(forHTTPHeaderField: "Authorization") == "Bearer token-1")
        #expect(unsigned.value(forHTTPHeaderField: "X-AppAttest-Proof") == nil)
        // Still cached: nothing changes until the app discards the token.
        let stillUnsigned = try await client.authorizedRequest(provider: .openai, providerPath: "v1/responses", body: body)
        #expect(stillUnsigned.value(forHTTPHeaderField: "X-AppAttest-Proof") == nil)
        #expect(tokens.snapshot() == 1)

        // The gateway refused it with assertion_required; the app recovers.
        await client.discardAccessToken()
        let signed = try await client.authorizedRequest(provider: .openai, providerPath: "v1/responses", body: body)
        #expect(tokens.snapshot() == 2)
        #expect(signed.value(forHTTPHeaderField: "Authorization") == "Bearer token-2")
        #expect(signed.value(forHTTPHeaderField: "X-AppAttest-Proof") != nil)
        #expect(signatures.snapshot().last?.keyID == "existing-key")
    }

    @Test
    func apiKeyModesSendNoProof() async throws {
        MockURLProtocol.handler = { request in
            response(request, status: 200, body: #"{"access_token":"gateway-token","expires_in":3600,"verify_on":"every_request"}"#)
        }
        for mode in [
            GatewayAuthMode.apiKey(key: "agw_machine-key"),
            GatewayAuthMode.apiKey(key: "agw_test-key", issuerTokenProvider: { _ in "issuer" }),
        ] {
            let client = AppAIGatewayClient(
                appID: "test-app",
                baseURL: URL(string: "https://gateway.test")!,
                authMode: mode,
                session: session()
            )
            let request = try await client.authorizedRequest(
                provider: .openai, providerPath: "v1/responses", body: Data("{}".utf8)
            )
            #expect(request.value(forHTTPHeaderField: "X-AppAttest-Proof") == nil)
            #expect(request.httpBody == Data("{}".utf8))
        }
    }

    /// A reinstall after the token was minted: the key the token is bound to
    /// can no longer sign, so the client registers a replacement, exchanges it
    /// for a token bound to the new key, and signs the request once more.
    @Test
    func aKeyThatStopsSigningIsReplacedAndTheRequestSignedOnceMore() async throws {
        let dying = DyingKeys()
        let signatures = SignatureLog()
        let registers = LockedCounter()
        let tokens = LockedCounter()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            if request.url!.path.hasSuffix("/auth/register") {
                registers.increment()
                return response(request, status: 200, body: #"{"user_id":"generated-key"}"#)
            }
            if request.url!.path.hasSuffix("/auth/failure") {
                return response(request, status: 200, body: #"{"recorded":true}"#)
            }
            let issued = tokens.increment()
            return response(request, status: 200, body: "{\"access_token\":\"token-\(issued)\",\"expires_in\":3600,\"verify_on\":\"every_request\"}")
        }
        let store = MemoryCredentialStore(keyID: "existing-key")
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            attestProvider: MockAttestProvider(dying: dying, signatures: signatures),
            credentialStore: store,
            session: session()
        )
        #expect(try await client.gatewayAccessToken() == "token-1")
        dying.kill("existing-key")

        let request = try await client.authorizedRequest(provider: .openai, providerPath: "v1/responses", body: Data("{}".utf8))
        #expect(registers.snapshot() == 1)
        #expect(try store.appAttestKeyID(for: "test-app") == "generated-key")
        // Bound to the new key: a token for the old one would be refused.
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer token-2")
        #expect(request.value(forHTTPHeaderField: "X-AppAttest-Proof") != nil)
        #expect(signatures.snapshot().last?.keyID == "generated-key")
    }

    @Test
    func theNewCodesDecode() {
        #expect(GatewayErrorCode(rawValue: "assertion_required") == .assertionRequired)
        let error = GatewayError(
            code: .appRateLimited, message: "", statusCode: 429, data: ["scope": .string("install")]
        )
        #expect(error.limitScope == "install")
    }

    /// `/me` is a gateway request like any other: signed in the App Attest
    /// modes, over a `GET` with no body, by the key the token is bound to.
    @Test
    func currentUserRequestIsASignedGetOfMe() async throws {
        let signatures = SignatureLog()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            return response(request, status: 200, body: #"{"access_token":"gateway-token","expires_in":3600,"verify_on":"every_request"}"#)
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test/base")!,
            authMode: .appAttestInstall,
            attestProvider: MockAttestProvider(signatures: signatures),
            credentialStore: MemoryCredentialStore(keyID: "existing-key"),
            session: session()
        )
        #expect(await client.currentUserURL().absoluteString == "https://gateway.test/base/v2/apps/test-app/me")
        let request = try await client.currentUserRequest()
        #expect(request.httpMethod == "GET")
        #expect(request.httpBody == nil)
        #expect(request.url?.absoluteString == "https://gateway.test/base/v2/apps/test-app/me")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer gateway-token")
        let proof = try #require(request.value(forHTTPHeaderField: "X-AppAttest-Proof"))
        let parts = proof.split(separator: ".").map(String.init)
        let expected = AppAIGatewayClient.requestClientData(
            appID: "test-app",
            method: "GET",
            pathAndQuery: "/base/v2/apps/test-app/me",
            body: nil,
            token: "gateway-token",
            timestamp: try #require(Int(parts[1])),
            nonce: parts[2]
        ).sha256
        let signed = try #require(signatures.snapshot().last)
        #expect(signed.keyID == "existing-key")
        #expect(signed.hash == expected)
    }

    @Test
    func currentUserRequestRecoversADeadKeyLikeAnyOtherRequest() async throws {
        let dying = DyingKeys()
        let registers = LockedCounter()
        let tokens = LockedCounter()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            if request.url!.path.hasSuffix("/auth/register") {
                registers.increment()
                return response(request, status: 200, body: #"{"user_id":"generated-key"}"#)
            }
            if request.url!.path.hasSuffix("/auth/failure") {
                return response(request, status: 200, body: #"{"recorded":true}"#)
            }
            let issued = tokens.increment()
            return response(request, status: 200, body: "{\"access_token\":\"token-\(issued)\",\"expires_in\":3600,\"verify_on\":\"every_request\"}")
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            attestProvider: MockAttestProvider(dying: dying),
            credentialStore: MemoryCredentialStore(keyID: "existing-key"),
            session: session()
        )
        _ = try await client.gatewayAccessToken()
        dying.kill("existing-key")
        let request = try await client.currentUserRequest()
        #expect(registers.snapshot() == 1)
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer token-2")
        #expect(request.value(forHTTPHeaderField: "X-AppAttest-Proof") != nil)
    }

    @Test
    func currentUserRequestInAPIKeyModeCarriesTheKeyAndNoProof() async throws {
        MockURLProtocol.handler = { request in response(request, status: 500, body: "{}") }
        let client = AppAIGatewayClient(
            appID: "machine-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .apiKey(key: "agw_machine-key"),
            endUserId: "customer-42",
            session: session()
        )
        let request = try await client.currentUserRequest()
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer agw_machine-key")
        #expect(request.value(forHTTPHeaderField: "X-End-User-ID") == "customer-42")
        #expect(request.value(forHTTPHeaderField: "X-AppAttest-Proof") == nil)
    }

    // MARK: The URL as the gateway reads it

    private struct URLGolden: Decodable {
        struct Fixed: Decodable {
            let appId: String
            let method: String
            let body: String
            let token: String
            let timestamp: String
            let nonce: String
        }
        struct Case: Decodable {
            let name: String
            let path: String
            let query: String?
            let pathAndQuery: String
            let clientData: String
        }
        let fixed: Fixed
        let cases: [Case]
    }

    /// The same file `v2/test/request-proof.test.ts` reads, where each
    /// `pathAndQuery` is checked against the gateway runtime's own URL parser.
    /// `request-proof-urls.json` beside it is the earlier gateway's, under
    /// `/v1`, which that gateway's own tests still read.
    private func urlGolden() throws -> URLGolden {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appending(path: "Fixtures/request-proof-urls-v2.json")
        return try JSONDecoder().decode(URLGolden.self, from: Data(contentsOf: file))
    }

    @Test
    func pathsAndQueriesAreSignedAsTheGatewayReadsThem() throws {
        let golden = try urlGolden()
        #expect(golden.cases.count >= 5)
        for fixture in golden.cases {
            let path = AppAIGatewayClient.whatwgPath(fixture.path)
            let pathAndQuery = fixture.query.map { "\(path)?\(AppAIGatewayClient.whatwgQuery($0))" } ?? path
            #expect(pathAndQuery == fixture.pathAndQuery, "\(fixture.name)")
            let clientData = AppAIGatewayClient.requestClientData(
                appID: golden.fixed.appId,
                method: golden.fixed.method,
                pathAndQuery: pathAndQuery,
                body: Data(golden.fixed.body.utf8),
                token: golden.fixed.token,
                timestamp: Int(golden.fixed.timestamp)!,
                nonce: golden.fixed.nonce
            )
            #expect(String(data: clientData, encoding: .utf8) == fixture.clientData, "\(fixture.name)")
            // Normalizing what is already normal changes nothing, so signing
            // the URL that is sent signs the same bytes again.
            #expect(AppAIGatewayClient.whatwgPath(path) == path, "\(fixture.name)")
        }
    }

    /// The URL that is sent is the normalized one, not only the string that
    /// is signed: a query with an apostrophe travels as `%27`, which is what
    /// the gateway's parser would have made of it anyway.
    @Test
    func theSentURLIsTheNormalizedOne() throws {
        let url = try #require(URL(string: "https://gateway.test/base/v2/apps/a/proxy/openai/./v1/x/../responses?q=it's"))
        let normalized = AppAIGatewayClient.whatwgNormalized(url)
        #expect(normalized.absoluteString == "https://gateway.test/base/v2/apps/a/proxy/openai/v1/responses?q=it%27s")
        #expect(AppAIGatewayClient.pathAndQuery(of: normalized) == "/base/v2/apps/a/proxy/openai/v1/responses?q=it%27s")
        let withPort = try #require(URL(string: "http://localhost:8787/v2/apps/a/me"))
        #expect(AppAIGatewayClient.whatwgNormalized(withPort).absoluteString == "http://localhost:8787/v2/apps/a/me")
    }

    @Test
    func aSignedRequestTravelsOnTheNormalizedURL() async throws {
        let signatures = SignatureLog()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            return response(request, status: 200, body: #"{"access_token":"gateway-token","expires_in":3600,"verify_on":"every_request"}"#)
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            attestProvider: MockAttestProvider(signatures: signatures),
            credentialStore: MemoryCredentialStore(keyID: "existing-key"),
            session: session()
        )
        let request = try await client.authorizedRequest(
            provider: .openai, providerPath: "v1/./models/../responses", body: Data("{}".utf8)
        )
        #expect(request.url?.absoluteString == "https://gateway.test/v2/apps/test-app/proxy/openai/v1/responses")
        let parts = try #require(request.value(forHTTPHeaderField: "X-AppAttest-Proof")).split(separator: ".").map(String.init)
        let expected = AppAIGatewayClient.requestClientData(
            appID: "test-app", method: "POST",
            pathAndQuery: "/v2/apps/test-app/proxy/openai/v1/responses",
            body: Data("{}".utf8), token: "gateway-token",
            timestamp: try #require(Int(parts[1])), nonce: parts[2]
        ).sha256
        #expect(signatures.snapshot().last?.hash == expected)
    }

    /// An exchange already in flight when the token is discarded — a
    /// background refresh, say, answered under token_exchange — is not joined
    /// by the rebuilt request: that one starts its own exchange, signs with
    /// its token, and the overtaken result is never cached.
    @Test
    func aDiscardedTokenIsNotReplacedByAnExchangeAlreadyInFlight() async throws {
        let tokens = LockedCounter()
        // Assertion 1 is the overtaken exchange's, 2 the fresh exchange's,
        // and 3 the rebuilt request's own proof.
        let gates = AssertionGates(gated: [1, 2])
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            let issued = tokens.increment()
            let verifyOn = issued == 1 ? "token_exchange" : "every_request"
            return response(
                request,
                status: 200,
                body: "{\"access_token\":\"token-\(issued)\",\"expires_in\":3600,\"verify_on\":\"\(verifyOn)\"}"
            )
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            attestProvider: GatedAttestProvider(gates: gates),
            credentialStore: MemoryCredentialStore(keyID: "existing-key"),
            session: session()
        )
        let overtaken = Task { try await client.gatewayAccessToken() }
        #expect(try await gates.held(1))

        await client.discardAccessToken()
        let rebuilt = Task {
            try await client.authorizedRequest(provider: .openai, providerPath: "v1/responses", body: Data("{}".utf8))
        }
        // A second exchange started rather than joining the first.
        let started = try await gates.held(2)
        #expect(started)

        // The overtaken exchange finishes first, for the caller already on it.
        gates.open(1)
        #expect(try await overtaken.value == "token-1")
        // Asked while the fresh exchange is still held: a cached token-1 would
        // answer at once, and an uncached one joins the fresh exchange.
        let probe = Task { try await client.gatewayAccessToken() }
        gates.open(2)
        #expect(try await probe.value == "token-2")
        let request = try await rebuilt.value
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer token-2")
        #expect(request.value(forHTTPHeaderField: "X-AppAttest-Proof") != nil)
        // The cache holds the fresh token, and nothing exchanges again.
        #expect(try await client.gatewayAccessToken() == "token-2")
        #expect(tokens.snapshot() == 2)
    }

    // MARK: withAuthorizedRequest

    /// A gateway whose tokens are numbered in the order it mints them, each
    /// answering `verifyOn(n)`, and a client of it that verifies App Attest.
    private func numberedTokenClient(
        tokens: LockedCounter,
        signatures: SignatureLog = SignatureLog(),
        verifyOn: @escaping @Sendable (Int) -> String = { _ in "every_request" }
    ) -> AppAIGatewayClient {
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            let issued = tokens.increment()
            return response(
                request,
                status: 200,
                body: "{\"access_token\":\"token-\(issued)\",\"expires_in\":3600,\"verify_on\":\"\(verifyOn(issued))\"}"
            )
        }
        return AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            attestProvider: MockAttestProvider(signatures: signatures),
            credentialStore: MemoryCredentialStore(keyID: "existing-key"),
            session: session()
        )
    }

    /// A 401 is answered by a request built afresh, a new token and a new
    /// proof, never by re-sending the one already spent.
    @Test
    func withAuthorizedRequestRebuildsAndResendsOnceOnA401() async throws {
        let tokens = LockedCounter()
        let client = numberedTokenClient(tokens: tokens)
        let transport = FakeTransport(statuses: [401, 200])
        let body = Data(#"{"input":"hi"}"#.utf8)
        let (data, response) = try await client.withAuthorizedRequest(
            provider: .openai,
            providerPath: "v1/responses",
            body: body,
            contentType: "application/json",
            send: transport.send
        )
        #expect((response as? HTTPURLResponse)?.statusCode == 200)
        #expect(String(decoding: data, as: UTF8.self) == "attempt-2")
        let sent = transport.snapshot()
        #expect(sent.count == 2)
        #expect(tokens.snapshot() == 2)
        #expect(sent[0].value(forHTTPHeaderField: "Authorization") == "Bearer token-1")
        #expect(sent[1].value(forHTTPHeaderField: "Authorization") == "Bearer token-2")
        let firstProof = try #require(sent[0].value(forHTTPHeaderField: "X-AppAttest-Proof"))
        let secondProof = try #require(sent[1].value(forHTTPHeaderField: "X-AppAttest-Proof"))
        #expect(firstProof != secondProof)
        for request in sent {
            #expect(request.url?.absoluteString == "https://gateway.test/v2/apps/test-app/proxy/openai/v1/responses")
            #expect(request.httpBody == body)
            #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        }
    }

    @Test
    func withAuthorizedRequestSendsOnceWhenTheFirstAnswerIsNot401() async throws {
        for status in [200, 403, 429, 500] {
            let tokens = LockedCounter()
            let client = numberedTokenClient(tokens: tokens)
            let transport = FakeTransport(statuses: [status, 200])
            let (data, response) = try await client.withAuthorizedRequest(
                provider: "openai",
                providerPath: "v1/responses",
                body: Data("{}".utf8),
                send: transport.send
            )
            #expect((response as? HTTPURLResponse)?.statusCode == status)
            #expect(String(decoding: data, as: UTF8.self) == "attempt-1")
            #expect(transport.snapshot().count == 1)
            #expect(tokens.snapshot() == 1)
        }
    }

    /// Transport failures are the app's: rethrown, not retried, and the token
    /// the client holds is kept.
    @Test
    func withAuthorizedRequestRethrowsWhatSendThrowsWithoutRetrying() async throws {
        let tokens = LockedCounter()
        let client = numberedTokenClient(tokens: tokens)
        let calls = LockedCounter()
        await #expect(throws: URLError.self) {
            _ = try await client.withAuthorizedRequest(
                provider: .openai,
                providerPath: "v1/responses",
                body: Data("{}".utf8)
            ) { (_: URLRequest) async throws -> (Data, URLResponse) in
                calls.increment()
                throw URLError(.notConnectedToInternet)
            }
        }
        #expect(calls.snapshot() == 1)
        #expect(try await client.gatewayAccessToken() == "token-1")
        #expect(tokens.snapshot() == 1)
    }

    /// A second refusal is real: returned to the caller, never a third send.
    @Test
    func withAuthorizedRequestReturnsASecond401WithoutAThirdSend() async throws {
        let tokens = LockedCounter()
        let client = numberedTokenClient(tokens: tokens)
        let transport = FakeTransport(statuses: [401, 401, 200])
        let (data, response) = try await client.withAuthorizedRequest(
            provider: .openai,
            providerPath: "v1/responses",
            body: Data("{}".utf8),
            send: transport.send
        )
        #expect((response as? HTTPURLResponse)?.statusCode == 401)
        #expect(String(decoding: data, as: UTF8.self) == "attempt-2")
        #expect(transport.snapshot().count == 2)
        #expect(tokens.snapshot() == 2)
    }

    /// The `assertion_required` case: a token cached under token_exchange
    /// sends the endpoint request unsigned, and the rebuilt one is signed.
    @Test
    func withAuthorizedRequestToAnEndpointPicksUpASwitchToEveryRequest() async throws {
        let tokens = LockedCounter()
        let signatures = SignatureLog()
        let client = numberedTokenClient(
            tokens: tokens,
            signatures: signatures,
            verifyOn: { $0 == 1 ? "token_exchange" : "every_request" }
        )
        let transport = FakeTransport(statuses: [401, 200])
        let (_, response) = try await client.withAuthorizedRequest(
            preset: "chat",
            body: Data("{}".utf8),
            send: transport.send
        )
        #expect((response as? HTTPURLResponse)?.statusCode == 200)
        let sent = transport.snapshot()
        #expect(sent.count == 2)
        #expect(sent.allSatisfy { $0.url?.absoluteString == "https://gateway.test/v2/apps/test-app/presets/chat" })
        #expect(sent[0].value(forHTTPHeaderField: "Authorization") == "Bearer token-1")
        #expect(sent[0].value(forHTTPHeaderField: "X-AppAttest-Proof") == nil)
        #expect(sent[1].value(forHTTPHeaderField: "Authorization") == "Bearer token-2")
        #expect(sent[1].value(forHTTPHeaderField: "X-AppAttest-Proof") != nil)
    }

    @Test
    func withCurrentUserRequestRebuildsMeOnA401() async throws {
        let tokens = LockedCounter()
        let client = numberedTokenClient(tokens: tokens)
        let transport = FakeTransport(statuses: [401, 200])
        let (_, response) = try await client.withCurrentUserRequest(send: transport.send)
        #expect((response as? HTTPURLResponse)?.statusCode == 200)
        let sent = transport.snapshot()
        #expect(sent.count == 2)
        for request in sent {
            #expect(request.httpMethod == "GET")
            #expect(request.url?.absoluteString == "https://gateway.test/v2/apps/test-app/me")
        }
        #expect(sent[1].value(forHTTPHeaderField: "Authorization") == "Bearer token-2")
        #expect(
            sent[0].value(forHTTPHeaderField: "X-AppAttest-Proof")
                != sent[1].value(forHTTPHeaderField: "X-AppAttest-Proof")
        )
    }

    /// A body that is a stream, as `URLSession.bytes(for:)` returns: the
    /// helper is generic over it, and hands back the second attempt's stream.
    @Test
    func withAuthorizedRequestPassesAStreamingBodyThrough() async throws {
        let tokens = LockedCounter()
        let client = numberedTokenClient(tokens: tokens)
        let calls = LockedCounter()
        let (stream, response) = try await client.withAuthorizedRequest(
            provider: .anthropic,
            providerPath: "v1/messages",
            body: Data(#"{"stream":true}"#.utf8),
            contentType: "application/json"
        ) { request -> (AsyncStream<String>, URLResponse) in
            let attempt = calls.increment()
            let status = attempt == 1 ? 401 : 200
            let stream = AsyncStream<String> { continuation in
                continuation.yield("event-\(attempt)-a")
                continuation.yield("event-\(attempt)-b")
                continuation.finish()
            }
            let marked = status == 401 ? ["X-AGW-Error": "auth_required"] : [:]
            return (stream, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: marked)!)
        }
        #expect((response as? HTTPURLResponse)?.statusCode == 200)
        var events: [String] = []
        for await event in stream { events.append(event) }
        #expect(events == ["event-2-a", "event-2-b"])
        #expect(calls.snapshot() == 2)
    }

    // MARK: The package's own version

    /// A release is cut from `VERSION`, so the version the package names itself
    /// with has to be that one: bump both together.
    @Test
    func theClientSDKVersionIsThePackageVersion() throws {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appending(path: "VERSION")
        let version = try String(contentsOf: file, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        #expect(ClientSDK.version == version)
        #expect(ClientSDK.headerValue == "app-ai-gateway-swift/\(version)")
    }

    /// Every request an App Attest client sends — challenge, register, token —
    /// and every one it builds — provider, endpoint, `/me` — names the package,
    /// and a signed one is signed exactly as it was before the header existed.
    @Test
    func everyAppAttestRequestNamesThePackageAndStillSignsTheSameBytes() async throws {
        let sent = SentHeaders()
        let signatures = SignatureLog()
        MockURLProtocol.handler = { request in
            sent.record(request)
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            if request.url!.path.hasSuffix("/auth/register") {
                return response(request, status: 200, body: #"{"user_id":"generated-key"}"#)
            }
            return response(request, status: 200, body: #"{"access_token":"gateway-token","expires_in":3600,"verify_on":"every_request"}"#)
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            attestProvider: MockAttestProvider(signatures: signatures),
            // No key yet, so the exchange registers one first.
            credentialStore: MemoryCredentialStore(),
            session: session()
        )
        let body = Data(#"{"model":"gpt-5.6-sol","input":"hi"}"#.utf8)
        let built = [
            try await client.authorizedRequest(provider: .openai, providerPath: "v1/responses", body: body),
            try await client.authorizedRequest(preset: "chat", body: body),
            try await client.currentUserRequest(),
        ]

        let paths = sent.snapshot().map(\.path)
        #expect(paths.contains { $0.hasSuffix("/auth/challenge") })
        #expect(paths.contains { $0.hasSuffix("/auth/register") })
        #expect(paths.contains { $0.hasSuffix("/auth/token") })
        for request in sent.snapshot() {
            #expect(request.clientSDK == ClientSDK.headerValue, "\(request.path)")
            #expect(request.appVersion != nil, "\(request.path)")
        }
        for request in built {
            #expect(request.value(forHTTPHeaderField: "X-Client-SDK") == ClientSDK.headerValue)
            #expect(request.value(forHTTPHeaderField: "X-App-Version") != nil)
        }

        // The proof is over the method, URL, body and token alone: the bytes
        // the gateway rebuilds, with no header among them.
        let proxy = try #require(built.first)
        let proof = try #require(proxy.value(forHTTPHeaderField: "X-AppAttest-Proof"))
        let parts = proof.split(separator: ".").map(String.init)
        let expected = AppAIGatewayClient.requestClientData(
            appID: "test-app",
            method: "POST",
            pathAndQuery: "/v2/apps/test-app/proxy/openai/v1/responses",
            body: body,
            token: "gateway-token",
            timestamp: try #require(Int(parts[1])),
            nonce: parts[2]
        ).sha256
        let requestSignatures = signatures.snapshot().suffix(3)
        #expect(requestSignatures.first?.hash == expected)
    }

    @Test
    func apiKeyRequestsAndTheirExchangeNameThePackage() async throws {
        let sent = SentHeaders()
        MockURLProtocol.handler = { request in
            sent.record(request)
            return response(request, status: 200, body: #"{"access_token":"gateway-token","expires_in":3600}"#)
        }
        let exchanging = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .apiKey(key: "agw_test-key", issuerTokenProvider: { _ in "firebase-token" }),
            session: session()
        )
        let proxied = try await exchanging.authorizedRequest(provider: .openai, providerPath: "v1/responses")
        #expect(proxied.value(forHTTPHeaderField: "X-Client-SDK") == ClientSDK.headerValue)
        let exchange = try #require(sent.snapshot().first)
        #expect(exchange.path.hasSuffix("/auth/token"))
        #expect(exchange.clientSDK == ClientSDK.headerValue)

        // A key sent directly has no exchange, so the request it builds is
        // the only one that can name the package.
        let direct = AppAIGatewayClient(
            appID: "machine-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .apiKey(key: "agw_machine-key"),
            session: session()
        )
        let me = try await direct.currentUserRequest()
        #expect(me.value(forHTTPHeaderField: "X-Client-SDK") == ClientSDK.headerValue)
        let endpoint = try await direct.authorizedRequest(preset: "chat")
        #expect(endpoint.value(forHTTPHeaderField: "X-Client-SDK") == ClientSDK.headerValue)
    }

    // MARK: - v2: keys per user, the attest recovery, gateway links

    /// A JWT whose payload names `iss` and `sub`, unsigned: the client reads
    /// only who it is about, and the gateway checks the rest.
    private static func jwt(iss: String = "https://issuer.test", sub: String) -> String {
        func part(_ object: [String: Any]) -> String {
            (try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])).base64URLEncodedString()
        }
        return "\(part(["alg": "RS256"])).\(part(["iss": iss, "sub": sub])).c2lnbmF0dXJl"
    }

    /// Each signed-in user on one install has a key of their own: a second
    /// user gets a new one, and the first user's comes back unchanged.
    @Test
    func eachSignedInUserKeepsAKeyOfTheirOwn() async throws {
        let user = LockedValue("alice")
        let tokenBodies = TokenBodyLog()
        let registrations = LockedCounter()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            if request.url!.path.hasSuffix("/auth/register") {
                registrations.increment()
                return response(request, status: 200, body: #"{"user_id":"u"}"#)
            }
            tokenBodies.record(request)
            return response(request, status: 200, body: #"{"access_token":"token","expires_in":3600}"#)
        }
        let store = MemoryCredentialStore()
        let keys = LockedCounter()
        // One client per signed-in session, as the README says.
        func signIn(_ name: String) -> AppAIGatewayClient {
            user.set(name)
            return AppAIGatewayClient(
                appID: "test-app",
                baseURL: URL(string: "https://gateway.test")!,
                authMode: .appAttest(issuerTokenProvider: { _ in Self.jwt(sub: user.get()) }),
                attestProvider: MockAttestProvider(numberedKeys: keys),
                credentialStore: store,
                session: session()
            )
        }
        var client = signIn("alice")
        _ = try await client.gatewayAccessToken()
        await client.invalidate()
        client = signIn("bob")
        _ = try await client.gatewayAccessToken()
        await client.invalidate()
        client = signIn("alice")
        _ = try await client.gatewayAccessToken()

        #expect(registrations.snapshot() == 2)
        #expect(tokenBodies.snapshot().map { $0["key_id"] } == ["generated-key-1", "generated-key-2", "generated-key-1"])
        let alice = await client.keySlot(issuerToken: Self.jwt(sub: "alice"))
        let bob = await client.keySlot(issuerToken: Self.jwt(sub: "bob"))
        #expect(alice != bob)
        #expect(alice.hasPrefix("test-app#"))
        #expect(store.places() == [alice: "generated-key-1", bob: "generated-key-2"])
    }

    /// A key an earlier release kept in the app's one place is tried for the
    /// first user who signs in, and becomes theirs once the gateway takes it.
    @Test
    func aKeyKeptBeforeKeysWerePerUserBecomesTheFirstUsers() async throws {
        let registrations = LockedCounter()
        let tokenBodies = TokenBodyLog()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            if request.url!.path.hasSuffix("/auth/register") {
                registrations.increment()
                return response(request, status: 200, body: #"{"user_id":"u"}"#)
            }
            tokenBodies.record(request)
            return response(request, status: 200, body: #"{"access_token":"token","expires_in":3600}"#)
        }
        let store = MemoryCredentialStore(keyID: "earlier-key")
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttest(issuerTokenProvider: { _ in Self.jwt(sub: "alice") }),
            attestProvider: MockAttestProvider(),
            credentialStore: store,
            session: session()
        )
        _ = try await client.gatewayAccessToken()
        #expect(registrations.snapshot() == 0)
        #expect(tokenBodies.snapshot().map { $0["key_id"] } == ["earlier-key"])
        let alice = await client.keySlot(issuerToken: Self.jwt(sub: "alice"))
        #expect(store.places() == [alice: "earlier-key"])
        #expect(try store.appAttestKeyID(for: "test-app") == nil)
    }

    /// A sign-in token that is not a JWT naming `iss` and `sub` keeps one key
    /// for the app, as before.
    @Test
    func aTokenThatNamesNoUserUsesTheAppsOnePlace() async {
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            session: session()
        )
        #expect(await client.keySlot(issuerToken: nil) == "test-app")
        #expect(await client.keySlot(issuerToken: "opaque-token") == "test-app")
        #expect(await client.keySlot(issuerToken: Self.jwt(iss: "", sub: "alice")) == "test-app")
        #expect(AppAIGatewayClient.issuerUser(Self.jwt(sub: "alice")) == AppAIGatewayClient.issuerUser(Self.jwt(sub: "alice")))
        #expect(AppAIGatewayClient.issuerUser(Self.jwt(sub: "alice")) != AppAIGatewayClient.issuerUser(Self.jwt(iss: "https://other.test", sub: "alice")))
    }

    /// A signed request refused with `attest_failed` is sent once more with a
    /// fresh proof; refused again, the key is replaced, a token is got for the
    /// new one, and the request goes a third time.
    @Test
    func aSignedRequestRefusedTwiceGetsANewKeyAndToken() async throws {
        let tokens = LockedCounter()
        let attestations = LockedCounter()
        let sends = LockedCounter()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            if request.url!.path.hasSuffix("/auth/register") {
                return response(request, status: 200, body: #"{"user_id":"u"}"#)
            }
            let n = tokens.increment()
            return response(request, status: 200, body: "{\"access_token\":\"t\(n)\",\"expires_in\":3600,\"verify_on\":\"every_request\"}")
        }
        let store = MemoryCredentialStore(keyID: "kept-key")
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            attestProvider: MockAttestProvider(attestations: attestations),
            credentialStore: store,
            session: session()
        )
        let seen = RequestHeaderLog()
        let (data, answer) = try await client.withAuthorizedRequest(
            provider: .openai,
            providerPath: "v1/responses",
            body: Data("{}".utf8)
        ) { request in
            seen.record(request)
            let n = sends.increment()
            let marked = n < 3 ? ["X-AGW-Error": "attest_failed"] : [:]
            let http = HTTPURLResponse(url: request.url!, statusCode: n < 3 ? 403 : 200, httpVersion: nil, headerFields: marked)!
            let body = n < 3 ? #"{"error":{"code":"attest_failed","message":"no"}}"# : "{}"
            return (Data(body.utf8), http as URLResponse)
        }
        #expect((answer as? HTTPURLResponse)?.statusCode == 200)
        #expect(String(data: data, encoding: .utf8) == "{}")
        #expect(sends.snapshot() == 3)
        #expect(attestations.snapshot() == 1)
        #expect(try store.appAttestKeyID(for: "test-app") == "generated-key")
        let sent = seen.snapshot()
        #expect(sent.map { $0["Authorization"] } == ["Bearer t1", "Bearer t1", "Bearer t2"])
        #expect(Set(sent.compactMap { $0["X-AppAttest-Proof"] }).count == 3)
    }

    /// Any other `403` is the caller's to read: nothing is sent again.
    @Test
    func anotherRefusedRequestIsNotSentAgain() async throws {
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            return response(request, status: 200, body: #"{"access_token":"t","expires_in":3600,"verify_on":"every_request"}"#)
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            attestProvider: MockAttestProvider(),
            credentialStore: MemoryCredentialStore(keyID: "kept-key"),
            session: session()
        )
        let sends = LockedCounter()
        let (_, answer) = try await client.withAuthorizedRequest(provider: .openai, providerPath: "v1/responses") { request in
            sends.increment()
            let http = HTTPURLResponse(url: request.url!, statusCode: 403, httpVersion: nil, headerFields: nil)!
            return (Data(#"{"error":{"code":"path_not_allowed","message":"no"}}"#.utf8), http as URLResponse)
        }
        #expect((answer as? HTTPURLResponse)?.statusCode == 403)
        #expect(sends.snapshot() == 1)
    }

    /// A provider's own `401` or `403`, unmarked by the gateway, is the
    /// caller's: never sent again, whatever its body says.
    @Test
    func aProvidersOwnRefusalIsNeverSentAgain() async throws {
        for (status, body) in [
            (401, #"{"error":{"code":"auth_required","message":"bad key"}}"#),
            (403, #"{"error":{"code":"attest_failed","message":"looks like ours"}}"#),
        ] {
            let tokens = LockedCounter()
            let client = numberedTokenClient(tokens: tokens)
            let sends = LockedCounter()
            let (_, answer) = try await client.withAuthorizedRequest(provider: .openai, providerPath: "v1/responses") { request in
                sends.increment()
                let http = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
                return (Data(body.utf8), http as URLResponse)
            }
            #expect((answer as? HTTPURLResponse)?.statusCode == status)
            #expect(sends.snapshot() == 1)
            #expect(tokens.snapshot() == 1)
        }
    }

    /// A streamed `403 attest_failed` is recovered from like any other: the
    /// gateway's header says so, and the body is never read.
    @Test
    func aStreamedAttestRefusalIsRecoveredByTheHeaderAlone() async throws {
        let tokens = LockedCounter()
        let client = numberedTokenClient(tokens: tokens)
        let sends = LockedCounter()
        let (stream, answer) = try await client.withAuthorizedRequest(provider: .openai, providerPath: "v1/responses") { request -> (AsyncStream<String>, URLResponse) in
            let n = sends.increment()
            let stream = AsyncStream<String> { continuation in
                continuation.yield("answer-\(n)")
                continuation.finish()
            }
            let marked = n == 1 ? ["X-AGW-Error": "attest_failed"] : [:]
            return (stream, HTTPURLResponse(url: request.url!, statusCode: n == 1 ? 403 : 200, httpVersion: nil, headerFields: marked)!)
        }
        #expect((answer as? HTTPURLResponse)?.statusCode == 200)
        var events: [String] = []
        for await event in stream { events.append(event) }
        #expect(events == ["answer-2"])
        #expect(sends.snapshot() == 2)
    }

    /// A user switch while a request is out: the old client is ended, and its
    /// refused request comes back as it is, never rebuilt with anyone's
    /// credentials; the ended client builds nothing more.
    @Test
    func anEndedClientNeverSendsARefusedRequestAgain() async throws {
        let tokens = LockedCounter()
        let client = numberedTokenClient(tokens: tokens)
        let sends = LockedCounter()
        let (_, answer) = try await client.withAuthorizedRequest(provider: .openai, providerPath: "v1/responses") { request in
            sends.increment()
            // The user signs out while this request is out.
            await client.invalidate()
            let http = HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: ["X-AGW-Error": "auth_required"])!
            return (Data(), http as URLResponse)
        }
        #expect((answer as? HTTPURLResponse)?.statusCode == 401)
        #expect(sends.snapshot() == 1)
        #expect(tokens.snapshot() == 1)
        await #expect(throws: GatewayClientInvalidated.self) {
            _ = try await client.authorizedRequest(provider: .openai, providerPath: "v1/responses")
        }
        await #expect(throws: GatewayClientInvalidated.self) {
            _ = try await client.gatewayAccessToken()
        }
    }

    /// Many requests refused with the same key at once register one
    /// replacement between them, not one each.
    @Test
    func parallelRefusalsShareOneReplacementKey() async throws {
        let tokens = LockedCounter()
        let attestations = LockedCounter()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            if request.url!.path.hasSuffix("/auth/register") {
                return response(request, status: 200, body: #"{"user_id":"u"}"#)
            }
            let n = tokens.increment()
            return response(request, status: 200, body: "{\"access_token\":\"t\(n)\",\"expires_in\":3600,\"verify_on\":\"every_request\"}")
        }
        let store = MemoryCredentialStore(keyID: "kept-key")
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            attestProvider: MockAttestProvider(attestations: attestations, numberedKeys: LockedCounter()),
            credentialStore: store,
            session: session()
        )
        _ = try await client.gatewayAccessToken()
        let statuses = try await withThrowingTaskGroup(of: Int.self) { group in
            for _ in 0..<8 {
                group.addTask {
                    let (_, answer) = try await client.withAuthorizedRequest(provider: .openai, providerPath: "v1/responses") { request in
                        // Every request signed by the kept key is refused.
                        let refused = request.value(forHTTPHeaderField: "Authorization") == "Bearer t1"
                        let marked = refused ? ["X-AGW-Error": "attest_failed"] : [:]
                        let http = HTTPURLResponse(url: request.url!, statusCode: refused ? 403 : 200, httpVersion: nil, headerFields: marked)!
                        return (Data(), http as URLResponse)
                    }
                    return (answer as? HTTPURLResponse)?.statusCode ?? 0
                }
            }
            return try await group.reduce(into: []) { $0.append($1) }
        }
        #expect(statuses == Array(repeating: 200, count: 8))
        #expect(attestations.snapshot() == 1)
        #expect(tokens.snapshot() == 2)
        #expect(try store.appAttestKeyID(for: "test-app") == "generated-key-1")
    }

    /// A late `401` for a token another request has already replaced does not
    /// throw the replacement away: two refused at once cost one new token.
    @Test
    func aLateRefusalKeepsTheTokenAnotherRequestAlreadyGot() async throws {
        let tokens = LockedCounter()
        let client = numberedTokenClient(tokens: tokens)
        _ = try await client.gatewayAccessToken()
        try await withThrowingTaskGroup(of: Void.self) { group in
            for _ in 0..<2 {
                group.addTask {
                    let (_, answer) = try await client.withAuthorizedRequest(provider: .openai, providerPath: "v1/responses") { request in
                        let stale = request.value(forHTTPHeaderField: "Authorization") == "Bearer token-1"
                        let marked = stale ? ["X-AGW-Error": "auth_required"] : [:]
                        return (Data(), HTTPURLResponse(url: request.url!, statusCode: stale ? 401 : 200, httpVersion: nil, headerFields: marked)! as URLResponse)
                    }
                    #expect((answer as? HTTPURLResponse)?.statusCode == 200)
                }
            }
            try await group.waitForAll()
        }
        #expect(tokens.snapshot() == 2)
    }

    /// A status link's redirect to the result is followed with a new request
    /// signed for the result; one to anywhere else comes back as it is.
    @Test
    func aStatusLinksRedirectIsFollowedWithItsOwnProof() async throws {
        let tokens = LockedCounter()
        let client = numberedTokenClient(tokens: tokens)
        let status = URL(string: "https://gateway.test/v2/apps/test-app/jobs/job-1/status")!
        let result = "https://gateway.test/v2/apps/test-app/jobs/job-1"
        let seen = RequestHeaderLog()
        let urls = LockedValue<[String]>([])
        let (data, answer) = try await client.withAuthorizedRequest(gatewayLink: status) { request in
            seen.record(request)
            urls.set(urls.get() + [request.url!.absoluteString])
            if request.url == status {
                let http = HTTPURLResponse(url: request.url!, statusCode: 303, httpVersion: nil, headerFields: ["Location": result])!
                return (Data(), http as URLResponse)
            }
            return (Data("done".utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)! as URLResponse)
        }
        #expect((answer as? HTTPURLResponse)?.statusCode == 200)
        #expect(String(data: data, encoding: .utf8) == "done")
        #expect(urls.get() == [status.absoluteString, result])
        let proofs = seen.snapshot().compactMap { $0["X-AppAttest-Proof"] }
        #expect(proofs.count == 2)
        #expect(Set(proofs).count == 2)

        let (_, away) = try await client.withAuthorizedRequest(gatewayLink: status, method: "PUT") { request in
            #expect(request.httpMethod == "PUT")
            let http = HTTPURLResponse(url: request.url!, statusCode: 302, httpVersion: nil, headerFields: ["Location": "https://cdn.example.test/out.png"])!
            return (Data(), http as URLResponse)
        }
        #expect((away as? HTTPURLResponse)?.statusCode == 302)
    }

    /// A key 1.x kept in the app's one place goes to one user only, and is not
    /// used at all if it cannot be taken out of that place.
    @Test
    func aKeyKeptBy1xGoesToOneUserOnly() async throws {
        let registrations = LockedCounter()
        let tokenBodies = TokenBodyLog()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            if request.url!.path.hasSuffix("/auth/register") {
                registrations.increment()
                return response(request, status: 200, body: #"{"user_id":"u"}"#)
            }
            tokenBodies.record(request)
            return response(request, status: 200, body: #"{"access_token":"token","expires_in":3600}"#)
        }
        let store = MemoryCredentialStore(keyID: "earlier-key")
        let keys = LockedCounter()
        for name in ["alice", "bob"] {
            let client = AppAIGatewayClient(
                appID: "test-app",
                baseURL: URL(string: "https://gateway.test")!,
                authMode: .appAttest(issuerTokenProvider: { _ in Self.jwt(sub: name) }),
                attestProvider: MockAttestProvider(numberedKeys: keys),
                credentialStore: store,
                session: session()
            )
            _ = try await client.gatewayAccessToken()
            await client.invalidate()
        }
        #expect(tokenBodies.snapshot().map { $0["key_id"] } == ["earlier-key", "generated-key-1"])
        #expect(registrations.snapshot() == 1)

        let stuck = UndeletableStore(keyID: "earlier-key")
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttest(issuerTokenProvider: { _ in Self.jwt(sub: "carol") }),
            attestProvider: MockAttestProvider(numberedKeys: keys),
            credentialStore: stuck,
            session: session()
        )
        _ = try await client.gatewayAccessToken()
        #expect(tokenBodies.snapshot().last?["key_id"] == "generated-key-2")
    }

    /// An app that names its signed-in user keeps keys by that name, whatever
    /// the sign-in token's `sub` is.
    @Test
    func anAppsOwnUserIDNamesTheKeysPlace() async {
        let named = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttest(issuerTokenProvider: { _ in "opaque" }),
            signedInUserID: "user-42",
            session: session()
        )
        let other = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttest(issuerTokenProvider: { _ in "opaque" }),
            signedInUserID: "user-43",
            session: session()
        )
        let a = await named.keySlot(issuerToken: Self.jwt(sub: "same"))
        let b = await other.keySlot(issuerToken: Self.jwt(sub: "same"))
        #expect(a != b)
        #expect(a.hasPrefix("test-app#id-"))
        // Install mode has no user: the app's one place.
        let install = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            signedInUserID: "ignored",
            session: session()
        )
        #expect(await install.keySlot(issuerToken: nil) == "test-app")
    }

    /// A sign-in token the app could not fetch is reported, under a challenge
    /// fetched for the report, as 1.x reported it.
    @Test
    func aSignInTokenThatCannotBeFetchedIsReported() async throws {
        let reports = FailureReportLog()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            if request.url!.path.hasSuffix("/auth/failure") {
                reports.record(request)
                return response(request, status: 200, body: #"{"recorded":true}"#)
            }
            return response(request, status: 500, body: "{}")
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttest(issuerTokenProvider: { _ in throw URLError(.timedOut) }),
            attestProvider: MockAttestProvider(),
            credentialStore: MemoryCredentialStore(keyID: "kept-key"),
            session: session()
        )
        await #expect(throws: URLError.self) { _ = try await client.gatewayAccessToken() }
        await client.settleFailureReports()
        let report = try #require(reports.snapshot().first)
        #expect(report["step"] as? String == "issuer_token")
        #expect(report["challenge"] as? String == "Y2hhbGxlbmdl")
        #expect((report["error"] as? [String: Any])?["domain"] as? String == NSURLErrorDomain)
    }

    /// A provider's own error, unmarked, is never read as the gateway's, even
    /// with an `error.code` that names one of its codes.
    @Test
    func aProvidersErrorIsNotReadAsTheGateways() throws {
        let body = Data(#"{"error":{"code":"app_budget_exhausted","message":"provider text"}}"#.utf8)
        let provider = try #require(GatewayError(
            response: HTTPURLResponse(
                url: URL(string: "https://gateway.test/v2/apps/a/proxy/openai/v1/responses")!,
                statusCode: 429, httpVersion: nil, headerFields: ["Retry-After": "3"]
            )!,
            body: body
        ))
        #expect(provider.isFromGateway == false)
        #expect(provider.code == .unknown)
        #expect(provider.providerBody == body)
        #expect(provider.statusCode == 429)
        #expect(provider.retryAfter == 3)
        #expect(provider.isRetryable)
        let gateway = try #require(GatewayError(
            response: HTTPURLResponse(
                url: URL(string: "https://gateway.test/v2/apps/a/proxy/openai/v1/responses")!,
                statusCode: 429, httpVersion: nil, headerFields: ["X-AGW-Error": "app_budget_exhausted"]
            )!,
            body: body
        ))
        #expect(gateway.isFromGateway)
        #expect(gateway.code == .appBudgetExhausted)
        #expect(gateway.providerBody == nil)
    }

    /// The sign-in provider ends the client while it answers, then hands back
    /// the next user's token: the ended client builds nothing with it, and
    /// keeps no key for anyone.
    @Test
    func aClientEndedDuringTheSignInTokenBuildsNothing() async throws {
        let registrations = LockedCounter()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            if request.url!.path.hasSuffix("/auth/register") {
                registrations.increment()
                return response(request, status: 200, body: #"{"user_id":"u"}"#)
            }
            return response(request, status: 200, body: #"{"access_token":"token","expires_in":3600,"verify_on":"every_request"}"#)
        }
        let box = LockedValue<AppAIGatewayClient?>(nil)
        let store = MemoryCredentialStore()
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttest(issuerTokenProvider: { _ in
                await box.get()?.invalidate()
                return Self.jwt(sub: "next-user")
            }),
            attestProvider: MockAttestProvider(),
            credentialStore: store,
            session: session()
        )
        box.set(client)
        await #expect(throws: GatewayClientInvalidated.self) {
            _ = try await client.authorizedRequest(provider: .openai, providerPath: "v1/responses")
        }
        #expect(registrations.snapshot() == 0)
        #expect(store.places().isEmpty)
    }

    /// A transport that followed a redirect itself sent the next hop with the
    /// first request's proof. Its refusal is not one a token or a key fixes,
    /// so nothing is sent again.
    @Test
    func aRefusalOfARedirectTheTransportFollowedIsNotRecoveredFrom() async throws {
        let tokens = LockedCounter()
        let client = numberedTokenClient(tokens: tokens)
        let status = URL(string: "https://gateway.test/v2/apps/test-app/jobs/job-1/status")!
        let sends = LockedCounter()
        let (_, answer) = try await client.withAuthorizedRequest(gatewayLink: status) { _ in
            sends.increment()
            let followed = URL(string: "https://gateway.test/v2/apps/test-app/jobs/job-1")!
            let http = HTTPURLResponse(url: followed, statusCode: 403, httpVersion: nil, headerFields: ["X-AGW-Error": "attest_failed"])!
            return (Data(), http as URLResponse)
        }
        #expect((answer as? HTTPURLResponse)?.statusCode == 403)
        #expect(sends.snapshot() == 1)
        #expect(tokens.snapshot() == 1)
    }

    /// A replacement key that is refused too stops replacing: no request after
    /// it costs another attestation until a signed request succeeds.
    @Test
    func aRefusedReplacementKeyStopsReplacingUntilASignedRequestSucceeds() async throws {
        let tokens = LockedCounter()
        let attestations = LockedCounter()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            if request.url!.path.hasSuffix("/auth/register") {
                return response(request, status: 200, body: #"{"user_id":"u"}"#)
            }
            let n = tokens.increment()
            return response(request, status: 200, body: "{\"access_token\":\"t\(n)\",\"expires_in\":3600,\"verify_on\":\"every_request\"}")
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            attestProvider: MockAttestProvider(attestations: attestations, numberedKeys: LockedCounter()),
            credentialStore: MemoryCredentialStore(keyID: "kept-key"),
            session: session()
        )
        let accept = LockedValue(false)
        let send: @Sendable (URLRequest) async throws -> (Data, URLResponse) = { request in
            let ok = accept.get()
            let marked = ok ? [:] : ["X-AGW-Error": "attest_failed"]
            return (Data(), HTTPURLResponse(url: request.url!, statusCode: ok ? 200 : 403, httpVersion: nil, headerFields: marked)! as URLResponse)
        }
        for _ in 0..<3 {
            let (_, answer) = try await client.withAuthorizedRequest(provider: .openai, providerPath: "v1/responses", send: send)
            #expect((answer as? HTTPURLResponse)?.statusCode == 403)
        }
        // One replacement for the kept key; refused too, so none after it.
        #expect(attestations.snapshot() == 1)
        accept.set(true)
        let (_, ok) = try await client.withAuthorizedRequest(provider: .openai, providerPath: "v1/responses", send: send)
        #expect((ok as? HTTPURLResponse)?.statusCode == 200)
        // Lifted: a later refusal of this key may replace it again.
        accept.set(false)
        _ = try await client.withAuthorizedRequest(provider: .openai, providerPath: "v1/responses", send: send)
        #expect(attestations.snapshot() == 2)
    }

    /// The client is ended while a `401` is being recovered from, during the
    /// rebuild's slow token exchange: nothing is sent a second time.
    @Test
    func aClientEndedDuringARebuildSendsNothingMore() async throws {
        let tokens = LockedCounter()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            let n = tokens.increment()
            // The rebuild's exchange is slow, so the end lands while it waits.
            if n > 1 { Thread.sleep(forTimeInterval: 0.4) }
            return response(request, status: 200, body: "{\"access_token\":\"token-\(n)\",\"expires_in\":3600,\"verify_on\":\"every_request\"}")
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            attestProvider: MockAttestProvider(),
            credentialStore: MemoryCredentialStore(keyID: "kept-key"),
            session: session()
        )
        let sends = LockedCounter()
        await #expect(throws: GatewayClientInvalidated.self) {
            _ = try await client.withAuthorizedRequest(provider: .openai, providerPath: "v1/responses") { request in
                sends.increment()
                Task {
                    try await Task.sleep(for: .milliseconds(100))
                    await client.invalidate()
                }
                let http = HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: ["X-AGW-Error": "auth_required"])!
                return (Data(), http as URLResponse)
            }
        }
        #expect(sends.snapshot() == 1)
    }

    /// On an app that checks App Attest at the exchange only, an exchange
    /// the gateway accepts lifts the brake on key replacement: its requests
    /// carry no proof, so no signed request ever could.
    @Test
    func anAcceptedExchangeLiftsTheBrakeWhereRequestsAreNotSigned() async throws {
        let attestations = LockedCounter()
        let accept = LockedValue(false)
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            if request.url!.path.hasSuffix("/auth/register") {
                return response(request, status: 200, body: #"{"user_id":"u"}"#)
            }
            if accept.get() {
                return response(request, status: 200, body: #"{"access_token":"token","expires_in":3600,"verify_on":"token_exchange"}"#)
            }
            return response(request, status: 403, body: #"{"error":{"code":"attest_failed","message":"no"}}"#)
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            attestProvider: MockAttestProvider(attestations: attestations, numberedKeys: LockedCounter()),
            credentialStore: MemoryCredentialStore(keyID: "kept-key"),
            session: session()
        )
        // The kept key is refused, and so is its replacement.
        await #expect(throws: GatewayError.self) { _ = try await client.gatewayAccessToken() }
        #expect(attestations.snapshot() == 1)
        // The replacement refused again: held, no new key.
        await #expect(throws: GatewayError.self) { _ = try await client.gatewayAccessToken() }
        #expect(attestations.snapshot() == 1)
        // The gateway accepts the replacement: the brake lifts.
        accept.set(true)
        _ = try await client.gatewayAccessToken()
        await client.discardAccessToken()
        accept.set(false)
        await #expect(throws: GatewayError.self) { _ = try await client.gatewayAccessToken() }
        #expect(attestations.snapshot() == 2)
    }

    /// A client ended while its token exchange is answered sends no failure
    /// report: its sign-in stopped on purpose.
    @Test
    func anEndedClientSendsNoFailureReport() async throws {
        let reports = FailureReportLog()
        let box = LockedValue<AppAIGatewayClient?>(nil)
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            if request.url!.path.hasSuffix("/auth/failure") {
                reports.record(request)
                return response(request, status: 200, body: #"{"recorded":true}"#)
            }
            // The client is ended while the gateway answers the exchange.
            let ended = DispatchSemaphore(value: 0)
            Task {
                await box.get()?.invalidate()
                ended.signal()
            }
            ended.wait()
            return response(request, status: 200, body: #"{"access_token":"token","expires_in":3600}"#)
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttestInstall,
            attestProvider: MockAttestProvider(),
            credentialStore: MemoryCredentialStore(keyID: "kept-key"),
            session: session()
        )
        box.set(client)
        await #expect(throws: (any Error).self) { _ = try await client.gatewayAccessToken() }
        await client.settleFailureReports()
        #expect(reports.snapshot().isEmpty)
        // The ending usually cancels the exchange first; where it lands after
        // the answer instead, the error it raises is never reported either.
        #expect(AppAIGatewayClient.isReportable(GatewayClientInvalidated()) == false)
    }

    /// A replacement registered with a stale sign-in token is refused before
    /// the gateway spends its challenge: sent again with the same attestation
    /// and a fresh token, so Apple attests once. A missing claim runs the
    /// app's recovery first.
    @Test(arguments: ["issuer_token_rejected", "issuer_claims_missing"])
    func aStaleSignInTokenAtRegistrationIsRefreshedWithoutANewAttestation(_ refusal: String) async throws {
        let attestations = LockedCounter()
        let registerBodies = TokenBodyLog()
        let tokens = LockedCounter()
        let fetches = LockedValue<[Bool]>([])
        let recoveries = RecoveryRecorder()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            if request.url!.path.hasSuffix("/auth/register") {
                registerBodies.record(request)
                if registerBodies.snapshot().count == 1 {
                    return response(request, status: 403, body: "{\"error\":{\"code\":\"\(refusal)\",\"message\":\"stale\"}}")
                }
                return response(request, status: 200, body: #"{"user_id":"alice"}"#)
            }
            let n = tokens.increment()
            return response(request, status: 200, body: "{\"access_token\":\"t\(n)\",\"expires_in\":3600,\"verify_on\":\"every_request\"}")
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttest(issuerTokenProvider: { force in
                fetches.set(fetches.get() + [force])
                return force ? Self.jwt(sub: "alice") + "-fresh" : Self.jwt(sub: "alice")
            }),
            issuerRejectionRecovery: { await recoveries.record() },
            attestProvider: MockAttestProvider(attestations: attestations, numberedKeys: LockedCounter()),
            credentialStore: MemoryCredentialStore(keyID: "kept-key"),
            session: session()
        )
        let sends = LockedCounter()
        let (_, answer) = try await client.withAuthorizedRequest(provider: .openai, providerPath: "v1/responses") { request in
            let n = sends.increment()
            let marked = n < 3 ? ["X-AGW-Error": "attest_failed"] : [:]
            return (Data(), HTTPURLResponse(url: request.url!, statusCode: n < 3 ? 403 : 200, httpVersion: nil, headerFields: marked)! as URLResponse)
        }
        #expect((answer as? HTTPURLResponse)?.statusCode == 200)
        #expect(attestations.snapshot() == 1)
        let bodies = registerBodies.snapshot()
        #expect(bodies.count == 2)
        #expect(bodies[0]["attestation"] == bodies[1]["attestation"])
        #expect(bodies[0]["key_id"] == bodies[1]["key_id"])
        #expect(bodies[1]["issuer_token"]?.hasSuffix("-fresh") == true)
        #expect(fetches.get().filter { $0 } == [true])
        #expect(await recoveries.snapshot() == (refusal == "issuer_claims_missing" ? 1 : 0))
    }

    /// Requests refused with the same key at once fetch the sign-in token for
    /// their one replacement once, and only when it starts: the ones that
    /// join it or reuse it fetch nothing.
    @Test
    func refusalsSharingAReplacementFetchTheSignInTokenOnce() async throws {
        let fetches = LockedCounter()
        let tokens = LockedCounter()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            if request.url!.path.hasSuffix("/auth/register") {
                return response(request, status: 200, body: #"{"user_id":"alice"}"#)
            }
            let n = tokens.increment()
            return response(request, status: 200, body: "{\"access_token\":\"t\(n)\",\"expires_in\":3600,\"verify_on\":\"every_request\"}")
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .appAttest(issuerTokenProvider: { _ in
                fetches.increment()
                return Self.jwt(sub: "alice")
            }),
            attestProvider: MockAttestProvider(numberedKeys: LockedCounter()),
            credentialStore: MemoryCredentialStore(keyID: "kept-key"),
            session: session()
        )
        _ = try await client.gatewayAccessToken()
        #expect(fetches.snapshot() == 1)
        try await withThrowingTaskGroup(of: Void.self) { group in
            for _ in 0..<8 {
                group.addTask {
                    _ = try await client.withAuthorizedRequest(provider: .openai, providerPath: "v1/responses") { request in
                        let refused = request.value(forHTTPHeaderField: "Authorization") == "Bearer t1"
                        let marked = refused ? ["X-AGW-Error": "attest_failed"] : [:]
                        return (Data(), HTTPURLResponse(url: request.url!, statusCode: refused ? 403 : 200, httpVersion: nil, headerFields: marked)! as URLResponse)
                    }
                }
            }
            try await group.waitForAll()
        }
        // One for the replacement's registration, one for its token exchange.
        #expect(fetches.snapshot() == 3)
        #expect(tokens.snapshot() == 2)
    }

    /// A gateway refusal whose body could not be read keeps its code from
    /// the header, and with it the right answer to whether to retry.
    @Test
    func aRefusalWithAnUnreadBodyKeepsItsCodeFromTheHeader() throws {
        for (code, retryable) in [("provider_disabled", false), ("app_budget_exhausted", false), ("service_unavailable", true)] {
            let error = try #require(GatewayError(
                response: HTTPURLResponse(
                    url: URL(string: "https://gateway.test/v2/apps/a/proxy/openai/v1/responses")!,
                    statusCode: code == "app_budget_exhausted" ? 429 : 502,
                    httpVersion: nil,
                    headerFields: ["X-AGW-Error": code]
                )!,
                body: Data()
            ))
            #expect(error.code.rawValue == code)
            #expect(error.isRetryable == retryable, "\(code)")
            #expect(error.isFromGateway)
        }
    }

    /// A job's links are followed only on this gateway, for this app.
    @Test
    func aGatewayLinkIsSignedOnlyForThisAppOnThisGateway() async throws {
        MockURLProtocol.handler = { request in
            response(request, status: 200, body: #"{"access_token":"gateway-token","expires_in":3600}"#)
        }
        let client = AppAIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test/base")!,
            authMode: .apiKey(key: "agw_test-key", issuerTokenProvider: { _ in "firebase-token" }),
            session: session()
        )
        let status = URL(string: "https://gateway.test/base/v2/apps/test-app/jobs/job-1/status")!
        let request = try await client.authorizedRequest(gatewayLink: status)
        #expect(request.url == status)
        #expect(request.httpMethod == "GET")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer gateway-token")
        for link in [
            "https://elsewhere.test/base/v2/apps/test-app/jobs/job-1/status",
            "http://gateway.test/base/v2/apps/test-app/jobs/job-1/status",
            "https://gateway.test:8443/base/v2/apps/test-app/jobs/job-1/status",
            "https://gateway.test/base/v2/apps/other-app/jobs/job-1/status",
            "https://gateway.test/base/v2/apps/test-app/../other-app/jobs/job-1/status",
            "https://gateway.test/v2/apps/test-app/jobs/job-1/status",
            "https://gateway.test/base/v2/apps/test-app/",
            "https://user@gateway.test/base/v2/apps/test-app/jobs/job-1/status",
        ] {
            #expect(await client.isLinkToThisApp(URL(string: link)!) == false, "\(link)")
        }
        await #expect(throws: GatewayError.self) {
            _ = try await client.authorizedRequest(gatewayLink: URL(string: "https://elsewhere.test/x")!)
        }
    }
}

/// The identifying headers of every request that reached the network.
/// A store whose removals the Keychain refuses.
final class UndeletableStore: GatewayCredentialStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var keys: [String: String]
    private let appPlaceKey: String
    init(keyID: String) {
        appPlaceKey = keyID
        keys = [:]
    }
    func appAttestKeyID(for place: String) throws -> String? {
        lock.withLock { place.contains("#") ? keys[place] : appPlaceKey }
    }
    func setAppAttestKeyID(_ keyID: String?, for place: String) throws {
        guard keyID != nil else { throw KeychainError(status: -25300) }
        lock.withLock { keys[place] = keyID }
    }
}

/// Every request's headers, as sent.
final class RequestHeaderLog: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [[String: String]] = []
    func record(_ request: URLRequest) { lock.withLock { entries.append(request.allHTTPHeaderFields ?? [:]) } }
    func snapshot() -> [[String: String]] { lock.withLock { entries } }
}

final class SentHeaders: @unchecked Sendable {
    struct Entry {
        let path: String
        let clientSDK: String?
        let appVersion: String?
    }
    private let lock = NSLock()
    private var entries: [Entry] = []
    func record(_ request: URLRequest) {
        let entry = Entry(
            path: request.url?.path ?? "",
            clientSDK: request.value(forHTTPHeaderField: "X-Client-SDK"),
            appVersion: request.value(forHTTPHeaderField: "X-App-Version")
        )
        lock.withLock { entries.append(entry) }
    }
    func snapshot() -> [Entry] { lock.withLock { entries } }
}

/// An App Attest provider whose numbered `generateAssertion` calls wait until
/// the test opens them, to hold a token exchange part way through.
struct GatedAttestProvider: AppAttestProviding {
    let gates: AssertionGates
    var isSupported: Bool { true }
    func generateKey() async throws -> String { "generated-key" }
    func attestKey(_ keyID: String, clientDataHash: Data) async throws -> Data { Data("attestation".utf8) }
    func generateAssertion(_ keyID: String, clientDataHash: Data) async throws -> Data {
        await gates.pass()
        return Data("assertion".utf8)
    }
}

final class AssertionGates: @unchecked Sendable {
    private let lock = NSLock()
    private let gated: Set<Int>
    private var calls = 0
    private var opened: Set<Int> = []
    private var waiting: [Int: CheckedContinuation<Void, Never>] = [:]

    /// Calls numbered in `gated`, from 1, wait for `open`; the rest pass.
    init(gated: Set<Int>) { self.gated = gated }

    func pass() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let resumeNow: Bool = lock.withLock {
                calls += 1
                guard gated.contains(calls), !opened.contains(calls) else { return true }
                waiting[calls] = continuation
                return false
            }
            if resumeNow { continuation.resume() }
        }
    }

    func open(_ call: Int) {
        let continuation = lock.withLock {
            opened.insert(call)
            return waiting.removeValue(forKey: call)
        }
        continuation?.resume()
    }

    /// Waits, for a second at most, until call `call` is held at its gate.
    func held(_ call: Int) async throws -> Bool {
        for _ in 0..<1000 {
            if lock.withLock({ waiting[call] != nil }) { return true }
            try await Task.sleep(for: .milliseconds(1))
        }
        return false
    }
}

/// Stands in for the app's transport: records each request it is handed and
/// answers the statuses it was given in turn, the last one repeating, with a
/// body naming the attempt.
final class FakeTransport: @unchecked Sendable {
    private let lock = NSLock()
    private let statuses: [Int]
    private let fromGateway: Bool
    private var requests: [URLRequest] = []

    /// `fromGateway`: each `401` is the gateway's own `auth_required`, marked
    /// in `X-AGW-Error`. Otherwise every answer is a provider's, unmarked.
    init(statuses: [Int], fromGateway: Bool = true) {
        self.statuses = statuses
        self.fromGateway = fromGateway
    }

    @Sendable
    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        lock.withLock {
            requests.append(request)
            let attempt = requests.count
            let status = statuses[min(attempt, statuses.count) - 1]
            let marked = fromGateway && status == 401 ? ["X-AGW-Error": "auth_required"] : [:]
            return (
                Data("attempt-\(attempt)".utf8),
                HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: marked)!
            )
        }
    }

    func snapshot() -> [URLRequest] { lock.withLock { requests } }
}
