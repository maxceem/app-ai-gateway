import Foundation

public enum GatewayErrorCode: String, Codable, Sendable {
    case authRequired = "auth_required"
    /// An App Attest proof was refused: at the token exchange, or on a request
    /// whose `X-AppAttest-Proof` was malformed, signed by a key the gateway no
    /// longer accepts, signed over a different request, or replayed. The
    /// message says which.
    case attestFailed = "attest_failed"
    /// A request with an App Attest gateway token arrived without the
    /// `X-AppAttest-Proof` header, on an app that verifies App Attest on every
    /// request. This client signs whenever the token it holds was issued under
    /// that setting, so a request built with `authorizedRequest`, its headers
    /// kept, sees it only when the application was switched to verify every
    /// request after the cached token was issued under
    /// `verify_on: token_exchange`. A request assembled from
    /// `gatewayAccessToken()` by hand sees it whenever that setting is on. Call
    /// `AppAIGatewayClient.discardAccessToken()` and build the request again
    /// with `authorizedRequest(…)`, once: the fresh exchange answers
    /// `every_request`, and the rebuilt request carries a proof.
    case assertionRequired = "assertion_required"
    case issuerTokenRejected = "issuer_token_rejected"
    /// The issuer token verified, but a required entitlement claim has not
    /// propagated yet. Re-authenticating cannot fix it — only waiting can.
    case issuerClaimsMissing = "issuer_claims_missing"
    /// The gateway could not reach or read the issuer's keys, so the token was
    /// never judged. Nothing about the credential is known to be wrong.
    case issuerVerificationUnavailable = "issuer_verification_unavailable"
    /// The application is not configured for what was asked — a token exchange
    /// it has no end-user source for, or `/me` on an application that
    /// identifies no end users. Retrying cannot help; the configuration has to
    /// change.
    case authMethodNotSupported = "auth_method_not_supported"
    /// No plan is available for the account this app belongs to. Nothing the
    /// app or its user can retry into success: the account's owner has to act.
    case billingPaymentRequired = "billing_payment_required"
    /// The account owner has not verified their email address yet. Retrying
    /// or replacing app credentials cannot help: the owner opens the link in
    /// their verification email, and requests are served from then on.
    case emailUnverified = "email_unverified"
    /// The account's plan allowance of requests for the current period is
    /// used up. Shared by every app and user in the account, so another
    /// app's traffic can use it up.
    ///
    /// Read ``GatewayError/monthlyRequestQuota`` for the allowance, what has
    /// been used, and when the next period begins.
    case billingRequestQuotaExceeded = "billing_request_quota_exceeded"
    /// A per-minute or per-day request limit set on the app refused the call.
    ///
    /// Nothing to do with the plan allowance above, and checked first, so a
    /// request refused here used none of it. ``GatewayError/limitScope`` says
    /// whether the limit was on this install, this user, or the whole app,
    /// and ``GatewayError/retryAfter`` says how long the window has left.
    case appRateLimited = "app_rate_limited"
    /// A monthly spending budget set on the app is used up. Same
    /// ``GatewayError/limitScope`` as ``appRateLimited``.
    ///
    /// Spend is recorded after a response completes, so this refuses requests
    /// after the one that crossed the budget, never the one that crossed it.
    case appBudgetExhausted = "app_budget_exhausted"
    /// The gateway protecting its own `challenge`, `register`, `token` and
    /// `failure` routes against a flood, counted per app and network address.
    ///
    /// Nothing the app sets causes this or lifts it, which is what separates it
    /// from ``appRateLimited``: ``GatewayError/limitScope`` stays `nil`.
    /// ``GatewayError/retryAfter`` says how much of the window is left, and the
    /// client waits that out by itself — a call made during it is refused
    /// without reaching the network.
    case rateLimited = "rate_limited"
    /// The request asks for more output than the app allows.
    case maxOutputTokensExceeded = "max_output_tokens_exceeded"
    case modelNotAllowed = "model_not_allowed"
    case pathNotAllowed = "path_not_allowed"
    case payloadTooLarge = "payload_too_large"
    case providerError = "provider_error"
    case invalidRequest = "invalid_request"
    /// The model has no price the operation can charge.
    case pricingNotConfigured = "pricing_not_configured"
    /// The app has no preset with this name.
    case presetNotFound = "preset_not_found"
    /// No job with this id belongs to this app and user, or its connection
    /// was removed or now sends requests somewhere else.
    case jobNotFound = "job_not_found"
    /// The app does not allow a connection with this slug, or none exists.
    case providerNotConfigured = "provider_not_configured"
    /// The connection is turned off.
    case providerDisabled = "provider_disabled"
    /// The connection cannot be used as stored.
    case providerUnavailable = "provider_unavailable"
    case appNotFound = "app_not_found"
    case appDisabled = "app_disabled"
    /// Nothing is served at this path or method.
    case notFound = "not_found"
    /// The platform the gateway runs on failed or was overloaded. Nothing is
    /// known to be wrong with the request.
    case serviceUnavailable = "service_unavailable"
    case internalError = "internal_error"
    /// A code this release does not know. ``GatewayError/message`` still says
    /// what happened.
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

/// The account's plan allowance of requests, as it stood when a request was
/// refused by it.
public struct MonthlyRequestQuota: Sendable, Equatable {
    /// Requests the plan allows in one period, across the whole account.
    public let limit: Int
    /// Requests already used in the period when this one was refused.
    public let used: Int
    /// When the next period begins, and a whole allowance returns.
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
    /// The `Retry-After` header's value in seconds, when the gateway sent one.
    ///
    /// A header rather than part of ``data``, so it has to be carried
    /// separately: every 429 the gateway raises has one, and for an
    /// ``GatewayErrorCode/appRateLimited`` refusal it is the only statement of
    /// when the window reopens.
    public let retryAfter: TimeInterval?

    public init(
        code: GatewayErrorCode,
        message: String,
        statusCode: Int,
        data: GatewayErrorData = [:],
        retryAfter: TimeInterval? = nil
    ) {
        self.code = code
        self.message = message
        self.statusCode = statusCode
        self.data = data
        self.retryAfter = retryAfter
    }

    public var errorDescription: String? { message }

    /// Whether trying the same request again later could succeed on its own.
    ///
    /// True for failures on the gateway's side of the call — it could not
    /// verify the issuer, or the provider or the platform was briefly
    /// unavailable — and for a `429`. False for anything that has to change
    /// first, including a connection that is missing, turned off or unusable,
    /// which arrives as a `502` too. Nothing in the client retries on this
    /// automatically; it exists so an app can tell "wait" from "fix it".
    ///
    /// Never send a job submission again on its own after a `5xx`: the
    /// provider may already have accepted it, and a second one is a second job.
    ///
    /// A spent budget or plan allowance is not retryable: it comes back only
    /// in the next period, or when its limit is raised. ``retryAfter`` and
    /// ``monthlyRequestQuota`` say when the next period begins.
    public var isRetryable: Bool {
        switch code {
        case .providerNotConfigured, .providerDisabled, .providerUnavailable,
             .appBudgetExhausted, .billingRequestQuotaExceeded:
            return false
        default:
            return code == .issuerVerificationUnavailable || statusCode == 429 || (500..<600).contains(statusCode)
        }
    }

    /// Which of the application's own limits refused the call: `"install"` for
    /// one counted for this install alone — an App Attest application counts
    /// its request limits, and by default its budget, per install —
    /// `"apple_account"` for a budget counted over the person's Apple Account,
    /// across their installs and devices, where the application chose that and
    /// the install sent its App Store transaction, `"user"` for one set on
    /// this user alone, `"app"` for one shared by every user of the
    /// application. `nil` for any rejection that is not an application limit.
    ///
    /// Worth telling apart in a client: an `"app"` refusal is somebody else's
    /// traffic, so backing this user off does not help.
    public var limitScope: String? {
        guard code == .appRateLimited || code == .appBudgetExhausted else { return nil }
        return data["scope"]?.stringValue
    }

    /// The allowance behind a ``GatewayErrorCode/billingRequestQuotaExceeded``
    /// rejection, or `nil` for every other rejection.
    public var monthlyRequestQuota: MonthlyRequestQuota? {
        guard code == .billingRequestQuotaExceeded,
              let limit = data["limit"]?.intValue,
              let used = data["used"]?.intValue,
              let resetAtText = data["resetAt"]?.stringValue,
              let resetAt = Self.instant(fromISO8601: resetAtText)
        else { return nil }
        return MonthlyRequestQuota(limit: limit, used: used, resetAt: resetAt)
    }

    /// Reads a gateway rejection out of a response the caller sent itself.
    ///
    /// ``AppAIGatewayClient`` signs proxy and preset requests but does not send
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
            data: envelope?.error.data ?? [:],
            retryAfter: Self.retryAfter(from: response)
        )
    }

    /// `Retry-After` is defined as either a delay in seconds or an HTTP date.
    /// The gateway only ever sends the former, so only that is read; a date
    /// would read as `nil` rather than as a wrong number.
    static func retryAfter(from response: HTTPURLResponse) -> TimeInterval? {
        guard let raw = response.value(forHTTPHeaderField: "Retry-After"),
              let seconds = TimeInterval(raw.trimmingCharacters(in: .whitespaces))
        else { return nil }
        return seconds
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
