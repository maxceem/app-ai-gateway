import AppAIGateway
import Foundation

/// One realtime conversation's socket: provider-native JSON events both ways.
protocol RealtimeSocket: Sendable {
    func send(_ event: [String: Any]) async throws
    /// The next event, or nil once the conversation has ended.
    func receive() async throws -> [String: Any]?
    func close()
}

/// Opens a realtime voice conversation through App AI Gateway.
extension GatewayBackend {
    func voice(model: ModelChoice) async throws -> any RealtimeSocket {
        // Discovers the conversation's WebSocket URL and signs the handshake
        // for this one connection. Build a new one for every conversation.
        let request = try await client.authorizedRealtimeRequest(provider: slug(model), model: model.model)
        let task = URLSession.shared.webSocketTask(with: request)
        // A single audio delta can be large; the gateway caps provider frames at 1 MiB.
        task.maximumMessageSize = 1 << 20
        task.resume()
        return WebSocket(task: task)
    }
}

private struct WebSocket: RealtimeSocket, @unchecked Sendable {
    let task: URLSessionWebSocketTask

    func send(_ event: [String: Any]) async throws {
        let data = try JSONSerialization.data(withJSONObject: event)
        try await task.send(.string(String(decoding: data, as: UTF8.self)))
    }

    func receive() async throws -> [String: Any]? {
        while true {
            let message: URLSessionWebSocketTask.Message
            do {
                message = try await task.receive()
            } catch {
                // The gateway explains a refusal in a `gateway.error` event
                // before it closes. A normal close is the conversation's end,
                // its 30-minute limit included; 1011 is the provider failing.
                switch task.closeCode {
                case .invalid: throw error
                case .normalClosure, .goingAway: return nil
                case let code:
                    let reason = task.closeReason.map { String(decoding: $0, as: UTF8.self) } ?? ""
                    throw RealtimeRefusal(
                        code: "Closed \(code.rawValue)",
                        message: reason.isEmpty ? "The gateway ended the conversation." : reason
                    )
                }
            }
            guard case .string(let text) = message,
                  let event = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
            else { continue }
            // The gateway's own refusal, such as `app_rate_limited` when the
            // app's limits refuse a response. Provider events keep their shape.
            if event["type"] as? String == "gateway.error",
               let refusal = try? JSONDecoder().decode(RealtimeGatewayError.self, from: Data(text.utf8)) {
                throw RealtimeRefusal(code: refusal.error.code, message: refusal.error.message)
            }
            return event
        }
    }

    func close() {
        task.cancel(with: .normalClosure, reason: nil)
    }
}

/// A `gateway.error` that ended a realtime conversation.
struct RealtimeRefusal: LocalizedError {
    let code: String
    let message: String

    var errorDescription: String? { message }
}
