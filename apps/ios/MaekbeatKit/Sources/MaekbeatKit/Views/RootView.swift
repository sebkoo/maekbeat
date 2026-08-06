import SwiftUI

/// The whole app: a disclaimer bar that never leaves, and two screens under it
/// — the server's devices, and the gateway's own two links.
///
/// The bar is outside the tabs and outside every `NavigationStack` on purpose.
/// A screen deep in a stack, or one that failed to load, must not be the one
/// that drops the line saying what this software is not.
public struct RootView: View {
    private let client: APIClient
    private let gateway: GatewayModel
    private let notifications: NotificationCoordinator

    /// Both dependencies are injected with no defaults. A default `GatewayModel`
    /// would have to choose between activating a real radio — which raises in a
    /// test bundle that declares no background mode — and a quiet stub that
    /// differs from what the app runs. Neither belongs in a default argument.
    public init(client: APIClient, gateway: GatewayModel, notifications: NotificationCoordinator) {
        self.client = client
        self.gateway = gateway
        self.notifications = notifications
    }

    public var body: some View {
        VStack(spacing: 0) {
            DisclaimerBar()
            TabView {
                NavigationStack {
                    DeviceListView(client: client, notifications: notifications)
                }
                .tabItem { Label(Copy.deviceListTitle, systemImage: "list.bullet") }

                NavigationStack {
                    LinkStatusView(model: gateway, notifications: notifications)
                }
                .tabItem {
                    Label(Copy.linkSectionTitle, systemImage: "antenna.radiowaves.left.and.right")
                }
            }
        }
        // The gateway is started here because nothing else would. Holding it and
        // rendering it is not running it: until C17 this view took a
        // `GatewayModel`, showed its state, and never called `start()`, so the
        // shipped app opened no `/ingest` socket and began no scan while every
        // gateway test passed — each of them calls `start()` itself. The same
        // class as apps/server's unwired retention at C12a, and the reason
        // CompositionTests drives this screen rather than reading it.
        .task {
            gateway.start()
            await notifications.prepare()
        }
    }
}
