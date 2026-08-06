import Foundation
import XCTest
@testable import MaekbeatKit

/*
 * Defaulted *values* nothing had ever read, and the screen initialiser nothing
 * but the app had ever called.
 *
 * The sibling file, DefaultPathTests, takes the injected ports — the sockets,
 * the timer, the HTTP transport. These are the smaller half of the same family:
 * a default argument that every test overrides because overriding it is what
 * makes the test small. The bound the app actually ships with is then the one
 * number no assertion has ever seen, which is a poor property for a bound.
 */
final class DefaultValueTests: XCTestCase {
    /// Port 1 on loopback: privileged, unbound, refused immediately.
    private static let refusedSocket = URL(string: "ws://127.0.0.1:1/devices/sim-001/stream")!

    /// The bounded-buffer default. Every behavioural test builds a small queue
    /// so its bound can be reached; the number the app ships with was read by
    /// nothing, and it is the one that decides how much a phone holds offline.
    func testTheQueueDefaultsToTheCapacityTheAppShips() {
        XCTAssertEqual(UplinkQueue.defaultCapacity, 1_024)
        XCTAssertEqual(
            UplinkQueue.reorderWindow,
            64,
            "the window is the server's SEQ_REORDER_WINDOW, not an invention"
        )

        var queue = UplinkQueue()
        for seq in 0..<UplinkQueue.defaultCapacity {
            queue.offer(Self.frame(seq: seq))
        }
        XCTAssertEqual(queue.count, UplinkQueue.defaultCapacity)
        XCTAssertEqual(queue.droppedOldest, 0, "nothing is dropped up to the bound")

        queue.offer(Self.frame(seq: UplinkQueue.defaultCapacity))
        XCTAssertEqual(queue.droppedOldest, 1, "and the oldest goes past it")
        XCTAssertEqual(queue.count, UplinkQueue.defaultCapacity)
    }

    /// `nextBatch()`'s default limit is what `GatewayModel.pump()` takes on every
    /// send, and no test had read it: the batch is bounded so a reconnect with a
    /// full buffer writes a bounded burst rather than a thousand frames.
    func testTheSendBatchIsBoundedByDefault() {
        var queue = UplinkQueue()
        for seq in 0..<200 { queue.offer(Self.frame(seq: seq)) }

        XCTAssertEqual(queue.nextBatch().count, 32)
        XCTAssertEqual(queue.nextBatch().map(\.seq), Array(0..<32), "oldest first")
    }

    /// The error panel with no failure behind it. `forFrames` reaches this
    /// fallback from `ViewRenderingTests`; `forDevices` is only ever called with
    /// a failure in hand, so its own fallback said nothing to anybody.
    func testAnErrorPanelWithNoFailureStillSaysSomething() {
        let devices = StatusCopy.forDevices(.error)
        XCTAssertFalse(devices.detail.isEmpty, "an error panel with no detail is a blank")
        XCTAssertEqual(devices.detail, Copy.readFailedTitle)
    }

    /// A decision event identifies itself by its own event id, not by the alert
    /// it judges: two decisions on one alert are two rows in an append-only log,
    /// and an `Identifiable` keyed on `alertId` would collapse them into one.
    func testADecisionIdentifiesItselfByItsOwnEventId() {
        let first = Self.decision(eventId: "sim-001:decision:1")
        let second = Self.decision(eventId: "sim-001:decision:2")

        XCTAssertEqual(first.id, "sim-001:decision:1")
        XCTAssertNotEqual(first.id, second.id, "one alert, two judgements, two rows")
        XCTAssertEqual(first.alertId, second.alertId)
    }

    /// The state a client reports before anything has been attempted. The view
    /// reads `state` rather than tracking transitions, so a client built and not
    /// yet opened has to answer something — and `connecting` is the honest one:
    /// a screen that says `disconnected` before it has tried is a screen
    /// claiming a failure that has not happened.
    @MainActor
    func testAClientThatHasNotOpenedYetReportsConnecting() {
        let client = StreamClient(
            url: Self.refusedSocket,
            handlers: StreamHandlers(onMessage: { _ in }),
            createSocket: FakeTransport().factory,
            schedule: FakeTransport().scheduler
        )
        XCTAssertEqual(client.state, .connecting)
        client.close()
    }

    // MARK: -

    private static func frame(seq: Int) -> VitalsFrame {
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

    private static func decision(eventId: String) -> AlertDecisionEvent {
        AlertDecisionEvent(
            eventId: eventId,
            alertId: "sim-001:spo2-low:1",
            deviceId: "sim-001",
            decision: .acknowledged,
            actor: "ios-gateway",
            recordedAtMs: 1_754_265_700_000,
            note: nil
        )
    }
}
