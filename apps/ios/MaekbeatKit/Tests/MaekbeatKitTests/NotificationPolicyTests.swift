import XCTest
@testable import MaekbeatKit

/*
 * Which alerts become notifications, and which do not.
 *
 * The case that matters most is the one the client would get wrong on its own:
 * a reconnect re-reads the alert history and the fan-out replays transitions,
 * so a phone that notifies on every alert it receives notifies again every time
 * the socket blinks. The server did nothing wrong in that story — one raise per
 * episode is a C7 guarantee — and the caregiver is buried anyway.
 */
final class NotificationPolicyTests: XCTestCase {
    private func alert(
        _ alertId: String = "sim-001:spo2-low:1",
        state: AlertState = .raised,
        deviceId: String = "sim-001",
        raisedAtMs: Int = 1_754_265_640_000
    ) -> AlertEvent {
        AlertEvent(
            alertId: alertId,
            deviceId: deviceId,
            metric: .spo2Pct,
            direction: .low,
            state: state,
            raisedAtMs: raisedAtMs,
            resolvedAtMs: state == .resolved ? raisedAtMs + 53_000 : nil,
            windowStats: AlertWindowStats(
                windowMs: 15_000,
                sampleCount: 12,
                breachCount: 5,
                minValue: 87.5,
                maxValue: 91.2
            )
        )
    }

    private func notification(_ effect: NotificationPolicy.Effect) -> CaregiverNotification? {
        guard case let .notify(notification) = effect else { return nil }
        return notification
    }

    // MARK: - One episode, one notification

    func testARaisedAlertNotifiesOnce() {
        var policy = NotificationPolicy()
        let first = policy.consider(alert(), decided: false, authorization: .authorized)

        XCTAssertEqual(notification(first)?.alertId, "sim-001:spo2-low:1")
        XCTAssertEqual(
            notification(first)?.identifier,
            "sim-001:spo2-low:1",
            "the identifier is the alertId, so a re-schedule replaces"
        )
    }

    /// The bug class, staged: the socket drops, the client re-reads the alert
    /// history, and every raised episode arrives again.
    func testAReconnectThatReplaysTheHistoryNotifiesNothingTwice() {
        var policy = NotificationPolicy()
        let episodes = (1...5).map {
            alert("sim-001:spo2-low:\($0)", raisedAtMs: 1_754_265_640_000 + $0)
        }

        for episode in episodes {
            let effect = policy.consider(episode, decided: false, authorization: .authorized)
            XCTAssertNotNil(notification(effect))
        }

        // Three reconnects, each replaying the whole history.
        var replays: [NotificationPolicy.Effect] = []
        for _ in 0..<3 {
            for episode in episodes {
                replays.append(policy.consider(episode, decided: false, authorization: .authorized))
            }
        }

        XCTAssertEqual(replays.count, 15)
        XCTAssertTrue(
            replays.allSatisfy { $0 == .suppressed(.alreadyNotified) },
            "a replayed episode must not notify again"
        )
        XCTAssertEqual(policy.notified.count, 5)
    }

    /// The case that had to come back from an integration test.
    ///
    /// A cold launch during a breach reads the alert list and gets `ongoing`,
    /// because apps/server mutates the stored alert on the second breaching
    /// sample and never re-reports the `raised`. Keying the notify decision on
    /// `raised` therefore left the loudest moment silent: an episode running
    /// right now, on a phone that has never heard of it. Nothing in this file
    /// noticed, because every test here starts from a `raised` — the hole was
    /// in what the suite assumed the server would say, not in its logic.
    func testAnOpenEpisodeFirstSeenAsOngoingStillNotifies() {
        var policy = NotificationPolicy()

        let effect = policy.consider(alert(state: .ongoing), decided: false, authorization: .authorized)

        XCTAssertEqual(
            notification(effect)?.alertId,
            "sim-001:spo2-low:1",
            "a live episode the phone has not seen is news, however it arrived"
        )
        XCTAssertEqual(policy.notified, ["sim-001:spo2-low:1"])
    }

    /// And it is still one banner: arriving as `ongoing` first does not make
    /// the later `raised` replay a second episode.
    func testAnOngoingFirstThenAReplayedRaiseIsStillOneNotification() {
        var policy = NotificationPolicy()
        _ = policy.consider(alert(state: .ongoing), decided: false, authorization: .authorized)

        let replayedRaise = policy.consider(alert(), decided: false, authorization: .authorized)

        XCTAssertEqual(replayedRaise, .suppressed(.alreadyNotified))
    }

    /// `ongoing` for an episode already notified is the same episode still
    /// running. The engine emits it as a lifecycle transition, not as news.
    ///
    /// The two suppression reasons stay apart deliberately, because the
    /// counters mean different things on screen: `notANewEpisode` is the
    /// episode simply lasting, and `alreadyNotified` is the dedupe catching a
    /// replayed raise. Collapsing them would hide whether a reconnect storm was
    /// happening.
    func testAnOngoingTransitionIsNotANewEpisodeRatherThanADuplicate() {
        var policy = NotificationPolicy()
        _ = policy.consider(alert(), decided: false, authorization: .authorized)

        let ongoing = policy.consider(alert(state: .ongoing), decided: false, authorization: .authorized)
        let replayedRaise = policy.consider(alert(), decided: false, authorization: .authorized)

        XCTAssertEqual(ongoing, .suppressed(.notANewEpisode))
        XCTAssertEqual(replayedRaise, .suppressed(.alreadyNotified))
    }

    func testTwoDifferentEpisodesEachNotify() {
        var policy = NotificationPolicy()
        let first = policy.consider(alert("sim-001:spo2-low:1"), decided: false, authorization: .authorized)
        let second = policy.consider(alert("sim-001:hr-high:2"), decided: false, authorization: .authorized)

        XCTAssertNotNil(notification(first))
        XCTAssertNotNil(notification(second))
        XCTAssertNotEqual(notification(first)?.identifier, notification(second)?.identifier)
    }

    // MARK: - The owner state, and what leaving it cancels

    /// C15's invariant, applied to a banner: the notification's owner is the
    /// open episode, and an episode that resolves takes it back.
    func testAResolvedEpisodeWithdrawsTheNotificationItScheduled() {
        var policy = NotificationPolicy()
        _ = policy.consider(alert(), decided: false, authorization: .authorized)

        let resolved = policy.consider(alert(state: .resolved), decided: false, authorization: .authorized)
        XCTAssertEqual(resolved, .withdraw(alertId: "sim-001:spo2-low:1"))
    }

    /// Somebody acknowledged it on the dashboard. The phone should not still be
    /// asking a second person to handle it.
    func testADecisionAnywhereWithdrawsTheNotification() {
        var policy = NotificationPolicy()
        _ = policy.consider(alert(), decided: false, authorization: .authorized)

        XCTAssertEqual(
            policy.decisionRecorded(alertId: "sim-001:spo2-low:1"),
            .withdraw(alertId: "sim-001:spo2-low:1")
        )
    }

    /// A resolved episode replayed after the withdraw must not come back — the
    /// case the `closed` set exists for.
    func testAReplayAfterResolutionDoesNotResurrectTheBanner() {
        var policy = NotificationPolicy()
        _ = policy.consider(alert(), decided: false, authorization: .authorized)
        _ = policy.consider(alert(state: .resolved), decided: false, authorization: .authorized)

        let replayedRaise = policy.consider(alert(), decided: false, authorization: .authorized)
        let replayedResolve = policy.consider(
            alert(state: .resolved),
            decided: false,
            authorization: .authorized
        )

        XCTAssertEqual(replayedRaise, .suppressed(.alreadyDecided))
        XCTAssertEqual(replayedResolve, .suppressed(.notANewEpisode))
    }

    /// An alert that was already decided before this app ever saw it — the REST
    /// seed after a cold start — is history, not an interruption.
    func testAnAlreadyDecidedAlertInTheSeedNeverNotifies() {
        var policy = NotificationPolicy()
        let effect = policy.consider(alert(), decided: true, authorization: .authorized)

        XCTAssertEqual(effect, .suppressed(.alreadyDecided))
        XCTAssertTrue(policy.notified.isEmpty)
    }

    /// Withdrawing twice is not two withdrawals. The second is a no-op with a
    /// reason, so the counter on screen counts banners taken back rather than
    /// times the code was asked.
    func testWithdrawIsIdempotent() {
        var policy = NotificationPolicy()
        _ = policy.consider(alert(), decided: false, authorization: .authorized)
        _ = policy.decisionRecorded(alertId: "sim-001:spo2-low:1")

        XCTAssertEqual(
            policy.decisionRecorded(alertId: "sim-001:spo2-low:1"),
            .suppressed(.alreadyDecided)
        )
    }

    /// A decision on an episode this phone never notified about — the dashboard
    /// handled one that arrived while the app was closed — withdraws nothing.
    func testADecisionOnAnUnnotifiedEpisodeWithdrawsNothing() {
        var policy = NotificationPolicy()
        XCTAssertEqual(
            policy.decisionRecorded(alertId: "sim-001:spo2-low:9"),
            .suppressed(.alreadyDecided)
        )
    }

    // MARK: - Authorization

    func testNothingIsScheduledWhileNotificationsAreNotAllowed() {
        for authorization in NotificationAuthorization.allCases where !authorization.canDeliver {
            var policy = NotificationPolicy()
            let effect = policy.consider(alert(), decided: false, authorization: authorization)

            XCTAssertEqual(effect, .suppressed(.notAuthorized), "\(authorization)")
            XCTAssertTrue(policy.notified.isEmpty, "\(authorization) must not mark it notified")
        }
    }

    /// Provisional authorization delivers quietly, so it delivers.
    func testProvisionalAuthorizationStillNotifies() {
        var policy = NotificationPolicy()
        XCTAssertNotNil(
            notification(policy.consider(alert(), decided: false, authorization: .provisional))
        )
    }

    /// Granting after a refusal must not leave the episode marked as notified —
    /// a suppression is not a delivery, and the caregiver has seen nothing.
    func testAnEpisodeSuppressedForPermissionNotifiesOnceItIsGranted() {
        var policy = NotificationPolicy()
        XCTAssertEqual(
            policy.consider(alert(), decided: false, authorization: .denied),
            .suppressed(.notAuthorized)
        )

        XCTAssertNotNil(
            notification(policy.consider(alert(), decided: false, authorization: .authorized)),
            "the caregiver never saw it, so the grant is its first chance"
        )
    }

    func testOnlyAuthorizedAndProvisionalCanDeliver() {
        XCTAssertEqual(
            NotificationAuthorization.allCases.filter(\.canDeliver),
            [.authorized, .provisional]
        )
    }
}
