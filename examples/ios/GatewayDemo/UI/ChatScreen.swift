import PhotosUI
import SwiftUI

struct ChatScreen: View {
    var itemID: UUID?
    @Environment(HistoryStore.self) private var history
    @Environment(AppSettings.self) private var settings
    @Environment(RequestRunner.self) private var runner
    @Environment(Navigator.self) private var nav
    @State private var text = ""
    @State private var photo: PhotosPickerItem?
    @State private var attachment: Data?

    var body: some View {
        let entries = history.item(itemID)?.entries ?? []
        VStack(spacing: 0) {
            if entries.isEmpty {
                Spacer()
                Suggestions(items: [
                    Suggestion(symbol: "pencil.line", color: .orange, prompt: "Write a haiku about rate limits"),
                    Suggestion(symbol: "lock.shield", color: .blue, prompt: "Explain App Attest in one paragraph"),
                    Suggestion(symbol: "airplane", color: .green, prompt: "Plan three days in Lisbon"),
                ]) { send($0) }
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 26) {
                        ForEach(entries) { entry in
                            MessageRow(entry: entry, retry: retry)
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
                placeholder: "Ask anything",
                busy: runner.isRunning(itemID),
                canSend: !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || attachment != nil,
                send: { send(text) },
                stop: { runner.cancel(itemID) },
                dictate: dictation,
                accessory: {
                    PhotosPicker(selection: $photo, matching: .images) {
                        Image(systemName: "plus")
                            .font(.system(size: 22, weight: .regular))
                            .foregroundStyle(.primary)
                            .frame(width: 40, height: 40)
                    }
                },
                attachment: attachment.flatMap(UIImage.init(data:)).map { image in
                    AnyView(AttachmentChip(image: image) { attachment = nil; photo = nil })
                }
            )
        }
        .task(id: photo) {
            guard let photo, let data = try? await photo.loadTransferable(type: Data.self) else { return }
            attachment = UIImage(data: data)?.jpeg(maxSide: 1024)
        }
    }

    private var dictation: ((Recording) async throws -> String)? {
        guard let model = settings.model(for: .transcription) else { return nil }
        return { try await runner.dictate($0, model: model) }
    }

    private func send(_ message: String) {
        guard let model = settings.model(for: .chat) else { nav.showSettings = true; return }
        let message = message.trimmingCharacters(in: .whitespacesAndNewlines)
        nav.itemID = runner.sendChat(message, image: attachment, in: itemID, model: model)
        text = ""
        attachment = nil
        photo = nil
    }

    private func retry() {
        guard let itemID, let model = settings.model(for: .chat) else { return }
        runner.retryChat(itemID, model: model)
    }
}

private struct MessageRow: View {
    var entry: Entry
    var retry: () -> Void
    @Environment(HistoryStore.self) private var history

    var body: some View {
        switch entry.role {
        case .user:
            HStack {
                Spacer(minLength: 56)
                VStack(alignment: .trailing, spacing: 6) {
                    if let image = history.data(entry.file).flatMap(UIImage.init(data:)) {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                            .frame(width: 180, height: 180)
                            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    }
                    if !entry.text.isEmpty {
                        Text(entry.text)
                            .font(.system(size: 17))
                            .padding(.horizontal, 16)
                            .padding(.vertical, 11)
                            .background(Theme.bubble, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                            .textSelection(.enabled)
                    }
                }
            }
        case .assistant:
            VStack(alignment: .leading, spacing: 12) {
                if let failure = entry.failure {
                    FailureCard(failure: failure, retry: retry)
                } else if entry.text.isEmpty {
                    ThinkingDot()
                } else {
                    MarkdownText(text: entry.text)
                        .textSelection(.enabled)
                }
                if !entry.pending {
                    ModelCaption(model: entry.model)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct AttachmentChip: View {
    var image: UIImage
    var remove: () -> Void

    var body: some View {
        Image(uiImage: image)
            .resizable()
            .scaledToFill()
            .frame(width: 64, height: 64)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(alignment: .topTrailing) {
                Button(action: remove) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 22, height: 22)
                        .background(.black.opacity(0.7), in: Circle())
                }
                .buttonStyle(.plain)
                .offset(x: 6, y: -6)
            }
            .padding(.top, 6)
            .padding(.leading, 6)
    }
}

extension UIImage {
    /// A JPEG no larger than `maxSide` on its long edge: small enough to send.
    func jpeg(maxSide: CGFloat) -> Data? {
        let scale = min(1, maxSide / max(size.width, size.height))
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: target, format: format)
            .image { _ in draw(in: CGRect(origin: .zero, size: target)) }
            .jpegData(compressionQuality: 0.8)
    }
}
