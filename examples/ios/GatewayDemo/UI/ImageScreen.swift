import SwiftUI

struct ImageScreen: View {
    var itemID: UUID?
    @Environment(HistoryStore.self) private var history
    @Environment(AppSettings.self) private var settings
    @Environment(RequestRunner.self) private var runner
    @Environment(Navigator.self) private var nav
    @State private var text = ""
    @State private var aspect = ImageAspect.square

    var body: some View {
        let entries = history.item(itemID)?.entries ?? []
        VStack(spacing: 0) {
            if entries.isEmpty {
                Spacer()
                Suggestions(items: [
                    Suggestion(symbol: "paintpalette", color: .pink, prompt: "A fox reading a newspaper in a Paris café, watercolor"),
                    Suggestion(symbol: "mountain.2", color: .indigo, prompt: "A tiny cabin under the northern lights, isometric"),
                    Suggestion(symbol: "camera", color: .orange, prompt: "A bowl of ramen as a 1970s product photo"),
                ]) { generate($0) }
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 22) {
                        ForEach(entries) { entry in
                            if entry.role == .user {
                                HStack {
                                    Spacer(minLength: 56)
                                    Text(entry.text)
                                        .font(.system(size: 17))
                                        .padding(.horizontal, 16)
                                        .padding(.vertical, 11)
                                        .background(Theme.bubble, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                                }
                            } else {
                                GeneratedImage(entry: entry, retry: retry)
                            }
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 12)
                }
                .defaultScrollAnchor(.bottom)
                .defaultScrollAnchor(.bottom, for: .sizeChanges)
                .scrollDismissesKeyboard(.interactively)
            }

            Composer(
                text: $text,
                placeholder: "Describe an image",
                busy: runner.isRunning(itemID),
                canSend: !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                send: { generate(text) },
                stop: { runner.cancel(itemID) },
                dictate: dictation,
                accessory: {
                    Menu {
                        Picker("Shape", selection: $aspect) {
                            Label("Square · 1:1", systemImage: "square").tag(ImageAspect.square)
                            Label("Portrait · 2:3", systemImage: "rectangle.portrait").tag(ImageAspect.portrait)
                            Label("Landscape · 3:2", systemImage: "rectangle").tag(ImageAspect.landscape)
                        }
                    } label: {
                        Text(aspect.label)
                            .font(.system(size: 13, weight: .semibold).monospacedDigit())
                            .foregroundStyle(.primary)
                            .frame(width: 38, height: 30)
                            .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(.primary.opacity(0.35), lineWidth: 1.2))
                            .frame(width: 40, height: 40)
                    }
                },
                attachment: nil
            )
        }
    }

    private var dictation: ((Recording) async throws -> String)? {
        guard let model = settings.model(for: .transcription) else { return nil }
        return { try await runner.dictate($0, model: model) }
    }

    private func generate(_ prompt: String) {
        guard let model = settings.model(for: .image) else { nav.showSettings = true; return }
        nav.itemID = runner.generateImage(prompt.trimmingCharacters(in: .whitespacesAndNewlines), aspect: aspect, in: itemID, model: model)
        text = ""
    }

    private func retry() {
        guard let itemID, let model = settings.model(for: .image) else { return }
        runner.retryImage(itemID, model: model)
    }
}

private struct GeneratedImage: View {
    var entry: Entry
    var retry: () -> Void
    @Environment(HistoryStore.self) private var history
    @State private var saved = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let failure = entry.failure {
                FailureCard(failure: failure, retry: retry)
                ModelCaption(model: entry.model)
            } else if let image = history.data(entry.file).flatMap(UIImage.init(data:)) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                    .frame(maxWidth: 340, alignment: .leading)
                HStack(spacing: 6) {
                    Button {
                        UIImageWriteToSavedPhotosAlbum(image, nil, nil, nil)
                        saved = true
                    } label: {
                        Image(systemName: saved ? "checkmark" : "arrow.down.to.line")
                            .font(.system(size: 20))
                            .foregroundStyle(.secondary)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(saved)
                    .accessibilityLabel(saved ? "Saved to Photos" : "Save to Photos")
                    ModelCaption(model: entry.model)
                }
                // Line the icon up with the image, not its touch target.
                .padding(.leading, -11)
                .padding(.top, -6)
            } else {
                Placeholder(aspect: entry.aspect ?? .square)
            }
        }
    }
}

/// The shimmering card an image fills once it arrives.
private struct Placeholder: View {
    var aspect: ImageAspect
    @State private var phase: CGFloat = -1

    var body: some View {
        RoundedRectangle(cornerRadius: 24, style: .continuous)
            .fill(Theme.bubble)
            .overlay {
                LinearGradient(colors: [.clear, .primary.opacity(0.06), .clear], startPoint: .leading, endPoint: .trailing)
                    .frame(width: 160)
                    .rotationEffect(.degrees(20))
                    .offset(x: phase * 340)
            }
            .overlay {
                Label("Creating image", systemImage: "sparkles")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
            }
            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
            .aspectRatio(aspect.ratio, contentMode: .fit)
            .frame(maxWidth: 340, alignment: .leading)
            .onAppear {
                withAnimation(.linear(duration: 1.4).repeatForever(autoreverses: false)) { phase = 1 }
            }
    }
}

extension ImageAspect {
    var label: String {
        switch self {
        case .square: "1:1"
        case .portrait: "2:3"
        case .landscape: "3:2"
        }
    }
}
