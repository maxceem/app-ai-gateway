import Foundation

public enum GatewayErrorCode: String, Codable, Sendable {
    case authRequired = "auth_required"
    case attestFailed = "attest_failed"
    case issuerTokenRejected = "issuer_token_rejected"
    /// The issuer token verified, but a required entitlement claim has not
    /// propagated yet. Re-authenticating cannot fix it — only waiting can.
    case issuerClaimsMissing = "issuer_claims_missing"
    /// The gateway could not reach or read the issuer's keys, so the token was
    /// never judged. Nothing about the credential is known to be wrong.
    case issuerVerificationUnavailable = "issuer_verification_unavailable"
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

    /// Whether trying the same request again later could succeed on its own.
    ///
    /// True for failures on the gateway's side of the call — it could not verify
    /// the issuer, or the upstream was briefly unavailable — and false for
    /// anything the caller has to change first. Nothing in the client retries on
    /// this automatically; it exists so an app can tell "wait" from "fix it".
    public var isRetryable: Bool {
        code == .issuerVerificationUnavailable || statusCode == 429 || (500..<600).contains(statusCode)
    }
}

struct ErrorEnvelope: Decodable {
    struct Body: Decodable {
        let code: String
        let message: String
    }

    let error: Body
}
