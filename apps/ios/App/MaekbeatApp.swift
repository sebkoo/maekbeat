import MaekbeatKit
import SwiftUI

/*
 * The whole app target: one entry point and nothing else.
 *
 * Everything Maekbeat does lives in MaekbeatKit, because that is the target
 * apps/ios/scripts/coverage-gate.sh measures. This file is the iOS analogue of
 * apps/web/src/main.tsx — untested by construction, so it is kept small enough
 * that there is nothing in it to test. A source scan in
 * MaekbeatKit/Tests/MaekbeatKitTests/SourceDisciplineTests.swift fails the
 * build if it grows.
 */
@main
struct MaekbeatApp: App {
    var body: some Scene {
        WindowGroup {
            RootView(client: APIClient(baseURL: Self.baseURL))
        }
    }

    /// The server to read. Defaults to the loopback address the iOS Simulator
    /// shares with the host Mac; override it in the scheme's environment to
    /// point a device at a Mac on the same network.
    private static var baseURL: URL {
        let raw = ProcessInfo.processInfo.environment["MAEKBEAT_API_BASE_URL"]
        guard let raw, let url = URL(string: raw) else { return APIClient.defaultBaseURL }
        return url
    }
}
