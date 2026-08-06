import SwiftUI

/// The device list: every device apps/server has seen, with the staleness
/// signal it serves. No logic here — `DeviceListModel` decided all of it.
public struct DeviceListView: View {
    @State private var model: DeviceListModel
    private let client: APIClient
    private let notifications: NotificationCoordinator?

    public init(client: APIClient, notifications: NotificationCoordinator? = nil) {
        self.client = client
        self.notifications = notifications
        _model = State(initialValue: DeviceListModel(client: client))
    }

    /// The seam the tests render through: a model already in the state under
    /// test, rather than one that has to reach a server to get there.
    public init(model: DeviceListModel, client: APIClient, notifications: NotificationCoordinator? = nil) {
        self.client = client
        self.notifications = notifications
        _model = State(initialValue: model)
    }

    public var body: some View {
        Group {
            if let variant = model.state.variant {
                StatusPanelView(
                    variant: variant,
                    copy: .forDevices(variant, failure: model.state.failure),
                    retry: { Task { await model.load() } }
                )
            } else if let devices = model.state.value {
                List(devices) { device in
                    NavigationLink(value: device.deviceId) {
                        DeviceRow(device: device)
                    }
                }
            }
        }
        .navigationTitle(Copy.deviceListTitle)
        .navigationDestination(for: String.self) { deviceId in
            DeviceDetailView(deviceId: deviceId, client: client, notifications: notifications)
        }
        .task { await model.load() }
    }
}

struct DeviceRow: View {
    let device: DeviceSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(device.deviceId).font(.headline)
            Text("\(device.frameCount) frames · session \(device.sessionEpoch)")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("last frame \(Format.time(device.lastReceivedAtMs))")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}
