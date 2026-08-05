import Foundation

/// Every user-visible string in one place, so a test can assert what the
/// interface claims. apps/web makes the same promise through its token file:
/// the words that carry a commitment are not scattered across views.
public enum Copy {
    /// Rendered by `DisclaimerBar`, which `RootView` keeps on screen in every
    /// state — the same rule apps/web holds for its header line. A blank or
    /// failed screen must never be the one that drops it.
    public static let notAMedicalDevice =
        "Not a medical device. Synthetic data only — no diagnosis, "
        + "no monitoring of any real person."

    /// What this app talks to today. Named in the interface because "iOS app"
    /// in a wearables project reads as "talks to a wearable", and this one does
    /// not: there is no radio code in this package, and none until C15. The
    /// word for the radio is itself banned from these sources — see the source
    /// scan in Tests/MaekbeatKitTests/SourceDisciplineTests.swift.
    public static let simulatorTransport = "Reading a Maekbeat server over WebSocket. No device radio."

    public static let appName = "Maekbeat"
    public static let deviceListTitle = "Devices"

    public static let loadingDevicesTitle = "Reading devices"
    public static let loadingDevicesDetail = "Asking the server which devices it has seen."

    public static let emptyDevicesTitle = "No data yet"
    public static let emptyDevicesDetail =
        "The server is reachable and has received no frames. "
        + "Run `pnpm --filter @maekbeat/server demo` to fill it."

    public static let readFailedTitle = "This read failed"
    public static let disconnectedTitle = "Connection lost"
    public static let disconnectedDetail = "The server could not be reached from this device."

    public static let loadingFramesTitle = "Reading frames"
    public static let loadingFramesDetail = "Fetching the window this device has in the ring buffer."

    public static let emptyFramesTitle = "No frames in the window"
    public static let emptyFramesDetail =
        "The server knows this device but is holding none of its frames right now."

    public static let retry = "Retry"
    public static let noAlertsYet = "No alerts for this device."
}
