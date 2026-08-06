import XCTest
@testable import MaekbeatKit

/*
 * The circuit, end to end with a fake centre and a stubbed server: alert in,
 * notification out, action taken, decision recorded.
 *
 * The leg worth the most scrutiny is the last one. A decision taken from a
 * notification has to reach the same append-only log the dashboard writes to,
 * under the same `alertId` — and the banner must not disappear until it has,
 * because a notification that vanishes on a failed request is the interface
 * claiming a record that does not exist. apps/web fixed that exact mistake at
 * C12; this is the same rule on a lock screen.
 */
@MainActor
final class NotificationCoordinatorTests: XCTestCase {
    private func alert(
        _ alertId: String = "sim-001:spo2-low:1",
        state: AlertState = .raised,
        deviceId: String = "sim-001"
    ) -> AlertEvent {
        AlertEvent(
            alertId: alertId,
            deviceId: deviceId,
            metric: .spo2Pct,
            direction: .low,
            state: state,
            raisedAtMs: 1_754_265_640_000,
            resolvedAtMs: state == .resolved ? 1_754_265_693_000 : nil,
            windowStats: AlertWindowStats(
                windowMs: 15_000,
                sampleCount: 12,
                breachCount: 5,
                minValue: 87.5,
                maxValue: 91.2
            )
        )
    }

    private nonisolated static let decisionBody = Data("""
    {"eventId":"sim-001:decision:1","alertId":"sim-001:spo2-low:1","deviceId":"sim-001",\
    "decision":"acknowledged","actor":"ios-gateway","recordedAtMs":1754265700000}
    """.utf8)

    private struct Rig {
        let coordinator: NotificationCoordinator
        let port: FakeNotificationPort
        let stub: StubHTTP
    }

    private func rig(
        authorization: NotificationAuthorization = .authorized,
        answers: [(Data, Int)] = [(decisionBody, 201)]
    ) -> Rig {
        let port = FakeNotificationPort()
        port.authorization = authorization
        let stub = StubHTTP(answers: answers)
        return Rig(
            coordinator: NotificationCoordinator(port: port, client: stub.client),
            port: port,
            stub: stub
        )
    }

    // MARK: - Alert in, notification out

    func testARaisedAlertBecomesOneScheduledNotification() async {
        let harness = rig()
        let coordinator = harness.coordinator
        let port = harness.port
        await coordinator.refreshAuthorization()

        coordinator.handle(alert(), decided: false)

        XCTAssertEqual(port.scheduled.count, 1)
        XCTAssertEqual(port.scheduled.first?.alertId, "sim-001:spo2-low:1")
        XCTAssertEqual(coordinator.delivered, 1)
    }

    /// The bug class at the level that would ship it: the socket drops, the
    /// seed replays, and the caregiver's phone stays quiet.
    func testAReconnectReplayLeavesExactlyOneStandingBanner() async {
        let harness = rig()
        let coordinator = harness.coordinator
        let port = harness.port
        await coordinator.refreshAuthorization()
        let history = (1...4).map { alert("sim-001:spo2-low:\($0)") }

        for _ in 0..<3 {
            for episode in history { coordinator.handle(episode, decided: false) }
        }

        XCTAssertEqual(port.scheduled.count, 4, "one per episode, not one per delivery")
        XCTAssertEqual(port.standing.count, 4)
        XCTAssertEqual(coordinator.suppressed(.alreadyNotified), 8)
    }

    // MARK: - The circuit's last leg

    func testAnActionRecordsTheDecisionServerSideAndThenWithdrawsTheBanner() async throws {
        let harness = rig()
        let coordinator = harness.coordinator
        let port = harness.port
        let stub = harness.stub
        await coordinator.refreshAuthorization()
        coordinator.handle(alert(), decided: false)
        let notification = try XCTUnwrap(port.scheduled.first)

        await coordinator.act(.acknowledge, on: notification)

        let url = try XCTUnwrap(stub.requested.last)
        XCTAssertEqual(
            url.path,
            "/devices/sim-001/alerts/sim-001:spo2-low:1/decisions",
            "the decision lands under the alertId the alert carried"
        )
        XCTAssertEqual(coordinator.decisionsRecorded, 1)
        XCTAssertEqual(port.withdrawn, ["sim-001:spo2-low:1"])
        XCTAssertTrue(port.standing.isEmpty)
    }

    func testDismissRecordsTheOtherDecision() async throws {
        let harness = rig(answers: [(Self.decisionBody, 201)])
        let coordinator = harness.coordinator
        let port = harness.port
        await coordinator.refreshAuthorization()
        coordinator.handle(alert(), decided: false)

        await coordinator.act(.dismiss, on: try XCTUnwrap(port.scheduled.first))

        XCTAssertEqual(coordinator.decisionsRecorded, 1)
        XCTAssertEqual(CaregiverNotification.Action.dismiss.decision, .dismissed)
    }

    /// A refused decision leaves the banner up. The caregiver has not handled
    /// anything the server knows about, and the interface must not pretend
    /// otherwise.
    func testARefusedDecisionLeavesTheBannerStanding() async throws {
        let harness = rig(answers: [
            (Data(#"{"statusCode":404,"message":"unknown alert"}"#.utf8), 404)
        ])
        let coordinator = harness.coordinator
        let port = harness.port
        await coordinator.refreshAuthorization()
        coordinator.handle(alert(), decided: false)

        await coordinator.act(.acknowledge, on: try XCTUnwrap(port.scheduled.first))

        XCTAssertEqual(coordinator.decisionFailures, 1)
        XCTAssertEqual(coordinator.decisionsRecorded, 0)
        XCTAssertEqual(port.withdrawn, [], "nothing was recorded, so nothing is handled")
        XCTAssertEqual(port.standing.count, 1)
    }

    /// Somebody acknowledged it on the dashboard; the decision arrives over the
    /// fan-out and the phone takes its banner back.
    func testADecisionFromAnotherClientWithdrawsTheBanner() async {
        let harness = rig()
        let coordinator = harness.coordinator
        let port = harness.port
        await coordinator.refreshAuthorization()
        coordinator.handle(alert(), decided: false)

        coordinator.handleDecision(alertId: "sim-001:spo2-low:1")

        XCTAssertEqual(port.withdrawn, ["sim-001:spo2-low:1"])
        XCTAssertEqual(coordinator.withdrawn, 1)
    }

    func testAResolvedEpisodeTakesItsBannerBack() async {
        let harness = rig()
        let coordinator = harness.coordinator
        let port = harness.port
        await coordinator.refreshAuthorization()
        coordinator.handle(alert(), decided: false)

        coordinator.handle(alert(state: .resolved), decided: false)

        XCTAssertEqual(port.withdrawn, ["sim-001:spo2-low:1"])
        XCTAssertTrue(port.standing.isEmpty)
    }

    // MARK: - Permission

    func testNothingIsScheduledWhileDeniedAndTheReasonIsCounted() async {
        let harness = rig(authorization: .denied)
        let coordinator = harness.coordinator
        let port = harness.port
        await coordinator.refreshAuthorization()

        coordinator.handle(alert(), decided: false)

        XCTAssertEqual(port.scheduled, [])
        XCTAssertEqual(coordinator.authorization, .denied)
        XCTAssertEqual(coordinator.suppressed(.notAuthorized), 1)
        XCTAssertEqual(coordinator.delivered, 0)
    }

    /// `prepare()` registers the actions and reads the permission — and does
    /// not ask. A category that is never registered gives the caregiver a
    /// banner with no buttons, which is an alert they can read and cannot
    /// answer; a prompt at launch is asked before the sentence explaining it.
    func testPreparingRegistersTheActionsAndReadsThePermissionWithoutAsking() async {
        let harness = rig(authorization: .authorized)
        let coordinator = harness.coordinator
        let port = harness.port

        await coordinator.prepare()

        XCTAssertEqual(port.categoryRegistrations, 1)
        XCTAssertEqual(coordinator.authorization, .authorized)
        XCTAssertEqual(port.prompts, 0, "the ask belongs to the button, not to launch")
    }

    /// It runs on every appearance, so a permission revoked while the app was
    /// away is picked up rather than remembered wrongly.
    func testPreparingAgainPicksUpAPermissionChangedWhileAway() async {
        let harness = rig(authorization: .authorized)
        let coordinator = harness.coordinator
        let port = harness.port
        await coordinator.prepare()

        port.authorization = .denied
        await coordinator.prepare()

        XCTAssertEqual(coordinator.authorization, .denied)
        XCTAssertEqual(port.categoryRegistrations, 2)
    }

    /// The port `live()` falls back to where the framework does not exist. It
    /// refuses rather than pretends: reporting `notDetermined` makes the policy
    /// suppress and the screen say so, where a port claiming `authorized` would
    /// have the interface reporting coverage that could not exist.
    func testTheInertPortRefusesRatherThanPretending() async {
        let port = InertNotificationPort()
        let coordinator = NotificationCoordinator(port: port, client: StubHTTP().client)

        await coordinator.prepare()
        coordinator.handle(alert(), decided: false)
        await coordinator.requestAuthorization()

        XCTAssertEqual(coordinator.authorization, .notDetermined)
        XCTAssertFalse(coordinator.authorization.canDeliver)
        XCTAssertEqual(coordinator.suppressed(.notAuthorized), 1)
        XCTAssertEqual(coordinator.delivered, 0)
        port.withdraw(alertId: "sim-001:spo2-low:1")
    }

    func testAskingOnceRecordsWhatTheUserChose() async {
        let harness = rig(authorization: .notDetermined)
        let coordinator = harness.coordinator
        let port = harness.port
        port.promptAnswer = .authorized

        await coordinator.requestAuthorization()

        XCTAssertEqual(port.prompts, 1)
        XCTAssertEqual(coordinator.authorization, .authorized)
    }

    /// The user can revoke in Settings while the app is away. A coordinator
    /// that kept its old answer would keep claiming coverage it has lost.
    func testRevokingInSettingsIsPickedUpOnTheNextRefresh() async {
        let harness = rig(authorization: .authorized)
        let coordinator = harness.coordinator
        let port = harness.port
        await coordinator.refreshAuthorization()
        XCTAssertTrue(coordinator.authorization.canDeliver)

        port.authorization = .denied
        await coordinator.refreshAuthorization()

        coordinator.handle(alert(), decided: false)
        XCTAssertEqual(coordinator.authorization, .denied)
        XCTAssertEqual(port.scheduled, [])
    }
}
