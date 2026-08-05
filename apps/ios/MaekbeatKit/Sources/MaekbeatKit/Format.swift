import Foundation

/// Number and time formatting, in UTC and with fixed decimals.
///
/// UTC because two clocks are already in play — device capture time and server
/// receive time — and rendering either one in the phone's local zone would add
/// a third offset to reason about while looking at a drift number.
public enum Format {
    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()

    /// `HH:mm:ss` UTC. Suffixed so nobody reads it as local time.
    public static func time(_ epochMs: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(epochMs) / 1000)
        return timeFormatter.string(from: date) + " UTC"
    }

    /// A vitals value at a fixed number of decimals, so a column of readings
    /// does not jitter in width as the digits change.
    public static func value(_ value: Double, decimals: Int = 1) -> String {
        String(format: "%.\(decimals)f", value)
    }

    /// A signed millisecond delta. The sign is the information — a negative
    /// clock delta means the device clock is ahead of the server's.
    public static func signedMs(_ delta: Int) -> String {
        delta >= 0 ? "+\(delta) ms" : "\(delta) ms"
    }

    /// A duration in whole seconds, or "running" while the episode is open.
    public static func duration(_ durationMs: Int?) -> String {
        guard let durationMs else { return "running" }
        return "\(durationMs / 1000) s"
    }
}
