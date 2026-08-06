import Foundation
import XCTest
@testable import MaekbeatKit

/*
 * The transition table under random event sequences.
 *
 * `BLELinkMatrixTests` asserts all ninety-nine cells one step deep: from this
 * state, this event, that landing and that effect list. What it cannot see is a
 * property of a *run* — a timer armed in one state firing three transitions
 * later, a counter that only drifts when two paths cross. apps/server got these
 * at C8 for the same reason, and its adversarial attacks became permanent
 * seeded suites rather than session artifacts. This is the iOS half of that.
 *
 * Seeded and fixed-length, so CI is deterministic: eight seeds, five hundred
 * events each, and a failure names the seed and the step that produced it.
 *
 * The invariant that earns the file is the one C15 wrote down and could only
 * spot-check: **every scheduled effect has an owner state, and leaving that
 * state cancels it.** It is asserted twice — as bookkeeping over the effect
 * lists in `testTheEffectLedgerNeverOutlivesItsOwnerState`, and again through
 * the driver and a clock in `testNoTimerEverFiresIntoAStateThatDidNotArmIt`,
 * where a violation shows up as the machine calling the radio impossible when
 * the fault was its own.
 *
 * That second test found one on its first run, and the fix is in
 * `BLELinkMachine.applyConnecting`: a connect that landed while a retry was
 * still pending left that retry running, and it fired `retryDue` into
 * `connected` some seconds later, where the machine rejected it and the link
 * screen counted an "unexpected radio event" the radio had not produced.
 */
@MainActor
final class BLELinkPropertyTests: XCTestCase {
    private static let seeds: [UInt64] = [1, 7, 13, 42, 99, 1_754, 26_500, 999_331]
    private static let steps = 500

    // MARK: - The machine, under anything at all

    /// Every event in every state, five hundred deep. Nothing here models a
    /// plausible radio on purpose: a radio that has gone wrong is exactly when
    /// the machine has to stay well-defined.
    func testTheMachineStaysWellDefinedUnderAnyEventSequence() {
        for seed in Self.seeds {
            var random = SeededGenerator(seed: seed)
            var machine = BLELinkMachine()
            var everStreamed = false

            for step in 0..<Self.steps {
                let event = Self.anyEvent(&random)
                let before = machine
                let outcome = machine.apply(event)
                let context = "seed \(seed), step \(step), \(event.kind) in \(before.state)"

                assertOutcomeIsConsistent(outcome, machine: machine, before: before, context)
                assertSessionHistoryIsEarned(
                    machine: machine,
                    before: before,
                    event: event,
                    everStreamed: &everStreamed,
                    context
                )
            }
        }
    }

    /// A landing inside the declared state space, a report that matches what
    /// happened, and a backoff sized by the attempt that earned it.
    private func assertOutcomeIsConsistent(
        _ outcome: BLELinkMachine.Outcome,
        machine: BLELinkMachine,
        before: BLELinkMachine,
        _ context: String
    ) {
        XCTAssertTrue(
            LinkState.allCases.contains(machine.state),
            "\(context): landed outside the declared state space — \(machine.state)"
        )
        XCTAssertGreaterThanOrEqual(machine.attempt, 0, "\(context): a negative attempt")

        switch outcome {
        case .rejected:
            XCTAssertEqual(machine, before, "\(context): a rejected event changed the machine")
        case let .ignored(_, state):
            XCTAssertEqual(state, before.state, "\(context): reported the wrong state")
            XCTAssertEqual(
                machine.state,
                before.state,
                "\(context): an ignored event moved the state"
            )
        case let .moved(from, to, effects):
            XCTAssertEqual(from, before.state, "\(context): reported the wrong origin")
            XCTAssertEqual(to, machine.state, "\(context): reported the wrong landing")
            for case let .scheduleRetry(afterMs) in effects {
                XCTAssertEqual(
                    afterMs,
                    LinkTiming.retryDelayMs(forAttempt: machine.attempt - 1),
                    "\(context): the backoff does not match the attempt it was sized for"
                )
                XCTAssertLessThanOrEqual(afterMs, LinkTiming.retryCapMs, context)
                XCTAssertGreaterThanOrEqual(afterMs, LinkTiming.retryBaseMs, context)
            }
        }
    }

    /// `hasStreamed` is a fact about the session, so it may only be earned by
    /// reaching `streaming` and only lost by ending the session. A path that
    /// sets it any other way is a link reporting missed readings where there
    /// were never any — the distinction C15 folded into the state type.
    private func assertSessionHistoryIsEarned(
        machine: BLELinkMachine,
        before: BLELinkMachine,
        event: LinkEvent,
        everStreamed: inout Bool,
        _ context: String
    ) {
        if machine.state.phase == .streaming { everStreamed = true }
        if machine.hasStreamed && !before.hasStreamed {
            XCTAssertEqual(
                machine.state.phase,
                .streaming,
                "\(context): hasStreamed was earned outside streaming"
            )
        }
        if !machine.hasStreamed && before.hasStreamed {
            XCTAssertEqual(event, .stop, "\(context): only stopping ends a session")
        }
        XCTAssertTrue(everStreamed || !machine.hasStreamed, context)
    }

    /// The C15 invariant as bookkeeping: track what the effect lists arm and
    /// cancel, and assert the ledger agrees with the state at every step.
    ///
    /// `connecting` is the one phase that allows either, and that is the design
    /// rather than a hole: a link that has never streamed goes back to
    /// `connecting` when an attempt fails, so it is both "trying now" (a
    /// deadline armed) and "waiting to try" (a retry pending) — never both, and
    /// never neither.
    func testTheEffectLedgerNeverOutlivesItsOwnerState() {
        for seed in Self.seeds {
            var random = SeededGenerator(seed: seed)
            var machine = BLELinkMachine()
            var ledger = TimerLedger()

            for step in 0..<Self.steps {
                let event = Self.anyEvent(&random)
                // Feeding a timer event means that timer has fired, and a fired
                // timer is spent whatever the machine then decides.
                ledger.spend(on: event)

                let before = machine.state
                if case let .moved(_, _, effects) = machine.apply(event) {
                    ledger.apply(effects)
                }
                assertLedger(ledger, machine.state, "seed \(seed), step \(step), \(event.kind) "
                    + "in \(before)")
            }
        }
    }

    private func assertLedger(_ ledger: TimerLedger, _ state: LinkState, _ context: String) {
        switch state.phase {
        case .disconnected:
            XCTAssertFalse(ledger.armed, "\(context): a deadline outlived the link")
            XCTAssertFalse(ledger.retryPending, "\(context): a retry outlived the link")
        case .connecting:
            XCTAssertNotEqual(
                ledger.armed,
                ledger.retryPending,
                "\(context): connecting is trying or waiting, never both and never neither"
            )
        case .connected, .streaming:
            XCTAssertTrue(ledger.armed, "\(context): a live link with no deadline on it")
            XCTAssertFalse(
                ledger.retryPending,
                "\(context): a retry survived the connection it was waiting for"
            )
        case .recovering:
            XCTAssertTrue(ledger.retryPending, "\(context): recovering with nothing scheduled")
            XCTAssertFalse(ledger.armed, "\(context): recovering with a deadline still armed")
        }
    }

    // MARK: - The driver, with a clock

    /// The same invariant one layer out, where it can actually bite. The event
    /// alphabet is restricted to what a radio and an app can legally produce at
    /// each moment — so every rejection the driver counts must have come from a
    /// timer this machine itself scheduled and failed to cancel.
    ///
    /// `rejectedEvents` is the assertion because it is also what the link screen
    /// shows: a number meaning "the radio did something this model says is
    /// impossible" is worthless if the model is what produced it.
    func testNoTimerEverFiresIntoAStateThatDidNotArmIt() {
        for seed in Self.seeds {
            var random = SeededGenerator(seed: seed)
            let clock = FakeTransport()
            let driver = BLEDriver(port: MockPeripheralPort(), schedule: clock.scheduler)
            var reachedStreaming = false

            for step in 0..<Self.steps {
                // Fire a pending timer roughly a third of the time, so deadlines
                // and backoffs interleave with radio traffic rather than only
                // landing in the quiet states a hand-written test would use.
                let firing = Int.random(in: 0..<3, using: &random) == 0
                if firing, clock.fireOldest() {
                    XCTAssertEqual(
                        driver.rejectedEvents,
                        0,
                        "seed \(seed), step \(step): a timer fired into \(driver.state), "
                            + "which never armed it"
                    )
                    continue
                }

                driver.handle(Self.plausibleEvent(for: driver.state, &random))
                if driver.phase == .streaming { reachedStreaming = true }

                XCTAssertEqual(
                    driver.rejectedEvents,
                    0,
                    "seed \(seed), step \(step): \(driver.state) rejected an event a radio "
                        + "in that state can produce"
                )
            }

            XCTAssertTrue(
                reachedStreaming,
                "seed \(seed): the run never reached streaming, so it proved little"
            )
            driver.stop()
        }
    }

    // MARK: - Generators

    /// Anything the type can express, including the illegal.
    private static func anyEvent(_ random: inout SeededGenerator) -> LinkEvent {
        let kinds = LinkEvent.allKinds
        let picked = kinds[Int.random(in: 0..<kinds.count, using: &random)]
        if case .radioUnavailable = picked {
            let reasons = RadioUnavailable.allCases
            return .radioUnavailable(reasons[Int.random(in: 0..<reasons.count, using: &random)])
        }
        return picked
    }

    /// What a radio and an app could actually produce next.
    ///
    /// The five app- and radio-level entries are legal in every state by design
    /// — `start`, `stop`, `radioReady` and `radioUnavailable` are what a user or
    /// a Bluetooth stack can raise at any moment — so they need no guard. The
    /// progress events are conditioned on the phase a peripheral would have to
    /// be in to send them, which models the peripheral rather than restating the
    /// table under test.
    ///
    /// Progress is weighted four to one against disruption. An unweighted draw
    /// spends five hundred steps being stopped and restarted and never reaches
    /// `streaming`, which proves nothing about the states past it — the
    /// `reachedStreaming` assertion is what keeps that from passing quietly.
    private static func plausibleEvent(
        for state: LinkState,
        _ random: inout SeededGenerator
    ) -> LinkEvent {
        var choices: [LinkEvent] = [
            .start, .radioReady,
            .stop, .radioUnavailable(.poweredOff), .radioUnavailable(.resetting)
        ]
        let progress: [LinkEvent]
        switch state.phase {
        case .disconnected: progress = [.start]
        case .connecting: progress = [.peripheralConnected, .linkLost]
        case .connected: progress = [.servicesResolved, .notificationsEnabled, .linkLost]
        case .streaming: progress = [.frameReceived, .linkLost]
        case .recovering: progress = [.linkLost]
        }
        for _ in 0..<4 { choices += progress }
        return choices[Int.random(in: 0..<choices.count, using: &random)]
    }
}

/// What the effect lists have armed and not yet cancelled.
struct TimerLedger {
    private(set) var armed = false
    private(set) var retryPending = false

    /// A timer event reaching the machine means that timer has just fired.
    mutating func spend(on event: LinkEvent) {
        if event == .timeout { armed = false }
        if event == .retryDue { retryPending = false }
    }

    mutating func apply(_ effects: [LinkEffect]) {
        for effect in effects {
            switch effect {
            case .armTimeout: armed = true
            case .clearTimeout: armed = false
            case .scheduleRetry: retryPending = true
            case .cancelRetry: retryPending = false
            case .scanAndConnect, .discoverServices, .enableNotifications, .cancelConnection:
                break
            }
        }
    }
}

/// splitmix64: small, seedable, and identical on every machine, so a failing
/// seed reproduces rather than being a story about one run. The same reason
/// packages/vitals-sim uses Irwin–Hall noise instead of a platform generator.
struct SeededGenerator: RandomNumberGenerator {
    private static let gamma: UInt64 = 0x9E37_79B9_7F4A_7C15

    private var state: UInt64

    init(seed: UInt64) {
        // A zero seed would start splitmix64 at its own fixed point.
        state = seed &+ Self.gamma
    }

    mutating func next() -> UInt64 {
        state = state &+ Self.gamma
        var mixed = state
        mixed = (mixed ^ (mixed >> 30)) &* 0xBF58_476D_1CE4_E5B9
        mixed = (mixed ^ (mixed >> 27)) &* 0x94D0_49BB_1331_11EB
        return mixed ^ (mixed >> 31)
    }
}
