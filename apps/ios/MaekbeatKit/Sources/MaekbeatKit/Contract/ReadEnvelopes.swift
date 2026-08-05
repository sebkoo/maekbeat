import Foundation

/*
 * The envelopes around the contract objects on apps/server's REST surface.
 *
 * apps/web splits strictness on purpose — contract objects strict, envelopes
 * permissive, so a new server counter cannot blank a caregiver's screen.
 * Swift's synthesised `Codable` is permissive for both, which matches the
 * envelope half of that rule and misses the strict half; the golden key-set
 * assertions in the tests carry it instead. apps/ios/README.md says so in the
 * table of what the goldens do not cover.
 */

/// One device as `GET /devices` lists it.
public struct DeviceSummary: Codable, Equatable, Sendable, Identifiable {
    public let deviceId: String
    public let sessionEpoch: Int
    public let frameCount: Int
    public let lastSeq: Int
    /// Server clock at the last accepted frame — the staleness signal.
    public let lastReceivedAtMs: Int
    public let duplicatesDropped: Int
    /// Undecided alerts the server had to drop because nothing in the backlog
    /// was triaged. Absent from older servers, so it decodes as `nil`.
    public let alertsForcedEvicted: Int?

    public var id: String { deviceId }
}

/// Process-lifetime ingest counters served alongside the device list.
public struct IngestCounters: Codable, Equatable, Sendable {
    public let received: Int
    public let accepted: Int
    public let rejectedInvalid: Int
    public let duplicatesDropped: Int
    public let sessionsStarted: Int
}

public struct DeviceList: Codable, Equatable, Sendable {
    public let ingest: IngestCounters
    public let devices: [DeviceSummary]
}

/// One page of the bounded ring buffer. A window, never history.
public struct FramesPage: Codable, Equatable, Sendable {
    public let deviceId: String
    public let count: Int
    public let frames: [StoredVitalsFrame]
}

public struct AlertCounters: Codable, Equatable, Sendable {
    public let raised: Int
    public let resolved: Int
    public let suppressed: Int
    public let acknowledged: Int
    public let dismissed: Int
}

public struct AlertsPage: Codable, Equatable, Sendable {
    public let deviceId: String
    public let counters: AlertCounters
    public let alerts: [AlertEvent]
    /// The append-only decision log for this device, oldest first.
    public let decisions: [AlertDecisionEvent]
}

/// `GET /healthz`.
public struct Health: Codable, Equatable, Sendable {
    public let status: String
    public let uptimeSec: Double
    public let version: String
}
