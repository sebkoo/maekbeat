import XCTest
@testable import MaekbeatKit

/*
 * The resume promise, as a unit.
 *
 * packages/protocol/README.md wrote it down before there was a gateway: resume
 * from the last delivered `seq`, never replay older frames, because a replay
 * past the server's 64-frame reorder window forks a session epoch. These tests
 * pin the rule; GatewayIntegrationTests then checks it against a real
 * apps/server rather than against this restatement of what that server does.
 */
final class UplinkQueueTests: XCTestCase {
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

    // MARK: - Ordering and delivery

    /// Notifications are ordered within one BLE connection, so this mostly
    /// cannot happen — but a late arrival inside the reorder window is accepted
    /// and leaves in seq order anyway, because the server orders by seq too and
    /// a gateway that sent them shuffled would be inventing disorder.
    func testALateFrameInsideTheWindowStillLeavesInSeqOrder() {
        var queue = UplinkQueue()
        for seq in [3, 1, 2] { queue.offer(frame(seq)) }
        XCTAssertEqual(queue.nextBatch().map(\.seq), [1, 2, 3])
    }

    func testAnAcknowledgementDropsEverythingThroughIt() {
        var queue = UplinkQueue()
        for seq in 1...5 { queue.offer(frame(seq)) }

        queue.acknowledge(seq: 3)

        XCTAssertEqual(queue.pending.map(\.seq), [4, 5])
        XCTAssertEqual(queue.lastAckedSeq, 3)
        XCTAssertEqual(queue.nextBatch().map(\.seq), [4, 5])
    }

    /// An older acknowledgement arriving late must not walk the mark backwards
    /// and re-send what the server already has.
    func testAnOutOfOrderAcknowledgementNeverLowersTheMark() {
        var queue = UplinkQueue()
        for seq in 1...5 { queue.offer(frame(seq)) }
        queue.acknowledge(seq: 4)
        queue.acknowledge(seq: 2)

        XCTAssertEqual(queue.lastAckedSeq, 4)
        XCTAssertEqual(queue.nextBatch().map(\.seq), [5])
    }

    // MARK: - Resume, which is the whole point

    /// The C6 contract, as a unit test: after a reconnect the queue offers the
    /// tail, not the session. Replaying from the beginning is what forks an
    /// epoch on the server.
    func testAReconnectResumesFromTheLastDeliveredSeqAndNeverReplays() {
        var queue = UplinkQueue()
        for seq in 1...100 { queue.offer(frame(seq)) }
        for frame in queue.nextBatch(limit: 100) { queue.markSent(through: frame.seq) }
        queue.acknowledge(seq: 90)

        queue.socketReconnected()

        XCTAssertEqual(queue.nextBatch().map(\.seq), Array(91...100))
        XCTAssertFalse(queue.nextBatch().contains { $0.seq <= 90 },
                       "a delivered frame must never go out twice")
    }

    /// A frame written to a socket that then died may never have arrived, so
    /// the in-flight mark is dropped on reconnect while the acknowledged one
    /// survives. That difference is the whole of "resend the tail, not the
    /// session".
    func testUnacknowledgedFramesGoAgainAfterAReconnectAndAcknowledgedOnesDoNot() {
        var queue = UplinkQueue()
        for seq in 1...10 { queue.offer(frame(seq)) }
        for frame in queue.nextBatch(limit: 10) { queue.markSent(through: frame.seq) }
        queue.acknowledge(seq: 4)

        XCTAssertEqual(queue.nextBatch(), [], "nothing new while the rest is in flight")
        queue.socketReconnected()
        XCTAssertEqual(queue.nextBatch().map(\.seq), Array(5...10))
    }

    /// The threat `lastAckedSeq` surviving a reconnect defends against, named
    /// and staged: the uplink drops and comes back, and the peripheral then
    /// re-offers a frame the server has already filed.
    ///
    /// Peripheral retransmits are not hypothetical here — they are the reason
    /// this queue borrows the server's 64-frame reorder window rather than
    /// treating every regression as a reboot. Both links can drop together, a
    /// phone going out of range takes the radio and the wifi with it. If the
    /// acknowledged mark did not survive the socket, that re-offer would be
    /// queued, sent, and answered `duplicate` by the server — the one outcome
    /// the resume rule exists to prevent, and a number the README claims stays
    /// at zero across a healthy resume.
    ///
    /// This is the test that was missing when the mutation "clear lastAckedSeq
    /// on reconnect" could not be caught.
    func testAnAcknowledgedFrameReofferedAfterAReconnectIsStillRefused() {
        var queue = UplinkQueue()
        for seq in 1...5 { queue.offer(frame(seq)) }
        for sent in queue.nextBatch() { queue.markSent(through: sent.seq) }
        queue.acknowledge(seq: 5)

        queue.socketReconnected()

        XCTAssertEqual(queue.offer(frame(5)), .alreadyDelivered, "the server already has it")
        XCTAssertEqual(queue.offer(frame(3)), .alreadyDelivered)
        XCTAssertEqual(queue.nextBatch(), [], "a reconnect must not resend a filed frame")
        XCTAssertEqual(queue.lastAckedSeq, 5, "the mark outlives the socket that earned it")
    }

    func testAFrameIsNotSentTwiceWhilePumpingRepeatedly() {
        var queue = UplinkQueue()
        for seq in 1...3 { queue.offer(frame(seq)) }
        for frame in queue.nextBatch() { queue.markSent(through: frame.seq) }

        XCTAssertEqual(queue.nextBatch(), [], "already on the wire")
    }

    func testAFrameTheServerAlreadyAcknowledgedIsRefusedAtTheDoor() {
        var queue = UplinkQueue()
        for seq in 1...5 { queue.offer(frame(seq)) }
        queue.acknowledge(seq: 5)

        XCTAssertEqual(queue.offer(frame(5)), .alreadyDelivered)
        XCTAssertEqual(queue.offer(frame(3)), .alreadyDelivered)
        XCTAssertTrue(queue.isEmpty)
    }

    func testTheSameFrameOfferedTwiceIsQueuedOnce() {
        var queue = UplinkQueue()
        XCTAssertEqual(queue.offer(frame(7)), .queued)
        XCTAssertEqual(queue.offer(frame(7)), .alreadyDelivered)
        XCTAssertEqual(queue.count, 1)
    }

    // MARK: - The peripheral rebooting

    /// A `seq` that goes backwards on an ordered BLE link is a reboot. The
    /// pre-reboot buffer is dropped rather than replayed across the boundary:
    /// pushing high seqs after low ones would drag the server's high-water mark
    /// back up and fork another epoch — the residual limit on the record in
    /// packages/protocol/README.md.
    func testARebootDropsThePreRebootBufferInsteadOfReplayingAcrossIt() {
        var queue = UplinkQueue()
        for seq in 100...110 { queue.offer(frame(seq)) }
        queue.acknowledge(seq: 105)

        XCTAssertEqual(queue.offer(frame(0)), .peripheralRebooted(previousHighSeq: 110))

        XCTAssertEqual(queue.pending.map(\.seq), [0])
        XCTAssertNil(queue.lastAckedSeq, "the old session's mark means nothing now")
        XCTAssertEqual(queue.rebootsObserved, 1)
        XCTAssertFalse(queue.nextBatch().contains { $0.seq > 0 })
    }

    func testAfterARebootTheNewSessionCountsFromItsOwnFirstFrame() {
        var queue = UplinkQueue()
        for seq in 100...110 { queue.offer(frame(seq)) }
        queue.offer(frame(0))
        for seq in 1...3 { queue.offer(frame(seq)) }

        XCTAssertEqual(queue.nextBatch().map(\.seq), [0, 1, 2, 3])
        XCTAssertEqual(queue.highestOfferedSeq, 3)
    }

    /// Two reboots in a row are two reboots, not one confused one.
    func testASecondRebootIsCountedSeparately() {
        var queue = UplinkQueue()
        for seq in 200...210 { queue.offer(frame(seq)) }
        queue.offer(frame(0))
        for seq in 1...100 { queue.offer(frame(seq)) }
        queue.offer(frame(0))

        XCTAssertEqual(queue.rebootsObserved, 2)
        XCTAssertEqual(queue.pending.map(\.seq), [0])
    }

    /// The residual limit, asserted rather than described. A reboot before the
    /// counter passes 64 is invisible to the server (packages/protocol
    /// README.md), and the gateway uses the same window, so it is invisible
    /// here too. Detecting it on the phone alone would only make the two ends
    /// disagree — the fix is a wire-level boot id, which is a protocol version
    /// bump and not this commit.
    func testARebootInsideTheReorderWindowIsNotDetectedByEitherEnd() {
        var queue = UplinkQueue()
        for seq in 10...12 { queue.offer(frame(seq)) }

        let outcome = queue.offer(frame(0))

        XCTAssertEqual(outcome, .queued, "inside the window it reads as a late frame")
        XCTAssertEqual(queue.rebootsObserved, 0)
        XCTAssertEqual(UplinkQueue.reorderWindow, 64, "must match SEQ_REORDER_WINDOW")
    }

    // MARK: - The bound

    func testTheBufferIsBoundedAndDropsTheOldestFirst() {
        var queue = UplinkQueue(capacity: 4)
        for seq in 1...6 { queue.offer(frame(seq)) }

        XCTAssertEqual(queue.pending.map(\.seq), [3, 4, 5, 6])
        XCTAssertEqual(queue.droppedOldest, 2)
    }

    func testDroppingIsReportedToTheCallerAndNotJustCounted() {
        var queue = UplinkQueue(capacity: 2)
        XCTAssertEqual(queue.offer(frame(1)), .queued)
        XCTAssertEqual(queue.offer(frame(2)), .queued)
        XCTAssertEqual(queue.offer(frame(3)), .queuedAfterDroppingOldest)
    }

    func testACapacityOfZeroIsRefusedRatherThanProducingAQueueThatHoldsNothing() {
        var queue = UplinkQueue(capacity: 0)
        XCTAssertEqual(queue.offer(frame(1)), .queued)
        XCTAssertEqual(queue.count, 1)
    }

    func testAnEmptyQueueOffersNothing() {
        let queue = UplinkQueue()
        XCTAssertEqual(queue.nextBatch(), [])
        XCTAssertTrue(queue.isEmpty)
        XCTAssertNil(queue.lastAckedSeq)
    }

    func testTheBatchLimitIsRespected() {
        var queue = UplinkQueue()
        for seq in 1...50 { queue.offer(frame(seq)) }
        XCTAssertEqual(queue.nextBatch(limit: 10).map(\.seq), Array(1...10))
        XCTAssertEqual(queue.nextBatch(limit: 0), [])
        XCTAssertEqual(queue.nextBatch(limit: -5), [])
    }
}
