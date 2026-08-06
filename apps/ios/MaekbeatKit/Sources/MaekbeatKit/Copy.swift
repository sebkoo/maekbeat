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

    /// The C15 line, and the one an interviewer should read twice. This app is
    /// the central half of a link whose other half does not exist: the profile
    /// is documented in docs/ble-gatt-profile.md and no hardware speaks it.
    public static let blePeripheralAbsent =
        "No peripheral implementing this profile exists. The app is the central "
        + "half of a documented link, and scans for a device that is not there."

    public static let linkSectionTitle = "Device link"
    public static let uplinkSectionTitle = "Server uplink"

    /// One line per link state, in the user's terms. `recovering` is the one
    /// that has to be distinct: it means readings are being missed now.
    public static func linkDescription(_ phase: LinkPhase) -> String {
        switch phase {
        case .disconnected: return "Not linked to a device."
        case .connecting: return "Looking for a device. Nothing has been received yet."
        case .connected: return "Linked. Setting up the vitals notification."
        case .streaming: return "Receiving vitals."
        case .recovering: return "The link dropped. Readings are being missed while it retries."
        }
    }

    public static func radioDescription(_ reason: RadioUnavailable) -> String {
        switch reason {
        case .poweredOff: return "Bluetooth is switched off."
        case .unauthorized: return "This app has not been allowed to use Bluetooth."
        case .unsupported: return "This hardware has no Bluetooth LE radio — every simulator."
        case .resetting: return "The Bluetooth stack is restarting."
        case .unknown: return "The Bluetooth state is not known yet."
        }
    }

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
