/// Where each provider type serves each capability.
///
/// Requests go to `/v1/apps/{app}/proxy/{slug}/{path}`, and the path is the
/// provider's own, passed through verbatim, so the prefixes differ:
/// DeepSeek has no `v1/`, Groq namespaces its OpenAI API under `openai/`.
enum ProviderPaths {
    /// Anthropic speaks Anthropic Messages; every other provider here speaks
    /// OpenAI Chat Completions, Gemini through its OpenAI-compatible API.
    static func chat(_ provider: String) -> String {
        switch provider {
        case "anthropic": "v1/messages"
        case "gemini": "v1beta/openai/chat/completions"
        case "perplexity", "deepseek", "bytedance": "chat/completions"
        case "groq": "openai/v1/chat/completions"
        case "fireworks": "inference/v1/chat/completions"
        default: "v1/chat/completions"
        }
    }

    /// An OpenAI-style multipart upload on all of them; xAI names it `v1/stt`.
    static func transcription(_ provider: String) -> String? {
        switch provider {
        case "openai", "together", "mistral": "v1/audio/transcriptions"
        case "groq": "openai/v1/audio/transcriptions"
        case "xai": "v1/stt"
        default: nil
        }
    }

    /// OpenAI-style image generation, except Gemini, whose image models answer
    /// on its native `generateContent`.
    static func image(_ provider: String, model: String) -> String? {
        switch provider {
        case "openai", "xai": "v1/images/generations"
        case "bytedance": "images/generations"
        case "gemini": "v1beta/models/\(model):generateContent"
        default: nil
        }
    }

    /// Whether the gateway holds realtime voice conversations with the
    /// provider. It has no path to choose: the Swift package discovers the
    /// WebSocket URL, and only direct OpenAI is served so far.
    static func realtime(_ provider: String) -> Bool {
        provider == "openai"
    }
}
