import SwiftUI

/// The whole app: a disclaimer bar that never leaves, and the device list under
/// it. The bar is outside the `NavigationStack` on purpose — a screen deep in
/// the stack, or a screen that failed to load, must not be the one that drops
/// the line saying what this software is not.
public struct RootView: View {
    private let client: APIClient

    public init(client: APIClient = APIClient(baseURL: APIClient.defaultBaseURL)) {
        self.client = client
    }

    public var body: some View {
        VStack(spacing: 0) {
            DisclaimerBar()
            NavigationStack {
                DeviceListView(client: client)
            }
        }
    }
}
