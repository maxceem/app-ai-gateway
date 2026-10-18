import Foundation

/// Transcribes a recording: a multipart upload of the audio and the model.
extension GatewayBackend {
    func transcribe(audio: Data, fileName: String, model: ModelChoice) async throws -> String {
        guard let path = ProviderPaths.transcription(model.provider) else {
            throw ProviderError(status: 0, message: "\(model.provider) has no transcription API in this demo.")
        }
        var form = MultipartForm()
        form.append("model", model.model)
        form.append("file", fileName: fileName, contentType: "audio/mp4", data: audio)

        // Leave `response_format` at its JSON default: a plain-text answer
        // reports nothing to bill, and the gateway refuses it.
        let data = try await post(model, path: path, body: form.body, contentType: form.contentType)
        struct Transcription: Decodable { let text: String }
        return try JSONDecoder().decode(Transcription.self, from: data).text
    }

}

/// A `multipart/form-data` body.
struct MultipartForm {
    private let boundary = "Boundary-\(UUID().uuidString)"
    private var parts = Data()

    var contentType: String { "multipart/form-data; boundary=\(boundary)" }
    var body: Data { parts + Data("--\(boundary)--\r\n".utf8) }

    mutating func append(_ name: String, _ value: String) {
        parts += Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8)
    }

    mutating func append(_ name: String, fileName: String, contentType: String, data: Data) {
        parts += Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"; filename=\"\(fileName)\"\r\nContent-Type: \(contentType)\r\n\r\n".utf8)
        parts += data + Data("\r\n".utf8)
    }
}
