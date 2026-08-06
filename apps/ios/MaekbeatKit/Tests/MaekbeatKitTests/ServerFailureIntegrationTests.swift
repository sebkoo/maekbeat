#if os(macOS)
import Foundation
import XCTest
@testable import MaekbeatKit

/*
 * What the interface says when things go wrong, against a server that is really
 * going wrong.
 *
 * Every failure path in this package is otherwise driven by a stub that was
 * told to fail. That proves the branch, and it cannot prove the diagnosis: a
 * stub throwing `URLError` is not the same event as a process that is no longer
 * listening, and the whole point of splitting `APIFailure` into `network`,
 * `http` and `contract` is that the screen has to tell "the server is down"
 * apart from "the server said no". So these five run against a real
 * `apps/server`, four of them breaking it in a different way and the fifth
 * refusing the permission it needs.
 *
 * The third one also closes a hole apps/ios/README.md has carried since C14:
 * `URLSessionStreamSocket`'s success path — a completed handshake and a
 * delivered frame — had no coverage anywhere, because proving it needs a live
 * server process. apps/web has that in its C13 Playwright smoke. This is the
 * iOS equivalent, and it drops the socket in the middle of an open episode
 * rather than at a convenient moment.
 *
 * macOS only, for the same reason as GatewayIntegrationTests: it spawns a
 * process, which an iOS Simulator test cannot. Outside the coverage gate, run
 * by scripts/integration.sh, which fails the step if the suite skips.
 */
@MainActor
final class ServerFailureIntegrationTests: XCTestCase {
    private var server: ServerProcess?
    private var rig: Rig?

    override func tearDownWithError() throws {
        rig?.stop()
        rig = nil
        server?.stop()
        server = nil
        try super.tearDownWithError()
    }

    // MARK: - The server is not there

    /// A cold launch against a server that has gone away. Every screen must say
    /// `disconnected` — the state that means nothing was reached — rather than
    /// `empty`, which is a claim that the server answered and had nothing.
    ///
    /// The distinction is the reason `LoadState` exists, and a stub cannot make
    /// it: it is the same code path either way until something really refuses.
    func testAColdLaunchAgainstAServerThatIsGoneSaysDisconnectedRatherThanEmpty() async throws {
        let rig = try await start()
        rig.streamFrames(1...20)
        await rig.waitForAcks(20)

        let api = APIClient(baseURL: rig.baseURL)
        let warm = DeviceListModel(client: api)
        await warm.load()
        XCTAssertNil(warm.state.variant, "the server is up; this read should be data")

        // The process dies. Nothing else changes — same URL, same client.
        server?.stop()

        let cold = DeviceListModel(client: api)
        await cold.load()
        XCTAssertEqual(
            cold.state.variant,
            .disconnected,
            "a refused connection is not an empty server"
        )
        XCTAssertEqual(StatusCopy.forDevices(.disconnected).title, Copy.disconnectedTitle)

        let screen = DeviceDetailModel(deviceId: "sim-001", client: api)
        await screen.load()
        XCTAssertEqual(screen.frames.variant, .disconnected)
        XCTAssertTrue(
            screen.frames.failure?.isDisconnected == true,
            "the device screen must not report this as the server saying no"
        )
        XCTAssertTrue(screen.timeline.isEmpty, "and it must not invent history it never read")
    }

    // MARK: - The decision does not land

    /// A caregiver answers a banner and the request never arrives. The banner
    /// has to stay: withdrawing it would be the interface claiming a log entry
    /// that does not exist, which is the rule apps/web fixed at C12 and the
    /// reason `act(_:on:)` records before it withdraws.
    ///
    /// `GatewayIntegrationTests` already covers the server *refusing* a decision
    /// on an alert it never raised — a 404, an answer. This is the other half: no
    /// answer at all.
    func testADecisionPostedToADeadServerLeavesTheBannerStanding() async throws {
        let rig = try await start()
        let alert = try await rig.raiseRealAlert()

        let centre = FakeNotificationPort()
        centre.authorization = .authorized
        let coordinator = NotificationCoordinator(
            port: centre,
            client: APIClient(baseURL: rig.baseURL)
        )
        await coordinator.refreshAuthorization()
        coordinator.handle(alert, decided: false)
        let banner = try XCTUnwrap(centre.scheduled.first)

        server?.stop()
        await coordinator.act(.acknowledge, on: banner)

        XCTAssertEqual(coordinator.decisionFailures, 1)
        XCTAssertEqual(coordinator.decisionsRecorded, 0)
        XCTAssertEqual(centre.withdrawn, [], "a decision nobody recorded took a banner back")
        XCTAssertTrue(
            centre.standing.contains(alert.alertId),
            "the caregiver must still be holding an alert nobody has"
        )
    }

    // MARK: - The socket drops mid-episode

    /// The fan-out socket, real, cut in the middle of an open alert episode and
    /// resumed. Three things have to survive it: the frames the socket delivers
    /// (the shipped socket's success path, covered nowhere else in this
    /// package), the REST back-fill on re-open, and the notify dedupe — the
    /// back-fill re-offers an episode this phone already banned itself from
    /// notifying about, which is the storm C16's policy exists to refuse.
    func testTheFanOutSocketDropsMidEpisodeAndResumesWithoutASecondBanner() async throws {
        let rig = try await start()
        let alert = try await rig.raiseRealAlert()

        let centre = FakeNotificationPort()
        centre.authorization = .authorized
        let api = APIClient(baseURL: rig.baseURL)
        let coordinator = NotificationCoordinator(port: centre, client: api)
        await coordinator.refreshAuthorization()

        var sockets: [ControllableStreamSocket] = []
        let model = DeviceDetailModel(
            deviceId: "sim-001",
            client: api,
            notifications: coordinator,
            createSocket: { url, handlers in
                let socket = ControllableStreamSocket(url: url, handlers: handlers)
                sockets.append(socket)
                return socket
            }
        )

        await model.load()
        XCTAssertEqual(centre.scheduled.count, 1, "the REST seed found the open episode")
        model.connect()
        defer { model.disconnect() }

        await wait(until: { model.connection == .live }, "the real fan-out socket to open")
        XCTAssertEqual(
            model.ringCapacity,
            1_024,
            "the server's own `ready` message crossed a real socket"
        )

        let beforeDrop = model.newestFrame?.seq ?? -1
        rig.streamMoreFrames(count: 5, spo2: 88)
        await wait(until: { (model.newestFrame?.seq ?? -1) > beforeDrop },
                   "frames to arrive over the socket")

        // The wire goes away in the middle of an episode nobody has answered.
        sockets.last?.forceDrop()
        await wait(until: { model.connection != .live }, "the drop to be noticed")
        await wait(until: { model.connection == .live }, "the socket to come back", timeout: 40)

        let afterResume = model.newestFrame?.seq ?? -1
        rig.streamMoreFrames(count: 5, spo2: 88)
        await wait(until: { (model.newestFrame?.seq ?? -1) > afterResume },
                   "frames to arrive over the second socket")

        XCTAssertGreaterThan(sockets.count, 1, "the client built a second socket")
        XCTAssertEqual(
            centre.scheduled.count,
            1,
            "the back-fill replayed the open episode and must not notify again"
        )
        XCTAssertTrue(centre.standing.contains(alert.alertId))
        XCTAssertGreaterThan(
            coordinator.suppressed(.alreadyNotified) + coordinator.suppressed(.notANewEpisode),
            0,
            "and the refusal is counted rather than silent"
        )

        let window = model.frames.value ?? []
        let keys = window.map { "\($0.sessionEpoch)#\($0.seq)" }
        XCTAssertEqual(Set(keys).count, keys.count, "the back-fill duplicated a frame")
        XCTAssertEqual(
            window.map(\.capturedAtMs),
            window.map(\.capturedAtMs).sorted(),
            "the window is ordered by capture time across the gap"
        )
        XCTAssertEqual(model.invalidMessages, 0, "the real server sent nothing off-contract")
    }

    /// The other half, and the one that was broken. An episode that opens while
    /// the socket is down produces no fan-out message — there is nobody to send
    /// it to — so unless the re-open asks the server what it missed, the alert
    /// reaches no caregiver at all until the screen is rebuilt.
    ///
    /// Until C17 the back-fill re-read frames and not alerts, and this test is
    /// what found it: the chart healed across the gap and the alarm did not
    /// exist. "Silence is not continuity" was written about frames and is truer
    /// about alerts.
    func testAnAlertRaisedWhileTheSocketWasDownStillReachesTheCaregiver() async throws {
        let rig = try await start()
        rig.streamMoreFrames(count: 10)
        await rig.waitForAcks(10)

        let centre = FakeNotificationPort()
        centre.authorization = .authorized
        let api = APIClient(baseURL: rig.baseURL)
        let coordinator = NotificationCoordinator(port: centre, client: api)
        await coordinator.refreshAuthorization()

        var sockets: [ControllableStreamSocket] = []
        let model = DeviceDetailModel(
            deviceId: "sim-001",
            client: api,
            notifications: coordinator,
            createSocket: { url, handlers in
                let socket = ControllableStreamSocket(url: url, handlers: handlers)
                sockets.append(socket)
                return socket
            }
        )

        await model.load()
        model.connect()
        defer { model.disconnect() }
        await wait(until: { model.connection == .live }, "the fan-out socket to open")
        XCTAssertEqual(centre.scheduled.count, 0, "nothing has breached yet")

        // The wire goes away, and only then does the episode start.
        sockets.last?.forceDrop()
        await wait(until: { model.connection != .live }, "the drop to be noticed")
        let alert = try await rig.raiseRealAlert()

        await wait(until: { model.connection == .live }, "the socket to come back", timeout: 40)
        await wait(until: { !centre.scheduled.isEmpty },
                   "the episode raised during the outage to reach the caregiver")

        XCTAssertEqual(centre.scheduled.count, 1)
        XCTAssertEqual(centre.scheduled.first?.alertId, alert.alertId)
        XCTAssertTrue(
            model.timeline.contains { $0.alertId == alert.alertId },
            "and to be on the screen, not only in a banner"
        )
    }

    // MARK: - The permission is refused

    /// A real alert on a phone whose notifications are denied. Nothing is
    /// scheduled, the refusal is counted under the reason that names it, and —
    /// the part that matters — the episode is still on the screen. An app that
    /// cannot notify must not also go quiet: the person believing they are
    /// covered is the failure this state exists to prevent.
    func testARefusedPermissionStillShowsTheEpisodeOnTheScreen() async throws {
        let rig = try await start()
        let alert = try await rig.raiseRealAlert()

        let centre = FakeNotificationPort()
        centre.authorization = .denied
        let api = APIClient(baseURL: rig.baseURL)
        let coordinator = NotificationCoordinator(port: centre, client: api)
        await coordinator.refreshAuthorization()

        let model = DeviceDetailModel(deviceId: "sim-001", client: api, notifications: coordinator)
        await model.load()

        XCTAssertEqual(coordinator.authorization, .denied)
        XCTAssertEqual(coordinator.delivered, 0)
        XCTAssertTrue(centre.scheduled.isEmpty)
        XCTAssertGreaterThan(
            coordinator.suppressed(.notAuthorized),
            0,
            "a refused notification must be counted, not dropped"
        )
        XCTAssertTrue(
            model.timeline.contains { $0.alertId == alert.alertId },
            "the episode must still be readable on the screen"
        )
        XCTAssertFalse(
            Copy.notificationDescription(.denied).isEmpty,
            "and the screen must say what was lost"
        )
    }

    // MARK: - Harness

    private func start() async throws -> Rig {
        let process = try ServerProcess.launch()
        server = process
        let started = Rig(port: process.port)
        rig = started
        await started.open()
        return started
    }

    private func wait(
        until condition: () -> Bool,
        _ what: String,
        timeout: TimeInterval = 20,
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
}

/// The shipped fan-out socket, with a way to cut it that the caller did not ask
/// for — which is what wifi does. `ControllableIngestSocket` is the same idea on
/// the uplink side; this one wraps the receive-only socket the dashboard and the
/// device screen share.
@MainActor
final class ControllableStreamSocket: StreamSocket {
    private let underlying: StreamSocket
    private let handlers: SocketHandlers
    private var cut = false

    init(url: URL, handlers: SocketHandlers) {
        self.handlers = handlers
        underlying = URLSessionStreamSocket.make(url: url, handlers: handlers)
    }

    func close() {
        cut = true
        underlying.close()
    }

    func forceDrop() {
        guard !cut else { return }
        cut = true
        underlying.close()
        handlers.onClose()
    }
}
#endif
