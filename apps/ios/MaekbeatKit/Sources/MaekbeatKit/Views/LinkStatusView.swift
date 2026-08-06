import SwiftUI

/// The gateway's two links, side by side: the radio to the peripheral and the
/// socket to the server. Both carry the state word before any colour, the
/// docs/DECISIONS.md #12 rule the alert badges already follow.
public struct LinkStatusView: View {
    private let model: GatewayModel

    public init(model: GatewayModel) {
        self.model = model
    }

    public var body: some View {
        List {
            Section(Copy.linkSectionTitle) {
                LabeledContent("State", value: model.link.phase.rawValue)
                Text(Copy.linkDescription(model.link.phase))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if let reason = model.radioUnavailable {
                    Text(Copy.radioDescription(reason)).font(.footnote)
                }
                if model.link.phase == .recovering || model.link.phase == .connecting {
                    LabeledContent("Attempt", value: "\(model.linkAttempt)")
                }
                // Counted rather than logged: a radio doing something this
                // model says is impossible, and a notification that was not a
                // frame. Both are zero on a healthy link, and both are the kind
                // of number that only helps if somebody can see it.
                if model.rejectedLinkEvents > 0 {
                    LabeledContent("Unexpected radio events", value: "\(model.rejectedLinkEvents)")
                }
                if model.undecodablePayloads > 0 {
                    LabeledContent("Dropped payloads", value: "\(model.undecodablePayloads)")
                }
            }

            Section(Copy.uplinkSectionTitle) {
                ConnectionBadge(state: model.uplink)
                LabeledContent("Buffered", value: "\(model.queue.count) frames")
                LabeledContent("Accepted", value: "\(model.accepted)")
                if let epoch = model.serverSessionEpoch {
                    LabeledContent("Server session", value: "\(epoch)")
                }
                if model.peripheralReboots > 0 {
                    LabeledContent("Device reboots", value: "\(model.peripheralReboots)")
                }
                if model.duplicatesRefused > 0 {
                    LabeledContent("Refused as duplicate", value: "\(model.duplicatesRefused)")
                }
            }

            Section {
                Text(Copy.blePeripheralAbsent)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle(Copy.linkSectionTitle)
    }
}
