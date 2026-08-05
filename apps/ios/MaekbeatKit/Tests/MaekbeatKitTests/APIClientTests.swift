import XCTest
@testable import MaekbeatKit

final class APIClientTests: XCTestCase {
    private let base = StubHTTP.baseURL

    // MARK: - Reads

    func testTheDeviceListDecodesIntoContractTypes() async throws {
        let recorder = StubHTTP()
        recorder.answers = [(Wire.deviceList, 200)]

        let list = try await recorder.client.devices()

        XCTAssertEqual(recorder.requested.map(\.absoluteString), ["http://127.0.0.1:3000/devices"])
        XCTAssertEqual(list.ingest.accepted, 120)
        XCTAssertEqual(list.devices.count, 1)
        XCTAssertEqual(list.devices[0].deviceId, "sim-001")
        XCTAssertEqual(list.devices[0].lastSeq, 119)
        XCTAssertEqual(list.devices[0].alertsForcedEvicted, 0)
    }

    /// A server that predates the forced-eviction counter must not blank the
    /// list. The envelope is permissive on purpose; the frame is not.
    func testADeviceRowWithoutTheNewestCounterStillDecodes() async throws {
        let recorder = StubHTTP()
        recorder.answers = [(Data("""
        {"ingest":{"received":1,"accepted":1,"rejectedInvalid":0,\
        "duplicatesDropped":0,"sessionsStarted":1},\
        "devices":[{"deviceId":"sim-001","sessionEpoch":1,"frameCount":1,\
        "lastSeq":0,"lastReceivedAtMs":1754265600120,"duplicatesDropped":0}]}
        """.utf8), 200)]

        let list = try await recorder.client.devices()
        XCTAssertNil(list.devices[0].alertsForcedEvicted)
    }

    func testTheFramesReadCarriesSinceAndLimit() async throws {
        let recorder = StubHTTP()
        recorder.answers = [(Wire.framesPage([Wire.frame(seq: 0), Wire.frame(seq: 1)]), 200)]

        let page = try await recorder.client.frames(
            deviceId: "sim-001",
            since: 1_754_265_600_000,
            limit: 1000
        )

        let url = try XCTUnwrap(recorder.requested.first)
        XCTAssertEqual(url.path, "/devices/sim-001/frames")
        let query = try XCTUnwrap(
            URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        )
        XCTAssertEqual(query.first { $0.name == "limit" }?.value, "1000")
        XCTAssertEqual(query.first { $0.name == "since" }?.value, "1754265600000")
        XCTAssertEqual(page.frames.count, 2)
        XCTAssertEqual(page.frames[1].seq, 1)
    }

    func testTheFramesReadOmitsSinceWhenThereIsNothingToResumeFrom() async throws {
        let recorder = StubHTTP()
        recorder.answers = [(Wire.framesPage([]), 200)]

        _ = try await recorder.client.frames(deviceId: "sim-001")

        let url = try XCTUnwrap(recorder.requested.first)
        XCTAssertFalse(url.absoluteString.contains("since"))
        XCTAssertTrue(url.absoluteString.contains("limit=100"))
    }

    func testTheAlertsReadDecodesAlertsAndTheDecisionLog() async throws {
        let recorder = StubHTTP()
        recorder.answers = [(Data("""
        {"deviceId":"sim-001","counters":{"raised":1,"resolved":1,"suppressed":0,\
        "acknowledged":1,"dismissed":0},"alerts":[{"alertId":"sim-001:spo2-low:1",\
        "deviceId":"sim-001","metric":"spo2Pct","direction":"low","state":"resolved",\
        "raisedAtMs":1754265640000,"resolvedAtMs":1754265693000,\
        "windowStats":{"windowMs":15000,"sampleCount":12,"breachCount":5,\
        "minValue":87.5,"maxValue":91.2}}],"decisions":[{"eventId":"sim-001:decision:1",\
        "alertId":"sim-001:spo2-low:1","deviceId":"sim-001","decision":"acknowledged",\
        "actor":"web-dashboard","recordedAtMs":1754265700000}]}
        """.utf8), 200)]

        let page = try await recorder.client.alerts(deviceId: "sim-001")

        XCTAssertEqual(page.counters.acknowledged, 1)
        XCTAssertEqual(page.alerts[0].state, .resolved)
        XCTAssertEqual(page.alerts[0].durationMs, 53_000)
        XCTAssertEqual(page.decisions[0].decision, .acknowledged)
        XCTAssertEqual(latestDecisions(page.decisions).count, 1)
    }

    func testHealthDecodes() async throws {
        let recorder = StubHTTP()
        recorder.answers = [(Data(#"{"status":"ok","uptimeSec":12.5,"version":"0.0.0"}"#.utf8), 200)]
        let health = try await recorder.client.health()
        XCTAssertEqual(health.status, "ok")
        XCTAssertEqual(health.uptimeSec, 12.5)
    }

    // MARK: - Failures, split by cause

    func testAnUnreachableServerIsANetworkFailureAndReadsAsDisconnected() async {
        let recorder = StubHTTP()
        recorder.thrown = URLError(.cannotConnectToHost)

        do {
            _ = try await recorder.client.devices()
            XCTFail("expected a failure")
        } catch let failure as APIFailure {
            XCTAssertTrue(failure.isDisconnected)
        } catch {
            XCTFail("expected an APIFailure, got \(error)")
        }
    }

    func testAnUnknownDeviceIsAnHTTPFailureCarryingTheServersMessage() async {
        let recorder = StubHTTP()
        recorder.answers = [(
            Data(#"{"statusCode":404,"message":"unknown device: ghost"}"#.utf8), 404
        )]

        do {
            _ = try await recorder.client.frames(deviceId: "ghost")
            XCTFail("expected a failure")
        } catch let failure as APIFailure {
            XCTAssertEqual(failure, .http(status: 404, message: "unknown device: ghost"))
            XCTAssertFalse(failure.isDisconnected, "the server answered; it is not unreachable")
        } catch {
            XCTFail("expected an APIFailure, got \(error)")
        }
    }

    func testAServerErrorWithoutAMessageBodyStillSurfacesItsStatus() async {
        let recorder = StubHTTP()
        recorder.answers = [(Data("<html>gateway</html>".utf8), 502)]

        do {
            _ = try await recorder.client.devices()
            XCTFail("expected a failure")
        } catch let failure as APIFailure {
            XCTAssertEqual(failure, .http(status: 502, message: nil))
        } catch {
            XCTFail("expected an APIFailure, got \(error)")
        }
    }

    /// A 200 that does not satisfy the contract is a contract failure, not a
    /// blank screen and not a rendered zero.
    func testAResponseThatBreaksTheContractIsAContractFailure() async {
        let recorder = StubHTTP()
        recorder.answers = [(Data(#"{"devices":"all of them"}"#.utf8), 200)]

        do {
            _ = try await recorder.client.devices()
            XCTFail("expected a failure")
        } catch let failure as APIFailure {
            guard case .contract = failure else {
                return XCTFail("expected a contract failure, got \(failure)")
            }
            XCTAssertFalse(failure.isDisconnected)
        } catch {
            XCTFail("expected an APIFailure, got \(error)")
        }
    }

    /// Each failure has to explain itself in words, because `StatusPanel` puts
    /// exactly this string in front of a person. "An error occurred" is the
    /// sentence that makes a caregiver phone somebody.
    func testEveryFailureExplainsItselfInWordsAScreenCanShow() {
        let failures: [APIFailure] = [
            .network("the server could not be reached"),
            .http(status: 404, message: "unknown device: ghost"),
            .http(status: 502, message: nil),
            .contract("missing key spo2Pct")
        ]
        let sentences = failures.map { $0.localizedDescription }
        for sentence in sentences {
            XCTAssertFalse(sentence.isEmpty)
        }
        XCTAssertEqual(Set(sentences).count, sentences.count, "two failures read identically")
        XCTAssertTrue(sentences[1].contains("unknown device: ghost"))
        XCTAssertTrue(sentences[2].contains("502"))
        XCTAssertTrue(sentences[3].contains("spo2Pct"))
    }

    // MARK: - URLs

    func testTheStreamURLIsTheServersFanOutRouteOverWebSocket() {
        let client = APIClient(baseURL: base) { _ in (Data(), URLResponse()) }
        XCTAssertEqual(
            client.streamURL(deviceId: "sim-001").absoluteString,
            "ws://127.0.0.1:3000/devices/sim-001/stream"
        )
    }

    func testATLSBaseURLProducesASecureSocketURL() {
        let secure = APIClient(baseURL: URL(string: "https://example.test")!) { _ in
            (Data(), URLResponse())
        }
        XCTAssertEqual(
            secure.streamURL(deviceId: "sim-001").absoluteString,
            "wss://example.test/devices/sim-001/stream"
        )
        XCTAssertEqual(secure.ingestURL().absoluteString, "wss://example.test/ingest")
    }

    /// A device id is one path segment, whatever is in it. A slash inside one
    /// must name a device, never a route.
    func testADeviceIdIsEscapedIntoASingleSegment() async throws {
        let recorder = StubHTTP()
        recorder.answers = [(Wire.framesPage([]), 200)]
        let client = recorder.client

        _ = try? await client.frames(deviceId: "wing 2/bed 4")
        let url = try XCTUnwrap(recorder.requested.first)
        XCTAssertEqual(url.absoluteString.contains("/devices/wing%202%2Fbed%204/frames"), true)
        XCTAssertEqual(
            client.streamURL(deviceId: "wing 2/bed 4").absoluteString,
            "ws://127.0.0.1:3000/devices/wing%202%2Fbed%204/stream"
        )
    }

    /// A base URL with a path prefix — a server behind a reverse proxy — keeps
    /// that prefix instead of losing it at the first route.
    func testABaseURLWithAPathPrefixKeepsIt() {
        let proxied = APIClient(baseURL: URL(string: "http://gateway.test/maekbeat/")!) { _ in
            (Data(), URLResponse())
        }
        XCTAssertEqual(
            proxied.streamURL(deviceId: "sim-001").absoluteString,
            "ws://gateway.test/maekbeat/devices/sim-001/stream"
        )
    }

    func testTheDefaultBaseURLIsTheLoopbackServerASimulatorCanReach() {
        XCTAssertEqual(APIClient.defaultBaseURL.absoluteString, "http://127.0.0.1:3000")
    }
}
