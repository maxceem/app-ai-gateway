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
    #if DEBUG
    /// A prepared recording played in place of the microphone; see `LaunchOptions`.
    private var playback: AVAudioPlayer?
    #endif

    enum Problem: LocalizedError {
        case denied
        var errorDescription: String? { "Allow microphone access in Settings to record." }
    }

    func start() async throws {
        #if DEBUG
        if let url = LaunchOptions.recordingFile {
            let player = try AVAudioPlayer(contentsOf: url)
            player.isMeteringEnabled = true
            player.volume = 0
            player.play()
            playback = player
            begin()
            return
        }
        #endif
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
        begin()
    }

    private func begin() {
        levels = levels.map { _ in 0 }
        elapsed = 0
        isRecording = true
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    /// Stops and returns the recording, or nil if there was none.
    func stop() -> Recording? {
        #if DEBUG
        if let playback {
            // A clip that played to its end has rewound to zero.
            let duration = playback.isPlaying ? playback.currentTime : playback.duration
            playback.stop()
            self.playback = nil
            reset()
            return (try? Data(contentsOf: playback.url!)).map { Recording(data: $0, duration: duration) }
        }
        #endif
        guard let recorder else { return nil }
        let duration = recorder.currentTime
        recorder.stop()
        reset()
        defer { try? FileManager.default.removeItem(at: recorder.url) }
        guard duration > 0.3, let data = try? Data(contentsOf: recorder.url) else { return nil }
        return Recording(data: data, duration: duration)
    }

    func cancel() {
        #if DEBUG
        playback?.stop()
        playback = nil
        #endif
        recorder?.stop()
        recorder?.deleteRecording()
        reset()
    }

    private func tick() {
        var power: Float?
        var time: TimeInterval = 0
        #if DEBUG
        if let playback {
            playback.updateMeters()
            power = playback.averagePower(forChannel: 0)
            time = playback.currentTime
        }
        #endif
        if let recorder {
            recorder.updateMeters()
            power = recorder.averagePower(forChannel: 0)
            time = recorder.currentTime
        }
        guard let power else { return }
        // Loudness rather than decibels, so speech rises and falls instead of
        // pinning near the top: -20 dB fills a third of the bar.
        let level = max(0, min(1, CGFloat(pow(10, power / 20)) * 3))
        levels.removeFirst()
        levels.append(level)
        elapsed = time
    }

    private func reset() {
        timer?.invalidate()
        timer = nil
        recorder = nil
        isRecording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
