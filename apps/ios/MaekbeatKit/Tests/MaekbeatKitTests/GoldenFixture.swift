import Foundation
import XCTest

/*
 * Locating the goldens, and refusing to pass without them.
 *
 * The fixtures belong to packages/vitals-sim. Nothing is copied into apps/ios —
 * a copy would be a second truth that drifts quietly, which is exactly the
 * failure this mechanism exists to prevent. The path is derived from #filePath
 * so it survives a clone anywhere, including a CI checkout.
 *
 * Every accessor here throws rather than skipping. A contract test that
 * silently skips when its fixture is missing is a green tick for work nobody
 * did.
 */
enum GoldenFixture {
    enum Scenario: String, CaseIterable {
        case rest
        case motion
        case anomaly
    }

    /// The repository root, six directories above this file:
    /// <root>/apps/ios/MaekbeatKit/Tests/MaekbeatKitTests/GoldenFixture.swift
    static var repositoryRoot: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url = url.deletingLastPathComponent() }
        return url
    }

    static var goldenDirectory: URL {
        repositoryRoot.appendingPathComponent("packages/vitals-sim/golden")
    }

    static func url(for scenario: Scenario) -> URL {
        goldenDirectory.appendingPathComponent("\(scenario.rawValue).ndjson")
    }

    /// The header line and the frame lines, as raw bytes. The split is part of
    /// the contract: line 0 is the generator header, every line after it is a
    /// frame.
    struct Lines {
        let header: Data
        let frames: [Data]
    }

    static func lines(for scenario: Scenario) throws -> Lines {
        let url = url(for: scenario)
        let data = try Data(contentsOf: url)
        let newline = UInt8(ascii: "\n")
        let rows: [Data] = data
            .split(separator: newline, omittingEmptySubsequences: true)
            .map { Data($0) }
        guard let header = rows.first, rows.count > 1 else {
            throw Failure.emptyFixture(url.path)
        }
        return Lines(header: header, frames: Array(rows.dropFirst()))
    }

    /// The key set of one JSON object line, used to compare the fixture's shape
    /// against what a Swift type round-trips to.
    static func keys(of line: Data) throws -> Set<String> {
        guard let object = try JSONSerialization.jsonObject(with: line) as? [String: Any] else {
            throw Failure.notAnObject
        }
        return Set(object.keys)
    }

    enum Failure: Error {
        case emptyFixture(String)
        case notAnObject
    }
}

/// The generator header, mirroring what packages/vitals-sim writes as line 0.
/// Decoded rather than string-matched, so a reshaped header fails here.
struct GoldenHeader: Decodable {
    struct Config: Decodable {
        let scenario: String
        let deviceId: String
        let startAtMs: Int
        let tickMs: Int
        let count: Int
    }

    let seed: Int
    let config: Config
    let generatorVersion: Int
}
