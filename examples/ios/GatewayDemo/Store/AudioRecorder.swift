import AVFoundation
import Observation

/// A finished AAC recording, ready to upload.
struct Recording: Sendable {
    var data: Data
    var duration: TimeInterval
}

/// Records a voice note to AAC and publishes its level for the waveform.
@MainActor @Observable
final class AudioRecorder {
    private(set) var isRecording = false
    private(set) var elapsed: TimeInterval = 0
    /// Recent input levels, 0...1, oldest first.
    private(set) var levels = [CGFloat](repeating: 0, count: 48)

    private var recorder: AVAudioRecorder?
    private var timer: Timer?

    enum Problem: LocalizedError {
        case denied
        var errorDescription: String? { "Allow microphone access in Settings to record." }
    }

    func start() async throws {
        guard await AVAudioApplication.requestRecordPermission() else { throw Problem.denied }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker])
        try session.setActive(true)
        let url = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).m4a")
        let recorder = try AVAudioRecorder(url: url, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ])
        recorder.isMeteringEnabled = true
        recorder.record()
        self.recorder = recorder
        levels = levels.map { _ in 0 }
        elapsed = 0
        isRecording = true
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    /// Stops and returns the recording, or nil if there was none.
    func stop() -> Recording? {
        guard let recorder else { return nil }
        let duration = recorder.currentTime
        recorder.stop()
        reset()
        defer { try? FileManager.default.removeItem(at: recorder.url) }
        guard duration > 0.3, let data = try? Data(contentsOf: recorder.url) else { return nil }
        return Recording(data: data, duration: duration)
    }

    func cancel() {
        recorder?.stop()
        recorder?.deleteRecording()
        reset()
    }

    private func tick() {
        guard let recorder else { return }
        recorder.updateMeters()
        // -50 dB and below is silence.
        let level = max(0, min(1, (CGFloat(recorder.averagePower(forChannel: 0)) + 50) / 50))
        levels.removeFirst()
        levels.append(level)
        elapsed = recorder.currentTime
    }

    private func reset() {
        timer?.invalidate()
        timer = nil
        recorder = nil
        isRecording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
