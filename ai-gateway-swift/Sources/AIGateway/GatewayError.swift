import Foundation

public enum GatewayErrorCode: String, Codable, Sendable {
    case authRequired = "auth_required"
    case attestFailed = "attest_failed"
    case issuerTokenRejected = "issuer_token_rejected"
    case rateLimited = "rate_limited"
    case budgetExhausted = "budget_exhausted"
    case modelNotAllowed = "model_not_allowed"
    case pathNotAllowed = "path_not_allowed"
    case payloadTooLarge = "payload_too_large"
    case providerError = "provider_error"
    case invalidRequest = "invalid_request"
    case endpointNotFound = "endpoint_not_found"
    case appNotFound = "app_not_found"
    case appDisabled = "app_disabled"
    case internalError = "internal_error"
    case unknown
}

public struct GatewayError: Error, Sendable, LocalizedError {
    public let code: GatewayErrorCode
    public let message: String
    public let statusCode: Int

    public var errorDescription: String? { message }
}

struct ErrorEnvelope: Decodable {
    struct Body: Decodable {
        let code: String
        let message: String
    }

    let error: Body
}
