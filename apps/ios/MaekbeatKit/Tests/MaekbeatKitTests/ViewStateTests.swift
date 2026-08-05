import XCTest
@testable import MaekbeatKit

/*
 * What the screens are showing, asserted on the models that decide it.
 *
 * SwiftUI view bodies are not introspected here — that needs a third-party
 * inspector or a snapshot harness, and neither lands at C14. The line this
 * package holds instead is that views carry no decisions: every branch a screen
 * can take is a value on a model, tested here, and SourceDisciplineTests keeps
 * the views from growing logic of their own. apps/ios/README.md states that
 * boundary plainly rather than implying view coverage this suite does not have.
 */
@MainActor
final class ViewStateTests: XCTestCase {
    // MARK: - The union itself

    func testEveryStateMapsToTheVariantTheScreenDraws() {
        XCTAssertEqual(LoadState<[Int]>.loading.variant, .loading)
        XCTAssertEqual(LoadState<[Int]>.empty.variant, .empty)
        XCTAssertNil(LoadState<[Int]>.ready([1]).variant)
        XCTAssertEqual(LoadState<[Int]>.failed(.http(status: 500, message: nil)).variant, .error)
        XCTAssertEqual(LoadState<[Int]>.failed(.network("down")).variant, .disconnected)
        XCTAssertEqual(LoadState<[Int]>.failed(.contract("bad")).variant, .error)
    }

    /// Every designed state has words. A variant added without copy would draw
    /// an empty panel, which is the blank screen the union exists to prevent.
    func testEveryVariantHasCopyOnBothScreens() {
        for variant in StatusVariant.allCases {
            for copy in [
                StatusCopy.forDevices(variant, failure: .network("x")),
                StatusCopy.forFrames(variant, failure: .network("x"))
            ] {
                XCTAssertFalse(copy.title.isEmpty, "\(variant) has no title")
                XCTAssertFalse(copy.detail.isEmpty, "\(variant) has no detail")
            }
        }
    }

    /// A failed read says what the server said. "Something went wrong" is the
    /// sentence that makes a caregiver call somebody.
    func testAFailedReadCarriesTheServersOwnMessage() {
        let copy = StatusCopy.forDevices(
            .error,
            failure: .http(status: 404, message: "unknown device: ghost")
        )
        XCTAssertTrue(copy.detail.contains("unknown device: ghost"), copy.detail)
    }

    // MARK: - The device list

    func testAServerWithDevicesEndsReady() async {
        let stub = StubHTTP()
        stub.answers = [(Wire.deviceList, 200)]
        let model = DeviceListModel(client: stub.client)

        await model.load()

        XCTAssertEqual(model.state.value?.count, 1)
        XCTAssertNil(model.state.variant)
        XCTAssertEqual(model.ingest?.accepted, 120)
    }

    /// Reachable and holding nothing is `empty`, not `error` and not an empty
    /// list rendered as data.
    func testAReachableServerWithNoDevicesIsEmptyRatherThanFailed() async {
        let stub = StubHTTP()
        stub.answers = [(Wire.emptyDeviceList, 200)]
        let model = DeviceListModel(client: stub.client)

        await model.load()

        XCTAssertEqual(model.state.variant, .empty)
        XCTAssertNil(model.state.failure)
    }

    func testAnUnreachableServerIsDisconnectedAndAnAnsweringOneIsAnError() async {
        let unreachable = StubHTTP()
        unreachable.thrown = URLError(.notConnectedToInternet)
        let offline = DeviceListModel(client: unreachable.client)
        await offline.load()
        XCTAssertEqual(offline.state.variant, .disconnected)

        let broken = StubHTTP()
        broken.answers = [(Data(#"{"statusCode":500,"message":"boom"}"#.utf8), 500)]
        let failing = DeviceListModel(client: broken.client)
        await failing.load()
        XCTAssertEqual(failing.state.variant, .error)
    }

    func testARetryAfterAFailureCanSucceed() async {
        let stub = StubHTTP()
        stub.thrown = URLError(.timedOut)
        let model = DeviceListModel(client: stub.client)
        await model.load()
        XCTAssertEqual(model.state.variant, .disconnected)

        stub.thrown = nil
        stub.answers = [(Wire.deviceList, 200)]
        await model.load()
        XCTAssertNil(model.state.variant)
    }

    // MARK: - Formatting

    /// The goldens start at 2025-08-04T00:00:00Z, so a formatter that fell back
    /// to the machine's zone would read anything but midnight here — which is
    /// the point of asserting it rather than a round number.
    func testTimesRenderInUTCAndSaySo() {
        XCTAssertEqual(Format.time(1_754_265_600_000), "00:00:00 UTC")
        XCTAssertEqual(Format.time(1_754_265_640_000), "00:00:40 UTC")
        XCTAssertEqual(Format.value(97.456), "97.5")
        XCTAssertEqual(Format.value(97.0, decimals: 2), "97.00")
    }

    func testTheClockDeltaKeepsItsSign() {
        XCTAssertEqual(Format.signedMs(120), "+120 ms")
        XCTAssertEqual(Format.signedMs(-900), "-900 ms")
        XCTAssertEqual(Format.signedMs(0), "+0 ms")
    }

    func testARunningEpisodeHasNoDurationYet() {
        XCTAssertEqual(Format.duration(nil), "running")
        XCTAssertEqual(Format.duration(53_000), "53 s")
    }

    func testTheClockDeltaIsReceiveTimeMinusCaptureTime() throws {
        let frame = try VitalsDecoder.json.decode(
            StoredVitalsFrame.self,
            from: Data(Wire.frame(seq: 0).utf8)
        )
        XCTAssertEqual(frame.clockDeltaMs, 120)
    }

    // MARK: - The marks, not the hues

    /// Three states, three glyphs, pairwise distinct — the docs/DECISIONS.md #12
    /// rule, held here so a later edit cannot collapse the encoding onto colour.
    func testEveryStateHasItsOwnMark() {
        let alertMarks = AlertState.allCases.map(AlertRow.mark(for:))
        XCTAssertEqual(Set(alertMarks).count, AlertState.allCases.count)

        let connectionMarks = ConnectionState.allCases.map(ConnectionBadge.mark(for:))
        XCTAssertEqual(Set(connectionMarks).count, ConnectionState.allCases.count)
    }
}
