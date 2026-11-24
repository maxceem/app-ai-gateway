import AppAIGateway
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

    /// What the gateway client is built from: where it sends, and how it
    /// proves who is calling. Slugs, models and turning a provider on change
    /// none of it, so the client and its token and App Attest key stay.
    private struct ClientSetup: Equatable {
        var baseURL: String
        var appID: String
        var apiKey: String?
    }

    /// The client in use, and the setup it was built from.
    private var gateway: (setup: ClientSetup, client: AppAIGatewayClient)?

    /// The backend a request goes to: the cached client, with the slugs as
    /// they are now. The client is kept while what it is built from stays the
    /// same, so it keeps its token between requests. When that changes, the
    /// next request gets a new client; a request already out keeps the backend
    /// it started with, retries included, and the old client goes away once
    /// nothing holds it.
    func backend() throws -> any AIBackend {
        if values.simulated { return SimulatedBackend() }
        let setup = ClientSetup(baseURL: values.baseURL, appID: values.appID, apiKey: values.useAPIKey ? apiKey : nil)
        if let gateway, gateway.setup == setup { return GatewayBackend(client: gateway.client, slugs: slugs) }
        guard let url = URL(string: setup.baseURL), url.scheme != nil, !setup.appID.isEmpty else {
            throw ProviderError(status: 0, message: "Add your gateway URL and app ID in Settings.")
        }
        if setup.apiKey?.isEmpty == true {
            throw ProviderError(status: 0, message: "Add your API key in Settings.")
        }
        // A slug change reuses the existing client; a change of gateway, app
        // or key makes a new one. Each client manages its own App Attest key,
        // so a slug change must never make a second one for the same install.
        // (A different app ID has its own Keychain slot.)
        //
        // The demo has no sign-in, so no user's identity can pass from one
        // client to the next, and the old client is not ended. An app whose
        // users sign in must `await client.invalidate()` before it switches
        // users, and make a new client for the new user: see "One client per
        // signed-in session" in the Swift SDK's README.
        let client = GatewayBackend.makeClient(baseURL: url, appID: setup.appID, apiKey: setup.apiKey)
        gateway = (setup, client)
        return GatewayBackend(client: client, slugs: slugs)
    }
}
