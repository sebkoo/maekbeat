#if canImport(UIKit)
import SwiftUI
import UIKit
import XCTest
@testable import MaekbeatKit

/*
 * Every screen, in every state it is designed to have, put through a real
 * layout pass.
 *
 * This is not a snapshot suite and makes no claim to be one — nothing here
 * compares pixels, and a view that lays out wrongly still passes. What it does
 * prove is that each `body` is evaluated on the platform the app ships on, in
 * each state, without trapping: a force unwrap of a missing frame, an index
 * into an empty window, a `ForEach` over non-unique ids. Those are the ways a
 * monitoring screen actually dies, and none of them is visible to a test that
 * only reads the model.
 *
 * It is also what puts the view files in the coverage denominator honestly. The
 * alternative was a lower threshold and a paragraph explaining why the views do
 * not count, which is the kind of exemption CLAUDE.md's ratchet exists to
 * refuse.
 */
@MainActor
final class ViewRenderingTests: XCTestCase {
    private static let screen = CGSize(width: 393, height: 852)

    /// Hosts a view in a real window and forces the pass that evaluates its
    /// body. `sizeThatFits` is the assertion rather than the subview count:
    /// SwiftUI does not necessarily produce UIKit subviews, but a body that
    /// never ran cannot measure to a non-zero size.
    private func render(_ view: some View, file: StaticString = #filePath, line: UInt = #line) {
        let host = UIHostingController(rootView: view)
        let window = UIWindow(frame: CGRect(origin: .zero, size: Self.screen))
        window.rootViewController = host
        window.isHidden = false
        window.layoutIfNeeded()

        let measured = host.sizeThatFits(in: Self.screen)
        XCTAssertGreaterThan(measured.width, 0, "the view measured to nothing", file: file, line: line)
        XCTAssertGreaterThan(measured.height, 0, "the view measured to nothing", file: file, line: line)
    }

    private var client: APIClient { StubHTTP().client }

    // MARK: - The disclaimer and the shell

    func testTheRootScreenRenders() {
        render(RootView(client: client))
    }

    func testTheDisclaimerBarRenders() {
        render(DisclaimerBar())
    }

    // MARK: - Every designed state

    func testEveryStatusVariantRenders() {
        for variant in StatusVariant.allCases {
            render(StatusPanelView(
                variant: variant,
                copy: .forDevices(variant, failure: .http(status: 500, message: "boom")),
                retry: {}
            ))
            // The same panel without a retry handler: the failure states must
            // not require a button that a caller did not supply.
            render(StatusPanelView(variant: variant, copy: .forFrames(variant)))
        }
    }

    func testEveryConnectionStateRenders() {
        for state in ConnectionState.allCases {
            render(ConnectionBadge(state: state))
        }
    }

    func testEveryAlertStateRendersWithAndWithoutADecision() throws {
        for state in AlertState.allCases {
            let alert = try Self.alert(state: state)
            render(AlertRow(alert: alert, decision: nil))
            render(AlertRow(alert: alert, decision: try Self.decision()))
        }
    }

    // MARK: - The device list

    func testTheDeviceListRendersInEveryState() async {
        let loading = StubHTTP()
        render(DeviceListView(model: DeviceListModel(client: loading.client), client: loading.client))

        for answer in [
            (Wire.deviceList, 200),
            (Wire.emptyDeviceList, 200),
            (Data(#"{"statusCode":500,"message":"boom"}"#.utf8), 500)
        ] {
            let stub = StubHTTP(answers: [answer])
            let model = DeviceListModel(client: stub.client)
            await model.load()
            render(DeviceListView(model: model, client: stub.client))
        }

        let offline = StubHTTP(thrown: URLError(.cannotConnectToHost))
        let disconnected = DeviceListModel(client: offline.client)
        await disconnected.load()
        XCTAssertEqual(disconnected.state.variant, .disconnected)
        render(DeviceListView(model: disconnected, client: offline.client))
    }

    // MARK: - The device screen

    func testTheDeviceScreenRendersWithFramesAlertsAndADecision() async {
        let transport = FakeTransport()
        let stub = StubHTTP(answers: [
            (Wire.framesPage([Wire.frame(seq: 0), Wire.frame(seq: 1, capturedAtMs: 1_754_265_601_000)]), 200),
            (Wire.emptyAlertsPage, 200)
        ])
        let model = DeviceDetailModel(
            deviceId: "sim-001",
            client: stub.client,
            createSocket: transport.factory,
            schedule: transport.scheduler
        )
        await model.load()
        model.connect()
        transport.latest?.open()
        transport.latest?.deliver(Wire.ready)
        transport.latest?.deliver(Wire.alertMessage())
        transport.latest?.deliver(Wire.decisionMessage())
        transport.latest?.deliver(Wire.frameMessage(seq: 2, sessionEpoch: 2))
        transport.latest?.deliver("not json")

        // The footnote branches — ring capacity, a second session, a rejected
        // message — are all live at this point, so the render walks them.
        XCTAssertEqual(model.ringCapacity, 1024)
        XCTAssertEqual(model.sessionsInWindow.count, 2)
        XCTAssertEqual(model.invalidMessages, 1)
        render(DeviceDetailView(model: model))
        model.disconnect()
    }

    /// Both models take the fake socket. `DeviceDetailView` connects from its
    /// own `.task`, and a hosted view really does run it — a render test that
    /// left the default transport in place would open a live WebSocket to
    /// whatever is listening on port 3000 and never close it.
    func testTheDeviceScreenRendersWhenTheWindowIsEmptyAndWhenTheReadFailed() async {
        let emptyTransport = FakeTransport()
        let empty = StubHTTP(answers: [(Wire.framesPage([]), 200), (Wire.emptyAlertsPage, 200)])
        let emptyModel = DeviceDetailModel(
            deviceId: "sim-001",
            client: empty.client,
            createSocket: emptyTransport.factory,
            schedule: emptyTransport.scheduler
        )
        await emptyModel.load()
        render(DeviceDetailView(model: emptyModel))
        emptyModel.disconnect()

        let brokenTransport = FakeTransport()
        let broken = StubHTTP(thrown: URLError(.cannotFindHost))
        let failedModel = DeviceDetailModel(
            deviceId: "sim-001",
            client: broken.client,
            createSocket: brokenTransport.factory,
            schedule: brokenTransport.scheduler
        )
        await failedModel.load()
        render(DeviceDetailView(model: failedModel))
        failedModel.disconnect()
    }

    // MARK: -

    private static func alert(state: AlertState) throws -> AlertEvent {
        let resolved = state == .resolved ? 1_754_265_693_000 : nil
        let json = Wire.alertMessage(state: state.rawValue, resolvedAtMs: resolved)
        guard case let .alert(event) = try StreamDecoder.message(from: Data(json.utf8)) else {
            throw ContractError.unknownMessageType(state.rawValue)
        }
        return event
    }

    private static func decision() throws -> AlertDecisionEvent {
        let json = Wire.decisionMessage()
        guard case let .decision(event) = try StreamDecoder.message(from: Data(json.utf8)) else {
            throw ContractError.unknownMessageType("decision")
        }
        return event
    }
}
#endif
