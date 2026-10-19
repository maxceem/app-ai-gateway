import Foundation

/// A few made-up sessions, so the sidebar has something in it.
@MainActor
enum SampleHistory {
    static func items(storingIn history: HistoryStore) -> [HistoryItem] {
        let sonnet = ModelChoice(provider: "anthropic", model: "claude-sonnet-5-5")
        let gpt = ModelChoice(provider: "openai", model: "gpt-5.6-sol")
        let banana = ModelChoice(provider: "gemini", model: "gemini-nano-banana-2.1")
        let transcribe = ModelChoice(provider: "openai", model: "gpt-transcribe")
        let image = SimulatedBackend.render(prompt: "A fox reading a newspaper in a Paris café, watercolor", aspect: .square)
        let hour: TimeInterval = 3600

        return [
            HistoryItem(kind: .chat, title: "Plan three days in Lisbon", updatedAt: .now.addingTimeInterval(-0.2 * hour), entries: [
                Entry(role: .user, text: "Plan three days in Lisbon"),
                Entry(role: .assistant, text: """
                **Day 1 — Alfama and the castle.** Start at *Castelo de São Jorge* when it opens, walk down \
                through Alfama's lanes, and end with fado in a small tavern.

                **Day 2 — Belém.** Jerónimos Monastery, the tower, and *pastéis de nata* still warm from the oven.

                **Day 3 — Sintra.** Take the train from Rossio and spend the day at Pena Palace and Quinta da Regaleira.
                """, model: sonnet),
            ]),
            HistoryItem(kind: .image, title: "A fox reading a newspaper in a Paris café, watercolor", updatedAt: .now.addingTimeInterval(-1 * hour), entries: [
                Entry(role: .user, text: "A fox reading a newspaper in a Paris café, watercolor", aspect: .square),
                Entry(role: .assistant, file: history.store(image, extension: "png"), aspect: .square, model: banana),
            ]),
            HistoryItem(kind: .transcription, title: "Remind me to send the invoice to Marta", updatedAt: .now.addingTimeInterval(-3 * hour), entries: [
                Entry(role: .user, duration: 9),
                Entry(role: .assistant, text: "Remind me to send the invoice to Marta on Friday, and to book the room for Tuesday's review.", model: transcribe),
            ]),
            HistoryItem(kind: .chat, title: "Write a haiku about rate limits", updatedAt: .now.addingTimeInterval(-26 * hour), entries: [
                Entry(role: .user, text: "Write a haiku about rate limits"),
                Entry(role: .assistant, model: ModelChoice(provider: "openai", model: "o3-pro"),
                      failure: Failure(code: "model_not_allowed", message: "The model is not in the app's allowlist.")),
            ]),
            HistoryItem(kind: .chat, title: "Explain App Attest in one paragraph", updatedAt: .now.addingTimeInterval(-50 * hour), entries: [
                Entry(role: .user, text: "Explain App Attest in one paragraph"),
                Entry(role: .assistant, text: """
                App Attest lets a server check that a request comes from a genuine copy of your app on a real Apple \
                device. The app creates a key in the Secure Enclave, Apple certifies it, and every request can then \
                be signed with that key, so a script with a stolen token cannot pass for your app.
                """, model: gpt),
            ]),
        ]
    }
}
