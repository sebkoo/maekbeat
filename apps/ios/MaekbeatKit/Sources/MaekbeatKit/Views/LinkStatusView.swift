import SwiftUI

/// The gateway's two links, side by side: the radio to the peripheral and the
/// socket to the server. Both carry the state word before any colour, the
/// docs/DECISIONS.md #12 rule the alert badges already follow.
public struct LinkStatusView: View {
    private let model: GatewayModel
    private let notifications: NotificationCoordinator?

    public init(model: GatewayModel, notifications: NotificationCoordinator? = nil) {
        self.model = model
        self.notifications = notifications
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

            if let notifications {
                Section(Copy.notificationSectionTitle) {
                    // The same three-cue discipline the connection badge uses:
                    // the word first, then the sentence, then the colour.
                    LabeledContent("Permission", value: notifications.authorization.rawValue)
                    Text(Copy.notificationDescription(notifications.authorization))
                        .font(.footnote)
                        .foregroundStyle(
                            notifications.authorization.canDeliver
                                ? Color.secondary
                                : Color.red
                        )
                    // The ask lives here rather than at launch, so it is made
                    // next to the sentence saying what it is for. Once refused
                    // it does not come back — iOS shows the prompt once — and
                    // the description says to go to Settings instead.
                    if notifications.authorization == .notDetermined {
                        Button(Copy.notificationPermissionAsk) {
                            Task { await notifications.requestAuthorization() }
                        }
                    }
                    LabeledContent("Delivered", value: "\(notifications.delivered)")
                    if notifications.withdrawn > 0 {
                        LabeledContent("Withdrawn", value: "\(notifications.withdrawn)")
                    }
                    let duplicates = notifications.suppressed(.alreadyNotified)
                    if duplicates > 0 {
                        LabeledContent("Repeats suppressed", value: "\(duplicates)")
                    }
                    let blocked = notifications.suppressed(.notAuthorized)
                    if blocked > 0 {
                        LabeledContent("Blocked by permission", value: "\(blocked)")
                    }
                    if notifications.decisionFailures > 0 {
                        LabeledContent("Decisions refused", value: "\(notifications.decisionFailures)")
                    }
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
