import Foundation

/*
 * The seam between the policy and the notification centre.
 *
 * `UNUserNotificationCenter` cannot be exercised where the deciding happens: a
 * CI runner never grants authorization and never delivers anything. So the same
 * shape as C15's radio — every decision above this protocol, and an adapter
 * below it that only translates. apps/ios/README.md says which side of the line
 * each behaviour falls on.
 */

/// What the user has allowed, translated at the adapter so nothing downstream
/// imports the framework or names its types.
public enum NotificationAuthorization: String, Sendable, CaseIterable {
    /// Not asked yet.
    case notDetermined
    /// Asked and refused. The state this app has to be loudest about.
    case denied
    case authorized
    /// Delivered quietly to the notification centre without interrupting.
    case provisional
    /// A managed configuration decides, and it has not said yes.
    case restricted

    /// Whether a scheduled notification would reach anybody.
    public var canDeliver: Bool {
        switch self {
        case .authorized, .provisional: return true
        case .notDetermined, .denied, .restricted: return false
        }
    }
}

/// The notification centre, as much of it as this app uses.
@MainActor
public protocol NotificationPort: AnyObject {
    /// Registers the actions, without which the banner has no buttons and a
    /// caregiver can read an alert but not answer it.
    func registerCategories()
    func currentAuthorization() async -> NotificationAuthorization
    /// Asks, once. Returns what the user chose.
    @discardableResult
    func requestAuthorization() async -> NotificationAuthorization
    func schedule(_ notification: CaregiverNotification)
    /// Takes back a delivered or pending notification by its identifier.
    func withdraw(alertId: String)
}

/// The port on a platform with no notification centre — macOS unit runs, and
/// anything else `canImport(UserNotifications)` is false for. It refuses
/// rather than pretends: `notDetermined` is the truth about what a caller can
/// expect from it, and the policy suppresses accordingly.
public final class InertNotificationPort: NotificationPort {
    public init() {}
    public func registerCategories() {}
    public func currentAuthorization() async -> NotificationAuthorization { .notDetermined }
    @discardableResult
    public func requestAuthorization() async -> NotificationAuthorization { .notDetermined }
    public func schedule(_ notification: CaregiverNotification) {}
    public func withdraw(alertId: String) {}
}
