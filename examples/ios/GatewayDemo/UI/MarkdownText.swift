import SwiftUI

/// The Markdown a model answers with, a block at a time: headings, list items,
/// code and paragraphs, each with its inline styling. A half-streamed answer
/// renders as far as it has arrived.
struct MarkdownText: View {
    var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(Self.blocks(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .heading(let line):
                    Text(inline(line)).font(.system(size: 19, weight: .semibold)).padding(.top, 4)
                case .item(let marker, let line):
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(marker).foregroundStyle(.secondary).frame(minWidth: 14, alignment: .leading)
                        Text(inline(line))
                    }
                case .code(let code):
                    Text(code)
                        .font(.system(size: 14, design: .monospaced))
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.bubble, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                case .paragraph(let line):
                    Text(inline(line))
                }
            }
        }
        .font(.system(size: 17))
        .lineSpacing(3)
    }

    private enum Block {
        case heading(String), item(String, String), code(String), paragraph(String)
    }

    private static func blocks(_ text: String) -> [Block] {
        var blocks: [Block] = []
        var paragraph: [String] = []
        var code: [String]?
        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: " "))) }
            paragraph = []
        }
        for raw in text.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") {
                if let open = code { blocks.append(.code(open.joined(separator: "\n"))); code = nil } else { flush(); code = [] }
            } else if code != nil {
                code?.append(raw)
            } else if line.isEmpty || line == "---" {
                flush()
            } else if let heading = line.firstMatch(of: /^#{1,6}\s+(.*)$/) {
                flush()
                blocks.append(.heading(String(heading.1)))
            } else if let item = line.firstMatch(of: /^[-*•]\s+(.*)$/) {
                flush()
                blocks.append(.item("•", String(item.1)))
            } else if let item = line.firstMatch(of: /^(\d+)[.)]\s+(.*)$/) {
                flush()
                blocks.append(.item("\(item.1).", String(item.2)))
            } else {
                paragraph.append(line)
            }
        }
        if let open = code { blocks.append(.code(open.joined(separator: "\n"))) }
        flush()
        return blocks
    }

    private func inline(_ line: String) -> AttributedString {
        (try? AttributedString(markdown: line, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(line)
    }
}
