import SwiftUI

/// The four designed states on screen. One view for all of them, so adding a
/// fifth means designing it rather than forgetting it.
public struct StatusPanelView: View {
    private let variant: StatusVariant
    private let copy: StatusCopy
    private let retry: (() -> Void)?

    public init(variant: StatusVariant, copy: StatusCopy, retry: (() -> Void)? = nil) {
        self.variant = variant
        self.copy = copy
        self.retry = retry
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                if variant == .loading { ProgressView() }
                Text(copy.title).font(.headline)
            }
            Text(copy.detail)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if let retry, variant == .error || variant == .disconnected {
                Button(Copy.retry, action: retry)
                    .buttonStyle(.bordered)
                    // Past SC 2.5.8's 24x24 minimum, the same floor apps/web
                    // holds its controls to.
                    .frame(minWidth: 44, minHeight: 44)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(copy.title). \(copy.detail)")
    }
}

/// The connection's four states as a line of text, with the state word first so
/// it survives greyscale and a screen reader hears it before anything else —
/// the docs/DECISIONS.md #12 rule that hue is the last cue, never the only one.
public struct ConnectionBadge: View {
    private let state: ConnectionState

    public init(state: ConnectionState) {
        self.state = state
    }

    public var body: some View {
        HStack(spacing: 6) {
            Text(Self.mark(for: state))
                .accessibilityHidden(true)
            Text(state.rawValue)
                .font(.caption)
                .textCase(.uppercase)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .foregroundStyle(Self.tint(for: state))
        .accessibilityLabel("Feed \(state.rawValue)")
    }

    /// A glyph per state, distinct in shape before it is distinct in colour.
    static func mark(for state: ConnectionState) -> String {
        switch state {
        case .connecting: return "…"
        case .live: return "●"
        case .reconnecting: return "◆"
        case .disconnected: return "▲"
        }
    }

    static func tint(for state: ConnectionState) -> Color {
        switch state {
        case .connecting: return .secondary
        case .live: return .green
        case .reconnecting: return .orange
        case .disconnected: return .red
        }
    }
}
