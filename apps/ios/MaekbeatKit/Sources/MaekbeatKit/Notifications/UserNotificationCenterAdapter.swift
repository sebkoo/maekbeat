#if canImport(UserNotifications)
import Foundation
import UserNotifications

/*
 * The adapter, and the only file in this package that imports UserNotifications.
 *
 * Same shape as C15's radio and for the same reason: a CI runner grants no
 * authorization and delivers nothing, so anything that lives here cannot be
 * executed by the gate. It therefore decides nothing — no dedupe, no wording,
 * no judgement about whether an alert deserves a banner. `NotificationPolicy`
 * owns all of that and is tested exhaustively.
 *
 * What CI does reach, on a simulator with no user to ask:
 *   - the authorization translation below, for every case the framework has,
 *   - building the request and the category from a `CaregiverNotification`.
 *
 * What CI cannot reach — and this is a harder line than C15's radio, which at
 * least constructs: `UNUserNotificationCenter.current()` raises
 * `NSInternalInconsistencyException` in a SwiftPM test bundle on macOS *and* on
 * the simulator, because the xctest agent has no app bundle proxy. So every
 * instance method below is unexercised by any gate in this repository, not
 * merely unverified in its effect. Closing that would take an app-hosted test
 * target, which this package does not have.
 *
 * The rest needs a device and a person anyway: the permission prompt, delivery,
 * the action callback, and anything about background or terminated state.
 * apps/ios/README.md lists it row by row.
 */
@MainActor
public final class UserNotificationCenterAdapter: NotificationPort {
    private let center: UNUserNotificationCenter

    public init(center: UNUserNotificationCenter = .current()) {
        self.center = center
    }

    // MARK: - Pure translations (these do run in CI)

    /// The framework's authorization as this app's vocabulary.
    public static func authorization(
        for status: UNAuthorizationStatus
    ) -> NotificationAuthorization {
        switch status {
        case .notDetermined: return .notDetermined
        case .denied: return .denied
        case .authorized: return .authorized
        case .provisional: return .provisional
        case .ephemeral: return .provisional
        @unknown default: return .restricted
        }
    }

    /// The request the centre schedules. Its identifier is the `alertId`, which
    /// is what makes a second schedule for one episode replace rather than
    /// stack — the dedupe the policy already refuses to reach, belt and braces.
    public static func request(for notification: CaregiverNotification) -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.body = notification.body
        content.categoryIdentifier = CaregiverNotification.categoryIdentifier
        content.userInfo = [
            "alertId": notification.alertId,
            "deviceId": notification.deviceId
        ]
        return UNNotificationRequest(
            identifier: notification.identifier,
            content: content,
            trigger: nil
        )
    }

    /// The two actions, registered once so the buttons exist on the banner.
    public static func category() -> UNNotificationCategory {
        let actions = CaregiverNotification.Action.allCases.map { action in
            UNNotificationAction(
                identifier: action.rawValue,
                title: action.label,
                options: [.authenticationRequired]
            )
        }
        return UNNotificationCategory(
            identifier: CaregiverNotification.categoryIdentifier,
            actions: actions,
            intentIdentifiers: [],
            options: []
        )
    }

    // MARK: - NotificationPort

    public func registerCategories() {
        center.setNotificationCategories([Self.category()])
    }

    public func currentAuthorization() async -> NotificationAuthorization {
        let settings = await center.notificationSettings()
        return Self.authorization(for: settings.authorizationStatus)
    }

    @discardableResult
    public func requestAuthorization() async -> NotificationAuthorization {
        _ = try? await center.requestAuthorization(options: [.alert, .sound])
        return await currentAuthorization()
    }

    public func schedule(_ notification: CaregiverNotification) {
        center.add(Self.request(for: notification))
    }

    public func withdraw(alertId: String) {
        center.removePendingNotificationRequests(withIdentifiers: [alertId])
        center.removeDeliveredNotifications(withIdentifiers: [alertId])
    }
}
#endif
