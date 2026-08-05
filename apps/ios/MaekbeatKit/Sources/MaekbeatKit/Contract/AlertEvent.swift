import Foundation

/// Vital fields an alert rule watches, mirroring `alertMetricSchema`.
public enum AlertMetric: String, Codable, Sendable, CaseIterable {
    case heartRateBpm
    case spo2Pct
    case respirationRpm
}

/// Lifecycle of one breach episode, mirroring `alertStateSchema`.
public enum AlertState: String, Codable, Sendable, CaseIterable {
    case raised
    case ongoing
    case resolved
}

/// Which side of the threshold the breach is on.
public enum AlertDirection: String, Codable, Sendable, CaseIterable {
    case low
    case high
}

/// Stats over the window that judged the alert, mirroring
/// `alertWindowStatsSchema`.
public struct AlertWindowStats: Codable, Equatable, Sendable {
    public let windowMs: Int
    public let sampleCount: Int
    public let breachCount: Int
    public let minValue: Double
    public let maxValue: Double
}

/// One alert through its lifecycle, mirroring `alertEventSchema`.
///
/// `alertId` is stable across state changes — it is the acknowledgement handle.
/// Both timestamps are **server** clock (receive time), never device clock: the
/// docs/ARCHITECTURE.md rule that drift shifts charts and never alerts.
public struct AlertEvent: Codable, Equatable, Sendable, Identifiable {
    public let alertId: String
    public let deviceId: String
    public let metric: AlertMetric
    public let direction: AlertDirection
    public let state: AlertState
    public let raisedAtMs: Int
    public let resolvedAtMs: Int?
    public let windowStats: AlertWindowStats

    public var id: String { alertId }

    /// How long the episode ran, or how long it has been running. `nil` while
    /// the alert is open, because a running episode has no duration yet — the
    /// same distinction apps/web's timeline draws as "and counting".
    public var durationMs: Int? {
        guard let resolvedAtMs else { return nil }
        return resolvedAtMs - raisedAtMs
    }
}

/// A caregiver's judgement of an alert, mirroring `alertDecisionSchema`.
///
/// `acknowledged` is seen and acted on; `dismissed` is seen and judged not
/// actionable. Counting the second against the first is the false-alarm signal
/// the C23 product loop asks for.
public enum AlertDecision: String, Codable, Sendable, CaseIterable {
    case acknowledged
    case dismissed
}

/// One appended decision, mirroring `alertDecisionEventSchema`. The server's
/// log has no update and no delete, so a change of mind is another event and
/// the decision in force is the newest one for an `alertId`.
public struct AlertDecisionEvent: Codable, Equatable, Sendable, Identifiable {
    public let eventId: String
    public let alertId: String
    public let deviceId: String
    public let decision: AlertDecision
    /// Asserted by whoever recorded it. Nothing in this system authenticates
    /// anything, so this is provenance, not identity.
    public let actor: String
    public let recordedAtMs: Int
    public let note: String?

    public var id: String { eventId }
}

/// The decision in force per alert: the newest event for it, derived rather
/// than stored — the Swift reading of `latestDecisions` in
/// packages/protocol/src/acks.ts.
public func latestDecisions(
    _ events: [AlertDecisionEvent]
) -> [String: AlertDecisionEvent] {
    var latest: [String: AlertDecisionEvent] = [:]
    for event in events {
        guard let held = latest[event.alertId] else {
            latest[event.alertId] = event
            continue
        }
        if event.recordedAtMs >= held.recordedAtMs {
            latest[event.alertId] = event
        }
    }
    return latest
}
