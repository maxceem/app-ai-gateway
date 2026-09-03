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
    /// The organization that owns this app has no active subscription or trial.
    /// Nothing the app or its user can retry into success — someone with access
    /// to the organization's billing has to act — so this is the one refusal
    /// worth surfacing as an account problem rather than a transient one.
    case paymentRequired = "payment_required"
    /// The gateway could not reach its billing service, so it never learned
    /// whether the organization is entitled and refused rather than guess.
    /// Carries no verdict on the subscription: the request is worth sending
    /// again, and ``GatewayError/isRetryable`` says so.
    case billingUnavailable = "billing_unavailable"
    /// The organization used up the calendar-month request allowance its plan
    /// grants. This is the gateway's only quota and the only 429 it raises; it
    /// is shared by every application, credential and user the organization
    /// owns, so another client's traffic can exhaust it.
    ///
    /// Read ``GatewayError/monthlyRequestQuota`` for the allowance, what has
    /// been spent, and the instant a fresh month begins.
    case monthlyRequestQuotaExceeded = "monthly_request_quota_exceeded"
    @available(
        *, deprecated,
        message: """
            The gateway no longer enforces per-user or per-application request rates; it answers \
            monthlyRequestQuotaExceeded instead. Kept so existing switches still compile and \
            historical logs still decode.
            """
    )
    case rateLimited = "rate_limited"
    @available(
        *, deprecated,
        message: """
            The gateway no longer enforces spending budgets; its only quota is the organization's \
            monthly request allowance. Kept so existing switches still compile and historical logs \
            still decode.
            """
    )
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

/// One value from a rejection's `data` object.
///
/// The gateway sends only strings, numbers and booleans there, so this is the
/// whole vocabulary. Reach for the typed accessors rather than matching the
/// cases: a count the gateway writes as JSON `3` and one it writes as `3.0` are
/// the same number, and ``intValue`` answers for both.
public enum GatewayErrorValue: Sendable, Equatable, Decodable {
    case string(String)
    case number(Double)
    case boolean(Bool)

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        // Bool is tried first: JSON `true` is not a number, but some decoders
        // will hand one back for it if asked.
        if let value = try? container.decode(Bool.self) {
            self = .boolean(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else {
            self = .string(try container.decode(String.self))
        }
    }

    public var stringValue: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }

    public var doubleValue: Double? {
        guard case .number(let value) = self else { return nil }
        return value
    }

    public var boolValue: Bool? {
        guard case .boolean(let value) = self else { return nil }
        return value
    }

    /// The value as a whole number, when it is one that fits.
    public var intValue: Int? {
        guard case .number(let value) = self,
              value.rounded() == value,
              value >= Double(Int.min),
              value <= Double(Int.max)
        else { return nil }
        return Int(value)
    }
}

/// The machine-readable facts a rejection carries beyond its code, keyed as the
/// gateway sent them. Empty for the rejections whose code says everything.
public typealias GatewayErrorData = [String: GatewayErrorValue]

/// The organization's monthly request allowance, as it stood when a request was
/// refused by it.
public struct MonthlyRequestQuota: Sendable, Equatable {
    /// Requests the plan allows in one UTC calendar month, organization-wide.
    public let limit: Int
    /// Requests already spent that month when this one was refused.
    public let used: Int
    /// The first instant of the next UTC month, when a whole allowance returns.
    public let resetAt: Date

    public init(limit: Int, used: Int, resetAt: Date) {
        self.limit = limit
        self.used = used
        self.resetAt = resetAt
    }
}

public struct GatewayError: Error, Sendable, LocalizedError {
    public let code: GatewayErrorCode
    public let message: String
    public let statusCode: Int
    /// Extra facts about this rejection, when the code alone is not actionable.
    /// Empty for every rejection that carries none.
    public let data: GatewayErrorData

    public init(
        code: GatewayErrorCode,
        message: String,
        statusCode: Int,
        data: GatewayErrorData = [:]
    ) {
        self.code = code
        self.message = message
        self.statusCode = statusCode
        self.data = data
    }

    public var errorDescription: String? { message }

    /// Whether trying the same request again later could succeed on its own.
    ///
    /// True for failures on the gateway's side of the call — it could not verify
    /// the issuer, it could not reach billing, or the upstream was briefly
    /// unavailable — and false for anything the caller has to change first.
    /// Nothing in the client retries on this automatically; it exists so an app
    /// can tell "wait" from "fix it".
    ///
    /// ``GatewayErrorCode/billingUnavailable`` in particular is not
    /// ``GatewayErrorCode/paymentRequired``: it arrives as a `5xx` and means the
    /// subscription was never read, so an app must not show an upsell for it.
    ///
    /// An exhausted monthly allowance is retryable in the same sense, but the
    /// wait is a calendar one: ``monthlyRequestQuota`` says exactly when.
    public var isRetryable: Bool {
        code == .issuerVerificationUnavailable || statusCode == 429 || (500..<600).contains(statusCode)
    }

    /// The allowance behind a ``GatewayErrorCode/monthlyRequestQuotaExceeded``
    /// rejection, or `nil` for every other rejection.
    public var monthlyRequestQuota: MonthlyRequestQuota? {
        guard code == .monthlyRequestQuotaExceeded,
              let limit = data["limit"]?.intValue,
              let used = data["used"]?.intValue,
              let resetAtText = data["resetAt"]?.stringValue,
              let resetAt = Self.instant(fromISO8601: resetAtText)
        else { return nil }
        return MonthlyRequestQuota(limit: limit, used: used, resetAt: resetAt)
    }

    /// Reads a gateway rejection out of a response the caller sent itself.
    ///
    /// ``AIGatewayClient`` signs proxy and endpoint requests but does not send
    /// them, so a refusal on those routes — a quota rejection above all, with
    /// its ``data`` — arrives in the caller's own `URLSession` result. This is
    /// how to read one. Returns `nil` for a successful response, which is not a
    /// rejection to read.
    public init?(response: HTTPURLResponse, body: Data) {
        guard !(200..<300).contains(response.statusCode) else { return nil }
        let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: body)
        self.init(
            code: envelope.flatMap { GatewayErrorCode(rawValue: $0.error.code) } ?? .unknown,
            message: envelope?.error.message ?? "Gateway request failed",
            statusCode: response.statusCode,
            data: envelope?.error.data ?? [:]
        )
    }

    /// The formatter is built per call rather than shared: `ISO8601DateFormatter`
    /// is a non-`Sendable` class, and this is a once-a-month path.
    private static func instant(fromISO8601 text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: text)
    }
}

struct ErrorEnvelope: Decodable {
    struct Body: Decodable {
        let code: String
        let message: String
        let data: GatewayErrorData?
    }

    let error: Body
}
