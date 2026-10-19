import Foundation

/// What the screens ask for. `GatewayBackend` sends it through App AI Gateway;
/// `SimulatedBackend` answers on the device, so the app runs without one.
protocol AIBackend: Sendable {
    func chat(_ turns: [ChatTurn], model: ModelChoice) -> AsyncThrowingStream<String, Error>
    func transcribe(audio: Data, fileName: String, model: ModelChoice) async throws -> String
    func generateImage(prompt: String, aspect: ImageAspect, model: ModelChoice) async throws -> Data
}

/// A provider type and one of its model IDs, as the picker offers them.
struct ModelChoice: Codable, Hashable, Sendable {
    var provider: String
    var model: String
}

/// One message of a conversation, in the shape every chat API needs.
struct ChatTurn: Sendable {
    enum Role: String, Sendable { case user, assistant }
    var role: Role
    var text: String
    /// A JPEG the user attached.
    var image: Data?
}

enum ImageAspect: String, Codable, CaseIterable, Sendable {
    case square, portrait, landscape

    /// Width over height, for laying out a placeholder before the image arrives.
    var ratio: CGFloat {
        switch self {
        case .square: 1
        case .portrait: 2 / 3
        case .landscape: 3 / 2
        }
    }
}
