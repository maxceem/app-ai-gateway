import SwiftUI

@main
struct GatewayDemoApp: App {
    @State private var settings: AppSettings
    @State private var history: HistoryStore
    @State private var runner: RequestRunner
    @State private var voice: VoiceConversation
    @State private var nav: Navigator

    init() {
        let settings = AppSettings()
        let history = HistoryStore()
        // `-SampleHistory YES` starts from a few made-up sessions, for screenshots.
        let nav = Navigator()
        #if DEBUG
        LaunchOptions.apply(settings: settings, history: history, nav: nav)
        #endif
        _nav = State(initialValue: nav)
        _settings = State(initialValue: settings)
        _history = State(initialValue: history)
        _runner = State(initialValue: RequestRunner(history: history, settings: settings))
        _voice = State(initialValue: VoiceConversation(history: history, settings: settings))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                #if DEBUG
                .task { LaunchOptions.send(settings: settings, runner: runner, nav: nav) }
                #endif
                .environment(settings)
                .environment(history)
                .environment(runner)
                .environment(voice)
                .environment(nav)
        }
    }
}
