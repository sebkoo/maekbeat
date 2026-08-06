import XCTest
@testable import MaekbeatKit

/// The mock central. It records what the machine asked the radio to do, which
/// is the whole of the adapter's contract — `CoreBluetoothCentral` implements
/// the same four calls against a radio that CI does not have.
@MainActor
final class MockPeripheralPort: PeripheralPort {
    enum Call: String, Equatable {
        case scanAndConnect, discoverServices, enableNotifications, cancelConnection
    }

    private(set) var calls: [Call] = []

    func scanAndConnect() { calls.append(.scanAndConnect) }
    func discoverServices() { calls.append(.discoverServices) }
    func enableNotifications() { calls.append(.enableNotifications) }
    func cancelConnection() { calls.append(.cancelConnection) }
}

@MainActor
final class BLEDriverTests: XCTestCase {
    private var driver: BLEDriver?

    override func tearDown() {
        driver = nil
        super.tearDown()
    }

    private func makeDriver(_ port: MockPeripheralPort, _ transport: FakeTransport) -> BLEDriver {
        let created = BLEDriver(port: port, schedule: transport.scheduler)
        driver = created
        return created
    }

    private func payload(seq: Int, spo2: Double = 97.5) -> Data {
        GattProfile.encode(VitalsFrame(
            deviceId: "ignored-on-the-air",
            seq: seq,
            capturedAtMs: 1_754_265_600_000 + seq * 1_000,
            heartRateBpm: 62,
            spo2Pct: spo2,
            respirationRpm: 13.7,
            motion: 0.01
        ))
    }

    // MARK: - Effects become calls

    func testTheDriverTranslatesEveryEffectIntoOneRadioCall() {
        let port = MockPeripheralPort()
        let driver = makeDriver(port, FakeTransport())

        driver.start()
        XCTAssertEqual(port.calls, [.scanAndConnect])
        driver.handle(.peripheralConnected)
        XCTAssertEqual(port.calls, [.scanAndConnect, .discoverServices])
        driver.handle(.servicesResolved)
        XCTAssertEqual(port.calls, [.scanAndConnect, .discoverServices, .enableNotifications])
        driver.handle(.notificationsEnabled)
        XCTAssertEqual(driver.phase, .streaming)

        driver.stop()
        XCTAssertEqual(port.calls.last, .cancelConnection)
    }

    func testStateChangesAreReportedOnceEach() {
        let port = MockPeripheralPort()
        let driver = makeDriver(port, FakeTransport())
        var reported: [LinkState] = []
        driver.onStateChange = { reported.append($0) }

        driver.start()
        driver.handle(.peripheralConnected)
        driver.handle(.servicesResolved)   // connected → connected, not a change
        driver.handle(.notificationsEnabled)

        XCTAssertEqual(reported.map(\.phase), [.connecting, .connected, .streaming])
    }

    // MARK: - Timers

    func testTheConnectDeadlineIsArmedAndFiresATimeout() {
        let port = MockPeripheralPort()
        let transport = FakeTransport()
        let driver = makeDriver(port, transport)

        driver.start()
        XCTAssertEqual(transport.scheduledDelaysMs, [LinkTiming.connectTimeoutMs])

        transport.fireScheduled()
        XCTAssertEqual(driver.phase, .connecting, "timed out, still trying")
        XCTAssertTrue(port.calls.contains(.cancelConnection))
    }

    /// A frame re-arms the stall deadline. Without the re-arm, a healthy stream
    /// would tear itself down after fifteen seconds.
    func testAStreamThatKeepsDeliveringNeverStalls() {
        let port = MockPeripheralPort()
        let transport = FakeTransport()
        let driver = makeDriver(port, transport)
        driver.start()
        driver.handle(.peripheralConnected)
        driver.handle(.servicesResolved)
        driver.handle(.notificationsEnabled)

        for seq in 0..<5 {
            driver.receive(payload: payload(seq: seq), from: "peripheral-1")
        }
        XCTAssertEqual(driver.phase, .streaming)
        XCTAssertEqual(
            transport.scheduledDelaysMs.suffix(5),
            Array(repeating: LinkTiming.streamStallMs, count: 5)
        )
    }

    func testASilentStreamStallsIntoRecovering() {
        let port = MockPeripheralPort()
        let transport = FakeTransport()
        let driver = makeDriver(port, transport)
        driver.start()
        driver.handle(.peripheralConnected)
        driver.handle(.servicesResolved)
        driver.handle(.notificationsEnabled)

        transport.fireScheduled()
        XCTAssertEqual(driver.phase, .recovering)
    }

    func testTheRetryTimerDrivesTheReconnect() {
        let port = MockPeripheralPort()
        let transport = FakeTransport()
        let driver = makeDriver(port, transport)
        driver.start()
        driver.handle(.peripheralConnected)
        driver.handle(.servicesResolved)
        driver.handle(.notificationsEnabled)
        driver.handle(.linkLost)
        XCTAssertEqual(driver.phase, .recovering)

        transport.fireScheduled()
        XCTAssertEqual(driver.phase, .connecting)
        XCTAssertEqual(port.calls.filter { $0 == .scanAndConnect }.count, 2)
    }

    /// The machine emitting `cancelRetry` is half the fix; the driver has to
    /// act on it. Without this the timer outlives the state that scheduled it
    /// and later delivers `retryDue` into `disconnected`, where it is rejected
    /// — so switching Bluetooth off gets counted as the radio doing something
    /// impossible. The rejected-event count is the symptom this asserts away.
    func testATimerNeverOutlivesTheStateThatScheduledIt() {
        for exit in [LinkEvent.stop, .radioUnavailable(.poweredOff)] {
            let port = MockPeripheralPort()
            let transport = FakeTransport()
            let driver = makeDriver(port, transport)
            driver.start()
            driver.handle(.peripheralConnected)
            driver.handle(.servicesResolved)
            driver.handle(.notificationsEnabled)
            driver.handle(.linkLost)
            XCTAssertEqual(driver.state.phase, .recovering, "a retry is pending")

            driver.handle(exit)
            let scansBefore = port.calls.filter { $0 == .scanAndConnect }.count
            transport.fireScheduled()

            XCTAssertEqual(driver.rejectedEvents, 0, "\(exit): a stale retry fired")
            XCTAssertEqual(
                port.calls.filter { $0 == .scanAndConnect }.count,
                scansBefore,
                "\(exit): a cancelled retry still reconnected"
            )
            XCTAssertEqual(driver.state.phase, .disconnected)
        }
    }

    // MARK: - Payloads

    func testADecodablePayloadBecomesAFrameCarryingThePeripheralsIdentity() {
        let port = MockPeripheralPort()
        let driver = makeDriver(port, FakeTransport())
        var frames: [VitalsFrame] = []
        driver.onFrame = { frames.append($0) }
        driver.start()
        driver.handle(.peripheralConnected)
        driver.handle(.servicesResolved)
        driver.handle(.notificationsEnabled)

        driver.receive(payload: payload(seq: 3), from: "peripheral-1")

        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames.first?.seq, 3)
        XCTAssertEqual(frames.first?.deviceId, "peripheral-1")
    }

    /// One bad packet is a counted drop, not a disconnect. Tearing a working
    /// link down over a garbled notification is the same mistake as closing an
    /// ingest socket over one invalid frame, which apps/server refuses to do.
    func testAnUndecodablePayloadIsCountedAndLeavesTheLinkAlone() {
        let port = MockPeripheralPort()
        let driver = makeDriver(port, FakeTransport())
        var frames: [VitalsFrame] = []
        driver.onFrame = { frames.append($0) }
        driver.start()
        driver.handle(.peripheralConnected)
        driver.handle(.servicesResolved)
        driver.handle(.notificationsEnabled)

        driver.receive(payload: Data([0xFF, 0x00]), from: "peripheral-1")
        driver.receive(payload: payload(seq: 1, spo2: 400), from: "peripheral-1")

        XCTAssertEqual(driver.undecodablePayloads, 2)
        XCTAssertEqual(frames.count, 0)
        XCTAssertEqual(driver.phase, .streaming, "the link is fine; the packet was not")
    }

    /// A radio doing something the model says is impossible is counted rather
    /// than absorbed — the difference between a model that is wrong and a model
    /// that hides being wrong.
    func testAnImpossibleEventIsCountedRatherThanSwallowed() {
        let port = MockPeripheralPort()
        let driver = makeDriver(port, FakeTransport())

        driver.handle(.notificationsEnabled)
        driver.handle(.frameReceived)

        XCTAssertEqual(driver.rejectedEvents, 2)
        XCTAssertEqual(driver.phase, .disconnected)
        XCTAssertEqual(port.calls, [], "nothing was asked of the radio")
    }

    /// A frame the link model says is impossible is still real data. The event
    /// is counted as rejected — the model is wrong about the link — and the
    /// reading is delivered anyway, because losing it would cost more than the
    /// bookkeeping disagreement is worth.
    func testAFrameArrivingBeforeNotificationsIsCountedAndStillDelivered() {
        let port = MockPeripheralPort()
        let driver = makeDriver(port, FakeTransport())
        var frames: [VitalsFrame] = []
        driver.onFrame = { frames.append($0) }
        driver.start()
        driver.handle(.peripheralConnected)

        driver.receive(payload: payload(seq: 0), from: "peripheral-1")

        XCTAssertEqual(driver.rejectedEvents, 1)
        XCTAssertEqual(driver.phase, .connected)
        XCTAssertEqual(frames.count, 1, "the payload decoded; the link event did not fit")
    }
}
