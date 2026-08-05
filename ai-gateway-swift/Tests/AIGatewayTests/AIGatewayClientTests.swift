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
    func developmentExchangeCachesTokenAndBuildsProxyRequest() async throws {
        var tokenCalls = 0
        MockURLProtocol.handler = { request in
            tokenCalls += 1
            return response(request, status: 200, body: #"{"access_token":"gateway-token","expires_in":3600}"#)
        }
        let client = AIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .development(secret: "dev-secret"),
            issuerTokenProvider: { _ in "firebase-token" },
            session: session()
        )
        #expect(try await client.gatewayAccessToken() == "gateway-token")
        #expect(try await client.gatewayAccessToken() == "gateway-token")
        #expect(tokenCalls == 1)
        let request = try await client.authorizedRequest(provider: "openai", providerPath: "v1/responses")
        #expect(request.url?.absoluteString == "https://gateway.test/v1/apps/test-app/proxy/openai/v1/responses")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer gateway-token")
        #expect(request.value(forHTTPHeaderField: "X-App-Version") != nil)
        #expect(
            AIGatewayClient.developmentTokenBody(
                issuerToken: "firebase-token",
                secret: "dev-secret"
            ) == ["issuer_token": "firebase-token", "dev_secret": "dev-secret"]
        )
    }

    @Test
    func issuerRejectionForcesOneFreshIssuerTokenAndRetries() async throws {
        var tokenCalls = 0
        let refreshRecorder = RefreshRecorder()
        let recoveryRecorder = RecoveryRecorder()
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            tokenCalls += 1
            if tokenCalls == 1 {
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
            issuerTokenProvider: { forceRefresh in
                await refreshRecorder.record(forceRefresh)
                return forceRefresh ? "issuer-fresh" : "issuer-old"
            },
            issuerRejectionRecovery: {
                await recoveryRecorder.record()
            },
            attestProvider: MockAttestProvider(),
            credentialStore: MemoryCredentialStore(keyID: "existing-key"),
            session: session()
        )
        #expect(try await client.gatewayAccessToken() == "fresh-token")
        #expect(tokenCalls == 2)
        #expect(await refreshRecorder.snapshot() == [false, true])
        #expect(await recoveryRecorder.snapshot() == 1)
    }

    /// A key the Secure Enclave has forgotten is registered afresh rather than
    /// ending the session. Signing fails on the device, before any request is
    /// made, so the gateway never gets the chance to reject it — which is why
    /// recovering from a rejection alone left a reinstalled app stuck.
    @Test
    func aKeyThisDeviceCannotSignWithIsReplaced() async throws {
        var registerCalls = 0
        var tokenCalls = 0
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/challenge") {
                return response(request, status: 200, body: #"{"challenge":"Y2hhbGxlbmdl"}"#)
            }
            if request.url!.path.hasSuffix("/auth/register") {
                registerCalls += 1
                return response(request, status: 200, body: #"{"user_id":"user-1"}"#)
            }
            tokenCalls += 1
            return response(request, status: 200, body: #"{"access_token":"recovered","expires_in":3600}"#)
        }
        let store = MemoryCredentialStore(keyID: "key-from-previous-install")
        let client = AIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            issuerTokenProvider: { _ in "issuer" },
            attestProvider: MockAttestProvider(deadKeyIDs: ["key-from-previous-install"]),
            credentialStore: store,
            session: session()
        )
        #expect(try await client.gatewayAccessToken() == "recovered")
        // Registered once, and the replacement is what gets stored.
        #expect(registerCalls == 1)
        #expect(tokenCalls == 1)
        #expect(try store.appAttestKeyID(for: "test-app") == "generated-key")
    }

    @Test
    func proactivelyRefreshesBeforeTokenExpiry() async throws {
        var tokenCalls = 0
        MockURLProtocol.handler = { request in
            tokenCalls += 1
            return response(
                request,
                status: 200,
                body: "{\"access_token\":\"token-\(tokenCalls)\",\"expires_in\":301}"
            )
        }
        let client = AIGatewayClient(
            appID: "test-app",
            baseURL: URL(string: "https://gateway.test")!,
            authMode: .development(secret: "dev-secret"),
            issuerTokenProvider: { _ in "firebase-token" },
            session: session()
        )
        #expect(try await client.gatewayAccessToken() == "token-1")
        try await Task.sleep(for: .seconds(1.2))
        #expect(tokenCalls >= 2)
        _ = client
    }

    @Test
    func assertionClientDataMatchesServerCanonicalForm() {
        let value = AIGatewayClient.assertionClientData(app: "app", challenge: "challenge", keyID: "key")
        #expect(String(data: value, encoding: .utf8) == #"{"app":"app","challenge":"challenge","key_id":"key"}"#)
    }
}
