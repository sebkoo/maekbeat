import SwiftUI

/// One device: the newest reading, the alert episodes, and what the feed is
/// doing. The numbers are the server's; the only thing this screen adds is the
/// clock delta, and it says which two clocks made it.
public struct DeviceDetailView: View {
    @State private var model: DeviceDetailModel

    public init(deviceId: String, client: APIClient) {
        _model = State(initialValue: DeviceDetailModel(deviceId: deviceId, client: client))
    }

    /// The seam the tests use: a model already wired to a fake socket.
    public init(model: DeviceDetailModel) {
        _model = State(initialValue: model)
    }

    public var body: some View {
        List {
            Section {
                ConnectionBadge(state: model.connection)
                if let frame = model.newestFrame {
                    LabeledContent("Heart rate", value: "\(frame.heartRateBpm) bpm")
                    LabeledContent("SpO2", value: "\(Format.value(frame.spo2Pct)) %")
                    LabeledContent("Respiration", value: "\(Format.value(frame.respirationRpm)) rpm")
                    LabeledContent("Captured", value: Format.time(frame.capturedAtMs))
                    LabeledContent("Clock delta", value: Format.signedMs(frame.clockDeltaMs))
                } else if let variant = model.frames.variant {
                    StatusPanelView(
                        variant: variant,
                        copy: .forFrames(variant, failure: model.frames.failure),
                        retry: { Task { await model.load() } }
                    )
                }
            } header: {
                Text("Newest reading")
            } footer: {
                Text(footnote)
            }

            Section("Alert episodes") {
                if model.timeline.isEmpty {
                    Text(Copy.noAlertsYet).foregroundStyle(.secondary)
                } else {
                    ForEach(model.timeline) { alert in
                        AlertRow(alert: alert, decision: model.decisions[alert.alertId])
                    }
                }
            }
        }
        .navigationTitle(model.deviceId)
        .task {
            await model.load()
            model.connect()
        }
        .onDisappear { model.disconnect() }
    }

    /// What the window is and is not. A screen showing 600 frames out of a
    /// server ring that may hold more should say so rather than imply history.
    private var footnote: String {
        var parts = ["Live window of at most \(DeviceDetailModel.windowLimit) frames."]
        if let capacity = model.ringCapacity {
            parts.append("The server keeps \(capacity) per device; anything older is gone.")
        }
        if model.sessionsInWindow.count > 1 {
            parts.append("This window spans \(model.sessionsInWindow.count) sessions — "
                + "the device rebooted, and its clock may have moved with it.")
        }
        if model.invalidMessages > 0 {
            parts.append("\(model.invalidMessages) message(s) failed the contract and were dropped.")
        }
        return parts.joined(separator: " ")
    }
}

struct AlertRow: View {
    let alert: AlertEvent
    let decision: AlertDecisionEvent?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(Self.mark(for: alert.state)).accessibilityHidden(true)
                Text(alert.state.rawValue).font(.subheadline).fontWeight(.semibold)
                Text("\(alert.metric.rawValue) \(alert.direction.rawValue)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Text("raised \(Format.time(alert.raisedAtMs)) · \(Format.duration(alert.durationMs))")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let decision {
                Text("\(decision.decision.rawValue) by \(decision.actor)")
                    .font(.caption)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    /// The docs/DECISIONS.md #12 marks, so the three states stay apart in
    /// greyscale and for a dichromat reader.
    static func mark(for state: AlertState) -> String {
        switch state {
        case .raised: return "▲"
        case .ongoing: return "◆"
        case .resolved: return "✓"
        }
    }
}
