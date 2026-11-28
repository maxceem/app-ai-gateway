@preconcurrency import AVFoundation
import Foundation

/// The microphone and the speaker, as the voice client uses them. Tests use a fake.
@MainActor
protocol AgentAudio: AnyObject {
    /// 100 ms chunks of the microphone, as 16-bit little-endian PCM at the input rate.
    var mic: AsyncStream<Data> { get }
    /// Seconds of agent audio queued and not played yet.
    var queuedSeconds: TimeInterval { get }
    /// Called when the queue has played to its end.
    var onDrained: (() -> Void)? { get set }
    /// Called with the seconds of queued audio a rebuild of the audio engine
    /// threw away. The queue is already empty then.
    var onLostAudio: ((TimeInterval) -> Void)? { get set }
    /// Silences the microphone before its samples are chunked, so no speech
    /// captured while muted is sent.
    var muted: Bool { get set }
    /// Starts the audio session and the engine. Does nothing when they run.
    func start() throws
    /// The rates the conversation uses, from ElevenLabs' `pcm_…` formats.
    func use(inputRate: Double, outputRate: Double)
    /// Queues agent audio: 16-bit little-endian PCM at the output rate.
    func play(pcm16: Data)
    /// Clears the queue. Answers the seconds that were queued.
    @discardableResult func flush() -> TimeInterval
    /// Stops the engine and lets the audio session go.
    func stop()
}

/// The audio of T17a's test app, which worked well on an iPhone:
/// - voice processing on, so the agent never hears itself;
/// - the microphone resampled to the agent's rate, in 100 ms chunks;
/// - the agent's audio queued on one player node, cleared with `stop()`;
/// - the engine rebuilt when iOS changes its configuration, which happens at
///   every start, and after another app took the audio, even when iOS doesn't
///   ask to resume (T17b).
@MainActor
final class AgentAudioEngine: AgentAudio {
    let mic: AsyncStream<Data>
    private let micOut: AsyncStream<Data>.Continuation
    var onDrained: (() -> Void)?
    var onLostAudio: ((TimeInterval) -> Void)?
    var muted: Bool {
        get { mute.value }
        set { mute.value = newValue }
    }
    /// Read by the audio thread.
    private let mute = MicMute()

    private var engine = AVAudioEngine()
    private var player = AVAudioPlayerNode()
    private var inputRate: Double = 16000
    private var outputRate: Double = 16000
    private var running = false
    /// Bumped on each flush: playback callbacks of cleared audio are ignored.
    private var generation = 0
    private var queuedFrames = 0
    private var observers: [NSObjectProtocol] = []

    var queuedSeconds: TimeInterval { Double(queuedFrames) / outputRate }

    init() {
        // A main thread that falls behind drops old chunks, never memory without end.
        (mic, micOut) = AsyncStream.makeStream(of: Data.self, bufferingPolicy: .bufferingNewest(50))
    }

    deinit {
        micOut.finish()
    }

    func start() throws {
        guard !running else { return }
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: Self.categoryOptions)
        try? session.setPreferredIOBufferDuration(0.02)
        try session.setActive(true)
        #endif
        try setUpEngine()
        running = true
        observe()
    }

    func use(inputRate: Double, outputRate: Double) {
        guard inputRate != self.inputRate || outputRate != self.outputRate else { return }
        self.inputRate = inputRate
        self.outputRate = outputRate
        guard running else { return }
        rebuild()
    }

    func play(pcm16 data: Data) {
        let count = data.count / 2
        guard running, count > 0,
              let format = playFormat,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
              let samples = buffer.floatChannelData?[0]
        else { return }
        buffer.frameLength = AVAudioFrameCount(count)
        data.withUnsafeBytes { raw in
            let bytes = raw.bindMemory(to: UInt8.self)
            for i in 0..<count {
                samples[i] = Float(Int16(bitPattern: UInt16(bytes[2 * i]) | UInt16(bytes[2 * i + 1]) << 8)) / 32768
            }
        }
        queuedFrames += count
        let current = generation
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { @Sendable [weak self] _ in
            Task { @MainActor in self?.played(count, of: current) }
        }
        // While another app has the audio, the engine is stopped: it plays once rebuilt.
        if engine.isRunning, !player.isPlaying { player.play() }
    }

    @discardableResult
    func flush() -> TimeInterval {
        let queued = queuedSeconds
        generation += 1
        queuedFrames = 0
        guard running else { return queued }
        player.stop()
        if engine.isRunning { player.play() }
        return queued
    }

    func stop() {
        guard running else { return }
        running = false
        generation += 1
        queuedFrames = 0
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }

    // MARK: - The engine

    private var playFormat: AVAudioFormat? {
        AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: outputRate, channels: 1, interleaved: false)
    }

    #if os(iOS)
    private static var categoryOptions: AVAudioSession.CategoryOptions {
        // Without Bluetooth HFP, AirPods are not used at all (T17b).
        #if compiler(>=6.2)
        [.allowBluetoothHFP, .defaultToSpeaker]
        #else
        [.allowBluetooth, .defaultToSpeaker]
        #endif
    }
    #endif

    private func setUpEngine() throws {
        // Echo cancellation: with it, the agent never heard itself in T17a.
        // Turning it on changes the configuration, so only when it is off.
        if !engine.inputNode.isVoiceProcessingEnabled { try engine.inputNode.setVoiceProcessingEnabled(true) }
        if player.engine == nil { engine.attach(player) }
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)
        try installTap()
        engine.prepare()
        try engine.start()
        player.play()
    }

    private func installTap() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: inputRate, channels: 1, interleaved: false),
              let resampler = MicResampler(from: format, to: target, out: micOut, mute: mute)
        else { throw AgentAudioError.microphoneFormat }
        input.installTap(onBus: 0, bufferSize: 1024, format: format, block: resampler.tap())
    }

    /// The engine again, on the same nodes, or on new ones after the media
    /// services were reset. Queued audio is lost: the client is told.
    private func rebuild(fresh: Bool = false) {
        let lost = flush()
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        if fresh {
            engine = AVAudioEngine()
            player = AVAudioPlayerNode()
        }
        do {
            try setUpEngine()
        } catch {
            // The next configuration change or the end of an interruption tries again.
        }
        if lost > 0 { onLostAudio?(lost) }
        // The playback callbacks of the lost audio never come: the queue is
        // empty now, which may be the end of a goodbye.
        onDrained?()
    }

    private func played(_ count: Int, of current: Int) {
        guard current == generation else { return }
        queuedFrames = max(0, queuedFrames - count)
        if queuedFrames == 0 { onDrained?() }
    }

    private func observe() {
        let center = NotificationCenter.default
        // Any engine: after a media services reset the engine is a new one.
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main) { [weak self] note in
            let source = (note.object as AnyObject?).map(ObjectIdentifier.init)
            MainActor.assumeIsolated {
                guard let self, self.running, source == ObjectIdentifier(self.engine) else { return }
                self.rebuild()
            }
        })
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { [weak self] note in
            let ended = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.ended.rawValue
            MainActor.assumeIsolated {
                guard ended, let self, self.running else { return }
                // Even without "should resume": the call is still on (T17b).
                try? AVAudioSession.sharedInstance().setActive(true)
                self.rebuild()
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.running else { return }
                try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: Self.categoryOptions)
                try? AVAudioSession.sharedInstance().setActive(true)
                self.rebuild(fresh: true)
            }
        })
        #endif
    }
}

enum AgentAudioError: Error {
    case microphoneFormat
}

/// The mute switch, set on the main thread and read on the audio thread.
final class MicMute: @unchecked Sendable {
    private let lock = NSLock()
    private var _value = false
    var value: Bool {
        get { lock.withLock { _value } }
        set { lock.withLock { _value = newValue } }
    }
}

/// Turns the microphone's buffers into 100 ms PCM16 chunks at the agent's
/// rate. It runs on the audio thread only, one per tap.
final class MicResampler: @unchecked Sendable {
    private let converter: AVAudioConverter
    private let target: AVAudioFormat
    private let out: AsyncStream<Data>.Continuation
    private let mute: MicMute
    private var muted = false
    private var samples: [Float] = []
    private let chunk: Int

    init?(from source: AVAudioFormat, to target: AVAudioFormat, out: AsyncStream<Data>.Continuation, mute: MicMute) {
        guard let converter = AVAudioConverter(from: source, to: target) else { return nil }
        if source.channelCount > 1 { converter.channelMap = [0] }
        self.converter = converter
        self.target = target
        self.out = out
        self.mute = mute
        chunk = Int(target.sampleRate / 10)
    }

    /// The tap block, made outside the main actor: the audio thread calls it.
    func tap() -> AVAudioNodeTapBlock {
        { [self] buffer, _ in take(buffer) }
    }

    func take(_ buffer: AVAudioPCMBuffer) {
        guard buffer.frameLength > 0 else { return }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * target.sampleRate / buffer.format.sampleRate + 64)
        guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
        // The converter calls this block during `convert`, on this thread.
        nonisolated(unsafe) var given = false
        let status = converter.convert(to: converted, error: nil) { _, state in
            if given {
                state.pointee = .noDataNow
                return nil
            }
            given = true
            state.pointee = .haveData
            return buffer
        }
        guard status != .error, let floats = converted.floatChannelData?[0] else { return }
        // A partial chunk never mixes muted and unmuted audio.
        let muted = mute.value
        if muted != self.muted {
            self.muted = muted
            samples.removeAll()
        }
        if muted {
            samples.append(contentsOf: repeatElement(0, count: Int(converted.frameLength)))
        } else {
            samples.append(contentsOf: UnsafeBufferPointer(start: floats, count: Int(converted.frameLength)))
        }
        while samples.count >= chunk {
            var data = Data(count: chunk * 2)
            data.withUnsafeMutableBytes { raw in
                let pcm = raw.bindMemory(to: Int16.self)
                for i in 0..<chunk { pcm[i] = Int16(max(-1, min(1, samples[i])) * 32767).littleEndian }
            }
            samples.removeFirst(chunk)
            out.yield(data)
        }
    }
}
