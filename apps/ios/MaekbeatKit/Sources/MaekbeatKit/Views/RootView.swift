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

    /// Both dependencies are injected with no defaults. A default `GatewayModel`
    /// would have to choose between activating a real radio — which raises in a
    /// test bundle that declares no background mode — and a quiet stub that
    /// differs from what the app runs. Neither belongs in a default argument.
    public init(client: APIClient, gateway: GatewayModel) {
        self.client = client
        self.gateway = gateway
    }

    public var body: some View {
        VStack(spacing: 0) {
            DisclaimerBar()
            TabView {
                NavigationStack {
                    DeviceListView(client: client)
                }
                .tabItem { Label(Copy.deviceListTitle, systemImage: "list.bullet") }

                NavigationStack {
                    LinkStatusView(model: gateway)
                }
                .tabItem {
                    Label(Copy.linkSectionTitle, systemImage: "antenna.radiowaves.left.and.right")
                }
            }
        }
    }
}
