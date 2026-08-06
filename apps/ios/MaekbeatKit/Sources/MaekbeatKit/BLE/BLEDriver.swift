import Foundation

/// What the machine can ask a radio to do. `CoreBluetoothCentral` is the only
/// implementation that touches a radio; the tests use a mock, which is the
/// whole point of the protocol existing.
@MainActor
public protocol PeripheralPort: AnyObject {
    func scanAndConnect()
    func discoverServices()
    func enableNotifications()
    func cancelConnection()
}

/*
 * The driver: the machine plus a clock plus a port, and no decisions of its
 * own beyond turning effects into calls.
 *
 * Everything here runs under test with a mock port and a fake scheduler. The
 * only thing below it that a simulator cannot execute is the CoreBluetooth
 * adapter, and the adapter's job is small enough to read in one screen —
 * apps/ios/README.md says which of its lines CI reaches and which need a
 * device.
 */
@MainActor
public final class BLEDriver {
    public private(set) var machine = BLELinkMachine()
    /// Events the machine refused. A radio that produces these is a radio
    /// behaving in a way this model did not predict, and the count is on the
    /// screen rather than in a log nobody reads.
    public private(set) var rejectedEvents = 0
    /// Notification payloads that were not frames. Counted, never rendered.
    public private(set) var undecodablePayloads = 0

    public var onFrame: (VitalsFrame) -> Void = { _ in }
    public var onStateChange: (LinkState) -> Void = { _ in }

    private let port: PeripheralPort
    private let schedule: Scheduler
    private var cancelTimeout: (() -> Void)?
    private var cancelRetry: (() -> Void)?

    public init(port: PeripheralPort, schedule: Scheduler? = nil) {
        self.port = port
        self.schedule = schedule ?? StreamClient.defaultScheduler
    }

    public var state: LinkState { machine.state }
    /// The visible half, for callers that only render it.
    public var phase: LinkPhase { machine.state.phase }

    public func start() { handle(.start) }
    public func stop() { handle(.stop) }

    /// The one way anything reaches the machine.
    public func handle(_ event: LinkEvent) {
        let before = machine.state
        switch machine.apply(event) {
        case let .moved(_, to, effects):
            for effect in effects { run(effect) }
            if to != before { onStateChange(to) }
        case .ignored:
            break
        case .rejected:
            rejectedEvents += 1
        }
    }

    /// A notification payload from the peripheral. Decoding failure is a
    /// counted drop, not a link event: a garbled packet says nothing about
    /// whether the link is up, and treating it as a disconnect would tear down
    /// a working stream over one bad frame — the same rule the server holds on
    /// `/ingest`, where a reject never closes the socket.
    public func receive(payload: Data, from deviceId: String) {
        guard let frame = try? GattProfile.decode(payload, deviceId: deviceId) else {
            undecodablePayloads += 1
            return
        }
        // The link event first, the data second, and the data goes out even if
        // the event was rejected. A frame that arrives when the model says it
        // cannot means the model is wrong about the link — and throwing away a
        // valid reading over that bookkeeping disagreement would lose exactly
        // what this pipeline exists to carry. The rejection is counted instead.
        handle(.frameReceived)
        onFrame(frame)
    }

    private func run(_ effect: LinkEffect) {
        switch effect {
        case .scanAndConnect:
            port.scanAndConnect()
        case .discoverServices:
            port.discoverServices()
        case .enableNotifications:
            port.enableNotifications()
        case .cancelConnection:
            port.cancelConnection()
        case let .armTimeout(afterMs):
            cancelTimeout?()
            cancelTimeout = schedule(afterMs) { [weak self] in self?.handle(.timeout) }
        case .clearTimeout:
            cancelTimeout?()
            cancelTimeout = nil
        case let .scheduleRetry(afterMs):
            cancelRetry?()
            // No self-clearing on fire: cancelling a spent timer is already a
            // no-op, so the line was state no observation could distinguish —
            // deleted under the rule in docs/ai/AI_USAGE.md rather than given a
            // test that would pin an internal nothing depends on.
            cancelRetry = schedule(afterMs) { [weak self] in self?.handle(.retryDue) }
        case .cancelRetry:
            cancelRetry?()
            cancelRetry = nil
        }
    }
}
