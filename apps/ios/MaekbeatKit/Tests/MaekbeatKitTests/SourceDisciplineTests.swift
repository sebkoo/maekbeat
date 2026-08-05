import XCTest
@testable import MaekbeatKit

/*
 * Source scans, the way apps/web/src/styles/tokens.test.ts scans its own
 * package: a few rules that no runtime assertion can reach, checked against the
 * files this target actually ships.
 *
 * Two of them are honesty rules rather than engineering ones. This app has no
 * radio and no store presence, and the fastest way for a portfolio repo to
 * start lying is for a view to get named `BLEDeviceView` in a commit that added
 * no Bluetooth. These fail the build instead.
 */
final class SourceDisciplineTests: XCTestCase {
    private static var sourcesDirectory: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<3 { url = url.deletingLastPathComponent() }
        return url.appendingPathComponent("Sources/MaekbeatKit")
    }

    private static var appShellDirectory: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url = url.deletingLastPathComponent() }
        return url.appendingPathComponent("App")
    }

    private func swiftFiles(in directory: URL) throws -> [(name: String, text: String)] {
        let urls = try FileManager.default
            .contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        var found: [(String, String)] = []
        for url in urls {
            var isDirectory: ObjCBool = false
            FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory)
            if isDirectory.boolValue {
                found += try swiftFiles(in: url)
            } else if url.pathExtension == "swift" {
                found.append((url.lastPathComponent, try String(contentsOf: url, encoding: .utf8)))
            }
        }
        return found
    }

    /// The lines of a Swift file that are code, with blank lines and both
    /// comment forms removed. Prose in this repository is long enough that a
    /// scan reading it as code says the wrong thing in both directions.
    static func codeLines(of text: String) -> [String] {
        var inBlockComment = false
        return text
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { line in
                if inBlockComment {
                    if line.contains("*/") { inBlockComment = false }
                    return false
                }
                if line.hasPrefix("/*") {
                    inBlockComment = !line.contains("*/")
                    return false
                }
                return !line.isEmpty && !line.hasPrefix("//")
            }
    }

    private func sources() throws -> [(name: String, text: String)] {
        let files = try swiftFiles(in: Self.sourcesDirectory)
        XCTAssertGreaterThan(files.count, 8, "the scan found almost nothing — check the path")
        return files
    }

    // MARK: - No hardware this app does not have

    /// C14 ships a simulator transport and nothing else. CoreBluetooth is C15's
    /// commit, and until it lands, a symbol suggesting a radio is a claim about
    /// a capability that does not exist.
    func testNothingInThisPackageNamesARadioItDoesNotHave() throws {
        let banned = [
            "CoreBluetooth", "CBCentralManager", "CBPeripheral", "CBUUID",
            "Bluetooth", "GATT", "advertis", "pairing", "RSSI"
        ]
        for file in try sources() {
            for term in banned {
                XCTAssertFalse(
                    file.text.localizedCaseInsensitiveContains(term),
                    "\(file.name) names \(term); this commit has no radio — that is C15"
                )
            }
        }
    }

    /// The same rule for the other easy lie. There is no App Store listing, no
    /// purchase, and no push notification in this repository.
    func testNothingClaimsAStoreListingOrPushNotifications() throws {
        let banned = ["StoreKit", "App Store", "in-app purchase", "UNUserNotificationCenter", "APNs"]
        for file in try sources() {
            for term in banned {
                XCTAssertFalse(
                    file.text.localizedCaseInsensitiveContains(term),
                    "\(file.name) names \(term), which this commit does not ship"
                )
            }
        }
    }

    // MARK: - The disclaimer is in the interface

    func testTheRootScreenRendersTheDisclaimerBarAboveTheNavigationStack() throws {
        let root = try XCTUnwrap(try sources().first { $0.name == "RootView.swift" })
        // Comment lines are dropped first: the doc comment on RootView explains
        // this very rule and names `NavigationStack` while doing so, which would
        // otherwise be the match the ordering check reads.
        let code = Self.codeLines(of: root.text).joined(separator: "\n")
        guard let bar = code.range(of: "DisclaimerBar()") else {
            return XCTFail("RootView must render the disclaimer, not merely import it")
        }
        guard let stack = code.range(of: "NavigationStack") else {
            return XCTFail("RootView is expected to hold the navigation stack")
        }
        // Rendering it is not enough: inside the stack, the bar is replaced on
        // every push, and the line vanishes on exactly the screens — a device
        // that failed to load, a detail view — where a reader is most likely to
        // be asking what this software is.
        XCTAssertTrue(
            bar.lowerBound < stack.lowerBound,
            "DisclaimerBar must sit above the NavigationStack so every pushed "
                + "screen keeps it, not inside it where a push replaces it"
        )
    }

    /// The app target compiles what the project tells it to, and the project can
    /// name any path. Without this, a file outside App/ could be built into the
    /// app while the shell cap, the coverage gate, and the source scans above
    /// all keep reporting on files it does not contain.
    func testTheAppTargetCompilesOnlyTheShell() throws {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url = url.deletingLastPathComponent() }
        let project = try String(
            contentsOf: url.appendingPathComponent("Maekbeat.xcodeproj/project.pbxproj"),
            encoding: .utf8
        )
        let phase = try XCTUnwrap(
            project.range(of: "/* Begin PBXSourcesBuildPhase section */")
        )
        let end = try XCTUnwrap(project.range(of: "/* End PBXSourcesBuildPhase section */"))
        let compiled = project[phase.upperBound..<end.lowerBound]
            .split(separator: "\n")
            .filter { $0.contains("in Sources */,") }

        XCTAssertEqual(compiled.count, 1, "the app target compiles more than the shell")
        XCTAssertTrue(
            compiled.first?.contains("MaekbeatApp.swift") == true,
            "the app target compiles something other than App/MaekbeatApp.swift: "
                + String(compiled.first ?? "")
        )
    }

    func testTheDisclaimerBarRendersTheLineAndTheTransportItActuallyUses() throws {
        let bar = try XCTUnwrap(try sources().first { $0.name == "DisclaimerBar.swift" })
        XCTAssertTrue(bar.text.contains("Copy.notAMedicalDevice"))
        XCTAssertTrue(bar.text.contains("Copy.simulatorTransport"))
        XCTAssertTrue(Copy.notAMedicalDevice.localizedCaseInsensitiveContains("not a medical device"))
        XCTAssertTrue(Copy.notAMedicalDevice.localizedCaseInsensitiveContains("synthetic data"))
        // The line about what the transport is must not imply a device radio.
        XCTAssertTrue(Copy.simulatorTransport.localizedCaseInsensitiveContains("WebSocket"))
    }

    // MARK: - The network lives in two files

    /// A view that can open its own connection is a view whose failure states
    /// nobody designed. apps/web enforces this with a source scan; so does this.
    func testOnlyTheTwoTransportModulesTouchTheNetwork() throws {
        let allowed: Set<String> = ["APIClient.swift", "StreamClient.swift"]
        let networkSymbols = ["URLSession", "URLRequest", "webSocketTask", "dataTask"]
        for file in try sources() where !allowed.contains(file.name) {
            for symbol in networkSymbols {
                XCTAssertFalse(
                    file.text.contains(symbol),
                    "\(file.name) opens a connection; the network belongs to \(allowed.sorted())"
                )
            }
        }
    }

    // MARK: - One measured target, and no siblings

    /// The coverage gate measures the `MaekbeatKit` target. A second SwiftPM
    /// target is therefore a way to ship code that no threshold covers — and it
    /// is worse than an `exclude:` entry, because a target with no exercised
    /// code does not appear in the xccov report at all, so the gate has no row
    /// to object to. It was proved: adding one left the gate green at the same
    /// 91.37%. This is where that is caught, at the declaration rather than in
    /// the measurement.
    func testThePackageDeclaresOnlyTheMeasuredTargetAndItsTests() throws {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<3 { url = url.deletingLastPathComponent() }
        let manifest = try String(
            contentsOf: url.appendingPathComponent("Package.swift"),
            encoding: .utf8
        )

        var declared: Set<String> = []
        for line in Self.codeLines(of: manifest) {
            guard line.contains(".target(name:") || line.contains(".testTarget(name:") else {
                continue
            }
            guard let open = line.range(of: "name: \""),
                  let close = line.range(of: "\"", range: open.upperBound..<line.endIndex) else {
                continue
            }
            declared.insert(String(line[open.upperBound..<close.lowerBound]))
        }

        XCTAssertEqual(
            declared,
            ["MaekbeatKit", "MaekbeatKitTests"],
            "the package declares a target the coverage gate does not measure; fold it into "
                + "MaekbeatKit or measure it in apps/ios/scripts/coverage-gate.sh"
        )

        // Declared names are not the whole story: a target can be given a path.
        // The directory listing has to agree.
        let sourceDirs = try FileManager.default
            .contentsOfDirectory(atPath: url.appendingPathComponent("Sources").path)
            .filter { !$0.hasPrefix(".") }
        XCTAssertEqual(Set(sourceDirs), ["MaekbeatKit"], "an unmeasured source directory exists")
    }

    // MARK: - The app target stays a shell

    /// Everything the app does lives in the library, because the library is
    /// what the coverage gate measures. The @main shell is allowed to exist and
    /// not allowed to grow: apps/ios/scripts/coverage-gate.sh cannot see it, so
    /// this is the check that keeps it uninteresting.
    func testTheAppTargetIsAShellAndNothingElse() throws {
        let files = try swiftFiles(in: Self.appShellDirectory)
        XCTAssertEqual(files.count, 1, "the app target holds one file: the @main entry point")

        let shell = try XCTUnwrap(files.first)
        let code = Self.codeLines(of: shell.text)
        XCTAssertLessThanOrEqual(
            code.count,
            20,
            "the app shell has grown to \(code.count) lines of code, which the coverage gate "
                + "cannot measure — move the logic into MaekbeatKit"
        )
        XCTAssertTrue(code.contains { $0.contains("RootView(") },
                      "the shell must show the library's root view")
    }
}
