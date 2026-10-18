import SwiftUI

/// A two-level menu: the providers offered for a capability, each opening a
/// submenu of its models.
struct ModelMenu<Label: View>: View {
    var capability: Capability
    @ViewBuilder var label: Label
    @Environment(AppSettings.self) private var settings
    @Environment(Navigator.self) private var nav
    @State private var customProvider: CatalogProvider?
    @State private var customModel = ""

    var body: some View {
        Menu {
            let providers = settings.providers(for: capability)
            if providers.isEmpty {
                Button("Turn on providers in Settings", systemImage: "gearshape") { nav.showSettings = true }
            }
            ForEach(providers) { provider in
                Menu {
                    ForEach(models(provider), id: \.self) { model in
                        let choice = ModelChoice(provider: provider.type, model: model)
                        Button { settings.select(choice, for: capability) } label: {
                            if choice == chosen { SwiftUI.Label(model, systemImage: "checkmark") } else { Text(model) }
                        }
                    }
                    Divider()
                    Button("Other model…", systemImage: "character.cursor.ibeam") {
                        customModel = ""
                        customProvider = provider
                    }
                } label: {
                    // The second text is the row's subtitle.
                    Text(provider.label)
                    Text(subtitle(provider))
                }
            }
        } label: {
            label
        }
        .menuOrder(.fixed)
        .alert("Model ID", isPresented: .init(get: { customProvider != nil }, set: { if !$0 { customProvider = nil } })) {
            TextField("model-id", text: $customModel)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Use") {
                let model = customModel.trimmingCharacters(in: .whitespaces)
                if let customProvider, !model.isEmpty {
                    settings.select(ModelChoice(provider: customProvider.type, model: model), for: capability)
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Any model \(customProvider?.label ?? "the provider") serves, as its API names it.")
        }
    }

    private var chosen: ModelChoice? { settings.model(for: capability) }

    /// The catalog's models, plus a typed-in one that is selected.
    private func models(_ provider: CatalogProvider) -> [String] {
        var models = provider.models(for: capability)
        if let chosen, chosen.provider == provider.type, !models.contains(chosen.model) {
            models.insert(chosen.model, at: 0)
        }
        return models
    }

    private func subtitle(_ provider: CatalogProvider) -> String {
        if let chosen, chosen.provider == provider.type { return "✓ \(chosen.model)" }
        let count = provider.models(for: capability).count
        return count == 0 ? "Type a model ID" : count == 1 ? "1 model" : "\(count) models"
    }
}
