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
    /// A finished conversation: the mic starts a new one rather than continuing it.
    private var ended: Bool { !live && !(history.item(itemID)?.entries.isEmpty ?? true) }

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
                // Your turn is a green microphone, the model's a blue speaker.
                Group {
                    if voice.phase == .thinking || voice.phase == .speaking {
                        TurnOrb(color: .blue, symbol: "speaker.wave.2.fill", level: voice.outputLevel, busy: voice.phase == .thinking)
                    } else {
                        TurnOrb(color: .green, symbol: "mic.fill", level: voice.inputLevel, busy: voice.phase == .connecting)
                    }
                }
                .frame(height: 120)
                .transition(.opacity)
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
                .accessibilityLabel(live ? "End conversation" : ended ? "Start a new voice chat" : "Start talking")
                Spacer()
                Color.clear.frame(width: 50, height: 50)
            }
            .padding(.horizontal, 28)
            Text(live ? requests : ended ? "This chat has ended. Tap to start a new one." : "Tap to start talking")
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
        case .speaking: ("Answering", "Start talking to interrupt")
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

/// Whose turn it is, with rings that swell as they get louder: you at the
/// microphone, or the model at the speaker. A spinner while it waits.
private struct TurnOrb: View {
    var color: Color
    var symbol: String
    var level: CGFloat
    var busy: Bool

    var body: some View {
        ZStack {
            Circle()
                .fill(color.opacity(0.08))
                .frame(width: 120, height: 120)
                .scaleEffect(busy ? 0.6 : 0.6 + level * 0.4)
            Circle()
                .fill(color.opacity(0.16))
                .frame(width: 92, height: 92)
                .scaleEffect(busy ? 0.75 : 0.75 + level * 0.25)
            Circle()
                .fill(color)
                .frame(width: 64, height: 64)
            if busy {
                ProgressView()
                    .tint(.white)
            } else {
                Image(systemName: symbol)
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(.white)
                    // The speaker's waves play; a microphone has none to play.
                    .symbolEffect(.variableColor.iterative, options: .repeating)
            }
        }
        .animation(.linear(duration: 0.08), value: level)
        .accessibilityHidden(true)
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
