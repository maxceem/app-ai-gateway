import SwiftUI

struct VoiceScreen: View {
    var itemID: UUID?
    @Environment(HistoryStore.self) private var history
    @Environment(AppSettings.self) private var settings
    @Environment(VoiceConversation.self) private var voice
    @Environment(Navigator.self) private var nav
    @Environment(\.scenePhase) private var scenePhase

    /// Whether this screen shows the conversation that is going on.
    private var live: Bool { voice.isActive && voice.itemID == itemID }

    var body: some View {
        let entries = history.item(itemID)?.entries ?? []
        VStack(spacing: 0) {
            if entries.isEmpty {
                Spacer()
                if !live { intro }
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 22) {
                        ForEach(entries) { entry in
                            if entry.role == .user {
                                SpokenTurn(duration: entry.duration ?? 0)
                            } else {
                                AnswerRow(entry: entry, retry: start)
                            }
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 12)
                }
                .defaultScrollAnchor(.bottom)
                .defaultScrollAnchor(.bottom, for: .sizeChanges)
            }
            dock
        }
        .onDisappear {
            // Leaving the conversation ends it; a new screen for the same one does not.
            if nav.kind != .voice || nav.itemID != voice.itemID { voice.stop() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background, live { voice.stop() }
        }
    }

    private var intro: some View {
        VStack(spacing: 14) {
            Image(systemName: "person.wave.2")
                .font(.system(size: 34, weight: .medium))
                .frame(width: 84, height: 84)
                .background(Theme.bubble, in: Circle())
            Text("Talk it through")
                .font(.system(size: 24, weight: .semibold))
            Text("A live voice conversation with \(settings.model(for: .voice)?.model ?? "a realtime model"), over one WebSocket through your gateway. Each answer counts as one request.")
                .font(.system(size: 16))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
    }

    private var dock: some View {
        VStack(spacing: 18) {
            if live {
                Orb(level: voice.level, phase: voice.phase)
                    .frame(height: 120)
                Text(status)
                    .font(.system(size: 17, weight: .medium))
                    .contentTransition(.opacity)
            }
            HStack {
                Color.clear.frame(width: 50, height: 50)
                Spacer()
                Button(action: live ? voice.stop : start) {
                    ZStack {
                        Circle()
                            .fill(live ? Color.red : Color.primary)
                            .frame(width: 78, height: 78)
                        Image(systemName: live ? "xmark" : "mic.fill")
                            .font(.system(size: 28, weight: live ? .semibold : .regular))
                            .foregroundStyle(live ? .white : Theme.canvas)
                    }
                    .floating()
                }
                .buttonStyle(.plain)
                .accessibilityLabel(live ? "End conversation" : "Start talking")
                Spacer()
                Color.clear.frame(width: 50, height: 50)
            }
            .padding(.horizontal, 28)
            Text(live ? requests : "Tap to start talking")
                .font(.footnote.monospacedDigit())
                .foregroundStyle(.secondary)
        }
        .padding(.top, 12)
        .padding(.bottom, 10)
        .animation(.snappy, value: live)
        .animation(.snappy, value: voice.phase)
    }

    private var status: String {
        switch voice.phase {
        case .idle: ""
        case .connecting: "Connecting…"
        case .listening: "Listening"
        case .hearing: "Hearing you"
        case .thinking: "Thinking"
        case .speaking: "Speaking"
        }
    }

    private var requests: String {
        voice.responses == 1 ? "1 answer · 1 request" : "\(voice.responses) answers · \(voice.responses) requests"
    }

    /// Starts a new conversation: a finished one cannot be picked up again,
    /// because a realtime session does not outlive its socket.
    private func start() {
        guard let model = settings.model(for: .voice) else { nav.showSettings = true; return }
        nav.itemID = voice.start(model: model)
    }
}

/// A circle that breathes with whoever is talking.
private struct Orb: View {
    var level: CGFloat
    var phase: VoiceConversation.Phase

    var body: some View {
        let speaking = phase == .speaking
        ZStack {
            Circle()
                .fill((speaking ? Color.blue : Color.primary).opacity(0.08))
                .frame(width: 120, height: 120)
                .scaleEffect(0.75 + level * 0.45)
            Circle()
                .fill(speaking ? Color.blue : Color.primary)
                .frame(width: 72, height: 72)
                .scaleEffect(0.9 + level * 0.25)
            if phase == .connecting || phase == .thinking {
                ProgressView().tint(Theme.canvas)
            }
        }
        .animation(.linear(duration: 0.05), value: level)
    }
}

/// One of your turns: the realtime session hears it, and keeps no text of it.
private struct SpokenTurn: View {
    var duration: TimeInterval

    var body: some View {
        HStack {
            Spacer(minLength: 56)
            HStack(spacing: 10) {
                Image(systemName: "waveform")
                    .font(.system(size: 15, weight: .semibold))
                Text("You spoke")
                    .font(.system(size: 17))
                if duration > 0 {
                    Text(formatDuration(duration))
                        .font(.system(size: 15).monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 11)
            .background(Theme.bubble, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
    }
}

/// What the model said, transcribed as it spoke.
private struct AnswerRow: View {
    var entry: Entry
    var retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let failure = entry.failure {
                FailureCard(failure: failure, retry: retry)
            } else if entry.text.isEmpty {
                ThinkingDot()
            } else {
                Text(entry.text)
                    .font(.system(size: 17))
                    .lineSpacing(3)
                    .textSelection(.enabled)
            }
            if !entry.pending {
                ModelCaption(model: entry.model)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
