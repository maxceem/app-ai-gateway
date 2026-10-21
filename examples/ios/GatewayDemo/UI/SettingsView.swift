import SwiftUI

struct SettingsView: View {
    @Environment(AppSettings.self) private var settings
    @Environment(HistoryStore.self) private var history
    @Environment(Navigator.self) private var nav
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingDelete = false

    private var enabledSummary: String {
        let count = ModelCatalog.providers.filter { settings.provider($0.type).enabled }.count
        return count == 1 ? "1 on" : "\(count) on"
    }

    var body: some View {
        @Bindable var settings = settings
        NavigationStack {
            Form {
                Section {
                    LabeledContent("URL") {
                        TextField("https://api.appaigateway.com", text: $settings.values.baseURL)
                            .keyboardType(.URL)
                            .multilineTextAlignment(.trailing)
                    }
                    LabeledContent("App ID") {
                        TextField("my-app-a1b2c3", text: $settings.values.appID)
                            .multilineTextAlignment(.trailing)
                    }
                    Picker("Sign requests with", selection: $settings.values.useAPIKey) {
                        Text("App Attest").tag(false)
                        Text("API key").tag(true)
                    }
                    if settings.values.useAPIKey {
                        SecureField("Application API key", text: $settings.apiKey)
                    }
                } header: {
                    Text("Gateway")
                } footer: {
                    Text(settings.values.useAPIKey
                         ? "An API key works in the simulator. Use one for testing only: a key shipped in an app can be extracted."
                         : "App Attest proves each request comes from this app on a real device. It does not work in the simulator.")
                }
                .autocorrectionDisabled()

                Section {
                    NavigationLink {
                        ProvidersView()
                    } label: {
                        LabeledContent("Providers", value: enabledSummary)
                    }
                }

                Section {
                    Button("Delete all history", role: .destructive) { confirmingDelete = true }
                } footer: {
                    Text("Chats, images and transcripts are stored only on this device.")
                }
            }
            .textInputAutocapitalization(.never)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .confirmationDialog("Delete all chats, images and transcripts?", isPresented: $confirmingDelete, titleVisibility: .visible) {
                Button("Delete all", role: .destructive) {
                    history.deleteAll()
                    nav.new(nav.kind)
                }
            }
        }
    }
}

/// Every provider type, each turned on with the slug it is connected under.
private struct ProvidersView: View {
    var body: some View {
        Form {
            Section {
                ForEach(ModelCatalog.providers) { provider in
                    ProviderRow(provider: provider)
                }
            } footer: {
                Text("Turn on the providers you connected to your gateway. The first of each type uses its type as its slug. The models come from the gateway's price catalog; your app may allow fewer.")
            }
        }
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .navigationTitle("Providers")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct ProviderRow: View {
    var provider: CatalogProvider
    @Environment(AppSettings.self) private var settings

    var body: some View {
        let setting = settings.provider(provider.type)
        VStack(alignment: .leading, spacing: 6) {
            Toggle(isOn: .init(get: { setting.enabled }, set: { settings.setProvider(provider.type, .init(enabled: $0, slug: setting.slug)) })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(provider.label)
                    Text(capabilities)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if setting.enabled {
                HStack {
                    Text("Slug").font(.footnote).foregroundStyle(.secondary)
                    TextField(provider.type, text: .init(
                        get: { setting.slug },
                        set: { settings.setProvider(provider.type, .init(enabled: true, slug: $0.isEmpty ? provider.type : $0)) }
                    ))
                    .font(.footnote.monospaced())
                }
            }
        }
    }

    private var capabilities: String {
        Capability.allCases.filter(provider.supports).map {
            switch $0 {
            case .chat: "Chat"
            case .transcription: "Transcription"
            case .image: "Images"
            case .voice: "Voice"
            }
        }.joined(separator: " · ")
    }
}
