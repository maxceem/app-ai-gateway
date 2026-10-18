import SwiftUI

struct SidebarView: View {
    @Environment(Navigator.self) private var nav
    @Environment(HistoryStore.self) private var history
    @State private var searching = false
    @State private var query = ""
    @FocusState private var searchFocused: Bool

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
                        Text(query.isEmpty
                             ? "Your chats, images and transcripts appear here. They stay on this device."
                             : "Nothing matches “\(query)”.")
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
            .scrollDismissesKeyboard(.immediately)

            bottomBar
        }
    }

    private var recents: [HistoryItem] {
        let items = history.items.sorted { $0.updatedAt > $1.updatedAt }
        guard !query.isEmpty else { return items }
        return items.filter { item in
            item.title.localizedCaseInsensitiveContains(query)
                || item.entries.contains { $0.text.localizedCaseInsensitiveContains(query) }
        }
    }

    @ViewBuilder private var header: some View {
        HStack(spacing: 12) {
            if searching {
                HStack {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("Search", text: $query)
                        .focused($searchFocused)
                        .submitLabel(.search)
                }
                .padding(.horizontal, 16)
                .frame(height: 50)
                .background(Theme.raised, in: Capsule())
                .floating()
            } else {
                Text("App AI Gateway Demo")
                    .font(.system(size: 30, weight: .bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                Spacer()
            }
            CircleButton(searching ? "xmark" : "magnifyingglass") {
                withAnimation(.snappy) {
                    searching.toggle()
                    query = ""
                }
                searchFocused = searching
            }
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
