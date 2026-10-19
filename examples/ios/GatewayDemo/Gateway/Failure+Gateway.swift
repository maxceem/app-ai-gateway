import AppAIGateway
import Foundation

extension Failure {
    /// Reads a failed request for the screen. A `GatewayError` is the
    /// gateway's own refusal and carries a stable code, such as
    /// `model_not_allowed` or `rate_limited`; a `ProviderError` is the
    /// provider's answer, passed through.
    init(_ error: Error) {
        switch error {
        case let error as GatewayError:
            self.init(code: error.code.rawValue, message: error.message)
        case let error as ProviderError:
            self.init(code: error.status > 0 ? "HTTP \(error.status)" : "Not sent", message: error.message)
        case let error as URLError:
            self.init(code: "Network", message: error.localizedDescription)
        default:
            self.init(code: "Error", message: error.localizedDescription)
        }
    }
}
