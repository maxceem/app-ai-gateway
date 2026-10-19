import Observation
import SwiftUI

/// Which screen is showing, and whether the sidebar is out.
@MainActor @Observable
final class Navigator {
    var kind: Capability = .chat
    /// The history item on screen; nil for a new one, created on the first send.
    var itemID: UUID?
    var sidebarOpen = false
    var showSettings = false
    var showCode = false

    func open(_ item: HistoryItem) {
        kind = item.kind
        itemID = item.id
        sidebarOpen = false
    }

    func new(_ kind: Capability) {
        self.kind = kind
        itemID = nil
        sidebarOpen = false
    }
}
