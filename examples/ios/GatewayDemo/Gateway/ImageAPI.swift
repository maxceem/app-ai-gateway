import Foundation

/// Generates one image: OpenAI-style `images/generations` for OpenAI, xAI and
/// ByteDance, and Gemini's native `generateContent` for Gemini.
extension GatewayBackend {
    func generateImage(prompt: String, aspect: ImageAspect, model: ModelChoice) async throws -> Data {
        guard let path = ProviderPaths.image(model.provider, model: model.model) else {
            throw ProviderError(status: 0, message: "\(model.provider) has no image API in this demo.")
        }
        if model.provider == "gemini" {
            return try await geminiImage(prompt: prompt, aspect: aspect, model: model, path: path)
        }

        var body: [String: Any] = ["model": model.model, "prompt": prompt, "n": 1]
        switch model.provider {
        case "openai": // GPT Image always answers in base64.
            body["size"] = ["square": "1024x1024", "portrait": "1024x1536", "landscape": "1536x1024"][aspect.rawValue]
        case "bytedance":
            body["size"] = ["square": "2048x2048", "portrait": "1728x2304", "landscape": "2304x1728"][aspect.rawValue]
            body["response_format"] = "b64_json"
        default:
            body["response_format"] = "b64_json"
        }
        let data = try await post(model, path: path, body: JSONSerialization.data(withJSONObject: body))

        struct Generated: Decodable { struct Image: Decodable { let b64_json: String?; let url: URL? }; let data: [Image] }
        guard let image = try JSONDecoder().decode(Generated.self, from: data).data.first else {
            throw ProviderError(status: 200, message: "The provider returned no image.")
        }
        if let base64 = image.b64_json, let decoded = Data(base64Encoded: base64) { return decoded }
        if let url = image.url { return try await URLSession.shared.data(from: url).0 }
        throw ProviderError(status: 200, message: "The provider returned no image.")
    }

    private func geminiImage(prompt: String, aspect: ImageAspect, model: ModelChoice, path: String) async throws -> Data {
        let body: [String: Any] = [
            "contents": [["parts": [["text": prompt]]]],
            "generationConfig": [
                "responseModalities": ["TEXT", "IMAGE"],
                "imageConfig": ["aspectRatio": ["square": "1:1", "portrait": "2:3", "landscape": "3:2"][aspect.rawValue]!],
            ],
        ]
        let data = try await post(model, path: path, body: JSONSerialization.data(withJSONObject: body))

        struct Response: Decodable {
            struct Candidate: Decodable {
                struct Content: Decodable {
                    struct Part: Decodable { struct Inline: Decodable { let data: String }; let inlineData: Inline?; let text: String? }
                    let parts: [Part]?
                }
                let content: Content?
            }
            let candidates: [Candidate]?
        }
        let parts = try JSONDecoder().decode(Response.self, from: data).candidates?.first?.content?.parts ?? []
        if let base64 = parts.compactMap(\.inlineData).first?.data, let image = Data(base64Encoded: base64) {
            return image
        }
        // A model that declines to draw explains why in text.
        throw ProviderError(status: 200, message: parts.compactMap(\.text).first ?? "The provider returned no image.")
    }
}
