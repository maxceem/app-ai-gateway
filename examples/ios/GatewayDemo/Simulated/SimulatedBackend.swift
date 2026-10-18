import SwiftUI

/// Answers on the device, so the app can be explored without a gateway.
struct SimulatedBackend: AIBackend {
    func chat(_ turns: [ChatTurn], model: ModelChoice) -> AsyncThrowingStream<String, Error> {
        let reply = """
        This is a **simulated** answer from `\(model.model)`. Turn off *Simulated responses* \
        in Settings and the same message goes to your gateway at \
        `/proxy/\(model.provider)/\(ProviderPaths.chat(model.provider))`, which checks the app, \
        applies its limits, and streams the provider's answer back unchanged.

        You asked: “\(turns.last?.text ?? "")”
        """
        return AsyncThrowingStream { continuation in
            let task = Task {
                for word in reply.split(separator: " ", omittingEmptySubsequences: false) {
                    try? await Task.sleep(for: .milliseconds(28))
                    if Task.isCancelled { break }
                    continuation.yield(word + " ")
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func transcribe(audio: Data, fileName: String, model: ModelChoice) async throws -> String {
        try await Task.sleep(for: .seconds(1.2))
        return "This is a simulated transcript. With simulated responses off, the recording is uploaded to "
            + "\(ProviderPaths.transcription(model.provider) ?? "the provider") through your gateway "
            + "and transcribed by \(model.model)."
    }

    func generateImage(prompt: String, aspect: ImageAspect, model: ModelChoice) async throws -> Data {
        try await Task.sleep(for: .seconds(2))
        return await MainActor.run { Self.render(prompt: prompt, aspect: aspect) }
    }

    /// A gradient picked from the prompt, so each prompt gets its own picture.
    @MainActor static func render(prompt: String, aspect: ImageAspect) -> Data {
        let seed = prompt.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF }
        let hue = Double(seed % 360) / 360
        let canvas = ZStack {
            LinearGradient(
                colors: [Color(hue: hue, saturation: 0.55, brightness: 0.95),
                         Color(hue: (hue + 0.18).truncatingRemainder(dividingBy: 1), saturation: 0.7, brightness: 0.6)],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
            Circle().fill(.white.opacity(0.18)).frame(width: 260).offset(x: 120, y: -140)
            Circle().fill(.white.opacity(0.12)).frame(width: 180).offset(x: -140, y: 160)
            Image(systemName: "sparkles").font(.system(size: 120, weight: .light)).foregroundStyle(.white.opacity(0.9))
        }
        .frame(width: 512 * min(aspect.ratio, 1), height: 512 / max(aspect.ratio, 1))
        let renderer = ImageRenderer(content: canvas)
        renderer.scale = 2
        return renderer.uiImage?.pngData() ?? Data()
    }
}
