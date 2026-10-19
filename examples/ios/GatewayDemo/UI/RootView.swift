import SwiftUI

/// The main screen over the sidebar. It slides right to show the sidebar,
/// on the menu button or a drag from the left edge.
struct RootView: View {
    @Environment(Navigator.self) private var nav
    @GestureState private var drag: CGFloat = 0

    var body: some View {
        @Bindable var nav = nav
        GeometryReader { geometry in
            let width = min(geometry.size.width * 0.82, 340)
            let offset = min(max((nav.sidebarOpen ? width : 0) + drag, 0), width)
            let progress = offset / width

            ZStack(alignment: .leading) {
                Theme.sidebar.ignoresSafeArea()

                SidebarView()
                    .frame(width: width)
                    .offset(x: (progress - 1) * 60)
                    .opacity(0.4 + 0.6 * progress)

                MainView()
                    .frame(width: geometry.size.width)
                    .background {
                        UnevenRoundedRectangle(
                            topLeadingRadius: 44 * progress, bottomLeadingRadius: 44 * progress, style: .continuous
                        )
                        .fill(Theme.canvas)
                        .shadow(color: .black.opacity(0.1 * progress), radius: 30)
                        .ignoresSafeArea()
                    }
                    .overlay {
                        if nav.sidebarOpen {
                            Color.clear
                                .contentShape(Rectangle())
                                .ignoresSafeArea()
                                .onTapGesture { nav.sidebarOpen = false }
                        }
                    }
                    .offset(x: offset)
                    .gesture(
                        DragGesture(minimumDistance: 12)
                            .updating($drag) { value, state, _ in
                                let horizontal = abs(value.translation.width) > abs(value.translation.height)
                                if horizontal, nav.sidebarOpen || value.startLocation.x < 32 {
                                    state = value.translation.width
                                }
                            }
                            .onEnded { value in
                                guard nav.sidebarOpen || value.startLocation.x < 32 else { return }
                                let end = (nav.sidebarOpen ? width : 0) + value.predictedEndTranslation.width
                                nav.sidebarOpen = end > width / 2
                            }
                    )
            }
            .animation(.spring(response: 0.36, dampingFraction: 0.88), value: nav.sidebarOpen)
            .animation(.interactiveSpring, value: drag)
        }
        .tint(.primary)
        .sheet(isPresented: $nav.showSettings) { SettingsView() }
        .sheet(isPresented: $nav.showCode) { CodeSheet(kind: nav.kind) }
        .onChange(of: nav.sidebarOpen) { _, open in
            if open { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
        }
    }
}

/// The top bar over whichever screen is selected.
struct MainView: View {
    @Environment(Navigator.self) private var nav

    var body: some View {
        VStack(spacing: 0) {
            TopBar()
            Group {
                switch nav.kind {
                case .chat: ChatScreen(itemID: nav.itemID)
                case .image: ImageScreen(itemID: nav.itemID)
                case .transcription: TranscribeScreen(itemID: nav.itemID)
                case .voice: VoiceScreen(itemID: nav.itemID)
                }
            }
            .id("\(nav.kind.rawValue)-\(nav.itemID?.uuidString ?? "new")")
            .frame(maxHeight: .infinity)
        }
    }
}

struct TopBar: View {
    @Environment(Navigator.self) private var nav
    @Environment(AppSettings.self) private var settings

    var body: some View {
        HStack {
            CircleButton(action: { nav.sidebarOpen.toggle() }) { MenuGlyph() }
                .accessibilityLabel("Sidebar")
            Spacer(minLength: 12)
            ModelMenu(capability: nav.kind) { pill }
                .buttonStyle(.plain)
            Spacer(minLength: 12)
            // A new chat starts from the sidebar; this shows the code behind this one.
            CircleButton("chevron.left.forwardslash.chevron.right") { nav.showCode = true }
                .accessibilityLabel("Show the code")
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }

    private var pill: some View {
        let choice = settings.model(for: nav.kind)
        return HStack(spacing: 8) {
            Image(systemName: nav.kind.symbol)
                .font(.system(size: 15, weight: .semibold))
            VStack(spacing: 0) {
                Text(choice?.model ?? "Choose a model")
                    .font(.system(size: 16, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .truncationMode(.middle)
                if let choice {
                    Text(ModelCatalog.label(choice.provider))
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                }
            }
            Image(systemName: "chevron.down")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(.secondary)
        }
        .foregroundStyle(.primary)
        .padding(.horizontal, 18)
        .frame(height: 50)
        .background(Theme.raised, in: Capsule())
        .floating()
    }
}
