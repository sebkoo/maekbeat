import Foundation

/*
 * What a caregiver notification says, as a value.
 *
 * A notification is labelling, and labelling is subject to G3. This one reports
 * that a demo threshold rule fired on synthetic data — it does not describe a
 * physiological state, name a condition, or imply that anything needs doing
 * medically. NotificationCopyTests holds it to that with a word list, because
 * the wording of an alert is exactly the place where a demo starts sounding
 * like a device.
 *
 * No UserNotifications import: this is a value the policy produces and the
 * adapter renders, which is what keeps the deciding half testable.
 */
public struct CaregiverNotification: Equatable, Sendable {
    /// The OS-level identifier, and the dedupe key. It is the `alertId`, so
    /// scheduling the same episode twice replaces one notification rather than
    /// stacking two — the second half of the dedupe, below the policy's own.
    public let identifier: String
    public let deviceId: String
    public let alertId: String
    public let title: String
    public let body: String
    /// The two actions, matching the two decisions the server records.
    public let actions: [Action]

    public enum Action: String, Sendable, CaseIterable {
        case acknowledge
        case dismiss

        /// What the caregiver taps.
        public var label: String {
            switch self {
            case .acknowledge: return "Acknowledge"
            case .dismiss: return "Dismiss"
            }
        }

        /// The decision this action records. `acknowledged` is seen and acted
        /// on; `dismissed` is seen and judged not actionable — the distinction
        /// the C23 product loop counts.
        public var decision: AlertDecision {
            switch self {
            case .acknowledge: return .acknowledged
            case .dismiss: return .dismissed
            }
        }
    }

    /// The category the adapter registers the actions under.
    public static let categoryIdentifier = "dev.maekbeat.alert"

    /// Builds the notification for one alert.
    ///
    /// The wording is deliberately flat. "spo2Pct went below a demo threshold"
    /// is a statement about a rule in apps/server/src/alerts.ts; "low blood
    /// oxygen" would be a statement about a person, and there is no person —
    /// the numbers come from packages/vitals-sim.
    ///
    /// The body does not say "not a diagnosis" even though it would be true:
    /// the word list in NotificationCopyTests is total, prose included, and a
    /// disclaimer that has to be exempted from a ban weakens the ban for
    /// everything else. "Not a medical device" is the repository's phrase
    /// anyway, and it carries the same meaning without the loophole.
    public static func forAlert(_ alert: AlertEvent) -> Self {
        let direction = alert.direction == .low ? "below" : "above"
        return Self(
            identifier: alert.alertId,
            deviceId: alert.deviceId,
            alertId: alert.alertId,
            title: "Demo rule fired — \(alert.deviceId)",
            body: "\(alert.metric.rawValue) went \(direction) a demo threshold at "
                + "\(Format.time(alert.raisedAtMs)). Synthetic data from a simulated "
                + "device; not a medical device.",
            actions: Action.allCases
        )
    }
}
