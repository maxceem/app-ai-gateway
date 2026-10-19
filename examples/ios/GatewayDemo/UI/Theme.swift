import SwiftUI

enum Theme {
    /// The main screen.
    static let canvas = dynamic(light: 0xFFFFFF, dark: 0x212121)
    /// The sidebar behind it.
    static let sidebar = dynamic(light: 0xF9F9F9, dark: 0x171717)
    /// Buttons and pills that float over the canvas.
    static let raised = dynamic(light: 0xFFFFFF, dark: 0x2F2F2F)
    /// The user's messages, and cards.
    static let bubble = dynamic(light: 0xF1F1F1, dark: 0x303030)
    static let hairline = dynamic(light: 0xE6E6E6, dark: 0x3A3A3A)

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }
}

private extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat(hex >> 16 & 0xFF) / 255, green: CGFloat(hex >> 8 & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

extension View {
    /// The soft shadow under everything that floats.
    func floating() -> some View {
        shadow(color: .black.opacity(0.07), radius: 14, y: 4)
    }
}

/// The round white button of the top bar and the sidebar.
struct CircleButton<Label: View>: View {
    var action: () -> Void
    @ViewBuilder var label: Label

    var body: some View {
        Button(action: action) {
            label
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(.primary)
                .frame(width: 50, height: 50)
                .background(Theme.raised, in: Circle())
                .floating()
        }
        .buttonStyle(.plain)
    }
}

extension CircleButton where Label == Image {
    init(_ systemImage: String, action: @escaping () -> Void) {
        self.action = action
        label = Image(systemName: systemImage)
    }
}

/// Two lines, the second shorter: the sidebar button.
struct MenuGlyph: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Capsule().frame(width: 20, height: 2.2)
            Capsule().frame(width: 13, height: 2.2)
        }
        .frame(width: 22, height: 22)
    }
}

extension Capability {
    var symbol: String {
        switch self {
        case .chat: "bubble.left"
        case .transcription: "waveform"
        case .image: "photo"
        case .voice: "person.wave.2"
        }
    }

    var newTitle: String {
        switch self {
        case .chat: "New chat"
        case .transcription: "New transcription"
        case .image: "New image"
        case .voice: "New voice chat"
        }
    }
}

extension ModelChoice {
    var label: String { "\(ModelCatalog.label(provider)) · \(model)" }
}

/// A failed request: the code the gateway or provider answered, its message, and a retry.
struct FailureCard: View {
    var failure: Failure
    var retry: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 6) {
                Text(failure.code)
                    .font(.footnote.monospaced().weight(.semibold))
                    .foregroundStyle(.red)
                Text(failure.message)
                    .font(.subheadline)
                    .textSelection(.enabled)
                if let retry {
                    Button("Try again", action: retry)
                        .font(.subheadline.weight(.semibold))
                        .padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(Color.red.opacity(0.07), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

/// Live input level bars.
struct Waveform: View {
    var levels: [CGFloat]
    var color: Color = .primary

    var body: some View {
        HStack(alignment: .center, spacing: 2.5) {
            ForEach(levels.indices, id: \.self) { index in
                Capsule()
                    .fill(color.opacity(0.85))
                    .frame(width: 3, height: 4 + levels[index] * 26)
            }
        }
        .frame(height: 32)
        .animation(.linear(duration: 0.05), value: levels)
    }
}

/// Which model answered, under each answer.
struct ModelCaption: View {
    var model: ModelChoice?

    var body: some View {
        if let model {
            Text(model.label)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }
}

/// A pulsing dot while an answer has not started.
struct ThinkingDot: View {
    @State private var on = false

    var body: some View {
        Circle()
            .fill(.primary)
            .frame(width: 14, height: 14)
            .scaleEffect(on ? 1 : 0.6)
            .opacity(on ? 1 : 0.5)
            .animation(.easeInOut(duration: 0.6).repeatForever(), value: on)
            .onAppear { on = true }
    }
}

func formatDuration(_ seconds: TimeInterval) -> String {
    let total = Int(seconds.rounded())
    return String(format: "%d:%02d", total / 60, total % 60)
}
