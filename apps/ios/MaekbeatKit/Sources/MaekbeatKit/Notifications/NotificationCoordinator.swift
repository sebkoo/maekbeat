import Foundation
import Observation

/*
 * The circuit, closed: server alert → notification → caregiver action →
 * the append-only decision log the dashboard writes to.
 *
 * This is the first end-to-end loop in the repository, and the leg that makes
 * it one is the last: a decision taken from a notification has to land
 * server-side exactly as one taken from apps/web does, under the same
 * `alertId`, in the same log, fanned out to every other client. Anything less
 * is a phone that agrees with itself.
 *
 * It decides nothing about which alerts notify — `NotificationPolicy` owns
 * that — and touches no framework. The adapter below the port does both of the
 * things CI cannot check; everything here is driven by a fake in the tests.
 */
@MainActor
@Observable
public final class NotificationCoordinator {
    public private(set) var authorization: NotificationAuthorization = .notDetermined
    public private(set) var delivered = 0
    public private(set) var withdrawn = 0
    /// Suppressions by reason. `alreadyNotified` climbing after a reconnect is
    /// the policy doing its job; `notAuthorized` climbing is the interface's
    /// problem to state.
    public private(set) var suppressions: [NotificationPolicy.Suppression: Int] = [:]
    /// Decisions the server refused. A notification that recorded nothing must
    /// not look like one that did.
    public private(set) var decisionFailures = 0
    public private(set) var decisionsRecorded = 0

    private var policy = NotificationPolicy()
    private let port: NotificationPort
    private let client: APIClient

    public init(port: NotificationPort, client: APIClient) {
        self.port = port
        self.client = client
    }

    /// The composition root, matching `GatewayModel.live`. Nothing constructs
    /// this in a test: `UNUserNotificationCenter.current()` raises in a bundle
    /// with no app proxy, which is the whole reason the adapter is this thin.
    public static func live(baseURL: URL = APIClient.defaultBaseURL) -> NotificationCoordinator {
        #if canImport(UserNotifications)
        let port: NotificationPort = UserNotificationCenterAdapter()
        #else
        let port: NotificationPort = InertNotificationPort()
        #endif
        return NotificationCoordinator(port: port, client: APIClient(baseURL: baseURL))
    }

    /// Registers the actions and reads the current permission, once per launch,
    /// from `RootView`. The re-read as the user changes their mind is
    /// `refreshAuthorization()`, which the link screen calls on appearance.
    ///
    /// It does not ask. A prompt fired at launch is a prompt asked before the
    /// user has seen what it is for, and a refusal is permanent — the interface
    /// offers the ask instead, next to the description of what is lost.
    public func prepare() async {
        port.registerCategories()
        await refreshAuthorization()
    }

    /// Reads the current authorization without asking for it, because the user
    /// can revoke in Settings and the app would otherwise keep claiming coverage
    /// it no longer has.
    ///
    /// Called at launch by `RootView` and on every appearance of the screen that
    /// renders the permission row, `LinkStatusView`. Not on foregrounding: that
    /// would need a `scenePhase` observer, which no gate here can drive, so the
    /// limit is stated in apps/ios/README.md rather than implied away by a
    /// comment claiming more than the code does.
    public func refreshAuthorization() async {
        authorization = await port.currentAuthorization()
    }

    /// Asks once. The interface says what is lost if the answer is no before
    /// this is called, not after.
    public func requestAuthorization() async {
        authorization = await port.requestAuthorization()
    }

    /// One alert, from the fan-out socket or from the REST seed on reconnect.
    @discardableResult
    public func handle(_ alert: AlertEvent, decided: Bool) -> NotificationPolicy.Effect {
        let effect = policy.consider(alert, decided: decided, authorization: authorization)
        apply(effect)
        return effect
    }

    /// A decision recorded anywhere — this phone, or a dashboard, arriving over
    /// the fan-out. The episode is handled either way.
    @discardableResult
    public func handleDecision(alertId: String) -> NotificationPolicy.Effect {
        let effect = policy.decisionRecorded(alertId: alertId)
        apply(effect)
        return effect
    }

    /// The caregiver tapped an action. This is the leg that closes the circuit,
    /// and it withdraws the notification only after the server has the
    /// decision — a banner that vanishes on a request that failed would be the
    /// interface claiming a log entry that does not exist, which is the rule
    /// apps/web fixed at C12.
    public func act(_ action: CaregiverNotification.Action, on notification: CaregiverNotification) async {
        do {
            _ = try await client.recordDecision(
                deviceId: notification.deviceId,
                alertId: notification.alertId,
                decision: action.decision
            )
            decisionsRecorded += 1
            handleDecision(alertId: notification.alertId)
        } catch {
            decisionFailures += 1
        }
    }

    private func apply(_ effect: NotificationPolicy.Effect) {
        switch effect {
        case let .notify(notification):
            delivered += 1
            port.schedule(notification)
        case let .withdraw(alertId):
            withdrawn += 1
            port.withdraw(alertId: alertId)
        case let .suppressed(reason):
            suppressions[reason, default: 0] += 1
        }
    }

    public func suppressed(_ reason: NotificationPolicy.Suppression) -> Int {
        suppressions[reason] ?? 0
    }
}
