import SwiftUI

struct TranscribeScreen: View {
    var itemID: UUID?
    @Environment(HistoryStore.self) private var history
    @Environment(AppSettings.self) private var settings
    @Environment(RequestRunner.self) private var runner
    @Environment(Navigator.self) private var nav
    @State private var recorder = AudioRecorder()
    @State private var problem: String?

    var body: some View {
        let entries = history.item(itemID)?.entries ?? []
        VStack(spacing: 0) {
            if entries.isEmpty {
                Spacer()
                intro
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 22) {
                        ForEach(entries) { entry in
                            if entry.role == .user {
                                VoiceNote(duration: entry.duration ?? 0)
                            } else {
                                TranscriptRow(entry: entry, retry: retry)
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
        .alert("Can't record", isPresented: .init(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(problem ?? "")
        }
    }

    private var intro: some View {
        VStack(spacing: 14) {
            Image(systemName: Capability.transcription.symbol)
                .font(.system(size: 34, weight: .medium))
                .frame(width: 84, height: 84)
                .background(Theme.bubble, in: Circle())
            Text("Record a voice note")
                .font(.system(size: 24, weight: .semibold))
            Text("It goes to \(settings.model(for: .transcription)?.model ?? "a transcription model") through your gateway and comes back as text.")
                .font(.system(size: 16))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
    }

    /// The record button, with the waveform and timer while recording.
    private var dock: some View {
        VStack(spacing: 18) {
            if recorder.isRecording {
                Waveform(levels: recorder.levels)
                Text(formatDuration(recorder.elapsed))
                    .font(.system(size: 17, weight: .medium).monospacedDigit())
            }
            HStack {
                // Cancel, while recording; the space keeps the record button centred.
                if recorder.isRecording {
                    CircleButton("xmark") { recorder.cancel() }
                } else {
                    Color.clear.frame(width: 50, height: 50)
                }
                Spacer()
                Button { Task { await toggleRecording() } } label: {
                    ZStack {
                        Circle()
                            .fill(recorder.isRecording ? Color.red : Color.primary)
                            .frame(width: 78, height: 78)
                        if recorder.isRecording {
                            RoundedRectangle(cornerRadius: 6).fill(.white).frame(width: 26, height: 26)
                        } else if runner.isRunning(itemID) {
                            ProgressView().tint(Theme.canvas)
                        } else {
                            Image(systemName: "mic.fill")
                                .font(.system(size: 28))
                                .foregroundStyle(Theme.canvas)
                        }
                    }
                    .floating()
                }
                .buttonStyle(.plain)
                .disabled(runner.isRunning(itemID))
                .accessibilityLabel(recorder.isRecording ? "Stop recording" : "Record")
                Spacer()
                Color.clear.frame(width: 50, height: 50)
            }
            .padding(.horizontal, 28)
            Text(recorder.isRecording ? "Tap to stop and transcribe" : "Tap to record")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.top, 12)
        .padding(.bottom, 10)
        .animation(.snappy, value: recorder.isRecording)
    }

    private func toggleRecording() async {
        guard let model = settings.model(for: .transcription) else { nav.showSettings = true; return }
        if recorder.isRecording {
            if let recording = recorder.stop() {
                nav.itemID = runner.transcribe(recording, in: itemID, model: model)
            }
            return
        }
        do {
            try await recorder.start()
        } catch {
            problem = error.localizedDescription
        }
    }

    private func retry() {
        guard let itemID, let model = settings.model(for: .transcription) else { return }
        runner.retryTranscription(itemID, model: model)
    }
}

private struct VoiceNote: View {
    var duration: TimeInterval

    var body: some View {
        HStack {
            Spacer(minLength: 56)
            HStack(spacing: 10) {
                Image(systemName: "waveform")
                    .font(.system(size: 15, weight: .semibold))
                Text("Voice note")
                    .font(.system(size: 17))
                Text(formatDuration(duration))
                    .font(.system(size: 15).monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 11)
            .background(Theme.bubble, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
    }
}

private struct TranscriptRow: View {
    var entry: Entry
    var retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let failure = entry.failure {
                FailureCard(failure: failure, retry: retry)
                ModelCaption(model: entry.model)
            } else if entry.pending {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Transcribing…").foregroundStyle(.secondary)
                }
            } else {
                Text(entry.text)
                    .font(.system(size: 17))
                    .lineSpacing(3)
                    .textSelection(.enabled)
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Theme.hairline))
                ModelCaption(model: entry.model)
            }
        }
    }
}
