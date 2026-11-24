import Foundation

enum Capability: String, Codable, CaseIterable, Sendable {
    case chat, image, transcription
}

/// The models the picker offers, generated from the gateway's price catalog by
/// `scripts/generate-catalog.ts`.
struct CatalogProvider: Decodable, Identifiable {
    let type: String
    let label: String
    let chat: [String]
    let transcription: [String]
    let image: [String]

    var id: String { type }

    func models(for capability: Capability) -> [String] {
        switch capability {
        case .chat: chat
        case .transcription: transcription
        case .image: image
        }
    }

    /// Whether the demo knows this provider's API for the capability, which a
    /// model typed in by hand needs even where the catalog lists none.
    func supports(_ capability: Capability) -> Bool {
        switch capability {
        case .chat: true
        case .transcription: ProviderPaths.transcription(type) != nil
        case .image: ProviderPaths.image(type, model: "") != nil
        }
    }
}

enum ModelCatalog {
    static let providers: [CatalogProvider] = {
        struct File: Decodable { let providers: [CatalogProvider] }
        guard let url = Bundle.main.url(forResource: "catalog", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let file = try? JSONDecoder().decode(File.self, from: data)
        else { return [] }
        return file.providers
    }()

    static func label(_ provider: String) -> String {
        providers.first { $0.type == provider }?.label ?? provider
    }

    /// Why the demo cannot use an image model, or nil when it can. The demo
    /// sends a prompt alone, so a model that edits a source image (ByteDance's
    /// SeedEdit, image-to-image models) is refused before anything is sent.
    /// The catalog leaves them out; this catches one saved earlier or typed in.
    static func imageModelProblem(_ model: ModelChoice) -> String? {
        let id = model.model.lowercased()
        guard id.hasPrefix("seededit") || id.contains("-i2i") else { return nil }
        return "\(model.model) needs a source image, which this demo does not send. Pick a model that draws from a prompt."
    }
}
