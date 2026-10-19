#if DEBUG
import Foundation

/// Launch arguments that put the app in a given state, for screenshots:
///
///     -SampleHistory YES   start from a few made-up sessions
///     -Open 2              open the third history item
///     -Sidebar YES         open the sidebar
///     -Show settings       open Settings
///     -Kind image -Send "A red bicycle"   send a prompt on a new screen
///
/// and that point the app at a gateway, saved like changes made in Settings:
///
///     -GatewayURL https://api.appaigateway.com -AppID my-app-a1b2c3
///     -Providers openai,gemini   the providers to turn on, all others off
///     -Simulated NO
///     -APIKeyFile /path/key     sign with the API key in this file
///
/// and, for recording a demo, one that plays a prepared voice note when the
/// record button is tapped, instead of using the microphone:
///
///     -RecordingFile /path/voice.m4a
@MainActor
enum LaunchOptions {
    private static let defaults = UserDefaults.standard

    static var recordingFile: URL? {
        defaults.string(forKey: "RecordingFile").map { URL(fileURLWithPath: $0) }
    }

    static func apply(settings: AppSettings, history: HistoryStore, nav: Navigator) {
        if let url = defaults.string(forKey: "GatewayURL") { settings.values.baseURL = url }
        if let appID = defaults.string(forKey: "AppID") { settings.values.appID = appID }
        if let path = defaults.string(forKey: "APIKeyFile"), let key = try? String(contentsOfFile: path, encoding: .utf8) {
            settings.apiKey = key.trimmingCharacters(in: .whitespacesAndNewlines)
            settings.values.useAPIKey = true
        }
        if defaults.object(forKey: "Simulated") != nil { settings.values.simulated = defaults.bool(forKey: "Simulated") }
        if let list = defaults.string(forKey: "Providers") {
            let on = Set(list.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
            for provider in ModelCatalog.providers {
                settings.setProvider(provider.type, .init(enabled: on.contains(provider.type), slug: settings.provider(provider.type).slug))
            }
        }
        if defaults.bool(forKey: "SampleHistory") {
            history.replaceAll(with: SampleHistory.items(storingIn: history))
        }
        if let index = defaults.string(forKey: "Open").flatMap(Int.init), history.items.indices.contains(index) {
            nav.open(history.items[index])
        }
        if let kind = defaults.string(forKey: "Kind").flatMap(Capability.init(rawValue:)) {
            nav.new(kind)
        }
        nav.sidebarOpen = defaults.bool(forKey: "Sidebar")
        nav.showSettings = defaults.string(forKey: "Show") == "settings"
    }

    static func send(settings: AppSettings, runner: RequestRunner, nav: Navigator) {
        guard let prompt = defaults.string(forKey: "Send"), let model = settings.model(for: nav.kind) else { return }
        switch nav.kind {
        case .chat: nav.itemID = runner.sendChat(prompt, image: nil, in: nav.itemID, model: model)
        case .image: nav.itemID = runner.generateImage(prompt, aspect: .square, in: nav.itemID, model: model)
        case .transcription, .voice: break
        }
    }
}
#endif
