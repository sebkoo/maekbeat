import Foundation
import XCTest
@testable import MaekbeatKit

/*
 * The defaults nothing had ever taken.
 *
 * Every port in this package is injectable, and every suite injects. That is
 * what makes the tests fast and deterministic, and it is also how a default
 * resolution ends up with no caller at all: `createSocket ?? URLSessionStreamSocket.make`
 * is one line, it is what ships, and until this file nothing but the app ran it.
 * C16 already paid for one of these — `APIClient`'s transport was a default
 * argument, every unit test passed a transport explicitly, and the first caller
 * to take the default from an `async` function segfaulted the process under
 * Swift 5.10 rather than failing. The suite could not have found it, because
 * the suite never went that way.
 *
 * So this file is the enumeration: one test per default that had no caller,
 * taking it. Where the default is a socket it is taken against port 1 on
 * loopback — privileged, unbound and refused immediately, the same deterministic
 * failure `URLSessionSocketTests` uses, which needs no fixture and cannot flake
 * on a busy port.
 *
 * Three defaults are **not** here, and they are named rather than omitted:
 * `GatewayModel.live()`, `NotificationCoordinator.live()` and
 * `UserNotificationCenterAdapter()`. Each raises an ObjC exception in a test
 * bundle, which Swift cannot catch, so no assertion can be written on the far
 * side of the call. The exact messages are in apps/ios/README.md, taken from a
 * run rather than from documentation.
 */
final class DefaultPathTests: XCTestCase {
    /// Port 1 on loopback: privileged, unbound, refused immediately.
    private static let refusedHTTP = URL(string: "http://127.0.0.1:1")!
    private static let refusedSocket = URL(string: "ws://127.0.0.1:1/devices/sim-001/stream")!

    // MARK: - The real HTTP transport

    /// `APIClient(baseURL:)` with no transport builds the real `URLSession` one.
    /// Every other test in this package hands one in, so this line — and the
    /// static that replaced the default argument which used to segfault — is
    /// covered by the app and by nothing else. Now by the gate too, rather than
    /// only by the macOS integration suite that found the crash.
    func testTheDefaultTransportIsARealURLSessionAndReportsARefusedServer() async {
        let client = APIClient(baseURL: Self.refusedHTTP)
        do {
            _ = try await client.devices()
            XCTFail("nothing is listening on port 1; the read cannot have succeeded")
        } catch let failure as APIFailure {
            XCTAssertTrue(
                failure.isDisconnected,
                "a refused connection is `disconnected`, not `error`: \(failure)"
            )
        } catch {
            XCTFail("the failure did not arrive as an APIFailure: \(error)")
        }
    }

    /// And the same transport on the write half, so a decision taken with no
    /// injected transport fails honestly rather than looking recorded.
    func testTheDefaultTransportCarriesTheDecisionRouteToo() async {
        let client = APIClient(baseURL: Self.refusedHTTP)
        do {
            _ = try await client.recordDecision(
                deviceId: "sim-001",
                alertId: "sim-001:spo2-low:1",
                decision: .acknowledged
            )
            XCTFail("nothing is listening on port 1")
        } catch let failure as APIFailure {
            XCTAssertTrue(failure.isDisconnected)
        } catch {
            XCTFail("the failure did not arrive as an APIFailure: \(error)")
        }
    }

    /// The `actor` a decision is filed under defaults to this app, and the
    /// default is what the app takes — no screen passes one. Asserted on the
    /// request body rather than on the reply, because the reply is a stub's.
    func testADecisionIsFiledUnderThisAppByDefault() async throws {
        let recorder = RequestRecorder(body: """
        {"eventId":"sim-001:decision:1","alertId":"sim-001:spo2-low:1",\
        "deviceId":"sim-001","decision":"acknowledged","actor":"ios-gateway",\
        "recordedAtMs":1754265700000}
        """)
        let client = APIClient(baseURL: StubHTTP.baseURL, transport: recorder.transport)

        _ = try await client.recordDecision(
            deviceId: "sim-001",
            alertId: "sim-001:spo2-low:1",
            decision: .acknowledged
        )

        let request = try XCTUnwrap(recorder.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        let body = try XCTUnwrap(request.httpBody)
        let sent = try XCTUnwrap(String(bytes: body, encoding: .utf8))
        XCTAssertTrue(
            sent.contains("\"actor\":\"ios-gateway\""),
            "the decision must name this app as its provenance: \(sent)"
        )
        XCTAssertTrue(sent.contains("\"decision\":\"acknowledged\""))
    }

    // MARK: - The real timer

    /// `StreamClient.defaultScheduler` is the timer three types fall back to and
    /// no test had ever run. Both halves matter: the work runs, and the
    /// canceller it returns stops the work from running.
    @MainActor
    func testTheDefaultSchedulerRunsTheWorkItWasHanded() async {
        let ran = expectation(description: "the scheduled work ran")
        _ = StreamClient.defaultScheduler(1) { ran.fulfill() }
        await fulfillment(of: [ran], timeout: 5)
    }

    /// A timer whose owner state is gone must not fire — the C15 invariant, at
    /// the one implementation of it that had no coverage.
    @MainActor
    func testTheDefaultSchedulersCancellerStopsTheWork() async {
        let fired = expectation(description: "the later timer ran")
        var cancelledRan = false

        let cancel = StreamClient.defaultScheduler(1) { cancelledRan = true }
        cancel()
        // A second, longer timer: when this one fires, the cancelled one was due
        // long ago, so its silence is a fact rather than a race.
        _ = StreamClient.defaultScheduler(150) { fired.fulfill() }

        await fulfillment(of: [fired], timeout: 5)
        XCTAssertFalse(cancelledRan, "a cancelled timer fired anyway")
    }

    // MARK: - The real sockets, through the clients that build them

    /// A `StreamClient` given neither port: the real socket factory and the real
    /// timer, both resolved in `init` and both otherwise unreached. Against a
    /// refused port it must run its whole retry ladder and land on
    /// `disconnected` — the badge a caregiver reads — rather than freezing on
    /// `connecting`.
    @MainActor
    func testAStreamClientWithNoPortsRetriesOverTheRealSocketAndTheRealTimer() async {
        let recorder = StreamRecorder()
        let client = StreamClient(url: Self.refusedSocket, handlers: recorder.handlers)
        client.open()

        // Ten seconds of budget for a ladder that needs about one and a half:
        // the loop exits on the condition, so the headroom costs nothing and
        // stops a loaded runner from turning this into a measurement of itself
        // (docs/ai/AI_USAGE.md, 2026-08-06).
        for _ in 0..<500 {
            if recorder.states.contains(.disconnected) { break }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        client.close()

        XCTAssertEqual(recorder.states.first, .connecting)
        XCTAssertTrue(
            recorder.states.contains(.disconnected),
            "three refusals on the real timer must reach disconnected: \(recorder.states)"
        )
        XCTAssertTrue(recorder.messages.isEmpty, "nothing is listening; there is no data")
    }

    /// The uplink half, same construction. Its real socket announces itself open
    /// as soon as the task is running — URLSession queues a send until the
    /// handshake resolves — so a refused port reads as an open that then drops,
    /// and the client must report the reconnect rather than staying `live`.
    @MainActor
    func testAnIngestClientWithNoPortsOpensTheRealSocketAndReportsItsDrop() async {
        var states: [ConnectionState] = []
        let client = IngestClient(url: Self.refusedSocket)
        client.onState = { states.append($0) }
        client.open()

        for _ in 0..<500 {
            if states.contains(.reconnecting) || states.contains(.disconnected) { break }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        client.close()

        XCTAssertTrue(
            states.contains(.live),
            "the real uplink socket reports open before the handshake: \(states)"
        )
        XCTAssertTrue(
            states.contains(.reconnecting) || states.contains(.disconnected),
            "a refused port must surface as a drop, not as a live uplink: \(states)"
        )
    }

    /// A driver built without a scheduler takes the same real timer. The radio
    /// calls are what this asserts — the deadline it arms is cancelled by
    /// `stop()` rather than waited on, because ten seconds of wall clock in a
    /// gate is how a suite starts getting skipped.
    @MainActor
    func testADriverWithNoSchedulerStillDrivesTheRadio() {
        let radio = MockPeripheralPort()
        let driver = BLEDriver(port: radio)

        driver.start()
        XCTAssertEqual(radio.calls, [.scanAndConnect])
        XCTAssertTrue(driver.state.wantsLink)

        driver.stop()
        XCTAssertEqual(radio.calls, [.scanAndConnect, .cancelConnection])
        XCTAssertEqual(driver.phase, .disconnected)
    }

    // MARK: - The default handler set

    /// `StreamHandlers` has three defaulted closures and every caller in this
    /// package passes all four. A caller that wants only the messages must not
    /// trap on a state change, a reconnect, or a payload the contract rejects.
    @MainActor
    func testTheDefaultStreamHandlersAbsorbEverythingButTheMessage() {
        var messages: [StreamMessage] = []
        let transport = FakeTransport()
        let client = StreamClient(
            url: Self.refusedSocket,
            handlers: StreamHandlers(onMessage: { messages.append($0) }),
            createSocket: transport.factory,
            schedule: transport.scheduler
        )
        client.open()

        transport.latest?.open()                       // onState: default
        transport.latest?.deliver("not json")          // onInvalidMessage: default
        transport.latest?.deliver(Wire.frameMessage(seq: 0))
        transport.latest?.drop()                       // onState: default
        transport.fireScheduled()
        transport.latest?.open()                       // onReconnect: default
        transport.latest?.deliver(Wire.frameMessage(seq: 1))
        client.close()

        XCTAssertEqual(messages.count, 2, "the one handler that was supplied still ran")
    }

    // MARK: - The fallback ports

    /// The `#else` ports exist for a platform with no framework to talk to, and
    /// on every platform this package builds for that branch is dead — so
    /// nothing had ever called one. They must be inert rather than wrong: a stub
    /// that pretended to be authorized would be worse than no notifications.
    @MainActor
    func testTheInertPortsRefuseRatherThanPretend() async {
        let radio = InertPeripheralPort()
        radio.scanAndConnect()
        radio.discoverServices()
        radio.enableNotifications()
        radio.cancelConnection()

        let centre = InertNotificationPort()
        centre.registerCategories()
        centre.schedule(CaregiverNotification(
            identifier: "sim-001:spo2-low:1",
            deviceId: "sim-001",
            alertId: "sim-001:spo2-low:1",
            title: "t",
            body: "b",
            actions: CaregiverNotification.Action.allCases
        ))
        centre.withdraw(alertId: "sim-001:spo2-low:1")

        let current = await centre.currentAuthorization()
        let asked = await centre.requestAuthorization()
        XCTAssertEqual(current, .notDetermined)
        XCTAssertEqual(
            asked,
            .notDetermined,
            "an inert port must not claim permission it has not got"
        )
        XCTAssertFalse(asked.canDeliver)
    }
}

/// Records the whole request rather than just its URL, which is what a test
/// about a request body needs. `StubHTTP` keeps URLs because that is all its
/// tests read.
private final class RequestRecorder: @unchecked Sendable {
    private(set) var requests: [URLRequest] = []
    private let body: Data

    init(body: String) {
        self.body = Data(body.utf8)
    }

    var transport: HTTPTransport {
        { [self] request in
            requests.append(request)
            let response = HTTPURLResponse(
                url: request.url ?? StubHTTP.baseURL,
                statusCode: 201,
                httpVersion: nil,
                headerFields: nil
            )
            guard let response else { throw URLError(.badServerResponse) }
            return (body, response)
        }
    }
}
