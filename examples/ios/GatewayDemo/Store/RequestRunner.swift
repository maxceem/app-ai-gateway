import Foundation
import Observation

/// Runs the screens' requests and writes what comes back into the history.
@MainActor @Observable
final class RequestRunner {
    private let history: HistoryStore
    private let settings: AppSettings
    private var tasks: [UUID: Task<Void, Never>] = [:]

    init(history: HistoryStore, settings: AppSettings) {
        self.history = history
        self.settings = settings
    }

    func isRunning(_ id: UUID?) -> Bool {
        id.map { tasks[$0] != nil } ?? false
    }

    func cancel(_ id: UUID?) {
        guard let id else { return }
        tasks[id]?.cancel()
    }

    // MARK: Chat

    /// Sends a message in a chat, starting one when `id` is nil, and streams the answer into it.
    func sendChat(_ text: String, image: Data?, in id: UUID?, model: ModelChoice) -> UUID {
        let id = id ?? history.start(.chat, title: text.isEmpty ? "Photo" : text)
        history.append(Entry(role: .user, text: text, file: image.map { history.store($0, extension: "jpg") }), to: id)
        answer(in: id, model: model)
        return id
    }

    /// Asks again after a failed answer.
    func retryChat(_ id: UUID, model: ModelChoice) {
        guard let failed = history.item(id)?.entries.last, failed.failure != nil else { return }
        history.remove(failed.id, in: id)
        answer(in: id, model: model)
    }

    private func answer(in id: UUID, model: ModelChoice) {
        let turns = (history.item(id)?.entries ?? []).filter { $0.failure == nil }.map {
            ChatTurn(role: $0.role == .user ? .user : .assistant, text: $0.text, image: history.data($0.file))
        }
        let entryID = history.append(Entry(role: .assistant, model: model, pending: true), to: id)
        run(id) { backend in
            for try await text in backend.chat(turns, model: model) {
                self.history.update(entryID, in: id, persist: false) { $0.text += text }
            }
        } done: { failure in
            let answer = self.history.item(id)?.entries.first { $0.id == entryID }
            if failure == nil, answer?.text.isEmpty ?? true {
                // Stopped before the first word: nothing to keep.
                self.history.remove(entryID, in: id)
                return
            }
            self.history.update(entryID, in: id) { $0.pending = false; $0.failure = failure }
        }
    }

    // MARK: Images

    func generateImage(_ prompt: String, aspect: ImageAspect, in id: UUID?, model: ModelChoice) -> UUID {
        let id = id ?? history.start(.image, title: prompt)
        history.append(Entry(role: .user, text: prompt, aspect: aspect), to: id)
        draw(prompt, aspect: aspect, in: id, model: model)
        return id
    }

    func retryImage(_ id: UUID, model: ModelChoice) {
        guard let entries = history.item(id)?.entries, let failed = entries.last, failed.failure != nil,
              let prompt = entries.last(where: { $0.role == .user }) else { return }
        history.remove(failed.id, in: id)
        draw(prompt.text, aspect: prompt.aspect ?? .square, in: id, model: model)
    }

    private func draw(_ prompt: String, aspect: ImageAspect, in id: UUID, model: ModelChoice) {
        let entryID = history.append(Entry(role: .assistant, aspect: aspect, model: model, pending: true), to: id)
        run(id) { backend in
            let image = try await backend.generateImage(prompt: prompt, aspect: aspect, model: model)
            let file = self.history.store(image, extension: "png")
            self.history.update(entryID, in: id) { $0.file = file }
        } done: { failure in
            if failure == nil, self.history.item(id)?.entries.first(where: { $0.id == entryID })?.file == nil {
                self.history.remove(entryID, in: id)
                return
            }
            self.history.update(entryID, in: id) { $0.pending = false; $0.failure = failure }
        }
    }

    // MARK: Transcription

    func transcribe(_ recording: Recording, in id: UUID?, model: ModelChoice) -> UUID {
        let id = id ?? history.start(.transcription, title: "Voice note")
        let file = history.store(recording.data, extension: "m4a")
        history.append(Entry(role: .user, file: file, duration: recording.duration), to: id)
        listen(file, in: id, model: model)
        return id
    }

    func retryTranscription(_ id: UUID, model: ModelChoice) {
        guard let entries = history.item(id)?.entries, let failed = entries.last, failed.failure != nil,
              let file = entries.last(where: { $0.role == .user })?.file else { return }
        history.remove(failed.id, in: id)
        listen(file, in: id, model: model)
    }

    private func listen(_ file: String, in id: UUID, model: ModelChoice) {
        let entryID = history.append(Entry(role: .assistant, model: model, pending: true), to: id)
        let audio = history.data(file) ?? Data()
        let first = history.item(id)?.entries.count == 2
        run(id) { backend in
            let text = try await backend.transcribe(audio: audio, fileName: file, model: model)
            self.history.update(entryID, in: id) { $0.text = text }
            if first { self.history.rename(id, to: text) }
        } done: { failure in
            if failure == nil, self.history.item(id)?.entries.first(where: { $0.id == entryID })?.text.isEmpty ?? true {
                self.history.remove(entryID, in: id)
                return
            }
            self.history.update(entryID, in: id) { $0.pending = false; $0.failure = failure }
        }
    }

    /// Transcribes a voice note into text for the composer, outside any history.
    func dictate(_ recording: Recording, model: ModelChoice) async throws -> String {
        try await settings.backend().transcribe(audio: recording.data, fileName: "dictation.m4a", model: model)
    }

    // MARK: Private

    private func run(
        _ id: UUID,
        _ work: @escaping (any AIBackend) async throws -> Void,
        done: @escaping (Failure?) -> Void
    ) {
        tasks[id]?.cancel()
        tasks[id] = Task {
            var failure: Failure?
            do {
                try await work(settings.backend())
            } catch is CancellationError {
            } catch let error as URLError where error.code == .cancelled {
            } catch {
                failure = Failure(error)
            }
            done(failure)
            tasks[id] = nil
        }
    }
}
