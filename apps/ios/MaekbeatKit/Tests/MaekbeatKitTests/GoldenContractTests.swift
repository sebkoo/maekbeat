import XCTest
@testable import MaekbeatKit

/*
 * The cross-language contract test.
 *
 * These Swift types are hand-written against packages/protocol, and nothing
 * generates them. What keeps them honest is that this suite decodes the exact
 * bytes of packages/vitals-sim/golden/<scenario>.ndjson — the same fixtures the
 * TypeScript golden suite pins byte for byte. Neither language owns them, so a
 * rename on either side breaks a test on the other.
 *
 * The limits of that are in apps/ios/README.md and are not small. Read them.
 */
final class GoldenContractTests: XCTestCase {
    // MARK: - The fixtures are actually there

    func testTheGoldensExistWhereTheContractSaysTheyDo() throws {
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: GoldenFixture.goldenDirectory.path),
            "no golden directory at \(GoldenFixture.goldenDirectory.path) — this suite must fail "
                + "loudly rather than skip, or it becomes a green tick for work nobody did"
        )
        for scenario in GoldenFixture.Scenario.allCases {
            XCTAssertTrue(
                FileManager.default.fileExists(atPath: GoldenFixture.url(for: scenario).path),
                "missing fixture: \(scenario.rawValue).ndjson"
            )
        }
    }

    // MARK: - The header line

    func testTheHeaderLineCarriesTheGeneratorConfiguration() throws {
        let lines = try GoldenFixture.lines(for: .anomaly)
        let header = try JSONDecoder().decode(GoldenHeader.self, from: lines.header)

        XCTAssertEqual(header.seed, 7)
        XCTAssertEqual(header.generatorVersion, 1)
        XCTAssertEqual(header.config.scenario, "anomaly")
        XCTAssertEqual(header.config.deviceId, "sim-001")
        XCTAssertEqual(header.config.startAtMs, 1_754_265_600_000)
        XCTAssertEqual(header.config.tickMs, 1_000)
        XCTAssertEqual(header.config.count, 120)
        XCTAssertEqual(lines.frames.count, header.config.count)
    }

    func testEveryFixtureHeaderNamesItsOwnScenarioAndItsSeed() throws {
        let seeds: [GoldenFixture.Scenario: Int] = [.rest: 1, .motion: 5, .anomaly: 7]
        for scenario in GoldenFixture.Scenario.allCases {
            let lines = try GoldenFixture.lines(for: scenario)
            let header = try JSONDecoder().decode(GoldenHeader.self, from: lines.header)
            XCTAssertEqual(header.config.scenario, scenario.rawValue)
            XCTAssertEqual(header.seed, seeds[scenario])
        }
    }

    /// Line 0 is a header, not a frame. If the fixture format ever changed so
    /// that frames started at line 0, every offset in this suite would be wrong
    /// by one and the field assertions below would read the wrong row.
    func testTheHeaderLineIsNotAFrame() throws {
        let lines = try GoldenFixture.lines(for: .rest)
        XCTAssertThrowsError(try VitalsDecoder.frame(from: lines.header))
    }

    // MARK: - Field by field, on a frame with known values

    func testTheFirstAnomalyFrameDecodesFieldByField() throws {
        let lines = try GoldenFixture.lines(for: .anomaly)
        let frame = try VitalsDecoder.frame(from: lines.frames[0])

        XCTAssertEqual(frame.v, 1)
        XCTAssertEqual(frame.deviceId, "sim-001")
        XCTAssertEqual(frame.seq, 0)
        XCTAssertEqual(frame.capturedAtMs, 1_754_265_600_000)
        XCTAssertEqual(frame.heartRateBpm, 62)
        XCTAssertEqual(frame.spo2Pct, 97.5)
        XCTAssertEqual(frame.respirationRpm, 13.7)
        XCTAssertEqual(frame.motion, 0.003)
    }

    func testTheSecondAnomalyFrameDecodesFieldByField() throws {
        let lines = try GoldenFixture.lines(for: .anomaly)
        let frame = try VitalsDecoder.frame(from: lines.frames[1])

        XCTAssertEqual(frame.v, 1)
        XCTAssertEqual(frame.deviceId, "sim-001")
        XCTAssertEqual(frame.seq, 1)
        XCTAssertEqual(frame.capturedAtMs, 1_754_265_601_000)
        XCTAssertEqual(frame.heartRateBpm, 62)
        XCTAssertEqual(frame.spo2Pct, 97.4)
        XCTAssertEqual(frame.respirationRpm, 13.3)
        XCTAssertEqual(frame.motion, 0.004)
    }

    /// Two fixtures, two different first frames. A test that only ever read
    /// anomaly.ndjson would pass against a decoder hard-wired to it.
    func testTheFirstRestFrameDecodesFieldByField() throws {
        let lines = try GoldenFixture.lines(for: .rest)
        let frame = try VitalsDecoder.frame(from: lines.frames[0])

        XCTAssertEqual(frame.deviceId, "sim-001")
        XCTAssertEqual(frame.seq, 0)
        XCTAssertEqual(frame.heartRateBpm, 63)
        XCTAssertEqual(frame.spo2Pct, 97.5)
        XCTAssertEqual(frame.respirationRpm, 14.1)
        XCTAssertEqual(frame.motion, 0.002)
    }

    // MARK: - The shape, not just the values

    /// Swift's synthesised `Codable` ignores keys it does not know, where
    /// `z.strictObject` rejects them. This is where that difference is caught:
    /// the type is re-encoded and its key set compared with the fixture's, so a
    /// field added to the wire, removed from the wire, or renamed on either
    /// side fails — including the cases a decode alone would sail through.
    func testEveryGoldenFrameHasExactlyTheKeysTheSwiftTypeCarries() throws {
        let encoder = JSONEncoder()
        for scenario in GoldenFixture.Scenario.allCases {
            let lines = try GoldenFixture.lines(for: scenario)
            for (index, line) in lines.frames.enumerated() {
                let frame = try VitalsDecoder.frame(from: line)
                let roundTripped = try GoldenFixture.keys(of: try encoder.encode(frame))
                let fixtureKeys = try GoldenFixture.keys(of: line)
                XCTAssertEqual(
                    roundTripped,
                    fixtureKeys,
                    "\(scenario.rawValue).ndjson frame \(index): the Swift type and the wire "
                        + "fixture disagree about which fields exist"
                )
            }
        }
    }

    // MARK: - The whole fixture, not just its first row

    func testEveryFrameInEveryFixtureDecodesAndSatisfiesTheTransportBounds() throws {
        for scenario in GoldenFixture.Scenario.allCases {
            let lines = try GoldenFixture.lines(for: scenario)
            let header = try JSONDecoder().decode(GoldenHeader.self, from: lines.header)
            // Against the header rather than against a literal, so a fixture
            // that loses a line fails here; and against the literal too, so a
            // header edited to match a shortened fixture does not slide past.
            XCTAssertEqual(
                lines.frames.count,
                header.config.count,
                "\(scenario.rawValue): the fixture and its own header disagree on frame count"
            )
            XCTAssertEqual(header.config.count, 120, "\(scenario.rawValue) frame count")

            for (index, line) in lines.frames.enumerated() {
                // VitalsDecoder runs validated(), so an out-of-bounds reading
                // throws here rather than reaching a view.
                let frame = try VitalsDecoder.frame(from: line)
                XCTAssertEqual(frame.seq, index, "\(scenario.rawValue) seq is the row index")
                XCTAssertEqual(
                    frame.capturedAtMs,
                    header.config.startAtMs + index * header.config.tickMs,
                    "\(scenario.rawValue) capture time advances by tickMs"
                )
                XCTAssertEqual(frame.deviceId, header.config.deviceId)
            }
        }
    }

    /// The fixture this project exists to surface. If the anomaly scenario ever
    /// stopped desaturating, the decode tests above would still pass while the
    /// contract carried nothing worth carrying.
    func testTheAnomalyFixtureCarriesADesaturationBelowTheAlertThreshold() throws {
        let lines = try GoldenFixture.lines(for: .anomaly)
        let frames = try lines.frames.map { try VitalsDecoder.frame(from: $0) }
        let lowest = try XCTUnwrap(frames.map(\.spo2Pct).min())
        XCTAssertLessThan(lowest, 90, "the anomaly fixture no longer breaches spo2-low")

        let rest = try GoldenFixture.lines(for: .rest)
        let restFrames = try rest.frames.map { try VitalsDecoder.frame(from: $0) }
        let restLowest = try XCTUnwrap(restFrames.map(\.spo2Pct).min())
        XCTAssertGreaterThanOrEqual(restLowest, 90, "the rest fixture must not breach")
    }

    // MARK: - What the client rejects

    func testAFrameAnnouncingAnotherProtocolVersionIsRejected() throws {
        let lines = try GoldenFixture.lines(for: .rest)
        let mutated = try mutate(lines.frames[0]) { $0["v"] = 2 }
        XCTAssertThrowsError(try VitalsDecoder.frame(from: mutated)) { error in
            XCTAssertEqual(error as? ContractError, .unsupportedVersion(2))
        }
    }

    func testAReadingOutsideItsTransportBoundIsRejected() throws {
        let lines = try GoldenFixture.lines(for: .rest)
        let tooHigh = try mutate(lines.frames[0]) { $0["spo2Pct"] = 101 }
        XCTAssertThrowsError(try VitalsDecoder.frame(from: tooHigh)) { error in
            XCTAssertEqual(error as? ContractError, .outOfBounds(field: "spo2Pct", value: 101))
        }

        let negative = try mutate(lines.frames[0]) { $0["motion"] = -0.1 }
        XCTAssertThrowsError(try VitalsDecoder.frame(from: negative))

        let impossibleRate = try mutate(lines.frames[0]) { $0["heartRateBpm"] = 301 }
        XCTAssertThrowsError(try VitalsDecoder.frame(from: impossibleRate))
    }

    /// A reading well outside the clinical normal range is still a valid frame.
    /// The bounds are transport validity; refusing an SpO2 of 45 here would
    /// throw away exactly the reading this pipeline exists to carry.
    func testAnAlarmingButRepresentableReadingIsAccepted() throws {
        let lines = try GoldenFixture.lines(for: .rest)
        let desaturated = try mutate(lines.frames[0]) { $0["spo2Pct"] = 45 }
        let frame = try VitalsDecoder.frame(from: desaturated)
        XCTAssertEqual(frame.spo2Pct, 45)
    }

    func testAFrameMissingAContractFieldIsRejected() throws {
        let lines = try GoldenFixture.lines(for: .rest)
        let withoutSpo2 = try mutate(lines.frames[0]) { $0.removeValue(forKey: "spo2Pct") }
        XCTAssertThrowsError(try VitalsDecoder.frame(from: withoutSpo2))
    }

    /// A fractional heart rate is not this contract's integer field. The
    /// server's schema says `z.int()`; Swift's `Int` has to agree.
    func testAFractionalHeartRateIsRejected() throws {
        let lines = try GoldenFixture.lines(for: .rest)
        let fractional = try mutate(lines.frames[0]) { $0["heartRateBpm"] = 62.5 }
        XCTAssertThrowsError(try VitalsDecoder.frame(from: fractional))
    }

    /// A rejected frame is counted and shown, so the reason has to be legible.
    func testEveryContractErrorExplainsItself() {
        let errors: [ContractError] = [
            .unsupportedVersion(2),
            .outOfBounds(field: "spo2Pct", value: 101),
            .unknownMessageType("telemetry")
        ]
        let sentences = errors.map { $0.localizedDescription }
        XCTAssertEqual(Set(sentences).count, 3)
        XCTAssertTrue(sentences[0].contains("2"))
        XCTAssertTrue(sentences[1].contains("spo2Pct"))
        XCTAssertTrue(sentences[2].contains("telemetry"))
    }

    // MARK: -

    /// Mutates one golden line and re-serialises it, so the negative tests
    /// start from real bytes rather than from a hand-written approximation of
    /// them.
    private func mutate(
        _ line: Data,
        _ change: (inout [String: Any]) -> Void
    ) throws -> Data {
        var object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: line) as? [String: Any]
        )
        change(&object)
        return try JSONSerialization.data(withJSONObject: object)
    }
}
