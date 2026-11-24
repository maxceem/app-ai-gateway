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

    var values: Values { didSet { save(); endGatewayIfChanged() } }
    var apiKey: String { didSet { Keychain.write(apiKey, account: "api-key"); endGatewayIfChanged() } }

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
        values.providers[type] ?? ProviderSetting(enabled: type == "openai", slug: type)
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

    /// What the gateway client is built from. Picking a model or turning a
    /// provider on changes none of it, so the client and its token stay.
    private struct ClientSetup: Equatable {
        var simulated: Bool
        var baseURL: String
        var appID: String
        var apiKey: String?
        var slugs: [String: String]
    }

    private var clientSetup: ClientSetup {
        ClientSetup(
            simulated: values.simulated,
            baseURL: values.baseURL,
            appID: values.appID,
            apiKey: values.useAPIKey ? apiKey : nil,
            slugs: slugs
        )
    }

    /// The client in use, and the setup it was built from.
    private var gateway: (setup: ClientSetup, backend: GatewayBackend)?
    /// The end of the last client, while it runs. A new client is made only
    /// once it is done, so no request of the old setup is sent again under
    /// the new one.
    private var ending: Task<Void, Never>?

    /// Ends the client as soon as what it was built from changes, even while
    /// the app is idle: a request of the old setup that is still out is then
    /// never sent again with it.
    private func endGatewayIfChanged() {
        guard let gateway, gateway.setup != clientSetup else { return }
        let old = gateway.backend.client
        let before = ending
        self.gateway = nil
        ending = Task {
            await before?.value
            await old.invalidate()
        }
    }

    /// The backend requests go to. The gateway one is kept while what its
    /// client is built from stays the same, so the client keeps its token
    /// between requests.
    func backend() async throws -> any AIBackend {
        // Every caller waits for the same end, then builds from the settings
        // as they are now, without waiting again in between: two callers can
        // never make two clients, and a client never mixes two setups.
        await ending?.value
        let setup = clientSetup
        if setup.simulated { return SimulatedBackend() }
        if let gateway, gateway.setup == setup { return gateway.backend }
        guard let url = URL(string: setup.baseURL), url.scheme != nil, !setup.appID.isEmpty else {
            throw ProviderError(status: 0, message: "Add your gateway URL and app ID in Settings.")
        }
        if setup.apiKey?.isEmpty == true {
            throw ProviderError(status: 0, message: "Add your API key in Settings.")
        }
        let backend = GatewayBackend(baseURL: url, appID: setup.appID, apiKey: setup.apiKey, slugs: setup.slugs)
        gateway = (setup, backend)
        return backend
    }
}
