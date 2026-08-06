import XCTest
@testable import MaekbeatKit

/*
 * The paths through the machine that matter, and the effects they emit.
 *
 * The matrix in BLELinkMatrixTests proves where each event lands. This proves
 * what the machine asks the radio to do on the way, and the one distinction the
 * whole design turns on: `recovering` means data is being missed, `connecting`
 * means there never was any.
 */
final class BLELinkScenarioTests: XCTestCase {
    private static let stopped = LinkState.disconnected(hasStreamed: false, wantsLink: false)

    private func effects(_ outcome: BLELinkMachine.Outcome) -> [LinkEffect] {
        guard case let .moved(_, _, effects) = outcome else { return [] }
        return effects
    }

    // MARK: - The happy path

    func testTheConnectPathAsksForEachStepInOrder() {
        var machine = BLELinkMachine()

        XCTAssertEqual(effects(machine.apply(.start)), [
            .cancelRetry, .scanAndConnect, .armTimeout(afterMs: LinkTiming.connectTimeoutMs)
        ])
        // `cancelRetry` on a first connect is a no-op, and it is there for the
        // connect that is not a first one: `connecting` is also where a failed
        // attempt waits out its backoff, and a connect landing there has to take
        // that timer with it (C17, BLELinkPropertyTests).
        XCTAssertEqual(effects(machine.apply(.peripheralConnected)), [
            .cancelRetry, .discoverServices, .armTimeout(afterMs: LinkTiming.discoveryTimeoutMs)
        ])
        XCTAssertEqual(effects(machine.apply(.servicesResolved)), [
            .enableNotifications, .armTimeout(afterMs: LinkTiming.discoveryTimeoutMs)
        ])
        XCTAssertEqual(effects(machine.apply(.notificationsEnabled)), [
            .armTimeout(afterMs: LinkTiming.streamStallMs)
        ])
        XCTAssertEqual(machine.phase, .streaming)
        XCTAssertTrue(machine.hasStreamed)
        XCTAssertEqual(machine.attempt, 0, "a success clears the failure count")
    }

    /// Every frame re-arms the stall deadline, which is what makes it mean
    /// "nothing has arrived recently" rather than "the link is old".
    func testEachFrameRearmsTheStallDeadline() {
        var machine = streaming()
        for expected in 1...3 {
            XCTAssertEqual(effects(machine.apply(.frameReceived)), [
                .armTimeout(afterMs: LinkTiming.streamStallMs)
            ])
            XCTAssertEqual(machine.framesReceived, expected)
        }
    }

    // MARK: - The distinction the design turns on

    func testALinkThatNeverStreamedRetriesAsConnectingNotRecovering() {
        var machine = BLELinkMachine()
        _ = machine.apply(.start)
        _ = machine.apply(.timeout)
        XCTAssertEqual(machine.phase, .connecting)

        _ = machine.apply(.retryDue)
        _ = machine.apply(.peripheralConnected)
        _ = machine.apply(.linkLost)
        XCTAssertEqual(machine.phase, .connecting, "still nothing to recover")
        XCTAssertFalse(machine.hasStreamed)
    }

    func testOnceItHasStreamedEveryLaterFailureIsRecovering() {
        var machine = streaming()

        _ = machine.apply(.linkLost)
        XCTAssertEqual(machine.phase, .recovering)

        _ = machine.apply(.retryDue)
        XCTAssertEqual(machine.phase, .connecting, "an attempt is in progress")
        _ = machine.apply(.timeout)
        XCTAssertEqual(machine.phase, .recovering, "and a failed attempt goes back to recovering")

        _ = machine.apply(.retryDue)
        _ = machine.apply(.peripheralConnected)
        _ = machine.apply(.linkLost)
        XCTAssertEqual(machine.phase, .recovering)
    }

    // MARK: - Recovery, which is the path that matters

    func testTheRecoveringPathReturnsToStreamingThroughTheFullHandshake() {
        var machine = streaming()
        _ = machine.apply(.linkLost)

        XCTAssertEqual(machine.phase, .recovering)
        _ = machine.apply(.retryDue)
        _ = machine.apply(.peripheralConnected)
        XCTAssertEqual(machine.phase, .connected)
        _ = machine.apply(.servicesResolved)
        _ = machine.apply(.notificationsEnabled)

        XCTAssertEqual(machine.phase, .streaming, "recovery re-runs discovery, it does not skip it")
        XCTAssertEqual(machine.attempt, 0)
    }

    func testTheRetryBackoffGrowsWithConsecutiveFailuresAndResetsOnSuccess() {
        var machine = streaming()
        var delays: [Int] = []

        for _ in 0..<5 {
            for effect in effects(machine.apply(.linkLost)) {
                if case let .scheduleRetry(afterMs) = effect { delays.append(afterMs) }
            }
            _ = machine.apply(.retryDue)
            _ = machine.apply(.peripheralConnected)
            _ = machine.apply(.servicesResolved)
            _ = machine.apply(.notificationsEnabled)
        }

        XCTAssertEqual(
            delays,
            Array(repeating: LinkTiming.retryBaseMs, count: 5),
            "each recovery succeeded, so each backoff starts over"
        )
    }

    /// The whole backoff sequence from a cold start, pinned so the code and the
    /// three documents quoting it cannot drift apart again. It read 2 s here
    /// before this commit — `beginAttempt` set the counter to 1 and
    /// `failAttempt` then charged the second step — while `LinkTiming`, the
    /// README and the hardware procedure all said 1 s. One of them had to be
    /// wrong; 1 s was the intent, so the code moved.
    func testTheColdStartBackoffSequenceIsTheOneTheDocumentsQuote() {
        var machine = BLELinkMachine()
        var delays: [Int] = []
        _ = machine.apply(.start)
        for _ in 0..<7 {
            for effect in effects(machine.apply(.timeout)) {
                if case let .scheduleRetry(afterMs) = effect { delays.append(afterMs) }
            }
            _ = machine.apply(.retryDue)
        }

        XCTAssertEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
        XCTAssertEqual(delays.first, LinkTiming.retryBaseMs, "the first retry is the base delay")
        XCTAssertEqual(delays.last, LinkTiming.retryCapMs)
    }

    /// A session that ended has nothing to recover. Keeping `hasStreamed` past
    /// a stop made the next session's first failure say "readings are being
    /// missed" with nothing ever received — the C11 mistake, one commit later.
    func testStoppingEndsTheSessionSoTheNextFailureIsConnectingNotRecovering() {
        var machine = streaming()
        _ = machine.apply(.stop)
        XCTAssertFalse(machine.hasStreamed, "the session ended with the stop")

        _ = machine.apply(.start)
        _ = machine.apply(.timeout)

        XCTAssertEqual(machine.phase, .connecting, "nothing was received; nothing is being missed")
        XCTAssertEqual(machine.framesReceived, 0)
    }

    /// Losing the radio is the same session interrupted, so it keeps both flags
    /// and a returning radio resumes into `recovering`, which is the honest
    /// label — that link really was delivering.
    func testLosingTheRadioKeepsTheSessionSoRecoveryStaysRecovery() {
        var machine = streaming()
        _ = machine.apply(.radioUnavailable(.poweredOff))
        XCTAssertTrue(machine.hasStreamed)
        XCTAssertTrue(machine.wantsLink)

        _ = machine.apply(.radioReady)
        _ = machine.apply(.timeout)
        XCTAssertEqual(machine.phase, .recovering)
    }

    /// Every scheduled effect has an owner state, and leaving that state
    /// cancels it. Before `cancelRetry` existed, switching Bluetooth off while
    /// a retry was pending left the timer running, and it later delivered
    /// `retryDue` into `disconnected` — where the machine rejected it and the
    /// driver counted the radio as having done something impossible.
    func testEveryExitFromAPendingRetryCancelsIt() {
        for exit in [LinkEvent.stop, .radioUnavailable(.poweredOff)] {
            var machine = streaming()
            _ = machine.apply(.linkLost)
            XCTAssertEqual(machine.phase, .recovering, "a retry is pending")

            let leaving = effects(machine.apply(exit))
            XCTAssertTrue(leaving.contains(.cancelRetry), "\(exit) left a timer running")
        }

        // And a fresh start cancels one the previous session may have left.
        var restarted = BLELinkMachine()
        _ = restarted.apply(.start)
        _ = restarted.apply(.timeout)
        _ = restarted.apply(.stop)
        XCTAssertTrue(effects(restarted.apply(.start)).contains(.cancelRetry))
    }

    func testRepeatedFailuresBackOffToTheCapAndStayThere() {
        var machine = streaming()
        var delays: [Int] = []
        for _ in 0..<8 {
            for effect in effects(machine.apply(.linkLost)) {
                if case let .scheduleRetry(afterMs) = effect { delays.append(afterMs) }
            }
            _ = machine.apply(.retryDue)
        }
        XCTAssertEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
        XCTAssertEqual(LinkTiming.retryDelayMs(forAttempt: 64), LinkTiming.retryCapMs)
        XCTAssertEqual(LinkTiming.retryDelayMs(forAttempt: -1), LinkTiming.retryBaseMs)
    }

    /// A stall is not a disconnect: the radio still holds the link, so the
    /// machine tears it down itself before retrying.
    func testAStalledStreamCancelsTheConnectionBeforeRetrying() {
        var machine = streaming()
        let stalled = effects(machine.apply(.timeout))
        XCTAssertEqual(machine.phase, .recovering)
        XCTAssertTrue(stalled.contains(.cancelConnection))
        XCTAssertTrue(stalled.contains(.clearTimeout))

        var dropped = streaming()
        let lost = effects(dropped.apply(.linkLost))
        XCTAssertFalse(lost.contains(.cancelConnection), "the link is already gone")
    }

    // MARK: - The radio going away

    func testLosingTheRadioParksTheLinkAndComingBackResumesIt() {
        var machine = streaming()

        _ = machine.apply(.radioUnavailable(.poweredOff))
        XCTAssertEqual(machine.phase, .disconnected)
        XCTAssertEqual(machine.unavailable, .poweredOff)
        XCTAssertTrue(machine.wantsLink, "the app still wants a link; the radio left")

        _ = machine.apply(.radioReady)
        XCTAssertEqual(machine.phase, .connecting)
        XCTAssertNil(machine.unavailable)
    }

    /// Stopping is a decision, and a radio returning afterwards must not undo
    /// it. This is the difference between "the user closed the screen" and
    /// "Bluetooth was switched off".
    func testStoppingClearsTheIntentSoAReturningRadioDoesNothing() {
        var machine = streaming()
        _ = machine.apply(.stop)
        XCTAssertEqual(machine.phase, .disconnected)
        XCTAssertFalse(machine.wantsLink)

        XCTAssertEqual(machine.apply(.radioReady), .ignored(.radioReady, in: Self.stopped))
        XCTAssertEqual(machine.phase, .disconnected)
    }

    func testAnUnusableRadioBeforeStartingIsRememberedWithoutStartingAnything() {
        var machine = BLELinkMachine()
        _ = machine.apply(.radioUnavailable(.unsupported))
        XCTAssertEqual(machine.phase, .disconnected)
        XCTAssertEqual(machine.unavailable, .unsupported)
        XCTAssertFalse(machine.wantsLink)
    }

    func testStoppingIsIdempotentAndClearsTheAttemptCount() {
        var machine = streaming()
        _ = machine.apply(.linkLost)
        _ = machine.apply(.retryDue)
        _ = machine.apply(.timeout)
        XCTAssertGreaterThan(machine.attempt, 0)

        _ = machine.apply(.stop)
        XCTAssertEqual(machine.attempt, 0)
        XCTAssertEqual(machine.apply(.stop), .ignored(.stop, in: Self.stopped))
    }

    // MARK: -

    private func streaming() -> BLELinkMachine {
        var machine = BLELinkMachine()
        _ = machine.apply(.start)
        _ = machine.apply(.peripheralConnected)
        _ = machine.apply(.servicesResolved)
        _ = machine.apply(.notificationsEnabled)
        return machine
    }
}
