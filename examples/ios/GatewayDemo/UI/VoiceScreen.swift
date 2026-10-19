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
                VoiceWave(samples: voice.wave, phase: voice.phase)
                VStack(spacing: 4) {
                    Text(status.title)
                        .font(.system(size: 17, weight: .medium))
                    Text(status.hint)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
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

    /// What is going on, and what you can do about it.
    private var status: (title: String, hint: String) {
        switch voice.phase {
        case .idle: ("", "")
        case .connecting: ("Connecting…", "Opening a session through your gateway")
        case .listening: ("Listening", "Start talking, then pause to get an answer")
        case .hearing: ("Hearing you", "Pause when you're done")
        case .thinking: ("Thinking", "Your turn is sent, the answer is on its way")
        case .speaking: ("Speaking", "Talk over it to interrupt")
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

/// The last couple of seconds of sound, scrolling left: your voice while you
/// talk, the answer while it speaks.
private struct VoiceWave: View {
    var samples: [CGFloat]
    var phase: VoiceConversation.Phase

    var body: some View {
        HStack(spacing: 3) {
            ForEach(samples.indices, id: \.self) { index in
                Capsule()
                    .fill(color)
                    .frame(width: 4, height: 4 + samples[index] * 76)
            }
        }
        .frame(height: 84)
        .overlay {
            if phase == .connecting || phase == .thinking {
                ProgressView()
                    .padding(10)
                    .background(Theme.canvas, in: Circle())
            }
        }
        .animation(.linear(duration: 0.05), value: samples)
        .animation(.snappy, value: phase)
        .accessibilityHidden(true)
    }

    private var color: Color {
        switch phase {
        case .speaking: .blue
        case .hearing: .primary
        default: .secondary.opacity(0.6)
        }
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
