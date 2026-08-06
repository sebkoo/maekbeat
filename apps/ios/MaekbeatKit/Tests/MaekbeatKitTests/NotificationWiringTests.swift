import XCTest
@testable import MaekbeatKit

/*
 * That the circuit is connected, not merely correct.
 *
 * C12a's lesson, one language over: the whole retention feature was right and
 * could be left unwired in `buildApp` with every unit test green, which is why
 * apps/server has a composition test. The same hole exists here — a policy that
 * dedupes perfectly and a coordinator nothing calls would pass every other file
 * in this directory.
 *
 * So these drive `DeviceDetailModel`, the thing the app actually runs, and
 * assert what came out of the notification centre at the far end.
 */
@MainActor
final class NotificationWiringTests: XCTestCase {
    private static let alertsPage = Data("""
    {"deviceId":"sim-001","counters":{"raised":1,"resolved":0,"suppressed":0,\
    "acknowledged":0,"dismissed":0},"alerts":[{"alertId":"sim-001:spo2-low:1",\
    "deviceId":"sim-001","metric":"spo2Pct","direction":"low","state":"raised",\
    "raisedAtMs":1754265640000,"windowStats":{"windowMs":15000,"sampleCount":12,\
    "breachCount":5,"minValue":87.5,"maxValue":91.2}}],"decisions":[]}
    """.utf8)

    private static let emptyPage = Data("""
    {"deviceId":"sim-001","counters":{"raised":0,"resolved":0,"suppressed":0,\
    "acknowledged":0,"dismissed":0},"alerts":[],"decisions":[]}
    """.utf8)

    /// What `GET /devices/sim-001/alerts` actually returns during a breach:
    /// the stored alert has already been mutated to `ongoing`. Written from the
    /// shape the real server produced in GatewayIntegrationTests rather than
    /// from what this suite assumed it would.
    private static let ongoingPage = Data("""
    {"deviceId":"sim-001","counters":{"raised":1,"resolved":0,"suppressed":0,\
    "acknowledged":0,"dismissed":0},"alerts":[{"alertId":"sim-001:spo2-low:1",\
    "deviceId":"sim-001","metric":"spo2Pct","direction":"low","state":"ongoing",\
    "raisedAtMs":1754265640000,"windowStats":{"windowMs":15000,"sampleCount":12,\
    "breachCount":5,"minValue":87.5,"maxValue":91.2}}],"decisions":[]}
    """.utf8)

    private static let decidedPage = Data("""
    {"deviceId":"sim-001","counters":{"raised":1,"resolved":0,"suppressed":0,\
    "acknowledged":1,"dismissed":0},"alerts":[{"alertId":"sim-001:spo2-low:1",\
    "deviceId":"sim-001","metric":"spo2Pct","direction":"low","state":"raised",\
    "raisedAtMs":1754265640000,"windowStats":{"windowMs":15000,"sampleCount":12,\
    "breachCount":5,"minValue":87.5,"maxValue":91.2}}],\
    "decisions":[{"eventId":"sim-001:decision:1","alertId":"sim-001:spo2-low:1",\
    "deviceId":"sim-001","decision":"acknowledged","actor":"web-dashboard",\
    "recordedAtMs":1754265700000}]}
    """.utf8)

    private struct Rig {
        let model: DeviceDetailModel
        let coordinator: NotificationCoordinator
        let port: FakeNotificationPort
        let transport: FakeTransport
    }

    private func makeRig(alertsPage: Data) async -> Rig {
        let port = FakeNotificationPort()
        let stub = StubHTTP(answers: [(Wire.framesPage([]), 200), (alertsPage, 200)])
        let coordinator = NotificationCoordinator(port: port, client: stub.client)
        await coordinator.refreshAuthorization()
        let transport = FakeTransport()
        let model = DeviceDetailModel(
            deviceId: "sim-001",
            client: stub.client,
            notifications: coordinator,
            createSocket: transport.factory,
            schedule: transport.scheduler
        )
        return Rig(model: model, coordinator: coordinator, port: port, transport: transport)
    }

    /// An alert arriving on the fan-out socket reaches the notification centre.
    /// Without this the policy could be perfect and never consulted.
    func testAnAlertOnTheSocketReachesTheNotificationCentre() async {
        let rig = await makeRig(alertsPage: Self.emptyPage)
        await rig.model.load()
        rig.model.connect()
        rig.transport.latest?.open()

        rig.transport.latest?.deliver(Wire.alertMessage())

        XCTAssertEqual(rig.port.scheduled.count, 1)
        XCTAssertEqual(rig.port.scheduled.first?.alertId, "sim-001:spo2-low:1")
        rig.model.disconnect()
    }

    /// The seed read is offered to the policy too, because after a reconnect it
    /// is history the phone has already notified about.
    func testTheRestSeedGoesThroughThePolicyRatherThanAroundIt() async {
        let rig = await makeRig(alertsPage: Self.alertsPage)

        await rig.model.load()

        XCTAssertEqual(rig.port.scheduled.count, 1, "the seed's open episode notified once")
    }

    /// The whole bug class, through the object the app runs: a seed, a socket
    /// replay of the same episode, and a second seed after a reconnect.
    func testASeedThenAReplayThenAnotherSeedLeavesOneBanner() async {
        let rig = await makeRig(alertsPage: Self.alertsPage)
        await rig.model.load()
        rig.model.connect()
        rig.transport.latest?.open()

        rig.transport.latest?.deliver(Wire.alertMessage())
        rig.transport.latest?.deliver(Wire.alertMessage(state: "ongoing"))

        XCTAssertEqual(rig.port.scheduled.count, 1)
        XCTAssertEqual(rig.port.standing, ["sim-001:spo2-low:1"])
        XCTAssertEqual(rig.coordinator.suppressed(.alreadyNotified), 1)
        XCTAssertEqual(rig.coordinator.suppressed(.notANewEpisode), 1)
        rig.model.disconnect()
    }

    /// A cold launch in the middle of a breach. The seed is the only thing the
    /// app has heard, and what it says is `ongoing`.
    func testALaunchDuringALiveEpisodeNotifiesFromTheSeedAlone() async {
        let rig = await makeRig(alertsPage: Self.ongoingPage)

        await rig.model.load()

        XCTAssertEqual(rig.port.scheduled.count, 1, "the live episode reached the caregiver")
        XCTAssertEqual(rig.port.standing, ["sim-001:spo2-low:1"])
    }

    /// An episode the dashboard already judged, present in the seed, must not
    /// interrupt anybody.
    func testAnAlreadyDecidedEpisodeInTheSeedNotifiesNobody() async {
        let rig = await makeRig(alertsPage: Self.decidedPage)

        await rig.model.load()

        XCTAssertEqual(rig.port.scheduled, [])
        XCTAssertEqual(rig.coordinator.suppressed(.alreadyDecided), 1)
    }

    /// A decision arriving over the fan-out — somebody acknowledged it on the
    /// dashboard — takes the phone's banner back.
    func testADecisionOnTheSocketWithdrawsTheBanner() async {
        let rig = await makeRig(alertsPage: Self.alertsPage)
        await rig.model.load()
        rig.model.connect()
        rig.transport.latest?.open()
        XCTAssertEqual(rig.port.standing.count, 1)

        rig.transport.latest?.deliver(Wire.decisionMessage())

        XCTAssertEqual(rig.port.withdrawn, ["sim-001:spo2-low:1"])
        XCTAssertTrue(rig.port.standing.isEmpty)
        rig.model.disconnect()
    }

    /// And the model still works with no coordinator at all — the device screen
    /// is useful without notifications, and the optional must stay optional.
    func testTheDeviceScreenWorksWithoutACoordinator() async {
        let stub = StubHTTP(answers: [(Wire.framesPage([]), 200), (Self.alertsPage, 200)])
        let model = DeviceDetailModel(deviceId: "sim-001", client: stub.client)

        await model.load()

        XCTAssertEqual(model.alerts.count, 1)
    }
}
