import Foundation
import Observation

/*
 * The gateway: BLE link on one side, `/ingest` on the other, and the buffer
 * between them. This is stage 2 of docs/ARCHITECTURE.md in its dev form.
 *
 * It decides nothing about the link (BLELinkMachine does) and nothing about
 * what to send (UplinkQueue does). What it owns is the wiring, and one rule
 * worth stating: a reconnect pumps the queue and never resets it. Resume is
 * the absence of a reset, which is why there is no resume method to call.
 */
@MainActor
@Observable
public final class GatewayModel {
    public private(set) var link: LinkState = .disconnected(hasStreamed: false, wantsLink: false)
    public private(set) var radioUnavailable: RadioUnavailable?
    public private(set) var uplink: ConnectionState = .connecting
    public private(set) var queue = UplinkQueue()

    /// The session the server filed the newest accepted frame under. It comes
    /// from the server's ack, never from a guess on this side.
    public private(set) var serverSessionEpoch: Int?
    /// Every epoch the server has filed frames under during this run. More than
    /// one means the link forked a session, which is a fact about the data a
    /// caregiver's chart will show as a break.
    public private(set) var serverSessionEpochsSeen: Set<Int> = []
    public private(set) var accepted = 0
    public private(set) var duplicatesRefused = 0
    public private(set) var framesRejected = 0
    /// Reboots the phone saw in the peripheral's `seq`, and the ones the server
    /// then agreed were new sessions. The two can differ, and the gap is the
    /// residual limit packages/protocol/README.md records.
    public private(set) var peripheralReboots = 0
    public private(set) var serverSessionsOpened = 0

    private let driver: BLEDriver
    private let ingest: IngestClient

    public init(driver: BLEDriver, ingest: IngestClient) {
        self.driver = driver
        self.ingest = ingest
        wire()
    }

    /// Convenience for the app: the real adapter and the real socket.
    public static func live(baseURL: URL = APIClient.defaultBaseURL) -> GatewayModel {
        let ingest = IngestClient(url: APIClient(baseURL: baseURL).ingestURL())
        var capturedDriver: BLEDriver?
        #if canImport(CoreBluetooth)
        let central = CoreBluetoothCentral(
            emit: { event in capturedDriver?.handle(event) },
            deliver: { payload, deviceId in capturedDriver?.receive(payload: payload, from: deviceId) }
        )
        let driver = BLEDriver(port: central)
        capturedDriver = driver
        central.activate()
        #else
        let driver = BLEDriver(port: InertPeripheralPort())
        capturedDriver = driver
        #endif
        return GatewayModel(driver: driver, ingest: ingest)
    }

    public var linkAttempt: Int { driver.machine.attempt }
    public var rejectedLinkEvents: Int { driver.rejectedEvents }
    public var undecodablePayloads: Int { driver.undecodablePayloads }

    public func start() {
        ingest.open()
        driver.start()
    }

    public func stop() {
        driver.stop()
        ingest.close()
    }

    // MARK: - Wiring

    private func wire() {
        driver.onStateChange = { [weak self] state in
            guard let self else { return }
            link = state
            radioUnavailable = driver.machine.unavailable
        }
        driver.onFrame = { [weak self] frame in self?.enqueue(frame) }
        ingest.onState = { [weak self] state in self?.uplink = state }
        // A reconnect pumps what is already queued. There is nothing to reset,
        // and that is the contract: the gateway resumes from its last delivered
        // seq rather than replaying a session the server has already filed.
        ingest.onReconnect = { [weak self] in
            self?.queue.socketReconnected()
            self?.pump()
        }
        ingest.onReply = { [weak self] reply in self?.handle(reply) }
    }

    private func enqueue(_ frame: VitalsFrame) {
        switch queue.offer(frame) {
        case .peripheralRebooted:
            peripheralReboots += 1
        case .queued, .queuedAfterDroppingOldest, .alreadyDelivered:
            break
        }
        pump()
    }

    /// Sends what the queue says is next, oldest first, and stops at the first
    /// frame the socket will not take — a half-sent batch out of seq order is
    /// how a replay turns into a fork.
    private func pump() {
        for frame in queue.nextBatch() {
            guard ingest.send(frame) else { return }
            queue.markSent(through: frame.seq)
        }
    }

    private func handle(_ reply: IngestReply) {
        switch reply {
        case let .ack(ack):
            accepted += 1
            queue.acknowledge(seq: ack.seq)
            serverSessionEpoch = ack.sessionEpoch
            serverSessionEpochsSeen.insert(ack.sessionEpoch)
            if ack.newSession { serverSessionsOpened += 1 }
        case let .rejected(rejection):
            switch rejection.reason {
            case .duplicate:
                duplicatesRefused += 1
            case .invalidJson, .invalidFrame:
                framesRejected += 1
            }
        }
    }
}

/// Stands in for the radio where there is no CoreBluetooth to import. It does
/// nothing, loudly enough to be obvious in a state machine that never leaves
/// `connecting`.
@MainActor
final class InertPeripheralPort: PeripheralPort {
    func scanAndConnect() {}
    func discoverServices() {}
    func enableNotifications() {}
    func cancelConnection() {}
}
