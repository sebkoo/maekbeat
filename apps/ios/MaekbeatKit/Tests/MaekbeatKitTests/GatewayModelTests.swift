import XCTest
@testable import MaekbeatKit

/*
 * The gateway wired end to end, with a mock radio and a fake socket: BLE
 * notification in, `/ingest` frame out, acknowledgement back.
 *
 * This is where the two halves meet, and where the C12a lesson applies one
 * language over — a queue and a machine can both be perfect and still not be
 * connected to each other. Every test here drives the model, not its parts.
 */
@MainActor
final class GatewayModelTests: XCTestCase {
    private var model: GatewayModel?

    override func tearDown() {
        model = nil
        super.tearDown()
    }

    /// The driver is held here rather than reached through the model, because
    /// that is how the real adapter uses it: `CoreBluetoothCentral` calls
    /// `handle` and `receive` from its delegate callbacks. Adding a test-only
    /// door on `GatewayModel` would have tested a path the app does not take.
    private struct Rig {
        let model: GatewayModel
        let driver: BLEDriver
        let port: MockPeripheralPort
        let radio: FakeTransport
        let sockets: FakeIngestTransport
    }

    private func makeRig() -> Rig {
        let port = MockPeripheralPort()
        let radio = FakeTransport()
        let sockets = FakeIngestTransport()
        let driver = BLEDriver(port: port, schedule: radio.scheduler)
        let ingest = IngestClient(
            url: URL(string: "ws://127.0.0.1:3000/ingest") ?? APIClient.defaultBaseURL,
            createSocket: sockets.factory,
            schedule: radio.scheduler
        )
        let built = GatewayModel(driver: driver, ingest: ingest)
        model = built
        return Rig(model: built, driver: driver, port: port, radio: radio, sockets: sockets)
    }

    private func stream(_ rig: Rig) {
        rig.model.start()
        rig.sockets.latest?.open()
        driveToStreaming(rig)
    }

    /// The radio path, in the order the adapter's delegate callbacks report it.
    private func driveToStreaming(_ rig: Rig) {
        for event in [LinkEvent.peripheralConnected, .servicesResolved, .notificationsEnabled] {
            rig.driver.handle(event)
        }
    }

    private func payload(seq: Int) -> Data {
        GattProfile.encode(VitalsFrame(
            deviceId: "on-the-air",
            seq: seq,
            capturedAtMs: 1_754_265_600_000 + seq * 1_000,
            heartRateBpm: 62,
            spo2Pct: 97.5,
            respirationRpm: 13.7,
            motion: 0.01
        ))
    }

    // MARK: - Notification in, frame out

    func testANotificationBecomesAnIngestFrame() {
        let rig = makeRig()
        stream(rig)

        rig.driver.receive(payload: payload(seq: 1), from: "peripheral-1")

        XCTAssertEqual(rig.sockets.latest?.sentSeqs, [1])
        XCTAssertEqual(rig.model.link.phase, .streaming)
        XCTAssertEqual(rig.model.uplink, .live)
    }

    func testAnAcknowledgementClearsTheFrameAndRecordsTheServersSession() {
        let rig = makeRig()
        stream(rig)
        rig.driver.receive(payload: payload(seq: 1), from: "peripheral-1")

        rig.sockets.latest?.reply(IngestWire.ack(seq: 1, sessionEpoch: 3))

        XCTAssertEqual(rig.model.accepted, 1)
        XCTAssertEqual(rig.model.serverSessionEpoch, 3)
        XCTAssertTrue(rig.model.queue.isEmpty)
    }

    func testASessionTheServerCallsNewIsCountedFromTheServersAnswerNotAGuess() {
        let rig = makeRig()
        stream(rig)
        rig.driver.receive(payload: payload(seq: 1), from: "peripheral-1")

        rig.sockets.latest?.reply(IngestWire.ack(seq: 1, sessionEpoch: 2, newSession: true))

        XCTAssertEqual(rig.model.serverSessionsOpened, 1)
        XCTAssertEqual(rig.model.serverSessionEpoch, 2)
    }

    func testADuplicateRefusalIsCountedSeparatelyFromAMalformedOne() {
        let rig = makeRig()
        stream(rig)

        rig.sockets.latest?.reply(IngestWire.rejected("duplicate"))
        rig.sockets.latest?.reply(IngestWire.rejected("invalid_frame"))
        rig.sockets.latest?.reply(IngestWire.rejected("invalid_json"))

        XCTAssertEqual(rig.model.duplicatesRefused, 1)
        XCTAssertEqual(rig.model.framesRejected, 2)
    }

    // MARK: - Offline, then back

    /// Frames taken while the socket is down are buffered, not lost, and not
    /// sent to a socket that cannot carry them.
    func testFramesTakenWhileTheServerIsUnreachableAreBuffered() {
        let rig = makeRig()
        rig.model.start()
        driveToStreaming(rig)

        for seq in 1...5 { rig.driver.receive(payload: payload(seq: seq), from: "p") }

        XCTAssertEqual(rig.sockets.latest?.sentSeqs, [], "the socket never opened")
        XCTAssertEqual(rig.model.queue.count, 5)
    }

    /// The C6 contract at the model level: what the server acknowledged is not
    /// sent again, and what it did not is.
    func testAReconnectSendsTheTailAndNeverTheAcknowledgedHead() {
        let rig = makeRig()
        stream(rig)
        for seq in 1...6 { rig.driver.receive(payload: payload(seq: seq), from: "p") }
        rig.sockets.latest?.reply(IngestWire.ack(seq: 3))

        rig.sockets.latest?.drop()
        rig.radio.fireScheduled()
        rig.sockets.latest?.open()

        XCTAssertEqual(rig.sockets.sockets.count, 2)
        XCTAssertEqual(
            rig.sockets.sockets[1].sentSeqs,
            [4, 5, 6],
            "resume starts one past the last delivered frame"
        )
        XCTAssertFalse(rig.sockets.sockets[1].sentSeqs.contains(where: { $0 <= 3 }))
    }

    func testNothingIsSentTwiceAcrossTheWholeRunWhenTheSocketStaysUp() {
        let rig = makeRig()
        stream(rig)
        for seq in 1...20 {
            rig.driver.receive(payload: payload(seq: seq), from: "p")
            rig.sockets.latest?.reply(IngestWire.ack(seq: seq))
        }

        XCTAssertEqual(rig.sockets.allSentSeqs, Array(1...20))
        XCTAssertEqual(Set(rig.sockets.allSentSeqs).count, 20)
    }

    // MARK: - The peripheral rebooting

    func testAPeripheralRebootIsSurfacedAndThePreRebootTailIsNotSent() {
        let rig = makeRig()
        stream(rig)
        for seq in 100...110 { rig.driver.receive(payload: payload(seq: seq), from: "p") }

        rig.driver.receive(payload: payload(seq: 0), from: "p")

        XCTAssertEqual(rig.model.peripheralReboots, 1)
        let sent = rig.sockets.allSentSeqs
        XCTAssertEqual(sent.last, 0)
        XCTAssertEqual(sent.filter { $0 == 0 }.count, 1)
    }

    // MARK: - The link

    func testTheLinkStateAndTheRadioReasonReachTheModel() {
        let rig = makeRig()
        rig.model.start()
        XCTAssertEqual(rig.model.link.phase, .connecting)

        rig.driver.handle(.radioUnavailable(.poweredOff))

        XCTAssertEqual(rig.model.link.phase, .disconnected)
        XCTAssertEqual(rig.model.radioUnavailable, .poweredOff)
    }

    func testStoppingClosesBothSides() {
        let rig = makeRig()
        stream(rig)

        rig.model.stop()

        XCTAssertEqual(rig.model.link.phase, .disconnected)
        XCTAssertEqual(rig.sockets.latest?.closeCount, 1)
        XCTAssertTrue(rig.port.calls.contains(.cancelConnection))
    }
}
