import XCTest
@testable import MaekbeatKit

@MainActor
final class StreamClientTests: XCTestCase {
    private let url = URL(string: "ws://127.0.0.1:3000/devices/sim-001/stream")!

    /// Held by the test case, not by the local scope. The client keeps only
    /// weak references to itself inside its socket handlers, so a client left
    /// to a local `let` can be released mid-test — and then every assertion
    /// about what it did passes because it did nothing. That happened while
    /// this suite was being written; it is why the reference lives here.
    private var held: StreamClient?

    override func tearDown() {
        held = nil
        super.tearDown()
    }

    @discardableResult
    private func makeClient(
        _ transport: FakeTransport,
        _ recorder: StreamRecorder
    ) -> StreamClient {
        let created = StreamClient(
            url: url,
            handlers: recorder.handlers,
            createSocket: transport.factory,
            schedule: transport.scheduler
        )
        held = created
        return created
    }

    // MARK: - States

    func testTheFirstAttemptIsConnectingAndTheOpenMakesItLive() {
        let transport = FakeTransport()
        let recorder = StreamRecorder()
        let client = makeClient(transport, recorder)

        client.open()
        XCTAssertEqual(recorder.states, [.connecting])

        transport.latest?.open()
        XCTAssertEqual(recorder.states, [.connecting, .live])
        XCTAssertEqual(client.state, .live)
    }

    /// A connection that never existed is not a reconnection. This is the bug
    /// apps/web found by deriving the label in two places (C11 mutation log).
    func testASocketThatNeverOpenedStaysConnectingRatherThanReconnecting() {
        let transport = FakeTransport()
        let recorder = StreamRecorder()
        makeClient(transport, recorder).open()

        transport.latest?.drop()
        XCTAssertEqual(recorder.states, [.connecting])
        XCTAssertEqual(recorder.reconnects, 0)
    }

    func testADropAfterALiveConnectionReportsReconnecting() {
        let transport = FakeTransport()
        let recorder = StreamRecorder()
        makeClient(transport, recorder).open()

        transport.latest?.open()
        transport.latest?.drop()
        XCTAssertEqual(recorder.states, [.connecting, .live, .reconnecting])
    }

    func testThreeConsecutiveFailuresReportDisconnectedAndRetriesContinue() {
        let transport = FakeTransport()
        let recorder = StreamRecorder()
        makeClient(transport, recorder).open()

        transport.latest?.drop()          // failure 1
        transport.fireScheduled()
        transport.latest?.drop()          // failure 2
        transport.fireScheduled()
        transport.latest?.drop()          // failure 3

        XCTAssertEqual(recorder.states, [.connecting, .disconnected])
        // Saying "disconnected" is not the same as giving up: a retry is
        // pending, which is what keeps a phone that lost wifi from staying dark
        // once wifi returns.
        XCTAssertEqual(transport.pendingCount, 1)
    }

    /// A retry loop repeating "disconnected" is not news. The state is reported
    /// on transitions only, so a screen reader is not told the same thing every
    /// fifteen seconds.
    func testARepeatedStateIsReportedOnce() {
        let transport = FakeTransport()
        let recorder = StreamRecorder()
        makeClient(transport, recorder).open()

        for _ in 0..<6 {
            transport.latest?.drop()
            transport.fireScheduled()
        }
        XCTAssertEqual(recorder.states, [.connecting, .disconnected])
    }

    // MARK: - Backoff

    func testBackoffDoublesToTheCapAndStaysThere() {
        XCTAssertEqual(backoffMs(forAttempt: 0), 500)
        XCTAssertEqual(backoffMs(forAttempt: 1), 1_000)
        XCTAssertEqual(backoffMs(forAttempt: 2), 2_000)
        XCTAssertEqual(backoffMs(forAttempt: 3), 4_000)
        XCTAssertEqual(backoffMs(forAttempt: 4), 8_000)
        XCTAssertEqual(backoffMs(forAttempt: 5), 15_000)
        XCTAssertEqual(backoffMs(forAttempt: 6), 15_000)
        // A socket left retrying overnight must not shift its way into
        // undefined behaviour.
        XCTAssertEqual(backoffMs(forAttempt: 64), 15_000)
        XCTAssertEqual(backoffMs(forAttempt: -1), 500)
    }

    func testTheClientSchedulesRetriesOnThatBackoff() {
        let transport = FakeTransport()
        let recorder = StreamRecorder()
        makeClient(transport, recorder).open()

        for _ in 0..<6 {
            transport.latest?.drop()
            transport.fireScheduled()
        }
        XCTAssertEqual(
            transport.scheduledDelaysMs,
            [500, 1_000, 2_000, 4_000, 8_000, 15_000]
        )
    }

    func testASuccessfulOpenResetsTheBackoff() {
        let transport = FakeTransport()
        let recorder = StreamRecorder()
        makeClient(transport, recorder).open()

        transport.latest?.drop()
        transport.fireScheduled()
        transport.latest?.drop()
        transport.fireScheduled()
        transport.latest?.open()
        transport.latest?.drop()

        XCTAssertEqual(transport.scheduledDelaysMs, [500, 1_000, 500])
    }

    // MARK: - Reconnect means back-fill

    func testAReopenAsksTheCallerToBackFillAndAFirstOpenDoesNot() {
        let transport = FakeTransport()
        let recorder = StreamRecorder()
        makeClient(transport, recorder).open()

        transport.latest?.open()
        XCTAssertEqual(recorder.reconnects, 0, "the first open missed nothing")

        transport.latest?.drop()
        transport.fireScheduled()
        transport.latest?.open()
        XCTAssertEqual(recorder.reconnects, 1)
    }

    // MARK: - Messages

    func testAContractValidMessageReachesTheCaller() throws {
        let transport = FakeTransport()
        let recorder = StreamRecorder()
        makeClient(transport, recorder).open()
        transport.latest?.open()

        transport.latest?.deliver(Wire.ready)
        transport.latest?.deliver(Wire.frameMessage(seq: 4))
        transport.latest?.deliver(Wire.alertMessage())
        transport.latest?.deliver(Wire.decisionMessage())

        XCTAssertEqual(recorder.messages.count, 4)
        XCTAssertEqual(recorder.invalid.count, 0)
        guard case let .ready(ready) = recorder.messages[0] else {
            return XCTFail("expected a ready message")
        }
        XCTAssertEqual(ready.ringCapacity, 1024)
        guard case let .frame(frame) = recorder.messages[1] else {
            return XCTFail("expected a frame message")
        }
        XCTAssertEqual(frame.seq, 4)
        XCTAssertEqual(frame.sessionEpoch, 1)
        guard case let .alert(alert) = recorder.messages[2] else {
            return XCTFail("expected an alert message")
        }
        XCTAssertEqual(alert.state, .raised)
        XCTAssertEqual(alert.metric, .spo2Pct)
        guard case let .decision(decision) = recorder.messages[3] else {
            return XCTFail("expected a decision message")
        }
        XCTAssertEqual(decision.decision, .acknowledged)
    }

    func testAMessageTheContractRejectsIsCountedAndNeverDelivered() {
        let transport = FakeTransport()
        let recorder = StreamRecorder()
        makeClient(transport, recorder).open()
        transport.latest?.open()

        transport.latest?.deliver("not json at all")
        transport.latest?.deliver(#"{"type":"telemetry","payload":1}"#)
        transport.latest?.deliver(#"{"type":"frame","frame":{"v":1}}"#)
        // A frame outside the transport bounds is a rejected message, not a
        // rendered one: the app must not draw an SpO2 of 140.
        transport.latest?.deliver(Wire.frameMessage(seq: 1, spo2: 140))

        XCTAssertEqual(recorder.messages.count, 0)
        XCTAssertEqual(recorder.invalid.count, 4)
    }

    // MARK: - Letting go

    func testCloseCancelsAPendingRetryAndClosesTheSocket() {
        let transport = FakeTransport()
        let recorder = StreamRecorder()
        let client = makeClient(transport, recorder)
        client.open()
        transport.latest?.open()
        transport.latest?.drop()

        client.close()
        XCTAssertEqual(transport.cancellations, 1)

        transport.fireScheduled()
        XCTAssertEqual(transport.sockets.count, 1, "a closed client opens nothing else")
    }

    func testNothingIsDeliveredAfterTheCallerCloses() {
        let transport = FakeTransport()
        let recorder = StreamRecorder()
        let client = makeClient(transport, recorder)
        client.open()
        let socket = transport.latest
        socket?.open()
        client.close()

        XCTAssertEqual(socket?.closeCount, 1)
        socket?.deliver(Wire.frameMessage(seq: 9))
        socket?.drop()

        XCTAssertEqual(recorder.messages.count, 0)
        XCTAssertEqual(recorder.states, [.connecting, .live])
    }

    func testAClientClosedBeforeItOpensNeverOpensASocket() {
        let transport = FakeTransport()
        let recorder = StreamRecorder()
        let client = makeClient(transport, recorder)

        client.close()
        client.open()

        XCTAssertEqual(transport.sockets.count, 0)
        XCTAssertEqual(recorder.states, [])
    }

    /// The narrow window where a leak lives: the caller lets go while the
    /// socket is still being constructed. Without the check after the factory
    /// returns, that socket is handed to nobody and never closed.
    func testASocketBuiltAfterTheCallerLetGoIsClosedAnyway() {
        final class Box {
            var client: StreamClient?
            var socket: FakeSocket?
        }
        let box = Box()
        let recorder = StreamRecorder()
        let factory: SocketFactory = { url, handlers in
            let socket = FakeSocket(url: url, handlers: handlers)
            box.socket = socket
            box.client?.close()
            return socket
        }

        let client = StreamClient(
            url: url,
            handlers: recorder.handlers,
            createSocket: factory,
            schedule: { _, _ in {} }
        )
        held = client
        box.client = client
        client.open()

        XCTAssertEqual(box.socket?.closeCount, 1)
    }
}
