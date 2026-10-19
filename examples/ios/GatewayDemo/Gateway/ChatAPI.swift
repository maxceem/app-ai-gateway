import Foundation

/// Streams a chat answer, in Anthropic Messages for Anthropic and OpenAI Chat
/// Completions for everyone else.
extension GatewayBackend {
    func chat(_ turns: [ChatTurn], model: ModelChoice) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let anthropic = model.provider == "anthropic"
                    // snippet chat: Stream the answer, in the provider's own events
                    let lines = try await stream(
                        model,
                        path: ProviderPaths.chat(model.provider),
                        body: anthropic ? anthropicBody(turns, model) : chatCompletionsBody(turns, model),
                        headers: anthropic ? ["anthropic-version": "2023-06-01"] : [:]
                    )
                    // Both stream server-sent events: `data: {json}` lines.
                    for try await line in lines where line.hasPrefix("data:") {
                        let event = Data(line.dropFirst(5).utf8)
                        if line.hasSuffix("[DONE]") { break }
                        if let text = try anthropic ? anthropicText(event) : chatCompletionsText(event) {
                            continuation.yield(text)
                        }
                    }
                    // snippet end
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: OpenAI Chat Completions

    private func chatCompletionsBody(_ turns: [ChatTurn], _ model: ModelChoice) throws -> Data {
        let messages: [[String: Any]] = turns.map { turn in
            guard let image = turn.image else { return ["role": turn.role.rawValue, "content": turn.text] }
            return ["role": turn.role.rawValue, "content": [
                ["type": "text", "text": turn.text],
                ["type": "image_url", "image_url": ["url": "data:image/jpeg;base64,\(image.base64EncodedString())"]],
            ]]
        }
        // snippet chat: The request is OpenAI's own Chat Completions body
        return try JSONSerialization.data(withJSONObject: [
            "model": model.model,
            "messages": messages,
            "stream": true,
            // The final event then reports token usage, which the gateway records.
            "stream_options": ["include_usage": true],
        ])
        // snippet end
    }

    private func chatCompletionsText(_ event: Data) -> String? {
        struct Chunk: Decodable {
            struct Choice: Decodable { struct Delta: Decodable { let content: String? }; let delta: Delta? }
            let choices: [Choice]?
        }
        return (try? JSONDecoder().decode(Chunk.self, from: event))?.choices?.first?.delta?.content
    }

    // MARK: Anthropic Messages

    private func anthropicBody(_ turns: [ChatTurn], _ model: ModelChoice) throws -> Data {
        let messages: [[String: Any]] = turns.map { turn in
            var content: [[String: Any]] = [["type": "text", "text": turn.text]]
            if let image = turn.image {
                content.insert(["type": "image", "source": [
                    "type": "base64", "media_type": "image/jpeg", "data": image.base64EncodedString(),
                ]], at: 0)
            }
            return ["role": turn.role.rawValue, "content": content]
        }
        return try JSONSerialization.data(withJSONObject: [
            "model": model.model,
            "max_tokens": 4096,
            "messages": messages,
            "stream": true,
        ])
    }

    private func anthropicText(_ event: Data) throws -> String? {
        struct Event: Decodable {
            struct Delta: Decodable { let text: String? }
            struct Failure: Decodable { let message: String }
            let delta: Delta?
            let error: Failure?
        }
        guard let decoded = try? JSONDecoder().decode(Event.self, from: event) else { return nil }
        if let error = decoded.error { throw ProviderError(status: 200, message: error.message) }
        return decoded.delta?.text
    }
}
