# App AI Gateway Demo for iOS

A small SwiftUI app that sends chat, image generation and transcription
requests to many providers, and holds live voice conversations with OpenAI's
realtime models, through App AI Gateway, using the
[Swift package](../../app-ai-gateway-swift). Its history stays on the device.

To run it on your iPhone through a gateway app of your own, follow
[Run the demo app on your iPhone](https://docs.appaigateway.com/demo-ios-app/).

Or open `GatewayDemo.xcodeproj` in Xcode 26 and run it. Every request goes
through your gateway, so open **Settings** from the sidebar first and fill in
your gateway URL and app ID:

- **App Attest** is what a real app uses. It needs a real device: set your team
  and a bundle ID of your own under **Signing & Capabilities**, and register
  the app with your gateway.
- **API key** works in the simulator. Use it for testing only, with an app that
  accepts API keys: a key shipped inside an app can be extracted.

Then turn on the providers you connected, under the slugs you gave them.

## Where the gateway code is

Everything that talks to the gateway is in `GatewayDemo/Gateway/`. Each file
stands on its own:

| File | What it shows |
| --- | --- |
| `GatewayBackend.swift` | Creating the client, sending a request, streaming one, and reading a refusal |
| `ChatAPI.swift` | Streaming chat in OpenAI Chat Completions and Anthropic Messages |
| `TranscriptionAPI.swift` | Uploading a recording as multipart form data |
| `ImageAPI.swift` | Image generation: OpenAI-style, and Gemini's `generateContent` |
| `RealtimeAPI.swift` | Opening a realtime WebSocket, and reading the gateway's `gateway.error` |
| `ProviderPaths.swift` | The path each provider type serves each capability at |
| `Failure+Gateway.swift` | Telling a gateway refusal from a provider's own error |

The rest is the app: `UI/` for the screens, `Store/` for settings and the
history. `Store/VoiceConversation.swift`
drives a voice chat in OpenAI's realtime events, and `Store/VoiceAudio.swift`
turns the microphone into the 24 kHz PCM they carry and plays the answers.
Voice chat needs **Realtime sessions** turned on in your app's settings.

## The model list

`GatewayDemo/Resources/catalog.json` lists the models the picker offers. It is
generated from the gateway's price catalog, so it names what the gateway can
price, not what your app allows: a model your app does not allow is refused
with `403 model_not_allowed`, and the app shows it. Regenerate it after the
catalog changes:

```sh
node --experimental-strip-types examples/ios/scripts/generate-catalog.ts
```

The picker's **Other model…** row takes any model ID a provider serves.
