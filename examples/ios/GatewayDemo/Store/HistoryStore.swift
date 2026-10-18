import Foundation
import Observation

/// A chat, an image session or a transcription session in the sidebar.
struct HistoryItem: Codable, Identifiable, Hashable {
    var id = UUID()
    var kind: Capability
    var title: String
    var updatedAt = Date()
    var entries: [Entry] = []
}

/// One row of a session: what the user sent, or what came back.
struct Entry: Codable, Identifiable, Hashable {
    enum Role: String, Codable { case user, assistant }

    var id = UUID()
    var role: Role
    var text = ""
    /// A photo the user attached, or the image that was generated.
    var file: String?
    /// The length of a voice note the user recorded.
    var duration: TimeInterval?
    var aspect: ImageAspect?
    var model: ModelChoice?
    var failure: Failure?
    var pending = false
}

/// A request that failed, as the screens show it.
struct Failure: Codable, Hashable {
    /// The gateway's error code, such as `model_not_allowed`, or the provider's status.
    var code: String
    var message: String
}

/// Keeps the history in one JSON file, and images and recordings beside it.
@MainActor @Observable
final class HistoryStore {
    private(set) var items: [HistoryItem] = []

    private let folder = URL.applicationSupportDirectory.appending(path: "History", directoryHint: .isDirectory)
    private var indexURL: URL { folder.appending(path: "history.json") }

    init() {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: indexURL), let saved = try? JSONDecoder().decode([HistoryItem].self, from: data) {
            // A request cut short by quitting the app is not coming back.
            items = saved.map { item in
                var item = item
                item.entries.removeAll { $0.pending }
                return item
            }
        }
    }

    func item(_ id: UUID?) -> HistoryItem? {
        items.first { $0.id == id }
    }

    func start(_ kind: Capability, title: String) -> UUID {
        let item = HistoryItem(kind: kind, title: String(title.prefix(60)))
        items.insert(item, at: 0)
        save()
        return item.id
    }

    @discardableResult
    func append(_ entry: Entry, to id: UUID) -> UUID {
        mutate(id) { $0.entries.append(entry) }
        return entry.id
    }

    func update(_ entryID: UUID, in id: UUID, persist: Bool = true, _ change: (inout Entry) -> Void) {
        mutate(id, persist: persist) { item in
            guard let index = item.entries.firstIndex(where: { $0.id == entryID }) else { return }
            change(&item.entries[index])
        }
    }

    func remove(_ entryID: UUID, in id: UUID) {
        mutate(id) { $0.entries.removeAll { $0.id == entryID } }
    }

    func rename(_ id: UUID, to title: String) {
        mutate(id) { $0.title = String(title.prefix(60)) }
    }

    func delete(_ id: UUID) {
        items.removeAll { $0.id == id }
        save()
    }

    func deleteAll() {
        items = []
        try? FileManager.default.removeItem(at: folder)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        save()
    }

    // MARK: Files

    func store(_ data: Data, extension ext: String) -> String {
        let name = "\(UUID().uuidString).\(ext)"
        try? data.write(to: fileURL(name))
        return name
    }

    func fileURL(_ name: String) -> URL {
        folder.appending(path: name)
    }

    func data(_ name: String?) -> Data? {
        name.flatMap { try? Data(contentsOf: fileURL($0)) }
    }

    // MARK: Private

    private func mutate(_ id: UUID, persist: Bool = true, _ change: (inout HistoryItem) -> Void) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        change(&items[index])
        items[index].updatedAt = Date()
        if persist { save() }
    }

    private func save() {
        try? JSONEncoder().encode(items).write(to: indexURL, options: .atomic)
    }

    /// Replaces the history, for the sample data screenshots start from.
    func replaceAll(with items: [HistoryItem]) {
        self.items = items
        save()
    }
}
