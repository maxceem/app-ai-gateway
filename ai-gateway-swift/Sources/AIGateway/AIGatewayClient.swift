import Foundation

#if canImport(UIKit)
import UIKit
#endif

public typealias IssuerTokenProvider = @Sendable (_ forceRefresh: Bool) async throws -> String
public typealias IssuerRejectionRecovery = @Sendable () async throws -> Void

public enum GatewayAuthMode: Sendable {
    /// App Attest proves the client installation and the issuer token proves the user.
    case appAttest(issuerTokenProvider: IssuerTokenProvider)

    /// With an issuer provider, the API key is exchanged for a per-user gateway token.
    /// Without one, the key is sent directly and is valid only for issuer-less apps.
    case apiKey(key: String, issuerTokenProvider: IssuerTokenProvider? = nil)
}

public actor AIGatewayClient {
    private struct AccessToken: Sendable {
        let value: String
        let expiresAt: Date
    }

    private struct TokenResponse: Decodable {
        let access_token: String
        let expires_in: TimeInterval
    }

    private struct ChallengeResponse: Decodable {
        let challenge: String
    }

    private let appID: String
    private let baseURL: URL
    private let authMode: GatewayAuthMode
    private let endUserId: String?
    private let issuerRejectionRecovery: IssuerRejectionRecovery?
    private let attestProvider: any AppAttestProviding
    private let credentialStore: any GatewayCredentialStoring
    private let session: URLSession
    private var accessToken: AccessToken?
    private var refreshTask: Task<Void, Never>?

    public init(
        appID: String,
        baseURL: URL,
        authMode: GatewayAuthMode,
        endUserId: String? = nil,
        issuerRejectionRecovery: IssuerRejectionRecovery? = nil,
        attestProvider: any AppAttestProviding = SystemAppAttestProvider(),
        credentialStore: any GatewayCredentialStoring = KeychainGatewayCredentialStore(),
        session: URLSession = .shared
    ) {
        self.appID = appID
        self.baseURL = baseURL
        self.authMode = authMode
        self.endUserId = endUserId
        self.issuerRejectionRecovery = issuerRejectionRecovery
        self.attestProvider = attestProvider
        self.credentialStore = credentialStore
        self.session = session
    }

    deinit { refreshTask?.cancel() }

    public func gatewayAccessToken() async throws -> String {
        if case .apiKey(let key, nil) = authMode { return key }
        if let accessToken, accessToken.expiresAt.timeIntervalSinceNow > 300 {
            return accessToken.value
        }
        return try await exchangeToken(forceIssuerRefresh: false, retryIssuerOnce: true)
    }

    public func proxyURL(provider: String, providerPath: String) -> URL {
        baseURL
            .appending(path: "v1/apps/\(appID)/proxy/\(provider)")
            .appending(path: providerPath)
    }

    public func authorizedRequest(
        provider: String,
        providerPath: String,
        method: String = "POST"
    ) async throws -> URLRequest {
        try await authorizedRequest(
            url: proxyURL(provider: provider, providerPath: providerPath),
            method: method
        )
    }

    /// A server-configured endpoint. The provider, model, and any baked
    /// parameters live in the gateway's endpoint row, so the caller sends only
    /// the request body its slug expects.
    public func endpointURL(slug: String) -> URL {
        baseURL.appending(path: "v1/apps/\(appID)/endpoints/\(slug)")
    }

    public func authorizedRequest(
        endpointSlug: String,
        method: String = "POST"
    ) async throws -> URLRequest {
        try await authorizedRequest(url: endpointURL(slug: endpointSlug), method: method)
    }

    private func authorizedRequest(url: URL, method: String) async throws -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(try await gatewayAccessToken())", forHTTPHeaderField: "Authorization")
        if case .apiKey(_, nil) = authMode, let endUserId {
            request.setValue(endUserId, forHTTPHeaderField: "X-End-User-ID")
        }
        request.setValue(Self.appVersion, forHTTPHeaderField: "X-App-Version")
        return request
    }

    private func exchangeToken(forceIssuerRefresh: Bool, retryIssuerOnce: Bool) async throws -> String {
        do {
            let response: TokenResponse
            switch authMode {
            case .apiKey(let key, .some(let issuerTokenProvider)):
                let issuerToken = try await issuerTokenProvider(forceIssuerRefresh)
                response = try await postJSON(
                    path: "auth/token",
                    body: Self.apiKeyTokenBody(issuerToken: issuerToken, apiKey: key)
                )
            case .apiKey(let key, nil):
                return key
            case .appAttest:
                response = try await productionExchange(forceIssuerRefresh: forceIssuerRefresh)
            }
            let token = AccessToken(value: response.access_token, expiresAt: Date().addingTimeInterval(response.expires_in))
            accessToken = token
            scheduleRefresh(for: token)
            return token.value
        } catch let error as GatewayError
            where error.code == .issuerTokenRejected && retryIssuerOnce {
            try await issuerRejectionRecovery?()
            return try await exchangeToken(forceIssuerRefresh: true, retryIssuerOnce: false)
        }
    }

    private func productionExchange(forceIssuerRefresh: Bool) async throws -> TokenResponse {
        guard attestProvider.isSupported else {
            throw GatewayError(code: .attestFailed, message: "App Attest is unavailable on this device", statusCode: 0)
        }
        var keyID = try credentialStore.appAttestKeyID(for: appID)
        if keyID == nil {
            keyID = try await registerKey(forceIssuerRefresh: forceIssuerRefresh)
        }
        guard let keyID else {
            throw GatewayError(code: .attestFailed, message: "App Attest key registration failed", statusCode: 0)
        }
        let signed = try await signedAssertion(for: keyID, forceIssuerRefresh: forceIssuerRefresh)
        let issuerToken = try await issuerToken(forceRefresh: forceIssuerRefresh)
        do {
            return try await postJSON(path: "auth/token", body: tokenBody(issuerToken, signed))
        } catch let error as GatewayError where error.code == .attestFailed {
            // The gateway holds a key this device is no longer signing with.
            let replacement = try await replaceKey(forceIssuerRefresh: forceIssuerRefresh)
            let retry = try await sign(with: replacement)
            return try await postJSON(path: "auth/token", body: tokenBody(issuerToken, retry))
        }
    }

    private struct SignedAssertion {
        let keyID: String
        let challenge: String
        let assertion: Data
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
    private func signedAssertion(for keyID: String, forceIssuerRefresh: Bool) async throws -> SignedAssertion {
        let challengeValue = try await challenge()
        let clientData = Self.assertionClientData(app: appID, challenge: challengeValue, keyID: keyID)
        do {
            let assertion = try await attestProvider.generateAssertion(keyID, clientDataHash: clientData.sha256)
            return SignedAssertion(keyID: keyID, challenge: challengeValue, assertion: assertion)
        } catch {
            let replacement = try await replaceKey(forceIssuerRefresh: forceIssuerRefresh)
            return try await sign(with: replacement)
        }
    }

    private func sign(with keyID: String) async throws -> SignedAssertion {
        let challengeValue = try await challenge()
        let clientData = Self.assertionClientData(app: appID, challenge: challengeValue, keyID: keyID)
        let assertion = try await attestProvider.generateAssertion(keyID, clientDataHash: clientData.sha256)
        return SignedAssertion(keyID: keyID, challenge: challengeValue, assertion: assertion)
    }

    private func replaceKey(forceIssuerRefresh: Bool) async throws -> String {
        try credentialStore.setAppAttestKeyID(nil, for: appID)
        return try await registerKey(forceIssuerRefresh: forceIssuerRefresh)
    }

    private func tokenBody(_ issuerToken: String, _ signed: SignedAssertion) -> [String: String] {
        [
            "issuer_token": issuerToken,
            "key_id": signed.keyID,
            "assertion": signed.assertion.base64EncodedString(),
            "challenge": signed.challenge,
        ]
    }

    private func registerKey(forceIssuerRefresh: Bool) async throws -> String {
        let keyID = try await attestProvider.generateKey()
        let challenge = try await challenge()
        let challengeData = try Self.base64URLData(challenge)
        let attestation = try await attestProvider.attestKey(keyID, clientDataHash: challengeData.sha256)
        let issuerToken = try await issuerToken(forceRefresh: forceIssuerRefresh)
        struct RegisterResponse: Decodable { let user_id: String }
        let _: RegisterResponse = try await postJSON(
            path: "auth/register",
            body: [
                "issuer_token": issuerToken,
                "key_id": keyID,
                "attestation": attestation.base64EncodedString(),
                "challenge": challenge,
            ]
        )
        try credentialStore.setAppAttestKeyID(keyID, for: appID)
        return keyID
    }

    private func challenge() async throws -> String {
        let response: ChallengeResponse = try await postJSON(path: "auth/challenge", body: [:])
        return response.challenge
    }

    private func issuerToken(forceRefresh: Bool) async throws -> String {
        switch authMode {
        case .appAttest(let issuerTokenProvider):
            return try await issuerTokenProvider(forceRefresh)
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
        var request = URLRequest(url: baseURL.appending(path: "v1/apps/\(appID)/\(path)"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data)
            let rawCode = envelope?.error.code ?? "unknown"
            throw GatewayError(
                code: GatewayErrorCode(rawValue: rawCode) ?? .unknown,
                message: envelope?.error.message ?? "Gateway request failed",
                statusCode: http.statusCode
            )
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }

    private func scheduleRefresh(for token: AccessToken) {
        refreshTask?.cancel()
        let delay = max(1, token.expiresAt.timeIntervalSinceNow - 300)
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            _ = try? await self?.exchangeToken(forceIssuerRefresh: false, retryIssuerOnce: true)
        }
    }

    static func assertionClientData(app: String, challenge: String, keyID: String) -> Data {
        Data("{\"app\":\"\(app)\",\"challenge\":\"\(challenge)\",\"key_id\":\"\(keyID)\"}".utf8)
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
}
