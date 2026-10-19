import SwiftUI

struct SidebarView: View {
    @Environment(Navigator.self) private var nav
    @Environment(HistoryStore.self) private var history

    var body: some View {
        ZStack(alignment: .bottom) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    header
                        .padding(.bottom, 14)

                    ForEach(Capability.allCases, id: \.self) { kind in
                        Button { nav.new(kind) } label: {
                            Label(kind.newTitle, systemImage: kind == .chat ? "square.and.pencil" : kind.symbol)
                                .labelStyle(SidebarLabelStyle())
                        }
                        .buttonStyle(.plain)
                    }

                    Text("Recents")
                        .font(.system(size: 20, weight: .bold))
                        .padding(.top, 30)
                        .padding(.bottom, 6)

                    if recents.isEmpty {
                        Text("Your chats, images, transcripts and voice chats appear here. They stay on this device.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .padding(.top, 6)
                    }
                    ForEach(recents) { item in
                        RecentRow(item: item, selected: item.id == nav.itemID) { nav.open(item) }
                            .contextMenu {
                                Button("Delete", systemImage: "trash", role: .destructive) {
                                    if nav.itemID == item.id { nav.new(item.kind) }
                                    history.delete(item.id)
                                }
                            }
                    }
                }
                .padding(.horizontal, 22)
                .padding(.top, 8)
                .padding(.bottom, 100)
            }
            .scrollIndicators(.hidden)

            bottomBar
        }
    }

    private var recents: [HistoryItem] {
        history.items.sorted { $0.updatedAt > $1.updatedAt }
    }

    private var header: some View {
        // About the size the old title showed at, smaller where it does not fit.
        ViewThatFits(in: .horizontal) {
            ForEach([21, 19, 17] as [CGFloat], id: \.self) { Wordmark(size: $0) }
        }
        .frame(height: 64)
    }

    private var bottomBar: some View {
        HStack {
            Spacer()
            CircleButton("gearshape") { nav.showSettings = true }
        }
        .padding(.horizontal, 22)
        .padding(.bottom, 6)
        .padding(.top, 30)
        .background(
            LinearGradient(colors: [Theme.sidebar.opacity(0), Theme.sidebar], startPoint: .top, endPoint: .center)
                .ignoresSafeArea()
        )
    }
}

private struct SidebarLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 18) {
            configuration.icon
                .font(.system(size: 21))
                .frame(width: 28)
            configuration.title
                .font(.system(size: 19))
            Spacer()
        }
        .frame(height: 54)
        .contentShape(Rectangle())
    }
}

private struct RecentRow: View {
    var item: HistoryItem
    var selected: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: item.kind.symbol)
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
                    .frame(width: 18)
                Text(item.title)
                    .font(.system(size: 17))
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .frame(height: 48)
            .background(selected ? Theme.bubble : .clear, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, -12)
    }
}

/// "App [AI] Gateway | Demo", as the website and the docs write it: the shield
/// stands in for "AI", and the suffix is set apart in a lighter weight.
private struct Wordmark: View {
    var size: CGFloat

    var body: some View {
        HStack(spacing: size * 0.3) {
            Text("App")
            BrandMark(height: size * 1.4)
            Text("Gateway")
            Rectangle()
                .fill(Theme.hairline)
                .frame(width: 1, height: size * 1.1)
            Text("Demo")
                .fontWeight(.medium)
                .foregroundStyle(.secondary)
        }
        .font(.system(size: size, weight: .bold))
        .tracking(-size * 0.015)
        .lineLimit(1)
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("App AI Gateway Demo")
        .accessibilityAddTraits(.isHeader)
    }
}
