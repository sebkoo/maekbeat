#if canImport(UserNotifications)
import UserNotifications
import XCTest
@testable import MaekbeatKit

/*
 * The slice of the UserNotifications adapter that CI can execute.
 *
 * A CI runner grants no authorization and delivers nothing, so nothing here
 * proves a notification ever reaches a person. What it does prove without a
 * device: the authorization translation for every case the framework declares,
 * the request the centre would be handed, and that reading the current
 * authorization from a real centre works at all.
 *
 * The permission prompt, delivery, the action callback and anything about
 * background or terminated state need a device and a person.
 * apps/ios/README.md lists them.
 */
@MainActor
final class NotificationAdapterTests: XCTestCase {
    private func alert(_ alertId: String = "sim-001:spo2-low:1") -> AlertEvent {
        AlertEvent(
            alertId: alertId,
            deviceId: "sim-001",
            metric: .spo2Pct,
            direction: .low,
            state: .raised,
            raisedAtMs: 1_754_265_640_000,
            resolvedAtMs: nil,
            windowStats: AlertWindowStats(
                windowMs: 15_000,
                sampleCount: 12,
                breachCount: 5,
                minValue: 87.5,
                maxValue: 91.2
            )
        )
    }

    // MARK: - Translation (pure, every case)

    /// `.ephemeral` is an App Clip state and exists only on iOS — the adapter
    /// can match it in a switch on either platform but nothing can name it as a
    /// value on macOS, so the row is compiled in where it is real.
    private static var expectedTranslations: [UNAuthorizationStatus: NotificationAuthorization] {
        var expected: [UNAuthorizationStatus: NotificationAuthorization] = [
            .notDetermined: .notDetermined,
            .denied: .denied,
            .authorized: .authorized,
            .provisional: .provisional
        ]
        #if os(iOS)
        expected[.ephemeral] = .provisional
        #endif
        return expected
    }

    func testEveryAuthorizationStatusTranslatesToExactlyOneState() {
        let expected = Self.expectedTranslations
        for (status, state) in expected {
            XCTAssertEqual(
                UserNotificationCenterAdapter.authorization(for: status),
                state,
                "\(status.rawValue)"
            )
        }
        #if os(iOS)
        XCTAssertEqual(expected.count, 5, "UNAuthorizationStatus gained a case")
        #else
        XCTAssertEqual(expected.count, 4, "UNAuthorizationStatus gained a case")
        #endif
    }

    /// Only the two states that actually deliver are treated as delivering. A
    /// translation that let `denied` through would have the policy scheduling
    /// into a void and the interface reporting coverage that does not exist.
    func testOnlyStatusesThatReallyDeliverTranslateToSomethingThatDelivers() {
        let delivering = Self.expectedTranslations
            .filter { UserNotificationCenterAdapter.authorization(for: $0.key).canDeliver }
            .map(\.value)

        XCTAssertTrue(delivering.allSatisfy { $0 == .provisional || $0 == .authorized })
        XCTAssertFalse(
            UserNotificationCenterAdapter.authorization(for: .denied).canDeliver,
            "a refusal must never read as coverage"
        )
        XCTAssertFalse(UserNotificationCenterAdapter.authorization(for: .notDetermined).canDeliver)
    }

    // MARK: - The request the centre would be handed

    func testTheRequestCarriesTheCopyTheIdentifierAndTheRoutingInfo() {
        let notification = CaregiverNotification.forAlert(alert())
        let request = UserNotificationCenterAdapter.request(for: notification)

        XCTAssertEqual(
            request.identifier,
            "sim-001:spo2-low:1",
            "the identifier is the alertId, so re-scheduling replaces"
        )
        XCTAssertEqual(request.content.title, notification.title)
        XCTAssertEqual(request.content.body, notification.body)
        XCTAssertEqual(request.content.categoryIdentifier, CaregiverNotification.categoryIdentifier)
        XCTAssertEqual(request.content.userInfo["alertId"] as? String, "sim-001:spo2-low:1")
        XCTAssertEqual(request.content.userInfo["deviceId"] as? String, "sim-001")
        XCTAssertNil(request.trigger, "an alert that already fired is delivered now")
    }

    /// Two episodes must not share an identifier, or one banner would silently
    /// replace the other and a caregiver would see one alert instead of two.
    func testTwoEpisodesProduceTwoIdentifiers() {
        let first = UserNotificationCenterAdapter.request(
            for: CaregiverNotification.forAlert(alert("sim-001:spo2-low:1"))
        )
        let second = UserNotificationCenterAdapter.request(
            for: CaregiverNotification.forAlert(alert("sim-001:hr-high:2"))
        )
        XCTAssertNotEqual(first.identifier, second.identifier)
    }

    /// The category is what puts the buttons on the banner. Without both
    /// actions registered under the identifier the content names, the caregiver
    /// gets a notification they cannot act on — and the circuit never closes.
    func testTheCategoryRegistersBothActionsUnderTheIdentifierTheContentUses() {
        let category = UserNotificationCenterAdapter.category()

        XCTAssertEqual(category.identifier, CaregiverNotification.categoryIdentifier)
        XCTAssertEqual(
            category.actions.map(\.identifier),
            CaregiverNotification.Action.allCases.map(\.rawValue)
        )
        XCTAssertEqual(category.actions.map(\.title), ["Acknowledge", "Dismiss"])
    }

}
#endif
