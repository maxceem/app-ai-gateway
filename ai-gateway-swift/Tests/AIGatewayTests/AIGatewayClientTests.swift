import Foundation
import Testing
@testable import AIGateway

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

    var isSupported: Bool { true }
    func generateKey() async throws -> String { "generated-key" }
    func attestKey(_ keyID: String, clientDataHash: Data) async throws -> Data {
        Data("attestation".utf8)
    }
    func generateAssertion(_ keyID: String, clientDataHash: Data) async throws -> Data {
        // `DCError.invalidInput` is what iOS actually raises here.
        if deadKeyIDs.contains(keyID) { throw URLError(.userAuthenticationRequired) }
        return Data("assertion".utf8)
    }
}

final class MemoryCredentialStore: GatewayCredentialStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var keyID: String?

    init(keyID: String? = nil) { self.keyID = keyID }

    func appAttestKeyID(for appID: String) throws -> String? {
        lock.withLock { keyID }
    }

    func setAppAttestKeyID(_ keyID: String?, for appID: String) throws {
        lock.withLock { self.keyID = keyID }
    }
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
struct AIGatewayClientTests {
    @Test
    func issuerBackedAPIKeyExchangeCachesTokenAndBuildsProxyRequest() async throws {
        let tokenCalls = LockedCounter()
        MockURLProtocol.handler = { request in
            tokenCalls.increment()
            return response(request, status: 200, body: #"{"access_token":"gateway-token","expires_in":3600}"#)
        }
        let client = AIGatewayClient(
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
        #expect(request.url?.absoluteString == "https://gateway.test/v1/apps/test-app/proxy/openai/v1/responses")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer gateway-token")
        #expect(request.value(forHTTPHeaderField: "X-App-Version") != nil)
        #expect(
            AIGatewayClient.apiKeyTokenBody(
                issuerToken: "firebase-token",
                apiKey: "agw_test-key"
            ) == ["issuer_token": "firebase-token", "api_key": "agw_test-key"]
        )
    }

    /// Named endpoints bake the provider and model into server config, so the
    /// URL carries only the slug and the request is otherwise identical to a
    /// proxy call.
    @Test
    func endpointRequestsUseTheNamedEndpointURL() async throws {
        MockURLProtocol.handler = { request in
            response(request, status: 200, body: #"{"access_token":"gateway-token","expires_in":3600}"#)
        }
        let client = AIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .apiKey(
                key: "agw_test-key",
                issuerTokenProvider: { _ in "firebase-token" }
            ),
            session: session()
        )
        #expect(
            await client.endpointURL(slug: "chat").absoluteString
                == "https://gateway.test/v1/apps/test-app/endpoints/chat"
        )
        let request = try await client.authorizedRequest(endpointSlug: "transcribe")
        #expect(request.url?.absoluteString == "https://gateway.test/v1/apps/test-app/endpoints/transcribe")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer gateway-token")
        #expect(request.value(forHTTPHeaderField: "X-App-Version") != nil)
    }

    /// A base URL with a path prefix keeps it, and both request builders stay
    /// available while the app finishes migrating off the proxy.
    @Test
    func endpointAndProxyURLsSharePrefixHandling() async {
        let client = AIGatewayClient(
            appID: "calorie-tracker",
            baseURL: URL(string: "https://gateway.test/base")!,
            authMode: .apiKey(
                key: "agw_test-key",
                issuerTokenProvider: { _ in "firebase-token" }
            ),
            session: session()
        )
        #expect(
            await client.endpointURL(slug: "chat").absoluteString
                == "https://gateway.test/base/v1/apps/calorie-tracker/endpoints/chat"
        )
        #expect(
            await client.proxyURL(provider: "openai", providerPath: "v1/responses").absoluteString
                == "https://gateway.test/base/v1/apps/calorie-tracker/proxy/openai/v1/responses"
        )
        #expect(
            await client.proxyURL(provider: .openai, providerPath: "v1/responses").absoluteString
                == "https://gateway.test/base/v1/apps/calorie-tracker/proxy/openai/v1/responses"
        )
        // A second instance of a provider type is addressed by its own slug.
        #expect(
            await client.proxyURL(provider: .custom("openai-dev"), providerPath: "v1/responses")
                .absoluteString
                == "https://gateway.test/base/v1/apps/calorie-tracker/proxy/openai-dev/v1/responses"
        )
    }

    @Test
    func endpointNotFoundDecodesFromTheGatewayEnvelope() {
        #expect(GatewayErrorCode(rawValue: "endpoint_not_found") == .endpointNotFound)
    }

    @Test
    func issuerRejectionForcesOneFreshIssuerTokenAndRetries() async throws {
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
                    body: #"{"error":{"code":"issuer_token_rejected","message":"refresh"}}"#
                )
            }
            return response(request, status: 200, body: #"{"access_token":"fresh-token","expires_in":3600}"#)
        }
        let client = AIGatewayClient(
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
    func issuerBackedAPIKeyRejectionForcesOneFreshIssuerTokenAndRetries() async throws {
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
        let client = AIGatewayClient(
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

    /// A key the Secure Enclave has forgotten is registered afresh rather than
    /// ending the session. Signing fails on the device, before any request is
    /// made, so the gateway never gets the chance to reject it — which is why
    /// recovering from a rejection alone left a reinstalled app stuck.
    @Test
    func aKeyThisDeviceCannotSignWithIsReplaced() async throws {
        let registerCalls = LockedCounter()
        let tokenCalls = LockedCounter()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            if request.url!.path.hasSuffix("/auth/register") {
                registerCalls.increment()
                return response(request, status: 200, body: #"{"user_id":"user-1"}"#)
            }
            tokenCalls.increment()
            return response(request, status: 200, body: #"{"access_token":"recovered","expires_in":3600}"#)
        }
        let store = MemoryCredentialStore(keyID: "key-from-previous-install")
        let client = AIGatewayClient(
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
        let client = AIGatewayClient(
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
        #expect(AIGatewayClient.refreshDelay(for: 120) == 96)
        #expect(AIGatewayClient.refreshDelay(for: 3600) == 3300)
        _ = client
    }

    @Test
    func concurrentTokenRequestsShareOneExchange() async throws {
        let tokenCalls = LockedCounter()
        MockURLProtocol.handler = { request in
            tokenCalls.increment()
            return response(request, status: 200, body: #"{"access_token":"shared-token","expires_in":3600}"#)
        }
        let client = AIGatewayClient(
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
        let client = AIGatewayClient(
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
        let value = AIGatewayClient.assertionClientData(app: "app", challenge: "challenge", keyID: "key")
        #expect(String(data: value, encoding: .utf8) == #"{"app":"app","challenge":"challenge","key_id":"key"}"#)
    }

    @Test
    func issuerlessAPIKeyIsAttachedDirectlyWithOptionalEndUserID() async throws {
        let networkCalls = LockedCounter()
        MockURLProtocol.handler = { request in
            networkCalls.increment()
            return response(request, status: 500, body: "{}")
        }
        let client = AIGatewayClient(
            appID: "machine-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .apiKey(key: "agw_machine-key"),
            endUserId: "customer-42",
            session: session()
        )

        #expect(try await client.gatewayAccessToken() == "agw_machine-key")
        let request = try await client.authorizedRequest(endpointSlug: "chat")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer agw_machine-key")
        #expect(request.value(forHTTPHeaderField: "X-End-User-ID") == "customer-42")
        #expect(networkCalls.snapshot() == 0)
    }
}
