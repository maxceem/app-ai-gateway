@preconcurrency import AVFoundation
import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// The microphone and the speaker, as the voice client uses them. Tests use a fake.
@MainActor
protocol AgentAudio: AnyObject, Sendable {
    /// 100 ms chunks of the microphone, as 16-bit little-endian PCM at the input rate.
    var mic: AsyncStream<Data> { get }
    /// Seconds of agent audio queued and not played yet.
    var queuedSeconds: TimeInterval { get }
    /// Called when the queue has played to its end.
    var onDrained: (() -> Void)? { get set }
    /// Called with the seconds of queued audio a rebuild of the audio engine
    /// threw away. The queue is already empty then.
    var onLostAudio: ((TimeInterval) -> Void)? { get set }
    /// Mutes the microphone at its source: muted audio is never captured.
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
    /// Ends the current run at once, from anywhere: its callbacks still
    /// waiting do nothing. The owner calls it when it is let go, before
    /// `stop()` runs on the main actor.
    nonisolated func endRun()
}

/// The number of the audio's current run, set on start and changed on stop
/// or release. A callback done later, on the main actor, does its work only
/// if the run it was registered under is still the current one: so it never
/// restarts audio after a release, or acts on a newer run after a quick stop
/// and start.
final class AudioRun: @unchecked Sendable {
    private let lock = NSLock()
    private var number = 0

    /// A new run, or the end of the current one. Answers the new number.
    @discardableResult func next() -> Int { lock.withLock { number += 1; return number } }
    func isCurrent(_ run: Int) -> Bool { lock.withLock { number == run } }

    /// Runs `work` on the main actor later, only if `run` is still current then.
    func later(_ run: Int, _ work: @escaping @MainActor () -> Void) {
        Task { @MainActor in
            guard self.isCurrent(run) else { return }
            work()
        }
    }
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
    /// Muted in voice processing: the microphone gives silence. Set again on
    /// every engine setup, since a rebuilt or new engine starts unmuted.
    var muted = false {
        didSet { if running { engine.inputNode.isVoiceProcessingInputMuted = muted } }
    }

    private var engine = AVAudioEngine()
    private var player = AVAudioPlayerNode()
    private var inputRate: Double = 16000
    private var outputRate: Double = 16000
    private var running = false
    /// Bumped on each flush: playback callbacks of cleared audio are ignored.
    private var generation = 0
    private var queuedFrames = 0
    private var observers: [NSObjectProtocol] = []
    private let run = AudioRun()
    /// The running engines, all on iOS's one audio session. It is let go only
    /// when the last one stops: a client released after a new one started
    /// (its teardown runs later, on the main actor) must not stop the new
    /// one's audio.
    private static var sessionUsers = 0

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
        try Self.useSession()
        do {
            try setUpEngine()
        } catch {
            // Let the audio session go again: other apps get their audio back.
            tearDown()
            Self.leaveSession()
            throw error
        }
        running = true
        observe(run: run.next())
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
        // A stopped engine never plays it, and the queue would never drain:
        // while another app has the audio, or after a rebuild that failed.
        guard engine.isRunning, count > 0,
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
        if !player.isPlaying { player.play() }
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

    nonisolated func endRun() {
        run.next()
    }

    func stop() {
        guard running else { return }
        run.next()
        running = false
        generation += 1
        queuedFrames = 0
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        tearDown()
        Self.leaveSession()
    }

    private func tearDown() {
        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
    }

    /// Sets the session up and turns it on for each engine: setting it again is harmless.
    private static func useSession() throws {
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: categoryOptions)
        try? session.setPreferredIOBufferDuration(0.02)
        try session.setActive(true)
        #endif
        sessionUsers += 1
    }

    private static func leaveSession() {
        sessionUsers -= 1
        #if os(iOS)
        if sessionUsers == 0 { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
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
        engine.inputNode.isVoiceProcessingInputMuted = muted
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
              let resampler = MicResampler(from: format, to: target, out: micOut)
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
            // The next configuration change, the end of an interruption or the
            // app becoming active tries again.
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

    /// Each callback holds the engine weakly and acts only while `current` is
    /// the engine's run.
    private func observe(run current: Int) {
        let run = run
        let center = NotificationCenter.default
        // AVFoundation posts these on its own threads, and its queue waits for
        // the observer to return. Stopping or rebuilding the engine inside it
        // could freeze the app, so the work runs afterwards, on the main actor
        // (Apple's AVAudioEngineConfigurationChange guidance).
        // Any engine: after a media services reset the engine is a new one.
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: nil) { [weak self] note in
            let source = (note.object as AnyObject?).map(ObjectIdentifier.init)
            run.later(current) {
                guard let self, source == ObjectIdentifier(self.engine) else { return }
                self.rebuild()
            }
        })
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) { [weak self] note in
            let ended = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.ended.rawValue
            run.later(current) {
                guard ended, let self else { return }
                // Even without "should resume": the call is still on (T17b).
                try? AVAudioSession.sharedInstance().setActive(true)
                self.rebuild()
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: nil) { [weak self] _ in
            run.later(current) {
                guard let self else { return }
                try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: Self.categoryOptions)
                try? AVAudioSession.sharedInstance().setActive(true)
                self.rebuild(fresh: true)
            }
        })
        // iOS doesn't always say an interruption ended: the engine is set up
        // again when the app is back in front. UIKit posts this on the main
        // thread, and no audio queue waits for it, so it runs here at once.
        observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, run.isCurrent(current), !self.engine.isRunning else { return }
                try? AVAudioSession.sharedInstance().setActive(true)
                self.rebuild()
            }
        })
        #endif
    }
}

enum AgentAudioError: Error {
    case microphoneFormat
}

/// Turns the microphone's buffers into 100 ms PCM16 chunks at the agent's
/// rate. It runs on the audio thread only, one per tap.
final class MicResampler: @unchecked Sendable {
    private let converter: AVAudioConverter
    private let target: AVAudioFormat
    private let out: AsyncStream<Data>.Continuation
    private var samples: [Float] = []
    private let chunk: Int

    init?(from source: AVAudioFormat, to target: AVAudioFormat, out: AsyncStream<Data>.Continuation) {
        guard let converter = AVAudioConverter(from: source, to: target) else { return nil }
        if source.channelCount > 1 { converter.channelMap = [0] }
        self.converter = converter
        self.target = target
        self.out = out
        chunk = Int(target.sampleRate / 10)
    }

    /// The tap block, made outside the main actor: the audio thread calls it.
    func tap() -> AVAudioNodeTapBlock {
        { [self] buffer, _ in take(buffer) }
    }

    private func take(_ buffer: AVAudioPCMBuffer) {
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
        samples.append(contentsOf: UnsafeBufferPointer(start: floats, count: Int(converted.frameLength)))
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
