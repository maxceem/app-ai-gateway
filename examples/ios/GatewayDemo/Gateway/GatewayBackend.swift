import AppAIGateway
import Foundation

/// Sends the demo's requests through App AI Gateway.
///
/// Keep one `AppAIGatewayClient` for the app's lifetime: it holds the gateway
/// token, refreshes it, and, on an app that verifies App Attest on every
/// request, signs each one with the device's App Attest key.
struct GatewayBackend: AIBackend {
    let client: AppAIGatewayClient
    /// The slug each provider type is connected under, e.g. `"openai"`.
    let slugs: [String: String]

    init(baseURL: URL, appID: String, apiKey: String?, slugs: [String: String]) {
        // snippet chat,image,transcription,voice: Create one client when the app starts
        client = AppAIGatewayClient(
            appID: appID,
            baseURL: baseURL,
            // App Attest proves the request comes from your app on a real
            // device. An API key works in the simulator, for testing.
            authMode: apiKey.map { .apiKey(key: $0) } ?? .appAttestInstall
        )
        // snippet end
        self.slugs = slugs
    }

    /// POSTs `body` to the model's provider and returns the response body.
    func post(_ model: ModelChoice, path: String, body: Data, contentType: String = "application/json") async throws -> Data {
        // snippet image,transcription: Send requests through your gateway, which signs each one for this app
        let (data, response) = try await client.withAuthorizedRequest(
            provider: slug(model),
            providerPath: path,
            body: body,
            contentType: contentType
        ) { try await URLSession.shared.data(for: $0) }
        // snippet end
        try check(response as! HTTPURLResponse, body: data)
        return data
    }

    /// POSTs `body` and returns the lines of the provider's event stream.
    func stream(
        _ model: ModelChoice,
        path: String,
        body: Data,
        headers: [String: String] = [:]
    ) async throws -> AsyncLineSequence<URLSession.AsyncBytes> {
        // snippet chat: Send requests through your gateway, which signs each one for this app
        let (bytes, response) = try await client.withAuthorizedRequest(
            provider: slug(model),
            providerPath: path,
            body: body,
            contentType: "application/json"
        ) { request in
            // Headers may be added to a signed request; its URL and body may not change.
            var request = request
            for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
            return try await URLSession.shared.bytes(for: request)
        }
        // snippet end
        let http = response as! HTTPURLResponse
        if !(200..<300).contains(http.statusCode) {
            var data = Data()
            for try await byte in bytes { data.append(byte) }
            try check(http, body: data)
        }
        return bytes.lines
    }

    func slug(_ model: ModelChoice) -> String {
        slugs[model.provider] ?? model.provider
    }

    /// Throws the refusal in a failed response: the gateway's own, with a code
    /// such as `model_not_allowed`, or the provider's, passed through as it was.
    private func check(_ response: HTTPURLResponse, body: Data) throws {
        guard let error = GatewayError(response: response, body: body) else { return }
        if error.code != .unknown { throw error }
        throw ProviderError(status: response.statusCode, body: body)
    }
}

/// A provider's own error response, which the gateway passes through.
struct ProviderError: LocalizedError {
    let status: Int
    let message: String

    init(status: Int, body: Data) {
        self.status = status
        let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        let nested = json?["error"] as? [String: Any]
        message = nested?["message"] as? String
            ?? json?["error"] as? String
            ?? json?["message"] as? String
            ?? String(decoding: body.prefix(300), as: UTF8.self)
    }

    init(status: Int, message: String) {
        self.status = status
        self.message = message
    }

    var errorDescription: String? { message }
}
