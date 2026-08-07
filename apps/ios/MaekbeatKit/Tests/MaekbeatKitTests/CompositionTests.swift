#if canImport(UIKit)
import SwiftUI
import UIKit
import XCTest
@testable import MaekbeatKit

/*
 * The composition, driven rather than read.
 *
 * This phase has found the same defect five times: a unit suite proving its own
 * behaviour while nothing proved the pieces were joined. C12a's retention was
 * correct and unwired; C12's CORS was correct and never crossed an origin;
 * C14's `swift test` compiled less than it looked; C16's notify rule was right
 * about `raised` and wrong about the only path a cold launch has. Every one was
 * found by something that ran the composition instead of inspecting it.
 *
 * It found a sixth here, and the sixth is the largest. `RootView` took a
 * `GatewayModel`, rendered its state, and never called `start()` — so the
 * shipped app opened no `/ingest` socket, began no scan, and sat on
 * `disconnected(wantsLink: false)` forever, while every test in
 * `GatewayModelTests` passed because each of them calls `start()` itself. The
 * app could not have connected to anything. That is not a coverage hole: the
 * lines are covered, by callers that are not the app.
 *
 * What makes these tests possible is a fact the C16 mutation log recorded the
 * other way round — "a rendered SwiftUI view does not run its own `.task` in
 * these tests, and no assertion available here would notice a `prepare()` that
 * never fired". It does run one, given a key window and an await for it: a
 * hosted view whose window is only laid out never gets that far, which is why
 * `ViewRenderingTests` sees no tasks and why that entry was true as written.
 * `present(_:)` below is the difference, and it turns two source scans into
 * assertions about what happened.
 */
@MainActor
final class CompositionTests: XCTestCase {
    private static let screen = CGSize(width: 393, height: 852)
    private var window: UIWindow?

    override func tearDown() {
        window?.isHidden = true
        window?.rootViewController = nil
        window = nil
        super.tearDown()
    }

    /// Hosts a view in a **key** window, which is what makes SwiftUI run the
    /// `.task` modifiers on it. `ViewRenderingTests` deliberately does not do
    /// this: it asserts that each `body` evaluates, and a body that also fires
    /// its effects would make that suite depend on a server.
    private func present(_ view: some View) {
        let host = UIHostingController(rootView: view)
        let created = UIWindow(frame: CGRect(origin: .zero, size: Self.screen))
        created.rootViewController = host
        created.makeKeyAndVisible()
        created.layoutIfNeeded()
        window = created
    }

    /// Waits for the effect a `.task` produces. Polling rather than a fixed
    /// sleep: the condition is the assertion, and a test that waits for the
    /// clock instead of for the condition is the flake C13's repair removed
    /// from apps/server (docs/ai/AI_USAGE.md, 2026-08-06).
    ///
    /// The bound is wall-clock rather than 100 iterations, for the reason
    /// e5cc33d records: a 20 ms sleep does not cost 20 ms under contention, so
    /// the count read as "2 s" and bounded nothing of the sort. Measured over
    /// this file's seven waits, the device-list read being the slowest:
    ///
    ///   local idle, 10 runs, 70 waits        0.000 - 0.197 s
    ///   local 12-core load, 6 runs, 42       0.000 - 1.833 s
    ///
    /// That loaded maximum is the argument: 1.833 s against a count that read
    /// as two seconds. 30 s is about 16x it, and the multiple is a judgement
    /// rather than a measured result.
    ///
    /// It is the same 30 s e5cc33d set for the back-fill wait, and deliberately
    /// so. Both bound in-process waits on these runners, so the number is
    /// anchored on the worst inflation observed for any of them — 11.643 s, one
    /// case on a loaded CI runner — rather than on each site's own spread. That
    /// is why the multiples differ, 16x here against 96x there, and the bound
    /// does not.
    private func settle(
        until condition: () -> Bool,
        _ what: String,
        timeout: TimeInterval = 30,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("timed out waiting for \(what)", file: file, line: line)
    }

    // MARK: - Fixtures

    private struct Wired {
        let gateway: GatewayModel
        let radio: MockPeripheralPort
        let sockets: FakeIngestTransport
        let notifications: NotificationCoordinator
        let centre: FakeNotificationPort
        let client: APIClient
    }

    private func wire() -> Wired {
        let transport = FakeTransport()
        let radio = MockPeripheralPort()
        let sockets = FakeIngestTransport()
        let gateway = GatewayModel(
            driver: BLEDriver(port: radio, schedule: transport.scheduler),
            ingest: IngestClient(
                url: StubHTTP.baseURL,
                createSocket: sockets.factory,
                schedule: transport.scheduler
            )
        )
        let centre = FakeNotificationPort()
        let client = StubHTTP(answers: [(Wire.deviceList, 200)]).client
        return Wired(
            gateway: gateway,
            radio: radio,
            sockets: sockets,
            notifications: NotificationCoordinator(port: centre, client: client),
            centre: centre,
            client: client
        )
    }

    // MARK: - The root screen runs what it holds

    /// The defect this file exists for. A gateway that is rendered and never
    /// started is a phone that forwards nothing: no uplink socket, no scan, and
    /// a link screen that says `disconnected` truthfully forever.
    func testTheRootScreenStartsTheGatewayItWasGiven() async {
        let wired = wire()
        present(RootView(
            client: wired.client,
            gateway: wired.gateway,
            notifications: wired.notifications
        ))

        await settle(until: { !wired.radio.calls.isEmpty }, "the radio to be asked to scan")

        XCTAssertEqual(
            wired.radio.calls.first,
            .scanAndConnect,
            "the app must begin the scan, not merely be able to"
        )
        XCTAssertEqual(wired.sockets.sockets.count, 1, "and open the uplink socket")
        XCTAssertTrue(
            wired.gateway.link.wantsLink,
            "the link the screen reports must be one the app asked for"
        )
    }

    /// C16 registered the notification actions from this same `.task` and could
    /// only assert that the line was written. Now the assertion is that the call
    /// happened: without the actions there are no buttons on the banner, and a
    /// caregiver can read an alert but not answer it.
    func testTheRootScreenPreparesTheNotificationCentre() async {
        let wired = wire()
        wired.centre.authorization = .authorized
        present(RootView(
            client: wired.client,
            gateway: wired.gateway,
            notifications: wired.notifications
        ))

        // `prepare()` registers the categories and then awaits the permission
        // read, so waiting on the registration goes true one step before the
        // authorization below is set. Wait on the later half; it covers the
        // registration for free (e5cc33d).
        await settle(until: { wired.notifications.authorization == .authorized },
                     "the permission read that follows the registration")

        XCTAssertEqual(wired.centre.categoryRegistrations, 1)
        XCTAssertEqual(
            wired.notifications.authorization,
            .authorized,
            "and the permission is read, not assumed"
        )
        XCTAssertEqual(wired.centre.prompts, 0, "launch must not spend the one prompt there is")
    }

    // MARK: - The link screen re-reads what it renders

    /// A permission row read once at launch goes quietly wrong: the user revokes
    /// in Settings, comes back, and the screen still claims coverage. The screen
    /// that renders the row is the one that re-reads it.
    func testTheLinkScreenReReadsThePermissionOnEveryAppearance() async {
        let wired = wire()
        wired.centre.authorization = .authorized
        present(LinkStatusView(model: wired.gateway, notifications: wired.notifications))
        await settle(until: { wired.notifications.authorization == .authorized },
                     "the first read")

        // The user goes to Settings and turns it off while this screen is away.
        wired.centre.authorization = .denied
        present(LinkStatusView(model: wired.gateway, notifications: wired.notifications))

        await settle(until: { wired.notifications.authorization == .denied },
                     "the screen to notice the permission it lost")
    }

    // MARK: - The device screens run their own reads

    /// `DeviceListView` builds its own model from the client it is handed, and
    /// the read is its `.task`. Every other test in this package calls `load()`
    /// itself, so nothing before this proved the screen ever asks.
    func testTheDeviceListReadsFromItsOwnTask() async {
        let stub = StubHTTP(answers: [(Wire.deviceList, 200)])
        let model = DeviceListModel(client: stub.client)
        present(DeviceListView(model: model, client: stub.client))

        await settle(until: { model.state.value?.isEmpty == false }, "the device list to load")

        XCTAssertEqual(model.state.value?.first?.deviceId, "sim-001")
    }

    /// And the device screen opens its socket from its own `.task`, then closes
    /// it when the screen goes away. A screen that keeps retrying after nobody
    /// is looking is a phone spending battery on a view that is gone.
    func testTheDeviceScreenConnectsOnAppearanceAndClosesWhenItGoesAway() async {
        let transport = FakeTransport()
        let stub = StubHTTP(answers: [
            (Wire.framesPage([Wire.frame(seq: 0)]), 200),
            (Wire.emptyAlertsPage, 200)
        ])
        let model = DeviceDetailModel(
            deviceId: "sim-001",
            client: stub.client,
            createSocket: transport.factory,
            schedule: transport.scheduler
        )
        present(DeviceDetailView(model: model))

        await settle(until: { transport.latest != nil }, "the screen to open its socket")
        guard let socket = transport.latest else {
            return XCTFail("the screen never opened a socket")
        }
        XCTAssertEqual(transport.sockets.count, 1)

        window?.rootViewController = UIHostingController(rootView: DisclaimerBar())
        window?.layoutIfNeeded()

        await settle(until: { socket.closeCount > 0 }, "the socket to be closed")
    }
}
#endif
