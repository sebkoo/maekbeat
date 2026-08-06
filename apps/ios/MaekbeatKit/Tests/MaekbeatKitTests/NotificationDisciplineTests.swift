import XCTest
@testable import MaekbeatKit

/*
 * The C16 half of the source scans, split from SourceDisciplineTests.swift only
 * because that file passed the 400-line limit its own suite enforces elsewhere.
 * Same type, same scanners — the rules here are about the notification centre:
 * where its vocabulary is allowed to appear, and what the adapter may not know.
 */
extension SourceDisciplineTests {

    /// C15 banned the notification framework outright, because C15 shipped no
    /// notifications. C16 does, so the ban becomes the same kind of boundary
    /// the radio has: `UserNotifications` may be named in the adapter and
    /// nowhere else. Everything above it decides; the adapter only translates.
    func testTheNotificationFrameworkIsNamedInExactlyOneFile() throws {
        let adapter = "UserNotificationCenterAdapter.swift"
        let symbols = ["import UserNotifications", "UNUserNotificationCenter",
                       "UNMutableNotificationContent", "UNNotificationRequest",
                       "UNAuthorizationStatus", "UNNotificationCategory", "UNNotificationAction"]
        let files = try sources()

        for file in files where file.name != adapter {
            let code = Self.codeLines(of: file.text).joined(separator: "\n")
            for symbol in symbols {
                XCTAssertFalse(
                    code.contains(symbol),
                    "\(file.name) names \(symbol); the notification centre belongs to \(adapter)"
                )
            }
        }

        let file = try XCTUnwrap(files.first { $0.name == adapter }, "the adapter is gone")
        XCTAssertTrue(file.text.contains("import UserNotifications"))
    }

    /// The adapter earns its exemption by holding no decisions. Whether an
    /// alert notifies, whether it is a duplicate, and what the body says are
    /// all `NotificationPolicy`'s, where the gate can reach them.
    func testTheNotificationAdapterHoldsNoLogicOfItsOwn() throws {
        let file = try XCTUnwrap(
            try sources().first { $0.name == "UserNotificationCenterAdapter.swift" }
        )
        let code = Self.codeLines(of: file.text).joined(separator: "\n")
        for symbol in ["NotificationPolicy", "notified", "alreadyNotified", "Set<String>",
                       "decision", "APIClient", "if alert", "Suppression"] {
            XCTAssertFalse(
                code.contains(symbol),
                "the adapter names \(symbol); decisions belong in NotificationPolicy"
            )
        }
        let lineCount = Self.codeLines(of: file.text).count
        XCTAssertLessThanOrEqual(lineCount, 90, "the untestable adapter has grown to \(lineCount) lines")
    }

    /// Registration has no behavioural test above it, so it has a source scan.
    ///
    /// `prepare()` is covered by NotificationCoordinatorTests, but *nobody
    /// calling it* is the C12a failure again: the coordinator would be correct,
    /// the app would never register its actions, and every banner would arrive
    /// with no buttons. A rendered `RootView` does not run its own `.task`, so
    /// there is no assertion available here that a render could make — this
    /// checks the call is written, which is weaker than checking it happens,
    /// and is recorded as such in docs/ai/mutation-log.md.
    func testTheRootScreenPreparesTheNotificationCentre() throws {
        let file = try XCTUnwrap(try sources().first { $0.name == "RootView.swift" })
        let code = Self.codeLines(of: file.text).joined(separator: "\n")
        XCTAssertTrue(
            code.contains("notifications.prepare()"),
            "RootView must prepare the notification centre, or no category is ever registered"
        )
    }

    /// The same rule for the other easy lie, and one distinction worth keeping:
    /// these are **local** notifications, scheduled by the phone from an alert
    /// it received on its own socket. There is no push server, no device token,
    /// and no delivery this project could make while the app has never run.
    func testNothingClaimsAStoreListingOrRemotePush() throws {
        let banned = ["StoreKit", "App Store", "in-app purchase", "APNs",
                      "remote notification", "device token", "push certificate"]
        for file in try sources() {
            for term in banned {
                XCTAssertFalse(
                    file.text.localizedCaseInsensitiveContains(term),
                    "\(file.name) names \(term), which this commit does not ship"
                )
            }
        }
    }
}
