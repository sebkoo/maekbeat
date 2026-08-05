import XCTest
@testable import MaekbeatKit

/*
 * The device screen's model: a REST seed, live frames and alerts over a fake
 * socket, and the back-fill that follows every re-open.
 *
 * Split out of ViewStateTests because it is the one model with a transport
 * attached, and because a file this long stops being read.
 */
@MainActor
final class DeviceScreenTests: XCTestCase {
    private func detailModel(
        _ stub: StubHTTP,
        _ transport: FakeTransport
    ) -> DeviceDetailModel {
        DeviceDetailModel(
            deviceId: "sim-001",
            client: stub.client,
            createSocket: transport.factory,
            schedule: transport.scheduler
        )
    }

    func testTheSeedReadFillsTheWindowAndTheSocketAppendsToIt() async {
        let stub = StubHTTP()
        stub.answers = [
            (Wire.framesPage([
                Wire.frame(seq: 0),
                Wire.frame(seq: 1, capturedAtMs: 1_754_265_601_000)
            ]), 200),
            (Wire.emptyAlertsPage, 200)
        ]
        let transport = FakeTransport()
        let model = detailModel(stub, transport)

        await model.load()
        XCTAssertEqual(model.frames.value?.count, 2)

        model.connect()
        transport.latest?.open()
        transport.latest?.deliver(Wire.frameMessage(seq: 2, capturedAtMs: 1_754_265_602_000))

        XCTAssertEqual(model.frames.value?.count, 3)
        XCTAssertEqual(model.newestFrame?.seq, 2)
        XCTAssertEqual(model.connection, .live)
        model.disconnect()
    }

    /// Identity is `(sessionEpoch, seq)`, never the timestamp: a device clock
    /// adjustment must not turn one frame into two.
    func testADuplicateFrameChangesNothingEvenWithADifferentTimestamp() async {
        let stub = StubHTTP()
        stub.answers = [(Wire.framesPage([Wire.frame(seq: 0)]), 200), (Wire.emptyAlertsPage, 200)]
        let transport = FakeTransport()
        let model = detailModel(stub, transport)
        await model.load()
        model.connect()
        transport.latest?.open()

        transport.latest?.deliver(Wire.frameMessage(seq: 0, capturedAtMs: 1_754_265_609_999))
        XCTAssertEqual(model.frames.value?.count, 1)

        // Same seq, different session: a reboot, so a different frame.
        transport.latest?.deliver(Wire.frameMessage(seq: 0, sessionEpoch: 2))
        XCTAssertEqual(model.frames.value?.count, 2)
        XCTAssertEqual(model.sessionsInWindow, [1, 2])
        model.disconnect()
    }

    /// A late arrival lands where it was captured, not where it turned up.
    func testAnOutOfOrderFrameIsPlacedByCaptureTime() async {
        let stub = StubHTTP()
        stub.answers = [(Wire.framesPage([]), 200), (Wire.emptyAlertsPage, 200)]
        let transport = FakeTransport()
        let model = detailModel(stub, transport)
        await model.load()
        model.connect()
        transport.latest?.open()

        transport.latest?.deliver(Wire.frameMessage(seq: 0, capturedAtMs: 1_000_000))
        transport.latest?.deliver(Wire.frameMessage(seq: 2, capturedAtMs: 1_002_000))
        transport.latest?.deliver(Wire.frameMessage(seq: 1, capturedAtMs: 1_001_000))

        XCTAssertEqual(model.frames.value?.map(\.seq), [0, 1, 2])
        XCTAssertEqual(model.newestFrame?.seq, 2)
        model.disconnect()
    }

    func testTheWindowIsBoundedAndDropsTheOldestFirst() async {
        let stub = StubHTTP()
        let seeded = (0..<DeviceDetailModel.windowLimit).map {
            Wire.frame(seq: $0, capturedAtMs: 1_000_000 + $0 * 1_000)
        }
        stub.answers = [(Wire.framesPage(seeded), 200), (Wire.emptyAlertsPage, 200)]
        let transport = FakeTransport()
        let model = detailModel(stub, transport)
        await model.load()
        model.connect()
        transport.latest?.open()

        transport.latest?.deliver(Wire.frameMessage(seq: 9_999, capturedAtMs: 9_000_000))

        XCTAssertEqual(model.frames.value?.count, DeviceDetailModel.windowLimit)
        XCTAssertEqual(model.frames.value?.first?.seq, 1)
        XCTAssertEqual(model.frames.value?.last?.seq, 9_999)
        model.disconnect()
    }

    /// A reachable device holding no frames is `empty`, with words, not a blank
    /// list that reads as calm.
    func testADeviceWithNoFramesInTheWindowIsEmpty() async {
        let stub = StubHTTP()
        stub.answers = [(Wire.framesPage([]), 200), (Wire.emptyAlertsPage, 200)]
        let model = detailModel(stub, FakeTransport())
        await model.load()
        XCTAssertEqual(model.frames.variant, .empty)
    }

    func testAFailedSeedReadShowsTheFailureRatherThanAnEmptyChart() async {
        let stub = StubHTTP()
        stub.thrown = URLError(.cannotFindHost)
        let model = detailModel(stub, FakeTransport())
        await model.load()
        XCTAssertEqual(model.frames.variant, .disconnected)
        XCTAssertNil(model.newestFrame)
    }

    /// Silence is not continuity: a re-open asks the server what was missed.
    func testAReconnectBackFillsOverRESTRatherThanResumingSilently() async throws {
        let stub = StubHTTP()
        stub.answers = [
            (Wire.framesPage([Wire.frame(seq: 0, capturedAtMs: 1_000_000)]), 200),
            (Wire.emptyAlertsPage, 200)
        ]
        let transport = FakeTransport()
        let model = detailModel(stub, transport)
        await model.load()
        model.connect()
        transport.latest?.open()

        stub.answers = [(
            Wire.framesPage([
                Wire.frame(seq: 1, capturedAtMs: 1_001_000),
                Wire.frame(seq: 2, capturedAtMs: 1_002_000)
            ]),
            200
        )]
        transport.latest?.drop()
        transport.fireScheduled()
        transport.latest?.open()

        // The back-fill is a task; let it land.
        try await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(model.frames.value?.map(\.seq), [0, 1, 2])
        let backfillURL = try XCTUnwrap(stub.requested.last)
        XCTAssertTrue(
            backfillURL.absoluteString.contains("since=1000000"),
            "the back-fill must resume from the newest frame held: \(backfillURL)"
        )
        model.disconnect()
    }

    // MARK: - Alerts on the screen

    func testAnAlertEpisodeIsOneRowThroughItsLifecycle() async {
        let stub = StubHTTP()
        stub.answers = [(Wire.framesPage([]), 200), (Wire.emptyAlertsPage, 200)]
        let transport = FakeTransport()
        let model = detailModel(stub, transport)
        await model.load()
        model.connect()
        transport.latest?.open()

        transport.latest?.deliver(Wire.alertMessage(state: "raised"))
        transport.latest?.deliver(Wire.alertMessage(state: "ongoing"))
        transport.latest?.deliver(
            Wire.alertMessage(state: "resolved", resolvedAtMs: 1_754_265_693_000)
        )

        XCTAssertEqual(model.alerts.count, 1, "one episode is one row, not three")
        XCTAssertEqual(model.alerts[0].state, .resolved)
        XCTAssertEqual(model.alerts[0].durationMs, 53_000)
        model.disconnect()
    }

    func testTheTimelinePutsTheNewestEpisodeFirst() async {
        let stub = StubHTTP()
        stub.answers = [(Wire.framesPage([]), 200), (Wire.emptyAlertsPage, 200)]
        let transport = FakeTransport()
        let model = detailModel(stub, transport)
        await model.load()
        model.connect()
        transport.latest?.open()

        transport.latest?.deliver(Wire.alertMessage(alertId: "sim-001:spo2-low:1"))
        transport.latest?.deliver(Wire.alertMessage(alertId: "sim-001:hr-high:2"))

        XCTAssertEqual(model.timeline.count, 2)
        XCTAssertGreaterThanOrEqual(
            model.timeline[0].raisedAtMs,
            model.timeline[1].raisedAtMs
        )
        model.disconnect()
    }

    /// A decision recorded on another client reaches this one, and a change of
    /// mind replaces it — newest event wins, never the first one seen.
    func testADecisionFromAnotherDashboardIsAppliedAndCanBeChanged() async {
        let stub = StubHTTP()
        stub.answers = [(Wire.framesPage([]), 200), (Wire.emptyAlertsPage, 200)]
        let transport = FakeTransport()
        let model = detailModel(stub, transport)
        await model.load()
        model.connect()
        transport.latest?.open()

        transport.latest?.deliver(Wire.decisionMessage(decision: "acknowledged"))
        XCTAssertEqual(model.decisions["sim-001:spo2-low:1"]?.decision, .acknowledged)

        transport.latest?.deliver(Wire.decisionMessage(
            eventId: "sim-001:decision:2",
            decision: "dismissed",
            recordedAtMs: 1_754_265_800_000
        ))
        XCTAssertEqual(model.decisions["sim-001:spo2-low:1"]?.decision, .dismissed)

        // An older event arriving late must not win.
        transport.latest?.deliver(Wire.decisionMessage(
            eventId: "sim-001:decision:0",
            decision: "acknowledged",
            recordedAtMs: 1_754_265_600_000
        ))
        XCTAssertEqual(model.decisions["sim-001:spo2-low:1"]?.decision, .dismissed)
        model.disconnect()
    }

    func testTheServersRingCapacityIsRememberedFromTheReadyMessage() async {
        let stub = StubHTTP()
        stub.answers = [(Wire.framesPage([]), 200), (Wire.emptyAlertsPage, 200)]
        let transport = FakeTransport()
        let model = detailModel(stub, transport)
        await model.load()
        model.connect()
        transport.latest?.open()

        XCTAssertNil(model.ringCapacity)
        transport.latest?.deliver(Wire.ready)
        XCTAssertEqual(model.ringCapacity, 1024)
        model.disconnect()
    }

    func testARejectedMessageIsCountedAndDrawsNothing() async {
        let stub = StubHTTP()
        stub.answers = [(Wire.framesPage([]), 200), (Wire.emptyAlertsPage, 200)]
        let transport = FakeTransport()
        let model = detailModel(stub, transport)
        await model.load()
        model.connect()
        transport.latest?.open()

        transport.latest?.deliver(Wire.frameMessage(seq: 1, spo2: 140))
        XCTAssertEqual(model.invalidMessages, 1)
        XCTAssertEqual(model.frames.variant, .empty)
        model.disconnect()
    }

    /// A screen that goes away closes its socket. A phone retrying for a view
    /// nobody is looking at is spending battery on nothing.
    func testDisconnectClosesALiveSocket() async {
        let stub = StubHTTP()
        stub.answers = [(Wire.framesPage([]), 200), (Wire.emptyAlertsPage, 200)]
        let transport = FakeTransport()
        let model = detailModel(stub, transport)
        await model.load()
        model.connect()
        transport.latest?.open()

        model.disconnect()

        XCTAssertEqual(transport.sockets[0].closeCount, 1)
    }

    /// Leaving mid-retry is the case that leaks. There is no socket left to
    /// close — the drop already took it — so what has to stop is the pending
    /// reconnect, which would otherwise open a second socket for a screen that
    /// is gone.
    func testDisconnectDuringABackoffStopsTheRetryLoop() async {
        let stub = StubHTTP()
        stub.answers = [(Wire.framesPage([]), 200), (Wire.emptyAlertsPage, 200)]
        let transport = FakeTransport()
        let model = detailModel(stub, transport)
        await model.load()
        model.connect()
        transport.latest?.open()
        transport.latest?.drop()
        XCTAssertEqual(transport.pendingCount, 1, "a retry is pending before the screen leaves")

        model.disconnect()
        transport.fireScheduled()

        XCTAssertEqual(transport.cancellations, 1)
        XCTAssertEqual(transport.sockets.count, 1, "no socket opened after the screen left")
    }

    func testConnectingTwiceOpensOneSocket() async {
        let stub = StubHTTP()
        stub.answers = [(Wire.framesPage([]), 200), (Wire.emptyAlertsPage, 200)]
        let transport = FakeTransport()
        let model = detailModel(stub, transport)
        await model.load()

        model.connect()
        model.connect()

        XCTAssertEqual(transport.sockets.count, 1)
        model.disconnect()
    }

}
