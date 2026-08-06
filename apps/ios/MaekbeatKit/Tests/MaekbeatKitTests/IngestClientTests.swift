import XCTest
@testable import MaekbeatKit

/*
 * The uplink socket's own behaviour, driven by a fake socket and a fake clock.
 *
 * Same rules as the fan-out client at C14 and deliberately the same numbers, so
 * the phone's two connections do not disagree about what a reconnect is. What
 * is new here is sending, and the one question sending raises: a frame handed
 * to a socket that is not live must come back refused, so the caller keeps it
 * buffered instead of believing it was delivered.
 */
@MainActor
final class IngestClientTests: XCTestCase {
    private var client: IngestClient?

    override func tearDown() {
        client = nil
        super.tearDown()
    }

    private func frame(_ seq: Int) -> VitalsFrame {
        VitalsFrame(
            deviceId: "sim-001",
            seq: seq,
            capturedAtMs: 1_754_265_600_000 + seq * 1_000,
            heartRateBpm: 62,
            spo2Pct: 97.5,
            respirationRpm: 13.7,
            motion: 0.01
        )
    }

    @discardableResult
    private func makeClient(
        _ sockets: FakeIngestTransport,
        _ timers: FakeTransport
    ) -> IngestClient {
        let created = IngestClient(
            url: StubHTTP.baseURL,
            createSocket: sockets.factory,
            schedule: timers.scheduler
        )
        client = created
        return created
    }

    // MARK: - States

    func testTheFirstAttemptIsConnectingAndTheOpenMakesItLive() {
        let sockets = FakeIngestTransport()
        let client = makeClient(sockets, FakeTransport())
        var states: [ConnectionState] = []
        client.onState = { states.append($0) }

        client.open()
        XCTAssertEqual(states, [.connecting])
        sockets.latest?.open()
        XCTAssertEqual(states, [.connecting, .live])
        XCTAssertEqual(client.state, .live)
    }

    func testThreeFailuresBeforeEverConnectingReportDisconnectedOnce() {
        let sockets = FakeIngestTransport()
        let timers = FakeTransport()
        let client = makeClient(sockets, timers)
        var states: [ConnectionState] = []
        client.onState = { states.append($0) }

        client.open()
        for _ in 0..<5 {
            sockets.latest?.drop()
            timers.fireScheduled()
        }
        XCTAssertEqual(states, [.connecting, .disconnected])
    }

    func testADropAfterALiveConnectionReadsAsReconnecting() {
        let sockets = FakeIngestTransport()
        let timers = FakeTransport()
        let client = makeClient(sockets, timers)
        var states: [ConnectionState] = []
        client.onState = { states.append($0) }

        client.open()
        sockets.latest?.open()
        sockets.latest?.drop()
        XCTAssertEqual(states, [.connecting, .live, .reconnecting])
    }

    func testTheRetriesUseTheSameCappedBackoffAsTheFanOutSocket() {
        let sockets = FakeIngestTransport()
        let timers = FakeTransport()
        makeClient(sockets, timers).open()

        for _ in 0..<6 {
            sockets.latest?.drop()
            timers.fireScheduled()
        }
        XCTAssertEqual(timers.scheduledDelaysMs, [500, 1_000, 2_000, 4_000, 8_000, 15_000])
    }

    func testASuccessfulOpenResetsTheBackoff() {
        let sockets = FakeIngestTransport()
        let timers = FakeTransport()
        makeClient(sockets, timers).open()

        sockets.latest?.drop()
        timers.fireScheduled()
        sockets.latest?.open()
        sockets.latest?.drop()

        XCTAssertEqual(timers.scheduledDelaysMs, [500, 500])
    }

    /// The caller resumes on a re-open and not on the first one, because there
    /// is nothing to resume from before anything was sent.
    func testAReopenAsksTheCallerToResumeAndAFirstOpenDoesNot() {
        let sockets = FakeIngestTransport()
        let timers = FakeTransport()
        let client = makeClient(sockets, timers)
        var reconnects = 0
        client.onReconnect = { reconnects += 1 }

        client.open()
        sockets.latest?.open()
        XCTAssertEqual(reconnects, 0)

        sockets.latest?.drop()
        timers.fireScheduled()
        sockets.latest?.open()
        XCTAssertEqual(reconnects, 1)
    }

    // MARK: - Sending

    func testAFrameIsRefusedWhileTheSocketIsNotLiveSoTheCallerKeepsIt() {
        let sockets = FakeIngestTransport()
        let client = makeClient(sockets, FakeTransport())
        client.open()

        XCTAssertFalse(client.send(frame(1)), "the socket has not opened yet")
        XCTAssertEqual(sockets.latest?.sent.count, 0)

        sockets.latest?.open()
        XCTAssertTrue(client.send(frame(1)))
        XCTAssertEqual(sockets.latest?.sentSeqs, [1])
    }

    func testAFrameIsRefusedAfterTheCallerCloses() {
        let sockets = FakeIngestTransport()
        let client = makeClient(sockets, FakeTransport())
        client.open()
        sockets.latest?.open()
        client.close()

        XCTAssertFalse(client.send(frame(2)))
    }

    func testTheFrameGoesOutAsTheWireContractsJson() throws {
        let sockets = FakeIngestTransport()
        let client = makeClient(sockets, FakeTransport())
        client.open()
        sockets.latest?.open()
        client.send(frame(9))

        let text = try XCTUnwrap(sockets.latest?.sent.first)
        let decoded = try VitalsDecoder.frame(from: Data(text.utf8))
        XCTAssertEqual(decoded.seq, 9)
        XCTAssertEqual(decoded.v, 1)
        XCTAssertEqual(decoded.deviceId, "sim-001")
    }

    // MARK: - Replies

    func testAnAckAndARejectionBothReachTheCaller() {
        let sockets = FakeIngestTransport()
        let client = makeClient(sockets, FakeTransport())
        var replies: [IngestReply] = []
        client.onReply = { replies.append($0) }
        client.open()
        sockets.latest?.open()

        sockets.latest?.reply(IngestWire.ack(seq: 4, sessionEpoch: 2, newSession: true))
        sockets.latest?.reply(IngestWire.rejected("duplicate"))

        XCTAssertEqual(replies.count, 2)
        guard case let .ack(ack) = replies[0] else { return XCTFail("expected an ack") }
        XCTAssertEqual(ack.seq, 4)
        XCTAssertEqual(ack.sessionEpoch, 2)
        XCTAssertTrue(ack.newSession)
        guard case let .rejected(rejection) = replies[1] else { return XCTFail("expected a reject") }
        XCTAssertEqual(rejection.reason, .duplicate)
    }

    func testEveryRejectionReasonTheServerCanSendDecodes() throws {
        for reason in IngestReply.Rejection.Reason.allCases {
            let decoded = try IngestReply.decode(Data(IngestWire.rejected(reason.rawValue).utf8))
            XCTAssertEqual(decoded, .rejected(.init(reason: reason)))
        }
    }

    func testAReplyTheContractRejectsIsCountedAndNeverDelivered() {
        let sockets = FakeIngestTransport()
        let client = makeClient(sockets, FakeTransport())
        var replies: [IngestReply] = []
        client.onReply = { replies.append($0) }
        client.open()
        sockets.latest?.open()

        sockets.latest?.reply("not json")
        sockets.latest?.reply(#"{"type":"telemetry"}"#)
        sockets.latest?.reply(#"{"type":"ack","seq":1}"#)

        XCTAssertEqual(client.undecodableReplies, 3)
        XCTAssertEqual(replies.count, 0)
    }

    // MARK: - Letting go

    func testCloseCancelsAPendingRetryAndOpensNothingElse() {
        let sockets = FakeIngestTransport()
        let timers = FakeTransport()
        let client = makeClient(sockets, timers)
        client.open()
        sockets.latest?.open()
        sockets.latest?.drop()

        client.close()
        timers.fireScheduled()

        XCTAssertEqual(timers.cancellations, 1)
        XCTAssertEqual(sockets.sockets.count, 1)
    }

    func testNothingIsReportedAfterTheCallerCloses() {
        let sockets = FakeIngestTransport()
        let client = makeClient(sockets, FakeTransport())
        var states: [ConnectionState] = []
        var replies: [IngestReply] = []
        client.onState = { states.append($0) }
        client.onReply = { replies.append($0) }
        client.open()
        let socket = sockets.latest
        socket?.open()
        client.close()

        XCTAssertEqual(socket?.closeCount, 1)
        socket?.reply(IngestWire.ack(seq: 1))
        socket?.drop()

        XCTAssertEqual(replies.count, 0)
        XCTAssertEqual(states, [.connecting, .live])
    }

    func testAClientClosedBeforeItOpensNeverOpensASocket() {
        let sockets = FakeIngestTransport()
        let client = makeClient(sockets, FakeTransport())

        client.close()
        client.open()

        XCTAssertEqual(sockets.sockets.count, 0)
    }
}
