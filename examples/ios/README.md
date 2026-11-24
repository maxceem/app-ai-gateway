# App AI Gateway Demo for iOS

A small SwiftUI app that sends chat, image generation and transcription
requests to many providers through App AI Gateway's `/v2` routes, using the
[Swift package](../../app-ai-gateway-swift) 2.0. Its history stays on the
device.

To run it on your iPhone through a gateway app of your own, follow
[Run the demo app on your iPhone](https://docs.appaigateway.com/demo-ios-app/).

Or open `GatewayDemo.xcodeproj` in Xcode 26 and run it. It starts with
**Simulate responses** on, so every screen works without a gateway. To use
yours, open **Settings** from the sidebar, turn simulated responses off, and
fill in your gateway URL and app ID:

- **App Attest** is what a real app uses. It needs a real device: set your team
  and a bundle ID of your own under **Signing & Capabilities**, and register
  the app with your gateway.
- **API key** works in the simulator. Use it for testing only, with a server app
  whose key you can throw away: a key shipped inside an app can be extracted.

Then turn on the providers you connected, under the slugs you gave them. The
app must allow each one, with the operations the demo uses, on its
**Providers** tab: `openai.chat`, `openai.images` and `openai.transcription`
for OpenAI, and the matching ones for others. Two are not what you might
guess: Groq's transcription is `groq.transcription.openai`, and Gemini's images
use `gemini.generate.v1beta`. `agw provider types` lists every provider's
operations.

The demo has no sign-in, so it keeps one gateway client until its gateway
settings change, then makes a new one for the next request. A request already
out finishes on the client it started with. An app whose users sign in makes
one client per signed-in session instead, and calls `await client.invalidate()`
before it switches users: see the Swift SDK's README.

To point a simulator at a gateway from a terminal, pass launch arguments, as
`LaunchOptions.swift` lists. `-APIKeyFile` reads the key from a file, so it
stays out of commands and logs:

```sh
xcrun simctl launch booted com.example.gatewaydemo -Simulated NO \
  -GatewayURL https://api.appaigateway.com -AppID APP_ID -Providers openai \
  -APIKeyFile /path/to/key -Kind chat -Send "Say hello"
```

## Where the gateway code is

Everything that talks to the gateway is in `GatewayDemo/Gateway/`. Each file
stands on its own:

| File | What it shows |
| --- | --- |
| `GatewayBackend.swift` | Creating the client, sending a request, streaming one, and reading a refusal |
| `ChatAPI.swift` | Streaming chat in OpenAI Chat Completions and Anthropic Messages |
| `TranscriptionAPI.swift` | Uploading a recording as multipart form data |
| `ImageAPI.swift` | Image generation: OpenAI-style, and Gemini's `generateContent` |
| `ProviderPaths.swift` | The path each provider type serves each capability at |
| `Failure+Gateway.swift` | Showing a gateway refusal, or a provider's own error, on the screen |

The rest is the app: `UI/` for the screens, `Store/` for settings and the
history, `Simulated/` for the on-device answers.

## The model list

`GatewayDemo/Resources/catalog.json` lists the models the picker offers. It is
generated from the v2 gateway's price file, for the providers that serve a chat
API, so it names what the gateway can price, not what your app allows: a model
your app does not allow is refused with `403 model_not_allowed`, and the app
shows it. Regenerate it after the price file changes, from the repository root after
`pnpm install`:

```sh
node --experimental-strip-types examples/ios/scripts/generate-catalog.ts
```

The picker's **Other model…** row takes any model ID a provider serves.
