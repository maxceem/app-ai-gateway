import AVFoundation

/// The microphone and the speaker of a voice conversation, both as 24 kHz
/// 16-bit mono PCM: the audio OpenAI's realtime API takes and returns.
///
/// Voice processing is on, which takes the phone's own speaker out of what the
/// microphone hears: without it the model hears its answer and interrupts itself.
final class VoiceAudio: @unchecked Sendable {
    /// The microphone, converted and split into chunks of about a tenth of a second.
    let chunks: AsyncStream<Data>
    private let continuation: AsyncStream<Data>.Continuation

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let wire = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24_000, channels: 1, interleaved: true)!
    private let speaker = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false)!

    private let lock = NSLock()
    private var input: Float = 0
    private var output: Float = 0
    /// Buffers scheduled on the player and not yet heard.
    private var queued = 0
    /// Bumped by `flush`, so a cancelled buffer's completion is not counted.
    private var generation = 0

    enum Problem: LocalizedError {
        case denied, unavailable
        var errorDescription: String? {
            switch self {
            case .denied: "Allow microphone access in Settings to talk."
            case .unavailable: "The microphone is unavailable."
            }
        }
    }

    init() {
        (chunks, continuation) = AsyncStream.makeStream(bufferingPolicy: .unbounded)
    }

    /// The microphone's and the speaker's loudness, 0...1.
    var levels: (input: Float, output: Float) {
        lock.withLock { (input, output) }
    }

    /// Whether an answer is still coming out of the speaker.
    var isPlaying: Bool {
        lock.withLock { queued > 0 }
    }

    func start() async throws {
        guard await AVAudioApplication.requestRecordPermission() else { throw Problem.denied }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker])
        try session.setActive(true)

        let mic = engine.inputNode
        try mic.setVoiceProcessingEnabled(true)
        let format = mic.outputFormat(forBus: 0)
        // Voice processing may hand over several channels; the first is the voice.
        guard let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: mono, to: wire)
        else { throw Problem.unavailable }
        mic.installTap(onBus: 0, bufferSize: AVAudioFrameCount(format.sampleRate / 10), format: format) { [weak self] buffer, _ in
            self?.capture(buffer, mono: mono, converter: converter)
        }

        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: speaker)
        engine.mainMixerNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in
            let level = Self.loudness(buffer)
            self?.lock.withLock { self?.output = level }
        }
        engine.prepare()
        try engine.start()
        player.play()
    }

    /// Plays a chunk of the answer after the ones before it.
    func play(_ pcm: Data) {
        let frames = AVAudioFrameCount(pcm.count / 2)
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: speaker, frameCapacity: frames) else { return }
        buffer.frameLength = frames
        let out = buffer.floatChannelData![0]
        pcm.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for index in 0..<Int(frames) { out[index] = Float(Int16(littleEndian: samples[index])) / 32_768 }
        }
        let generation = lock.withLock { self.queued += 1; return self.generation }
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            guard let self else { return }
            lock.withLock { if self.generation == generation { self.queued -= 1 } }
        }
    }

    /// Drops what is left of the answer: you started talking over it.
    func flush() {
        lock.withLock { self.generation += 1; self.queued = 0 }
        player.stop()
        player.play()
    }

    func stop() {
        continuation.finish()
        engine.inputNode.removeTap(onBus: 0)
        engine.mainMixerNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func capture(_ buffer: AVAudioPCMBuffer, mono: AVAudioFormat, converter: AVAudioConverter) {
        guard let source = buffer.floatChannelData,
              let first = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength)
        else { return }
        first.frameLength = buffer.frameLength
        first.floatChannelData![0].update(from: source[0], count: Int(buffer.frameLength))
        let level = Self.loudness(first)
        lock.withLock { input = level }

        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * wire.sampleRate / mono.sampleRate) + 32
        guard let converted = AVAudioPCMBuffer(pcmFormat: wire, frameCapacity: capacity) else { return }
        var fed = false
        var error: NSError?
        // `.noDataNow`, not `.endOfStream`, keeps the resampler's state between chunks.
        converter.convert(to: converted, error: &error) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return first
        }
        guard error == nil, converted.frameLength > 0 else { return }
        continuation.yield(Data(bytes: converted.int16ChannelData![0], count: Int(converted.frameLength) * 2))
    }

    /// Loudness rather than decibels, so speech rises and falls instead of pinning near the top.
    private static func loudness(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        var sum: Float = 0
        for index in 0..<Int(buffer.frameLength) { sum += samples[index] * samples[index] }
        return min(1, (sum / Float(buffer.frameLength)).squareRoot() * 5)
    }
}
