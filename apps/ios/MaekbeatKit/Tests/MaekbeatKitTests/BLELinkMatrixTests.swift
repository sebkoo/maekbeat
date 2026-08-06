import XCTest
@testable import MaekbeatKit

/*
 * The whole transition table, asserted cell by cell — over the state space
 * rather than over the part of it that shows on screen.
 *
 * The first version of this file indexed by phase alone: five rows, eleven
 * events, and a header claiming fifty-five answers. Three of those cells had
 * two answers, because the machine also consulted a `hasStreamed` flag the
 * table did not index, and whichever setup path a row happened to use decided
 * which of the two got asserted. Folding that flag into `LinkState` produced a
 * table that immediately failed on a cell nobody had suspected — `radioReady`
 * in `disconnected` — because a second field, `wantsLink`, had escaped the same
 * way. Both are in the type now. docs/DECISIONS.md #18 records the rule.
 *
 * Exhaustive over: the nine reachable `LinkState` values by the eleven
 * `LinkEvent` cases — ninety-nine cells, each asserting the resulting state and
 * the exact effect list.
 *
 * Not exhaustive over: `attempt`, `unavailable` and `framesReceived`. Those are
 * counters and a last-reason record; no transition branches on them. `attempt`
 * does size one effect, the retry backoff, so cells that schedule a retry
 * assert it as a function of the attempt the machine held on entry rather than
 * as a constant — see `backoffForEntryAttempt`.
 */
final class BLELinkMatrixTests: XCTestCase {
    private enum Expected: Equatable {
        case moves(to: LinkState, effects: [LinkEffect])
        case ignored
        case rejected
    }

    private static let connectArm = LinkEffect.armTimeout(afterMs: LinkTiming.connectTimeoutMs)
    private static let discoverArm = LinkEffect.armTimeout(afterMs: LinkTiming.discoveryTimeoutMs)
    private static let stallArm = LinkEffect.armTimeout(afterMs: LinkTiming.streamStallMs)

    /// Stands in for "a retry scheduled at the backoff for the attempt this
    /// machine had on entry". Resolved in the comparison, because the delay is
    /// a function of a counter rather than of the state.
    private static let backoffForEntryAttempt = LinkEffect.scheduleRetry(afterMs: -1)

    /// Leaving a state cancels what it scheduled. Every exit to `disconnected`
    /// carries all three.
    private static let teardown: [LinkEffect] = [.cancelConnection, .clearTimeout, .cancelRetry]
    /// A fresh attempt cancels a retry a previous session may have left behind.
    private static let freshAttempt: [LinkEffect] = [.cancelRetry, .scanAndConnect, connectArm]
    /// A scheduled retry firing does not — that timer has just spent itself.
    private static let continuedAttempt: [LinkEffect] = [.scanAndConnect, connectArm]

    private static let stopped = LinkState.disconnected(hasStreamed: false, wantsLink: false)

    private static func rowForDisconnected(hasStreamed: Bool, wantsLink: Bool) -> [String: Expected] {
        let resume = Expected.moves(
            to: .connecting(hasStreamed: hasStreamed), effects: freshAttempt
        )
        return [
            "start": resume,
            // Stopping something already stopped is a no-op; stopping a link the
            // app still wants is the decision that ends the session.
            "stop": wantsLink ? .moves(to: stopped, effects: teardown) : .ignored,
            // The cell that exposed `wantsLink`: a returning radio resumes only
            // a link somebody asked for.
            "radioReady": wantsLink ? resume : .ignored,
            "radioUnavailable": .ignored,
            "peripheralConnected": .rejected,
            "servicesResolved": .rejected,
            "notificationsEnabled": .rejected,
            "frameReceived": .rejected,
            "linkLost": .rejected,
            "timeout": .rejected,
            "retryDue": .rejected
        ]
    }

    private static func rowForConnecting(hasStreamed: Bool) -> [String: Expected] {
        let failed: LinkState = hasStreamed ? .recovering : .connecting(hasStreamed: false)
        return [
            "start": .ignored,
            "stop": .moves(to: stopped, effects: teardown),
            "radioReady": .ignored,
            "radioUnavailable": .moves(
                to: .disconnected(hasStreamed: hasStreamed, wantsLink: true), effects: teardown
            ),
            "peripheralConnected": .moves(
                to: .connected(hasStreamed: hasStreamed), effects: [.discoverServices, discoverArm]
            ),
            "servicesResolved": .rejected,
            "notificationsEnabled": .rejected,
            "frameReceived": .rejected,
            "linkLost": .moves(to: failed, effects: [.clearTimeout, backoffForEntryAttempt]),
            "timeout": .moves(
                to: failed, effects: [.cancelConnection, .clearTimeout, backoffForEntryAttempt]
            ),
            "retryDue": .moves(to: .connecting(hasStreamed: hasStreamed), effects: continuedAttempt)
        ]
    }

    private static func rowForConnected(hasStreamed: Bool) -> [String: Expected] {
        let failed: LinkState = hasStreamed ? .recovering : .connecting(hasStreamed: false)
        return [
            "start": .ignored,
            "stop": .moves(to: stopped, effects: teardown),
            "radioReady": .ignored,
            "radioUnavailable": .moves(
                to: .disconnected(hasStreamed: hasStreamed, wantsLink: true), effects: teardown
            ),
            "peripheralConnected": .rejected,
            "servicesResolved": .moves(
                to: .connected(hasStreamed: hasStreamed),
                effects: [.enableNotifications, discoverArm]
            ),
            "notificationsEnabled": .moves(to: .streaming, effects: [stallArm]),
            // Notifications are not on yet; a frame here is impossible.
            "frameReceived": .rejected,
            "linkLost": .moves(to: failed, effects: [.clearTimeout, backoffForEntryAttempt]),
            "timeout": .moves(
                to: failed, effects: [.cancelConnection, .clearTimeout, backoffForEntryAttempt]
            ),
            "retryDue": .rejected
        ]
    }

    private static let streamingRow: [String: Expected] = [
        "start": .ignored,
        "stop": .moves(to: stopped, effects: teardown),
        "radioReady": .ignored,
        "radioUnavailable": .moves(
            to: .disconnected(hasStreamed: true, wantsLink: true), effects: teardown
        ),
        "peripheralConnected": .rejected,
        "servicesResolved": .rejected,
        "notificationsEnabled": .rejected,
        "frameReceived": .moves(to: .streaming, effects: [stallArm]),
        "linkLost": .moves(to: .recovering, effects: [.clearTimeout, backoffForEntryAttempt]),
        "timeout": .moves(
            to: .recovering, effects: [.cancelConnection, .clearTimeout, backoffForEntryAttempt]
        ),
        "retryDue": .rejected
    ]

    private static let recoveringRow: [String: Expected] = [
        "start": .ignored,
        "stop": .moves(to: stopped, effects: teardown),
        "radioReady": .ignored,
        "radioUnavailable": .moves(
            to: .disconnected(hasStreamed: true, wantsLink: true), effects: teardown
        ),
        "peripheralConnected": .rejected,
        "servicesResolved": .rejected,
        "notificationsEnabled": .rejected,
        "frameReceived": .rejected,
        // Radios report a disconnect more than once. Already waiting.
        "linkLost": .ignored,
        "timeout": .rejected,
        "retryDue": .moves(to: .connecting(hasStreamed: true), effects: continuedAttempt)
    ]

    private static var matrix: [LinkState: [String: Expected]] {
        [
            .disconnected(hasStreamed: false, wantsLink: false):
                rowForDisconnected(hasStreamed: false, wantsLink: false),
            .disconnected(hasStreamed: false, wantsLink: true):
                rowForDisconnected(hasStreamed: false, wantsLink: true),
            .disconnected(hasStreamed: true, wantsLink: true):
                rowForDisconnected(hasStreamed: true, wantsLink: true),
            .connecting(hasStreamed: false): rowForConnecting(hasStreamed: false),
            .connecting(hasStreamed: true): rowForConnecting(hasStreamed: true),
            .connected(hasStreamed: false): rowForConnected(hasStreamed: false),
            .connected(hasStreamed: true): rowForConnected(hasStreamed: true),
            .streaming: streamingRow,
            .recovering: recoveringRow
        ]
    }

    /// Drives a fresh machine into one state, by the shortest path that reaches
    /// it. Every has-streamed state goes through `streaming` first, because
    /// that is the only way the flag is ever set.
    private func machine(in state: LinkState) -> BLELinkMachine {
        var machine = BLELinkMachine()
        if state.hasStreamed {
            for event in [LinkEvent.start, .peripheralConnected, .servicesResolved,
                          .notificationsEnabled] {
                _ = machine.apply(event)
            }
        }
        switch state.phase {
        case .disconnected:
            reachDisconnected(&machine, state)
        case .connecting:
            reachAttempting(&machine, state)
        case .connected:
            reachAttempting(&machine, state)
            _ = machine.apply(.peripheralConnected)
        case .streaming:
            break
        case .recovering:
            _ = machine.apply(.linkLost)
        }
        XCTAssertEqual(machine.state, state, "the setup path did not reach \(state)")
        return machine
    }

    /// Losing the radio preserves both flags where stopping clears them, so
    /// the wanted-but-disconnected states are only reachable the first way.
    private func reachDisconnected(_ machine: inout BLELinkMachine, _ state: LinkState) {
        guard state.wantsLink else { return }
        if !state.hasStreamed { _ = machine.apply(.start) }
        _ = machine.apply(.radioUnavailable(.poweredOff))
    }

    /// A fresh attempt, or the retry that follows a lost stream.
    private func reachAttempting(_ machine: inout BLELinkMachine, _ state: LinkState) {
        if state.hasStreamed {
            _ = machine.apply(.linkLost)
            _ = machine.apply(.retryDue)
        } else {
            _ = machine.apply(.start)
        }
    }

    /// Substitutes the entry attempt into any backoff placeholder.
    private func resolve(_ effects: [LinkEffect], entryAttempt: Int) -> [LinkEffect] {
        effects.map { effect in
            effect == Self.backoffForEntryAttempt
                ? .scheduleRetry(afterMs: LinkTiming.retryDelayMs(forAttempt: entryAttempt))
                : effect
        }
    }

    func testEveryStateAndEventPairBehavesAsTheTableSays() {
        for state in LinkState.allCases {
            guard let row = Self.matrix[state] else {
                XCTFail("no matrix row for \(state)")
                continue
            }
            for event in LinkEvent.allKinds {
                guard let expected = row[event.kind] else {
                    XCTFail("no matrix cell for \(state) + \(event.kind)")
                    continue
                }
                var subject = machine(in: state)
                let entryAttempt = subject.attempt
                let outcome = subject.apply(event)
                let cell = "\(state) + \(event.kind)"

                switch (expected, outcome) {
                case let (.moves(to, effects), .moved(_, actual, actualEffects)):
                    XCTAssertEqual(actual, to, cell)
                    XCTAssertEqual(
                        actualEffects,
                        resolve(effects, entryAttempt: entryAttempt),
                        "\(cell): effects"
                    )
                case (.ignored, .ignored):
                    XCTAssertEqual(subject.state, state, "\(cell) moved anyway")
                case (.rejected, .rejected):
                    XCTAssertEqual(subject.state, state, "\(cell) moved anyway")
                default:
                    XCTFail("\(cell): expected \(expected), got \(outcome)")
                }
            }
        }
    }

    /// The table is only exhaustive if the two lists it iterates are. A new
    /// `LinkEvent` case breaks the compile at `LinkEvent.kind`; a new
    /// `LinkState` case breaks it at `phase`. These catch the other half — a
    /// case added to those switches and forgotten in `allCases` / `allKinds`.
    func testTheStateAndEventListsCoverEveryCaseAndTheMatrixCoversEveryCell() {
        XCTAssertEqual(LinkEvent.allKinds.count, 11, "an event was added or removed")
        XCTAssertEqual(LinkState.allCases.count, 9, "a state was added or removed")
        XCTAssertEqual(
            Set(LinkState.allCases.map(\.phase)),
            Set(LinkPhase.allCases),
            "every phase must appear in allCases"
        )
        XCTAssertEqual(Set(Self.matrix.keys), Set(LinkState.allCases))
        for (state, row) in Self.matrix {
            XCTAssertEqual(
                Set(row.keys),
                Set(LinkEvent.allKinds.map(\.kind)),
                "the \(state) row is not a full row"
            )
        }
        XCTAssertEqual(Self.matrix.count * LinkEvent.allKinds.count, 99, "the cell count moved")
    }

    /// Three combinations are unrepresentable rather than merely unused, and
    /// the type is what enforces it: `streaming` and `recovering` have no
    /// never-streamed form, and a link that has streamed is one somebody asked
    /// for, so there is no has-streamed-but-unwanted state to write down.
    func testTheImpossibleStatesAreUnrepresentable() {
        for state in LinkState.allCases where !state.hasStreamed {
            XCTAssertNotEqual(state.phase, .streaming)
            XCTAssertNotEqual(state.phase, .recovering)
        }
        for state in LinkState.allCases where state.hasStreamed {
            XCTAssertTrue(state.wantsLink, "\(state) has streamed but is unwanted")
        }
        XCTAssertTrue(LinkState.streaming.hasStreamed)
        XCTAssertTrue(LinkState.recovering.hasStreamed)
    }

    /// Rejection is a distinct outcome, not a silent no-op. If these collapsed
    /// into each other the matrix would still pass while the driver lost its
    /// only signal that the radio did something impossible.
    func testRejectedAndIgnoredAreNotTheSameOutcome() {
        var machine = BLELinkMachine()
        XCTAssertEqual(machine.apply(.stop), .ignored(.stop, in: Self.stopped))
        XCTAssertEqual(
            machine.apply(.notificationsEnabled),
            .rejected(.notificationsEnabled, in: Self.stopped)
        )
    }
}
