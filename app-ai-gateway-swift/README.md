# AppAIGateway

The Swift client for [App AI Gateway](https://appaigateway.com). It handles
App Attest registration, the gateway token exchange and refresh, and the
headers every request needs, so your iOS app can call AI providers through the
gateway without holding a provider key.

Add `https://github.com/maxceem/app-ai-gateway-swift` in Xcode's **File → Add
Package Dependencies**, or add this dependency to `Package.swift`:

```swift
.package(url: "https://github.com/maxceem/app-ai-gateway-swift", from: "2.0.0")
```

Add the `AppAIGateway` product to your target.

Version 2 calls the gateway's `/v2` routes. Use 1.x with the earlier
gateway's `/v1` routes; see [Upgrading to 2.0](#upgrading-to-20).

```swift
import AppAIGateway

let gateway = AppAIGatewayClient(
    appID: "example-app-a1b2c3",
    baseURL: URL(string: "https://api.appaigateway.com")!,
    authMode: .appAttestInstall
)

let (data, response) = try await gateway.withAuthorizedRequest(
    provider: .openai,
    providerPath: "v1/responses",
    body: Data(#"{"model":"gpt-5.6-sol","input":"Say hello."}"#.utf8),
    contentType: "application/json"
) { try await URLSession.shared.data(for: $0) }
if let error = GatewayError(response: response as! HTTPURLResponse, body: data) {
    // `error.isFromGateway` tells the gateway's own refusal, with its `code`,
    // from a provider's error, kept as it came in `error.providerBody`.
    throw error
}
```

`withAuthorizedRequest` builds the request and hands it to your closure, which
sends it. The package never performs the request itself, so any session,
configuration or networking library works. To stream, send it with
`bytes(for:)`, which returns once the response headers arrive, before the body:

```swift
let (bytes, response) = try await gateway.withAuthorizedRequest(
    provider: .openai,
    providerPath: "v1/responses",
    body: Data(#"{"model":"gpt-5.6-sol","input":"Say hello.","stream":true}"#.utf8),
    contentType: "application/json"
) { try await URLSession.shared.bytes(for: $0) }
let http = response as! HTTPURLResponse
guard (200..<300).contains(http.statusCode) else {
    let body = try await bytes.reduce(into: Data()) { $0.append($1) }
    throw GatewayError(response: http, body: body)!
}
for try await line in bytes.lines {
    print(line)
}
```

A preset is called the same way, with `preset:`. One in Gemini's format
streams when its URL carries `alt=sse`: pass that query to the helper, which
signs it with the rest of the URL. A query added to the request afterwards
invalidates its proof.

```swift
let (bytes, response) = try await gateway.withAuthorizedRequest(
    preset: "gemini-chat",
    query: [URLQueryItem(name: "alt", value: "sse")],
    body: body,
    contentType: "application/json"
) { try await URLSession.shared.bytes(for: $0) }
```

The helper acts only on a refusal the gateway marks as its own, in the
`X-AGW-Error` header, and never reads the body for it, so a stream stays
yours. A provider's answer never carries that header, so a provider's own
`401` or `403` comes back to you as it is and is never sent again.

- `401 auth_required` (an expired gateway token, or one that names no
  install) and `401 assertion_required` (an app switched to verify every
  request after the token was cached): the helper forgets the token the
  request was sent with, builds the request again with a fresh token and,
  where requests are signed, a fresh proof, and sends it once more.
- `403 attest_failed` on a signed request: it sends once more with a fresh
  proof. If that is refused too, it registers a new key, gets a token for it,
  and sends a third time. A new key costs an attestation with Apple and starts
  a new request count for the install, so it is never the first step, and
  requests refused at the same time share one new key. The token exchange
  does the same: once more with a fresh challenge, then a new key. Nothing
  helps when the key's environment is no longer accepted, or when the request
  was changed after it was signed.

Whatever the last send returns comes back to you. A thrown error and every
other status come back untouched. `authorizedRequest` remains available for
apps that want to drive the retry themselves.

A job's status, result and cancel links point at the gateway. Follow one with
`withAuthorizedRequest(gatewayLink:)`, which signs it like any other request,
and pass `method: "PUT"` for a cancel link. Only a link to this app on this
gateway is accepted, so the gateway token is never sent anywhere else. A status
link can redirect to the result, which needs a proof of its own, so turn off
redirects in your transport and let the helper follow them:

```swift
let (data, response) = try await gateway.withAuthorizedRequest(gatewayLink: statusLink) {
    try await URLSession.shared.data(for: $0, delegate: GatewayRedirectBlocker())
}
```

When a sign-in step fails on the device, such as App Attest failing to reach
Apple or your sign-in token provider throwing, the client reports the step
and the error's domain and code to `POST /v2/apps/{app}/auth/failure`. It never
sends the error's text. The report goes out in the background, so the error
still reaches you at once. A refusal the gateway answered is not reported,
because the gateway has recorded it already.

### One client per signed-in session

Make a client when a user signs in, and end it with `invalidate()` when they
sign out or another user signs in; then make a new one:

```swift
// At sign-in.
let gateway = AppAIGatewayClient(
    appID: "example-app-a1b2c3",
    baseURL: URL(string: "https://api.appaigateway.com")!,
    authMode: .appAttest(issuerTokenProvider: { forceRefresh in
        try await Auth.auth().currentUser!.getIDToken(forcingRefresh: forceRefresh)
    })
)

// At sign-out, or before another user signs in.
await gateway.invalidate()
```

Call `invalidate()` before your sign-in library switches users, not when it
only refreshes the same user's ID token. Without it, the client keeps the
gateway token it holds, and goes on sending requests as the previous user for
up to an hour, the token's lifetime. An ended client builds no request and
gets no token: every call throws `GatewayClientInvalidated`. A request it
already sent comes back with its own answer, and is never sent again with
anyone's credentials. Install mode (`.appAttestInstall`) and API-key apps
without sign-in need only one client.

On an app whose users sign in, each user on an install has a key of their own:
the gateway ties a key to the user who registered it, and refuses a token for
one user signed by another's key. The client keeps one key per user and
registers a new one only for a user who has none on this install. It names the
user by the sign-in token's `iss` and `sub`, which must be stable and unique
per user: Firebase's and most providers' are. If yours are not, or your app
sets the gateway's user ID claim to another claim, pass your own stable user
ID as `signedInUserID:`. A sign-in token that is not a JWT naming both, with no
`signedInUserID`, keeps one key for the app. A key 1.x kept goes to the first
user who signs in after the upgrade, and to no one else.

In the App Attest modes the gateway decides whether requests are signed. Each
app has a "Verify App Attest on" setting, and the token exchange answers with
it as `verify_on`:

- `every_request` (the default for new apps): each request gets an
  `X-AppAttest-Proof` header, an assertion the device's App Attest key made
  over exactly that method, URL, body and gateway token. Pass the body to
  `withAuthorizedRequest` (or `authorizedRequest`) and send the request as it
  comes back. Changing the body or the URL afterwards invalidates the proof,
  and the gateway refuses the request with `attest_failed`. Other headers may
  be added. Build a new request for every send: each proof is accepted once.
- `token_exchange`: the assertion is checked once per hourly token, and
  requests carry only the token. A gateway that sends no `verify_on` is
  treated the same way.

Build requests through the package in either case, so a change of the
setting needs no change in your app.

In the App Attest modes the token exchange also sends the app's App Store
transaction (StoreKit's `AppTransaction`), signed by Apple and bound into the
exchange's assertion. That lets an app measure its monthly budget per Apple
Account, which holds across reinstalls and devices, rather than per install.
There is nothing to configure, and the user is never asked to sign in: the
package reads only what StoreKit already has. Where no transaction is
available, as on a simulator or offline, the exchange goes ahead without one
and the gateway counts the install. A gateway too old to read the transaction
is not sent one.

To show the caller where they stand against your app's limits, send
`withCurrentUserRequest`, a `GET /v2/apps/{app}/me` signed the same way and
resent once on a `401` (`currentUserRequest()` builds it alone). Build it
there rather than from a URL of your own: on an app that verifies every
request, a request without a proof is refused with `assertion_required`, and editing
a signed request's URL breaks its proof.

### Upgrading to 2.0

- Every route moves from `/v1` to `/v2`. Signed requests sign the `/v2` path,
  so 2.0 works only with a gateway that serves `/v2`, and 1.x only with one
  that serves `/v1`.
- Custom endpoints are presets: `endpointURL(slug:)` is `presetURL(name:)`,
  and `endpointSlug:` is `preset:`.
- New: `gatewayLink:` requests for a job's links, with redirects followed,
  one key per signed-in user, `signedInUserID:`, `invalidate()`, and the
  `attest_failed` recovery above.
- Make one client per signed-in session, and call `invalidate()` on the old
  one before the user changes. A 1.x app that kept one client across sign-ins
  must change this: otherwise the old client goes on sending requests as the
  previous user for up to an hour. See
  [One client per signed-in session](#one-client-per-signed-in-session).
- The helpers act only on refusals marked with `X-AGW-Error`, so a provider's
  own `401` is no longer sent again.
- `GatewayError(response:body:)` reads only an answer marked with
  `X-AGW-Error` as the gateway's. A provider's error is now `.unknown`, with
  `isFromGateway == false` and its body in `providerBody`, where 1.x read its
  `error.code` as if the gateway had sent it.
- For a job's links, turn off your transport's redirects with
  `GatewayRedirectBlocker`, and let `withAuthorizedRequest(gatewayLink:)`
  follow them with a proof for each.
- A custom `GatewayCredentialStoring` sees new names in `for:`: the app's id,
  or on an app with signed-in users the app's id, `#` and a user's mark. Store
  each name apart. Removing a key with `nil` must throw when the removal
  fails, so a key meant to be gone is never read back.
- `GatewayErrorCode` follows the gateway's v2 codes. Added:
  `presetNotFound`, `jobNotFound`, `pricingNotConfigured`,
  `maxOutputTokensExceeded`, `providerNotConfigured`, `providerDisabled`,
  `providerUnavailable`, `notFound` and `serviceUnavailable`. Removed, since
  v2 never sends them: `endpointNotFound`, `billingUnavailable`,
  `unclaimedAccessExpired` and `accountExpired`. A code a release does not
  know is `.unknown`, with the gateway's message.
- `isRetryable` is `false` for a connection that is missing, turned off or
  unusable, although it arrives as a `502`, and for a spent budget
  (`appBudgetExhausted`) or plan allowance (`billingRequestQuotaExceeded`),
  although they arrive as a `429`: waiting a little does not bring them back.
- `ProviderSlug` has a constant for every provider type the gateway serves.
- A key kept by 1.x is used again, for one user only on an app with signed-in
  users. If the gateway does not know it, the client registers a new one by
  itself. If a new key is refused too, the client makes no more until a signed
  request succeeds.

### Upgrading to 1.4

1.4 is required by apps that verify App Attest on every request.
`authorizedRequest` now takes `body:` and `contentType:`, both optional, so
existing calls compile unchanged; move a body you used to assign to `httpBody`
into the call, because a body set afterwards is outside the proof. API-key
modes are unchanged and send no proof. Since 1.4.1, `withAuthorizedRequest`
recovers from `auth_required` and `assertion_required`, both `401`, on its
own. On a request built by the package and sent with its headers intact,
`assertion_required` means the app was switched to verify every request after
the client's token was issued; the fresh exchange says so, and the rebuilt
request is signed. A request you assemble from `gatewayAccessToken()` yourself
gets it whenever the app verifies every request. If you send requests built
with `authorizedRequest`, handle a `401` yourself: call `discardAccessToken()`
and build the request again, once.

Every request the package sends or builds names your app's version in
`X-App-Version` and the package's in `X-Client-SDK`
(`app-ai-gateway-swift/<version>`), so the gateway can show which package
release your installs run. Neither header is sent on to the provider.

Requires iOS 16 or macOS 13. App Attest needs a real device.

- Guide: https://docs.appaigateway.com/integrate/ios/
- Errors and limits: https://docs.appaigateway.com/integrate/errors/

This repository is published from the `app-ai-gateway-swift` directory of
[maxceem/app-ai-gateway](https://github.com/maxceem/app-ai-gateway). Open
issues and pull requests there.

To release a new version, update `app-ai-gateway-swift/VERSION` in the source
repository, set `ClientSDK.version` in `Sources/AppAIGateway/ClientSDK.swift`
to the same value (a test fails until they match), and merge the pull request
into `main`. After tests pass, the
publishing workflow syncs this repository and creates the matching immutable
version tag. Changes without a version bump sync `main` without changing any
released version. The current version is `2.0.0`, released with the v2
gateway. Fixes for 1.x are made on the source repository's `swift-1.x`
branch. A failed publish can be retried with the source repository's
**Publish Swift package** workflow.

Licensed under the Apache License 2.0.
