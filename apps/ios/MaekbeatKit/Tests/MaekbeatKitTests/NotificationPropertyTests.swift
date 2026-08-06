import Foundation
import XCTest
@testable import MaekbeatKit

/*
 * Dedupe under random reconnect and replay interleavings.
 *
 * `NotificationPolicyTests` walks the cases a person can think of: a raise, a
 * replay, a resolve, a decision from elsewhere. The bug C16 was designed
 * against is not any one of those — it is a *sequence*, and the sequences that
 * matter are the ones nobody staged. A reconnect re-reads the alert history
 * over REST while the fan-out is already replaying transitions, so the same
 * episode arrives twice from two directions with a decision possibly landing in
 * between. The C16 integration test found one such ordering by accident; this
 * file looks for the rest on purpose.
 *
 * Seeded, fixed-length, deterministic: six seeds, four hundred steps, six
 * episodes, and every failure names the seed and the step.
 *
 * The properties are the promises apps/ios/README.md makes about notifications,
 * written as invariants rather than as examples:
 *
 *   1. One episode, one banner — ever, not merely at a time.
 *   2. A closed episode stays closed: nothing standing after a resolution or a
 *      decision, from any client, in any order.
 *   3. A withdrawn banner never comes back, and nothing is withdrawn that was
 *      never scheduled.
 *   4. Every effect is accounted for: delivered + withdrawn + suppressed equals
 *      the number of things the coordinator was asked to judge. A suppression
 *      that goes uncounted is the alarm-fatigue argument losing its evidence.
 */
@MainActor
final class NotificationPropertyTests: XCTestCase {
    private static let seeds: [UInt64] = [3, 11, 29, 512, 8_191, 1_754_265]
    private static let steps = 400
    private static let episodes = 6

    /// What the test believes about an episode, kept beside the policy rather
    /// than derived from it — an oracle that reads the thing under test proves
    /// only that it is self-consistent.
    private struct Episode {
        var isResolved = false
        var isDecided = false
        var everSeen = false
        var isClosed = false
    }

    /// One run's mutable world, so the step function can stay under the
    /// complexity the linter allows and still read as one story.
    private struct Run {
        var model: [Episode]
        var judgements = 0
    }

    // MARK: - One episode, one banner

    func testOneEpisodeNeverProducesTwoBannersUnderAnyInterleaving() async throws {
        for seed in Self.seeds {
            var random = SeededGenerator(seed: seed)
            let centre = FakeNotificationPort()
            centre.authorization = .authorized
            let coordinator = NotificationCoordinator(port: centre, client: Self.acceptingClient())
            await coordinator.refreshAuthorization()

            var run = Run(model: Array(repeating: Episode(), count: Self.episodes))

            for step in 0..<Self.steps {
                await advance(&run, &random, coordinator, centre)
                assertInvariants(run, centre, coordinator, "seed \(seed), step \(step)")
            }

            assertRunProvedSomething(run, centre, coordinator, "seed \(seed)")
        }
    }

    /// One interleaving step: a fan-out message, a resolution, a decision from
    /// another client, an answer on this phone, or a reconnect that re-seeds
    /// everything at once.
    private func advance(
        _ run: inout Run,
        _ random: inout SeededGenerator,
        _ coordinator: NotificationCoordinator,
        _ centre: FakeNotificationPort
    ) async {
        let index = Int.random(in: 0..<Self.episodes, using: &random)

        switch Int.random(in: 0..<10, using: &random) {
        case 0...3:
            // The fan-out repeating itself: `raised` on a first sight, `ongoing`
            // on every later sample, and either can arrive again after a
            // reconnect replays the transition.
            let arriving: AlertState = run.model[index].everSeen ? .ongoing : .raised
            run.model[index].everSeen = true
            offer(index, run.model[index].isResolved ? .resolved : arriving, &run, coordinator)

        case 4:
            run.model[index].isResolved = true
            run.model[index].isClosed = true
            run.model[index].everSeen = true
            offer(index, .resolved, &run, coordinator)

        case 5:
            // A dashboard decided it, and the phone hears about it on the same
            // socket the alert came in on.
            run.model[index].isDecided = true
            run.model[index].isClosed = true
            coordinator.handleDecision(alertId: Self.alertId(index))
            run.judgements += 1

        case 6:
            // The caregiver answered the banner on this phone.
            guard let standing = centre.scheduled.last(where: {
                centre.standing.contains($0.identifier)
            }) else { return }
            let answered = Self.index(of: standing.alertId)
            run.model[answered].isDecided = true
            run.model[answered].isClosed = true
            await coordinator.act(.acknowledge, on: standing)
            run.judgements += 1

        default:
            // A reconnect: the REST seed replays every episode this run has
            // produced, which is the storm the policy exists to refuse.
            // `ongoing` because that is what a real server sends for a live
            // episode — the hole C16's integration test found.
            for seen in run.model.indices where run.model[seen].everSeen {
                offer(seen, run.model[seen].isResolved ? .resolved : .ongoing, &run, coordinator)
            }
        }
    }

    private func offer(
        _ index: Int,
        _ state: AlertState,
        _ run: inout Run,
        _ coordinator: NotificationCoordinator
    ) {
        coordinator.handle(
            Self.alert(index, state: state),
            decided: run.model[index].isDecided
        )
        run.judgements += 1
    }

    // MARK: - The invariants

    private func assertInvariants(
        _ run: Run,
        _ centre: FakeNotificationPort,
        _ coordinator: NotificationCoordinator,
        _ context: String
    ) {
        for index in run.model.indices {
            let scheduled = centre.scheduled.filter { $0.alertId == Self.alertId(index) }
            XCTAssertLessThanOrEqual(
                scheduled.count,
                1,
                "\(context): episode \(index) has been notified \(scheduled.count) times"
            )
        }

        for index in run.model.indices where run.model[index].isClosed {
            XCTAssertFalse(
                centre.standing.contains(Self.alertId(index)),
                "\(context): episode \(index) is closed and still has a banner standing"
            )
        }

        let suppressed = NotificationPolicy.Suppression.allCases
            .reduce(0) { $0 + coordinator.suppressed($1) }
        XCTAssertEqual(
            coordinator.delivered + coordinator.withdrawn + suppressed,
            run.judgements,
            "\(context): \(run.judgements) judgements did not produce that many effects"
        )
    }

    /// A property suite that never reached the interesting states passes for the
    /// wrong reason, so the run has to show it did the work.
    private func assertRunProvedSomething(
        _ run: Run,
        _ centre: FakeNotificationPort,
        _ coordinator: NotificationCoordinator,
        _ context: String
    ) {
        for id in centre.withdrawn {
            XCTAssertTrue(
                centre.scheduled.contains { $0.identifier == id },
                "\(context): withdrew \(id), which was never scheduled"
            )
        }
        XCTAssertEqual(coordinator.delivered, centre.scheduled.count, context)
        XCTAssertEqual(coordinator.withdrawn, centre.withdrawn.count, context)
        XCTAssertGreaterThan(
            coordinator.delivered,
            0,
            "\(context): nothing was ever delivered, so nothing was proved"
        )
        XCTAssertGreaterThan(
            coordinator.suppressed(.alreadyNotified) + coordinator.suppressed(.notANewEpisode),
            0,
            "\(context): no repeat was ever refused, so nothing was proved"
        )
    }

    // MARK: - The permission is refused

    /// The same interleavings with the permission refused. Nothing may be
    /// scheduled, every refusal is counted under the reason that names it, and
    /// granting the permission later must still notify the episodes that are
    /// open and unseen — a denied user who changes their mind is not owed
    /// silence for the rest of the run.
    func testARefusedPermissionSchedulesNothingAndCountsEveryRefusal() async {
        for seed in Self.seeds {
            var random = SeededGenerator(seed: seed)
            let centre = FakeNotificationPort()
            centre.authorization = .denied
            let coordinator = NotificationCoordinator(port: centre, client: Self.acceptingClient())
            await coordinator.refreshAuthorization()

            // An `alertId` names one breach episode for its whole life (C7), so a
            // resolved episode never reopens under it — the server mints a new id
            // for the next breach. `resolved` is therefore sticky here, and
            // getting that wrong is what the first run of this test did: it
            // replayed `ongoing` after a resolution and then blamed the policy
            // for refusing to resurrect a closed episode.
            var resolved: Set<Int> = []
            var openAndUnseen: Set<Int> = []
            for step in 0..<Self.steps / 2 {
                let index = Int.random(in: 0..<Self.episodes, using: &random)
                let closing = Int.random(in: 0..<8, using: &random) == 0
                if closing || resolved.contains(index) {
                    resolved.insert(index)
                    openAndUnseen.remove(index)
                    coordinator.handle(Self.alert(index, state: .resolved), decided: false)
                } else {
                    openAndUnseen.insert(index)
                    coordinator.handle(Self.alert(index, state: .ongoing), decided: false)
                }
                XCTAssertTrue(
                    centre.scheduled.isEmpty,
                    "seed \(seed), step \(step): a banner was scheduled while denied"
                )
            }

            XCTAssertEqual(coordinator.delivered, 0, "seed \(seed)")
            XCTAssertGreaterThan(
                coordinator.suppressed(.notAuthorized),
                0,
                "seed \(seed): the refusals were not counted"
            )

            // The user relents. Every episode still open and never seen must now
            // reach them; the ones already resolved must not.
            centre.authorization = .authorized
            await coordinator.refreshAuthorization()
            for index in openAndUnseen.sorted() {
                coordinator.handle(Self.alert(index, state: .ongoing), decided: false)
            }

            XCTAssertEqual(
                Set(centre.scheduled.map(\.alertId)),
                Set(openAndUnseen.map(Self.alertId)),
                "seed \(seed): granting the permission notified the wrong set of episodes"
            )
        }
    }

    // MARK: - Fixtures

    private static func alertId(_ index: Int) -> String { "sim-001:spo2-low:\(index)" }

    private static func index(of alertId: String) -> Int {
        Int(alertId.split(separator: ":").last ?? "0") ?? 0
    }

    private static func alert(_ index: Int, state: AlertState) -> AlertEvent {
        AlertEvent(
            alertId: alertId(index),
            deviceId: "sim-001",
            metric: .spo2Pct,
            direction: .low,
            state: state,
            raisedAtMs: 1_754_265_640_000 + index * 1_000,
            resolvedAtMs: state == .resolved ? 1_754_265_693_000 + index * 1_000 : nil,
            windowStats: AlertWindowStats(
                windowMs: 15_000,
                sampleCount: 12,
                breachCount: 5,
                minValue: 87.5,
                maxValue: 91.2
            )
        )
    }

    /// A server that files every decision. The refusal path is
    /// `NotificationCoordinatorTests` and, against a real server that really
    /// refuses, `ServerFailureIntegrationTests`.
    private static func acceptingClient() -> APIClient {
        StubHTTP(answers: [(Data("""
        {"eventId":"sim-001:decision:1","alertId":"sim-001:spo2-low:0",\
        "deviceId":"sim-001","decision":"acknowledged","actor":"ios-gateway",\
        "recordedAtMs":1754265700000}
        """.utf8), 201)]).client
    }
}

extension NotificationPolicy.Suppression: CaseIterable {
    public static var allCases: [Self] {
        [.alreadyNotified, .notANewEpisode, .alreadyDecided, .notAuthorized]
    }
}
