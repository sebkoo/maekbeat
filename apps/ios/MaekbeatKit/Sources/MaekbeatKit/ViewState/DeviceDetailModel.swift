import Foundation
import Observation

/// The device screen's state: a REST seed, then live frames and alerts over the
/// fan-out socket, then a REST back-fill on every re-open.
///
/// The rule this holds, and the reason the back-fill exists: silence is not
/// continuity. A socket that dropped for forty seconds missed forty seconds,
/// and the honest recovery is to ask the server what happened rather than to
/// staple the next frame onto the last one.
@MainActor
@Observable
public final class DeviceDetailModel {
    public let deviceId: String

    public private(set) var frames: LoadState<[StoredVitalsFrame]> = .loading
    public private(set) var alerts: [AlertEvent] = []
    public private(set) var decisions: [String: AlertDecisionEvent] = [:]
    public private(set) var connection: ConnectionState = .connecting
    /// Socket payloads the contract rejected. Counted and shown, never rendered
    /// as data — a number nobody can explain is worse than a number missing.
    public private(set) var invalidMessages = 0
    /// What the server said it keeps per device, once it says it.
    public private(set) var ringCapacity: Int?

    /// Frames held on screen. Smaller than the server's ring on purpose: a
    /// phone is not a dashboard, and this is a live window, not an archive.
    public static let windowLimit = 600

    private let client: APIClient
    /// Where alerts become notifications. Optional because the device screen is
    /// useful without one — and injected rather than constructed, because the
    /// coordinator is one per app while this model is one per device.
    private let notifications: NotificationCoordinator?
    private let createSocket: SocketFactory?
    private let schedule: Scheduler?
    private var stream: StreamClient?

    public init(
        deviceId: String,
        client: APIClient,
        notifications: NotificationCoordinator? = nil,
        createSocket: SocketFactory? = nil,
        schedule: Scheduler? = nil
    ) {
        self.deviceId = deviceId
        self.client = client
        self.notifications = notifications
        self.createSocket = createSocket
        self.schedule = schedule
    }

    // MARK: - REST

    /// The seed read. Frames and alerts come from the same server the socket
    /// will stream from, so the screen starts populated rather than waiting for
    /// the device's next tick.
    public func load() async {
        frames = .loading
        do {
            let page = try await client.frames(deviceId: deviceId, limit: 1000)
            apply(seed: page.frames)
            let alertsPage = try await client.alerts(deviceId: deviceId)
            alerts = alertsPage.alerts
            decisions = latestDecisions(alertsPage.decisions)
            // The seed is history, and after a reconnect it is history this
            // phone has already seen. The policy is what stops it becoming a
            // second round of banners; offering it here is what lets the policy
            // decide rather than the caller guessing.
            for alert in alertsPage.alerts {
                notifications?.handle(alert, decided: decisions[alert.alertId] != nil)
            }
        } catch let failure as APIFailure {
            frames = .failed(failure)
        } catch {
            frames = .failed(.network(error.localizedDescription))
        }
    }

    /// Asks for everything captured at or after the newest frame on screen. The
    /// span the server has already evicted is gone from every source, and this
    /// read is bounded by the same 1000-frame limit apps/web works under.
    public func backfill() async {
        let newest = frames.value?.last?.capturedAtMs
        do {
            let page = try await client.frames(deviceId: deviceId, since: newest, limit: 1000)
            for frame in page.frames { merge(frame) }
        } catch {
            // A failed back-fill leaves the window as it was: stale is visible
            // (the newest frame's timestamp is on screen), invented is not.
        }
    }

    // MARK: - Stream

    public func connect() {
        guard stream == nil else { return }
        let handlers = StreamHandlers(
            onMessage: { [weak self] message in self?.receive(message) },
            onState: { [weak self] state in self?.connection = state },
            onReconnect: { [weak self] in Task { await self?.backfill() } },
            onInvalidMessage: { [weak self] _, _ in self?.invalidMessages += 1 }
        )
        let client = StreamClient(
            url: self.client.streamURL(deviceId: deviceId),
            handlers: handlers,
            createSocket: createSocket,
            schedule: schedule
        )
        stream = client
        client.open()
    }

    /// Closing is not optional. A screen that goes away while its socket keeps
    /// retrying is a phone spending battery on a view nobody is looking at.
    public func disconnect() {
        stream?.close()
        stream = nil
    }

    private func receive(_ message: StreamMessage) {
        switch message {
        case let .ready(ready):
            ringCapacity = ready.ringCapacity
        case let .frame(frame):
            merge(frame)
        case let .alert(alert):
            mergeAlert(alert)
            notifications?.handle(alert, decided: decisions[alert.alertId] != nil)
        case let .decision(decision):
            apply(decision)
            // A decision from any client closes the episode here too, so the
            // banner does not outlive the judgement somebody already made.
            notifications?.handleDecision(alertId: decision.alertId)
        }
    }

    /// The decision in force is the newest event for an alert, never the first
    /// one this screen happened to see. A late-arriving older event changes
    /// nothing — the same rule `latestDecisions` holds on the server side.
    private func apply(_ decision: AlertDecisionEvent) {
        if let held = decisions[decision.alertId], decision.recordedAtMs < held.recordedAtMs {
            return
        }
        decisions[decision.alertId] = decision
    }

    // MARK: - The window

    private func apply(seed: [StoredVitalsFrame]) {
        let window = Array(seed.suffix(Self.windowLimit))
        frames = window.isEmpty ? .empty : .ready(window)
    }

    /// Frames are identified by `(sessionEpoch, seq)`, never by timestamp: a
    /// device clock adjustment must not change a frame's identity
    /// (packages/protocol/README.md). A duplicate replaces nothing and adds
    /// nothing.
    private func merge(_ frame: StoredVitalsFrame) {
        var window = frames.value ?? []
        let key = frameKey(frame)
        guard !window.contains(where: { frameKey($0) == key }) else { return }

        // Ordered by capture time so a late arrival lands where it was taken,
        // not where it turned up. Insert-in-place beats a full sort: the common
        // case is an append.
        if let last = window.last, frame.capturedAtMs < last.capturedAtMs {
            let index = window.firstIndex { $0.capturedAtMs > frame.capturedAtMs } ?? window.count
            window.insert(frame, at: index)
        } else {
            window.append(frame)
        }
        if window.count > Self.windowLimit { window.removeFirst(window.count - Self.windowLimit) }
        frames = .ready(window)
    }

    private func frameKey(_ frame: StoredVitalsFrame) -> String {
        "\(frame.sessionEpoch)#\(frame.seq)"
    }

    /// One row per episode, not one per firing: the engine already gives one
    /// `alertId` per breach, so a lifecycle transition replaces its record
    /// rather than appending a second row for the same event.
    private func mergeAlert(_ alert: AlertEvent) {
        if let index = alerts.firstIndex(where: { $0.alertId == alert.alertId }) {
            alerts[index] = alert
        } else {
            alerts.append(alert)
        }
    }

    // MARK: - Derived

    /// Newest episode first, which is the order a caregiver reads in.
    public var timeline: [AlertEvent] {
        alerts.sorted { $0.raisedAtMs > $1.raisedAtMs }
    }

    public var newestFrame: StoredVitalsFrame? { frames.value?.last }

    /// The sessions present in the window. More than one means the device
    /// rebooted inside it, and a reboot may have reset the device clock.
    public var sessionsInWindow: Set<Int> {
        Set((frames.value ?? []).map(\.sessionEpoch))
    }
}
