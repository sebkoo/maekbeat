import SwiftUI

/// The not-a-medical-device line, in the interface rather than only in
/// DISCLAIMER.md. `RootView` keeps it above every screen, including the failed
/// and empty ones — the states where a reader is most likely to be looking for
/// an explanation of what they are seeing.
public struct DisclaimerBar: View {
    public init() {}

    public var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(Copy.notAMedicalDevice)
                .font(.footnote)
                .fontWeight(.semibold)
            Text(Copy.simulatorTransport)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.thinMaterial)
        .accessibilityElement(children: .combine)
    }
}
