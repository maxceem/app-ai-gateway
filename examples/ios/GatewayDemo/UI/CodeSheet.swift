import SwiftUI

/// One piece of the demo's own code, cut from its source by
/// `scripts/generate-snippets.ts`: what a kind of chat runs to reach the gateway.
struct CodeSnippet: Decodable, Hashable {
    let file: String
    let caption: String
    let code: String

    static let all: [String: [CodeSnippet]] = {
        guard let url = Bundle.main.url(forResource: "snippets", withExtension: "json"),
              let data = try? Data(contentsOf: url)
        else { return [:] }
        return (try? JSONDecoder().decode([String: [CodeSnippet]].self, from: data)) ?? [:]
    }()

    static func of(_ kind: Capability) -> [CodeSnippet] { all[kind.rawValue] ?? [] }
}

/// The code behind a kind of chat, to show how little of it there is.
struct CodeSheet: View {
    var kind: Capability
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    private var snippets: [CodeSnippet] { CodeSnippet.of(kind) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    Text(intro)
                        .font(.system(size: 16))
                        .foregroundStyle(.secondary)
                    ForEach(Array(snippets.enumerated()), id: \.element) { index, snippet in
                        SnippetBlock(number: index + 1, snippet: snippet)
                    }
                }
                .padding(20)
            }
            .background(Theme.canvas)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        UIPasteboard.general.string = snippets.map { "// \($0.caption)\n\($0.code)" }.joined(separator: "\n\n")
                        copied = true
                    } label: {
                        Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                    }
                }
            }
        }
    }

    private var title: String {
        switch kind {
        case .chat: "Chat, in code"
        case .image: "Images, in code"
        case .transcription: "Transcription, in code"
        case .voice: "Voice chat, in code"
        }
    }

    private var intro: String {
        let what = switch kind {
        case .chat: "a chat answer streams"
        case .image: "an image is drawn"
        case .transcription: "a voice note is transcribed"
        case .voice: "a voice chat talks"
        }
        return "This is how \(what) through your gateway, in this app's own code. "
            + "The client signs each request for your app, so no provider key ships in it; "
            + "everything else is the provider's own API, unchanged."
    }
}

private struct SnippetBlock: View {
    var number: Int
    var snippet: CodeSnippet

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("\(number)")
                    .font(.system(size: 13, weight: .bold).monospacedDigit())
                    .foregroundStyle(Theme.canvas)
                    .frame(width: 22, height: 22)
                    .background(.primary, in: Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text(snippet.caption)
                        .font(.system(size: 16, weight: .semibold))
                    Text(snippet.file)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(SwiftHighlighter.highlight(snippet.code))
                    .font(.system(size: 13, design: .monospaced))
                    .lineSpacing(3)
                    .textSelection(.enabled)
                    .padding(14)
            }
            .background(Theme.bubble, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
    }
}

/// Colors Swift the way Xcode's default themes do, light and dark. A scanner
/// rather than a parser: enough for short, well-formed snippets.
enum SwiftHighlighter {
    private static let keyword = Theme.dynamic(light: 0x9B2393, dark: 0xFF7AB2)
    private static let string = Theme.dynamic(light: 0xC41A16, dark: 0xFF8170)
    private static let comment = Theme.dynamic(light: 0x5D6C79, dark: 0x7F8C98)
    private static let number = Theme.dynamic(light: 0x1C00CF, dark: 0xD9C97C)
    private static let type = Theme.dynamic(light: 0x3900A0, dark: 0xDABAFF)
    private static let call = Theme.dynamic(light: 0x326D74, dark: 0x67B7A4)

    private static let keywords: Set<String> = [
        "as", "async", "await", "break", "case", "catch", "class", "continue", "default", "defer", "do",
        "else", "enum", "extension", "false", "for", "func", "guard", "if", "import", "in", "init", "is",
        "let", "nil", "private", "return", "self", "Self", "some", "any", "static", "struct", "switch",
        "throw", "throws", "true", "try", "var", "where", "while",
    ]

    static func highlight(_ code: String) -> AttributedString {
        let chars = Array(code)
        var result = AttributedString()
        var index = 0

        func emit(_ range: Range<Int>, _ color: Color? = nil) {
            var part = AttributedString(String(chars[range]))
            if let color { part.foregroundColor = color }
            result += part
        }
        func at(_ offset: Int) -> Character? {
            index + offset < chars.count ? chars[index + offset] : nil
        }

        while index < chars.count {
            let start = index
            let char = chars[index]
            if char == "/", at(1) == "/" {
                while index < chars.count, chars[index] != "\n" { index += 1 }
                emit(start..<index, comment)
            } else if char == "\"" || (char == "#" && at(1) == "\"") {
                // A string, or a raw #"…"# one, which has no escapes.
                let raw = char == "#"
                index += raw ? 2 : 1
                while index < chars.count, chars[index] != "\n" {
                    if !raw, chars[index] == "\\" { index += 2; continue }
                    if chars[index] == "\"", !raw || at(1) == "#" {
                        index += raw ? 2 : 1
                        break
                    }
                    index += 1
                }
                index = min(index, chars.count)
                emit(start..<index, string)
            } else if char.isNumber {
                while let next = at(0), next.isNumber || next == "_" || (next == "." && at(1)?.isNumber == true) {
                    index += 1
                }
                emit(start..<index, number)
            } else if char.isLetter || char == "_" || char == "@" || char == "$" {
                index += 1
                while let next = at(0), next.isLetter || next.isNumber || next == "_" { index += 1 }
                let word = String(chars[start..<index])
                // A word before a colon is an argument label, even `for` in `data(for:)`.
                let label = at(0) == ":" && word != "default"
                let color: Color? =
                    if label { nil }
                    else if word.hasPrefix("@") || keywords.contains(word) { keyword }
                    else if word.first?.isUppercase == true { type }
                    else if at(0) == "(" { call }
                    else { nil }
                emit(start..<index, color)
            } else {
                index += 1
                emit(start..<index)
            }
        }
        return result
    }
}
