import XCTest
@testable import MaekbeatKit

/*
 * The notification is labelling, and labelling is subject to G3.
 *
 * This is the one string in the repository that arrives unbidden on a lock
 * screen, out of context, with none of the disclaimers the app and the
 * dashboard carry on every view. If any sentence in this project is going to be
 * mistaken for a medical claim, it is this one — so the wording is asserted
 * rather than reviewed.
 */
final class NotificationCopyTests: XCTestCase {
    private func alert(
        metric: AlertMetric = .spo2Pct,
        direction: AlertDirection = .low,
        deviceId: String = "sim-001"
    ) -> AlertEvent {
        AlertEvent(
            alertId: "\(deviceId):rule:1",
            deviceId: deviceId,
            metric: metric,
            direction: direction,
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

    /// Every wording a real alert can produce, so the check covers the product
    /// of metrics and directions rather than one example.
    private var everyNotification: [CaregiverNotification] {
        AlertMetric.allCases.flatMap { metric in
            AlertDirection.allCases.map { direction in
                CaregiverNotification.forAlert(alert(metric: metric, direction: direction))
            }
        }
    }

    /// No diagnosis, no clinical reading, no urgency this system cannot
    /// justify. A threshold rule fired; that is the whole of what is known.
    func testNoNotificationClaimsAClinicalMeaning() {
        let banned = [
            "diagnos", "hypox", "desaturation", "seizure", "critical", "emergency",
            "urgent", "danger", "abnormal", "unsafe", "patient", "symptom",
            "condition", "medical attention", "call a doctor", "vital signs are"
        ]
        for notification in everyNotification {
            let text = "\(notification.title) \(notification.body)"
            for word in banned {
                XCTAssertFalse(
                    text.localizedCaseInsensitiveContains(word),
                    "notification copy names \"\(word)\": \(text)"
                )
            }
        }
    }

    /// And says, affirmatively, the two things that keep it honest: the numbers
    /// are synthetic, and this is not a medical device.
    func testEveryNotificationSaysWhatTheDataIsAndWhatTheAppIsNot() {
        for notification in everyNotification {
            XCTAssertTrue(
                notification.body.localizedCaseInsensitiveContains("synthetic"),
                notification.body
            )
            XCTAssertTrue(
                notification.body.localizedCaseInsensitiveContains("not a medical device"),
                notification.body
            )
            XCTAssertTrue(
                notification.body.localizedCaseInsensitiveContains("demo threshold"),
                "the body must attribute the alert to a demo rule: \(notification.body)"
            )
        }
    }

    /// It reports the rule that fired and the device it fired on, because a
    /// notification a caregiver cannot act on is noise.
    func testTheCopyIdentifiesTheRuleTheDeviceAndTheTime() {
        let notification = CaregiverNotification.forAlert(alert())

        XCTAssertTrue(notification.title.contains("sim-001"))
        XCTAssertTrue(notification.body.contains("spo2Pct"))
        XCTAssertTrue(notification.body.contains("below"))
        XCTAssertTrue(notification.body.contains(Format.time(1_754_265_640_000)))
    }

    func testDirectionIsReportedAsGivenRatherThanInterpreted() {
        let low = CaregiverNotification.forAlert(alert(direction: .low))
        let high = CaregiverNotification.forAlert(alert(direction: .high))

        XCTAssertTrue(low.body.contains("below"))
        XCTAssertTrue(high.body.contains("above"))
        XCTAssertNotEqual(low.body, high.body)
    }

    /// The two actions are the two decisions the server records, and nothing
    /// else — an action with no matching decision would be a button that does
    /// not reach the log.
    func testTheActionsAreExactlyTheTwoDecisionsTheServerRecords() {
        let notification = CaregiverNotification.forAlert(alert())

        XCTAssertEqual(notification.actions, [.acknowledge, .dismiss])
        XCTAssertEqual(
            Set(notification.actions.map(\.decision)),
            Set(AlertDecision.allCases)
        )
        XCTAssertEqual(notification.actions.map(\.label), ["Acknowledge", "Dismiss"])
    }
}
