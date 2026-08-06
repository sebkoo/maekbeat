import Foundation

/*
 * Whether an alert becomes a notification — every decision, in one value type
 * with no UserNotifications in it.
 *
 * The bug this exists to prevent is one the client would manufacture on its
 * own. apps/server guarantees one raise per breach episode (C7), so a caregiver
 * should see one notification per episode. But a client that notifies on every
 * alert message it receives notifies again after every reconnect, because a
 * reconnect re-reads the alert history and the fan-out replays transitions.
 * Nothing on the server side is wrong in that story; the alarm fatigue is made
 * entirely by the phone, and it is the kind the C21 risk register will cite.
 *
 * The C15 invariant applies here too: every scheduled effect has an owner, and
 * leaving that owner cancels it. A notification's owner is the open episode. An
 * episode that resolves, or that anyone decides on from any client, withdraws
 * the notification it scheduled — a caregiver should not be left holding a
 * banner for something already handled.
 */
public struct NotificationPolicy: Equatable, Sendable {
    /// What the policy asks the notification centre to do.
    public enum Effect: Equatable, Sendable {
        case notify(CaregiverNotification)
        /// Take back a notification whose episode is over or already judged.
        case withdraw(alertId: String)
        /// Nothing to do, and why — counted and shown rather than swallowed.
        case suppressed(Suppression)
    }

    public enum Suppression: Equatable, Sendable {
        /// This episode already has a notification, and the alert arrived as a
        /// `raised` — a replayed transition. The reconnect case.
        case alreadyNotified
        /// This episode already has a notification, and the alert arrived as an
        /// `ongoing` — the same episode still running, not a new event. Kept
        /// apart from `alreadyNotified` because the two count different things:
        /// one is the fan-out repeating itself, the other is the episode simply
        /// lasting, and a run of `notANewEpisode` with no `alreadyNotified` is a
        /// long breach rather than a replay storm.
        case notANewEpisode
        /// Somebody already acknowledged or dismissed it, here or on the
        /// dashboard. Notifying would ask a second person to handle it.
        case alreadyDecided
        /// The user has not allowed notifications. Nothing is delivered, and
        /// the interface has to say so — see `NotificationAuthorization`.
        case notAuthorized
    }

    /// Episodes this policy has already notified for, by `alertId`.
    ///
    /// Both sets grow with the number of episodes the app has seen and are
    /// never trimmed — a stated limit, not an oversight. Bounding them the way
    /// apps/server bounds its alert history (C12a) would mean evicting an
    /// `alertId`, and an evicted id notifies again the next time the seed
    /// replays it, which is the exact bug this type exists to prevent. An
    /// episode needs a threshold breach to exist, so the count grows in the
    /// tens rather than with uptime; if that ever stops being true the answer
    /// is an expiry keyed on the episode being resolved and decided, not a cap.
    public private(set) var notified: Set<String> = []
    /// Episodes withdrawn, so a late replay of a resolved alert does not
    /// resurrect the banner.
    public private(set) var closed: Set<String> = []

    public init() {}

    /// The decision, for one alert as it arrives.
    ///
    /// - Parameters:
    ///   - alert: the alert event, from the fan-out socket or the REST seed.
    ///   - decided: whether a decision is already in force for it.
    ///   - authorization: what the user has allowed.
    public mutating func consider(
        _ alert: AlertEvent,
        decided: Bool,
        authorization: NotificationAuthorization
    ) -> Effect {
        // A resolved or decided episode closes, whether or not it ever
        // notified: the withdraw is idempotent and the state is what matters.
        if alert.state == .resolved || decided {
            let wasOpen = notified.contains(alert.alertId) && !closed.contains(alert.alertId)
            closed.insert(alert.alertId)
            return wasOpen
                ? .withdraw(alertId: alert.alertId)
                : .suppressed(decided ? .alreadyDecided : .notANewEpisode)
        }

        // What earns a banner is an open episode nobody has seen yet — not the
        // particular transition that carried it. `raised` and `ongoing` are
        // treated alike here, and the difference survives only in the
        // suppression reason below.
        //
        // Keying on `raised` alone was the first design, and apps/ios's
        // integration test against a real apps/server killed it: the engine
        // mutates a stored alert to `ongoing` the moment a second breaching
        // sample lands (apps/server/src/alerts.ts:318), so `GET /alerts`
        // reports every live episode as `ongoing`. The REST seed is the only
        // path a cold launch or a killed-and-relaunched app has, which made the
        // silent case exactly the one that matters: an episode running right
        // now, on a phone that has never heard of it. Designing against
        // duplicate banners had produced a missing one.
        guard !closed.contains(alert.alertId) else { return .suppressed(.alreadyDecided) }
        guard !notified.contains(alert.alertId) else {
            return .suppressed(alert.state == .ongoing ? .notANewEpisode : .alreadyNotified)
        }
        // Authorization is checked last on purpose, so a denied user's replays
        // still record as `alreadyNotified` rather than piling up as new
        // suppressions — and so the counter means what it says.
        guard authorization.canDeliver else { return .suppressed(.notAuthorized) }

        notified.insert(alert.alertId)
        return .notify(CaregiverNotification.forAlert(alert))
    }

    /// A decision landed — from this phone's notification action, or from a
    /// dashboard, arriving over the same fan-out socket. Either way the episode
    /// is handled and its notification comes back.
    public mutating func decisionRecorded(alertId: String) -> Effect {
        let wasOpen = notified.contains(alertId) && !closed.contains(alertId)
        closed.insert(alertId)
        return wasOpen ? .withdraw(alertId: alertId) : .suppressed(.alreadyDecided)
    }
}
