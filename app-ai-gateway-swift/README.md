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

If the gateway answers `401`, the helper discards its token, builds the
request again with a fresh token and, where requests are signed, a fresh
proof, and sends it once more. That recovers from an expired gateway token or
one that names no install (`401 auth_required`), and from an app switched to
verify every request after the token was cached (`401 assertion_required`).
It retries any `401` without reading the body, including one a provider
returned through the proxy, such as for a provider key the provider rejected;
that costs one extra token exchange and one repeated provider call, and
nothing more. A thrown error and every other status, `403` and `429` included,
come back to you untouched, except one `403` described below.
`authorizedRequest` remains available for apps that want to drive the retry
themselves.

A job's status, result and cancel links point at the gateway. Follow one with
`withAuthorizedRequest(gatewayLink:)`, which signs it like any other request.
Only a link to this app on this gateway is accepted, so the gateway token is
never sent anywhere else.

When a sign-in step fails on the device after the gateway handed out a
challenge, such as App Attest failing to reach Apple, the client reports the
step and the error's domain and code to `POST /v2/apps/{app}/auth/failure`.
It never sends the error's text. The report goes out in the background, so
the error still reaches you at once. A refusal the gateway answered is not
reported, because the gateway has recorded it already.

On `403 attest_failed`, the client first tries once more with the same key:
the token exchange with a fresh challenge, a signed request with a fresh
proof. If that is refused too, it registers a new key, gets a token for it,
and tries a third time. A new key costs an attestation with Apple and starts a
new request count for the install, so it is never the first step. For a signed
request this happens only where the body comes back as `Data`, which the
client can read: a stream's body cannot be read without spending it, so a
streamed `403` comes back to you. Read it with `GatewayError`, and for
`attest_failed` call `discardAccessToken()` and send once more: the fresh
exchange runs the same recovery. Nothing helps when the key's environment is
no longer accepted, or when the request was changed after it was signed.

On an app whose users sign in, each user on an install has a key of their own:
the gateway ties a key to the user who registered it, and refuses a token for
one user signed by another's key. The client keeps one key per user, named by
the sign-in token's `iss` and `sub`, and registers a new one only for a user
who has none on this install. A sign-in token that is not a JWT naming both
keeps one key for the app. A key 1.x kept is tried once for the first user who
signs in after the upgrade.

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
- New: `gatewayLink:` requests for a job's links, one key per signed-in user,
  and the `attest_failed` recovery above.
- `GatewayErrorCode` follows the gateway's v2 codes. Added:
  `presetNotFound`, `jobNotFound`, `pricingNotConfigured`,
  `maxOutputTokensExceeded`, `providerNotConfigured`, `providerDisabled`,
  `providerUnavailable`, `notFound` and `serviceUnavailable`. Removed, since
  v2 never sends them: `endpointNotFound`, `billingUnavailable`,
  `unclaimedAccessExpired` and `accountExpired`. A code a release does not
  know is `.unknown`, with the gateway's message.
- `isRetryable` is `false` for a connection that is missing, turned off or
  unusable, although it arrives as a `502`.
- `ProviderSlug` has a constant for every provider type the gateway serves.
- A key kept by 1.x is used again. If the gateway does not know it, the client
  registers a new one by itself.

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
