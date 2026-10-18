import SwiftUI

/// The floating input at the bottom of the chat and image screens: an
/// accessory on the left, the text, dictation, and send or stop.
struct Composer<Accessory: View>: View {
    @Binding var text: String
    var placeholder: String
    var busy: Bool
    var canSend: Bool
    var send: () -> Void
    var stop: () -> Void
    /// Turns a voice note into text for the field, through the transcription model.
    var dictate: ((Recording) async throws -> String)?
    @ViewBuilder var accessory: Accessory
    var attachment: AnyView?

    @State private var recorder = AudioRecorder()
    @State private var transcribing = false
    @State private var problem: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let attachment { attachment }
            HStack(alignment: .bottom, spacing: 6) {
                if recorder.isRecording {
                    recording
                } else {
                    accessory
                        .frame(width: 40, height: 40)
                    TextField(placeholder, text: $text, axis: .vertical)
                        .font(.system(size: 18))
                        .lineLimit(1...6)
                        .focused($focused)
                        .padding(.vertical, 9)
                    if dictate != nil {
                        Button { Task { await startDictation() } } label: {
                            Group {
                                if transcribing { ProgressView() } else { Image(systemName: "mic") }
                            }
                            .font(.system(size: 20))
                            .frame(width: 40, height: 40)
                        }
                        .buttonStyle(.plain)
                        .disabled(transcribing)
                        .accessibilityLabel("Dictate")
                    }
                    sendButton
                }
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, 7)
        .padding(.vertical, 7)
        .background(Theme.raised, in: RoundedRectangle(cornerRadius: 30, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 30, style: .continuous).stroke(Theme.hairline, lineWidth: 0.5))
        .floating()
        .padding(.horizontal, 14)
        .padding(.bottom, 8)
        .alert("Dictation failed", isPresented: .init(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(problem ?? "")
        }
    }

    private var sendButton: some View {
        Button(action: busy ? stop : send) {
            Image(systemName: busy ? "stop.fill" : "arrow.up")
                .font(.system(size: busy ? 14 : 18, weight: .bold))
                .foregroundStyle(Theme.canvas)
                .frame(width: 40, height: 40)
                .background(busy || canSend ? Color.primary : Color.secondary.opacity(0.35), in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(!busy && !canSend)
        .accessibilityLabel(busy ? "Stop" : "Send")
    }

    private var recording: some View {
        HStack(spacing: 10) {
            Button { recorder.cancel() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 40, height: 40)
            }
            .buttonStyle(.plain)
            Waveform(levels: Array(recorder.levels.suffix(30)))
                .frame(maxWidth: .infinity)
            Text(formatDuration(recorder.elapsed))
                .font(.system(size: 15).monospacedDigit())
                .foregroundStyle(.secondary)
            Button { Task { await finishDictation() } } label: {
                Image(systemName: "checkmark")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(Theme.canvas)
                    .frame(width: 40, height: 40)
                    .background(.primary, in: Circle())
            }
            .buttonStyle(.plain)
        }
    }

    private func startDictation() async {
        do {
            focused = false
            try await recorder.start()
        } catch {
            problem = error.localizedDescription
        }
    }

    private func finishDictation() async {
        guard let recording = recorder.stop(), let dictate else { return }
        transcribing = true
        defer { transcribing = false }
        do {
            let words = try await dictate(recording).trimmingCharacters(in: .whitespacesAndNewlines)
            text = text.isEmpty ? words : "\(text) \(words)"
        } catch {
            problem = Failure(error).message
        }
    }
}

/// A starter prompt on an empty screen.
struct Suggestion {
    var symbol: String
    var color: Color
    var prompt: String
}

/// Starter prompts, as icon rows above the composer.
struct Suggestions: View {
    var items: [Suggestion]
    var pick: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(items, id: \.prompt) { item in
                Button { pick(item.prompt) } label: {
                    HStack(spacing: 14) {
                        Image(systemName: item.symbol)
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(item.color)
                            .frame(width: 36, height: 36)
                            .background(item.color.opacity(0.13), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                        Text(item.prompt)
                            .font(.system(size: 18))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .frame(height: 54)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 10)
    }
}
