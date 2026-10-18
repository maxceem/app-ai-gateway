import Foundation
import Observation

/// The demo's settings, kept in `UserDefaults`; the API key in the Keychain.
@MainActor @Observable
final class AppSettings {
    struct ProviderSetting: Codable, Equatable {
        var enabled = false
        /// The slug the provider is connected under in your gateway.
        var slug: String
    }

    struct Values: Codable, Equatable {
        var simulated = true
        var baseURL = "https://api.appaigateway.com"
        var appID = ""
        var useAPIKey = false
        var providers: [String: ProviderSetting] = [:]
        /// The model chosen for each capability, keyed by `Capability.rawValue`.
        var selection: [String: ModelChoice] = [:]
    }

    var values: Values { didSet { save() } }
    var apiKey: String { didSet { Keychain.write(apiKey, account: "api-key") } }

    private static let key = "settings"

    init() {
        let data = UserDefaults.standard.data(forKey: Self.key)
        values = data.flatMap { try? JSONDecoder().decode(Values.self, from: $0) } ?? Values()
        apiKey = Keychain.read(account: "api-key") ?? ""
    }

    private func save() {
        UserDefaults.standard.set(try? JSONEncoder().encode(values), forKey: Self.key)
    }

    // MARK: Providers

    func provider(_ type: String) -> ProviderSetting {
        values.providers[type] ?? ProviderSetting(enabled: ["openai", "anthropic", "gemini", "xai"].contains(type), slug: type)
    }

    func setProvider(_ type: String, _ setting: ProviderSetting) {
        values.providers[type] = setting
    }

    var slugs: [String: String] {
        Dictionary(uniqueKeysWithValues: ModelCatalog.providers.map { ($0.type, provider($0.type).slug) })
    }

    /// The providers the picker offers for a capability. Simulated responses
    /// offer every provider; your gateway, the ones you turned on.
    func providers(for capability: Capability) -> [CatalogProvider] {
        ModelCatalog.providers.filter { entry in
            entry.supports(capability)
                && (values.simulated || provider(entry.type).enabled)
                && (!entry.models(for: capability).isEmpty || !values.simulated)
        }
    }

    // MARK: Models

    func model(for capability: Capability) -> ModelChoice? {
        let offered = providers(for: capability)
        if let chosen = values.selection[capability.rawValue], offered.contains(where: { $0.type == chosen.provider }) {
            return chosen
        }
        if let preferred = Self.preferred[capability], offered.contains(where: { $0.type == preferred.provider && $0.models(for: capability).contains(preferred.model) }) {
            return preferred
        }
        return offered.lazy.compactMap { entry in
            entry.models(for: capability).first.map { ModelChoice(provider: entry.type, model: $0) }
        }.first
    }

    /// What a fresh install starts with, where the provider is offered.
    private static let preferred: [Capability: ModelChoice] = [
        .chat: ModelChoice(provider: "openai", model: "gpt-6-sol"),
        .image: ModelChoice(provider: "openai", model: "gpt-image-2"),
        .transcription: ModelChoice(provider: "openai", model: "gpt-transcribe"),
    ]

    func select(_ choice: ModelChoice, for capability: Capability) {
        values.selection[capability.rawValue] = choice
    }

    // MARK: Backend

    private var gateway: (values: Values, apiKey: String, backend: GatewayBackend)?

    /// The backend requests go to. The gateway one is kept while the settings
    /// stay the same, so its client keeps its token between requests.
    func backend() throws -> any AIBackend {
        if values.simulated { return SimulatedBackend() }
        if let gateway, gateway.values == values, gateway.apiKey == apiKey { return gateway.backend }
        guard let url = URL(string: values.baseURL), url.scheme != nil, !values.appID.isEmpty else {
            throw ProviderError(status: 0, message: "Add your gateway URL and app ID in Settings.")
        }
        if values.useAPIKey, apiKey.isEmpty {
            throw ProviderError(status: 0, message: "Add your API key in Settings.")
        }
        let backend = GatewayBackend(
            baseURL: url,
            appID: values.appID,
            apiKey: values.useAPIKey ? apiKey : nil,
            slugs: slugs
        )
        gateway = (values, apiKey, backend)
        return backend
    }
}
