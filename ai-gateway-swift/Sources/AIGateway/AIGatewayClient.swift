import Foundation

#if canImport(UIKit)
import UIKit
#endif

public enum GatewayAuthMode: Sendable {
    case production
    case development(secret: String)
}

public typealias IssuerTokenProvider = @Sendable (_ forceRefresh: Bool) async throws -> String
public typealias IssuerRejectionRecovery = @Sendable () async throws -> Void

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
    private let issuerTokenProvider: IssuerTokenProvider
    private let issuerRejectionRecovery: IssuerRejectionRecovery?
    private let attestProvider: any AppAttestProviding
    private let credentialStore: any GatewayCredentialStoring
    private let session: URLSession
    private var accessToken: AccessToken?
    private var refreshTask: Task<Void, Never>?

    public init(
        appID: String,
        baseURL: URL,
        authMode: GatewayAuthMode = .production,
        issuerTokenProvider: @escaping IssuerTokenProvider,
        issuerRejectionRecovery: IssuerRejectionRecovery? = nil,
        attestProvider: any AppAttestProviding = SystemAppAttestProvider(),
        credentialStore: any GatewayCredentialStoring = KeychainGatewayCredentialStore(),
        session: URLSession = .shared
    ) {
        self.appID = appID
        self.baseURL = baseURL
        self.authMode = authMode
        self.issuerTokenProvider = issuerTokenProvider
        self.issuerRejectionRecovery = issuerRejectionRecovery
        self.attestProvider = attestProvider
        self.credentialStore = credentialStore
        self.session = session
    }

    deinit { refreshTask?.cancel() }

    public func gatewayAccessToken() async throws -> String {
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
        var request = URLRequest(url: proxyURL(provider: provider, providerPath: providerPath))
        request.httpMethod = method
        request.setValue("Bearer \(try await gatewayAccessToken())", forHTTPHeaderField: "Authorization")
        request.setValue(Self.appVersion, forHTTPHeaderField: "X-App-Version")
        return request
    }

    private func exchangeToken(forceIssuerRefresh: Bool, retryIssuerOnce: Bool) async throws -> String {
        do {
            let response: TokenResponse
            switch authMode {
            case .development(let secret):
                let issuerToken = try await issuerTokenProvider(forceIssuerRefresh)
                response = try await postJSON(
                    path: "auth/token",
                    body: Self.developmentTokenBody(issuerToken: issuerToken, secret: secret)
                )
            case .production:
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
        let challengeValue = try await challenge()
        let clientData = Self.assertionClientData(app: appID, challenge: challengeValue, keyID: keyID)
        let assertion = try await attestProvider.generateAssertion(keyID, clientDataHash: clientData.sha256)
        let issuerToken = try await issuerTokenProvider(forceIssuerRefresh)
        do {
            return try await postJSON(
                path: "auth/token",
                body: [
                    "issuer_token": issuerToken,
                    "key_id": keyID,
                    "assertion": assertion.base64EncodedString(),
                    "challenge": challengeValue,
                ]
            )
        } catch let error as GatewayError where error.code == .attestFailed {
            try credentialStore.setAppAttestKeyID(nil, for: appID)
            let replacement = try await registerKey(forceIssuerRefresh: forceIssuerRefresh)
            let retryChallenge = try await challenge()
            let retryData = Self.assertionClientData(app: appID, challenge: retryChallenge, keyID: replacement)
            let retryAssertion = try await attestProvider.generateAssertion(replacement, clientDataHash: retryData.sha256)
            return try await postJSON(
                path: "auth/token",
                body: [
                    "issuer_token": issuerToken,
                    "key_id": replacement,
                    "assertion": retryAssertion.base64EncodedString(),
                    "challenge": retryChallenge,
                ]
            )
        }
    }

    private func registerKey(forceIssuerRefresh: Bool) async throws -> String {
        let keyID = try await attestProvider.generateKey()
        let challenge = try await challenge()
        let challengeData = try Self.base64URLData(challenge)
        let attestation = try await attestProvider.attestKey(keyID, clientDataHash: challengeData.sha256)
        let issuerToken = try await issuerTokenProvider(forceIssuerRefresh)
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

    static func developmentTokenBody(issuerToken: String, secret: String) -> [String: String] {
        ["issuer_token": issuerToken, "dev_secret": secret]
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
