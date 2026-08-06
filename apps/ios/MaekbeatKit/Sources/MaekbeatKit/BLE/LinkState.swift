import Foundation

/*
 * The BLE link's vocabulary: states, events, and effects.
 *
 * All three are plain values with no CoreBluetooth in them, because the state
 * machine that consumes them has to run everywhere the tests do — and
 * CoreBluetooth cannot connect to anything on a simulator or a CI runner. The
 * boundary that makes that work is written down in apps/ios/README.md; this
 * file is the near side of it.
 */

/// Why the radio cannot be used: one case per framework radio-state that means
/// "not now", translated at the adapter so nothing downstream imports the
/// framework or names its types.
public enum RadioUnavailable: String, Sendable, CaseIterable {
    /// The user turned Bluetooth off.
    case poweredOff
    /// The user declined, or has not yet been asked.
    case unauthorized
    /// No BLE radio at all. Every iOS Simulator reports this.
    case unsupported
    /// The stack is restarting; transient.
    case resetting
    case unknown
}

/// The five phases docs/ARCHITECTURE.md names. A phase alone is not a state —
/// see `LinkState` — it is the part of the state a screen shows.
public enum LinkPhase: String, Sendable, CaseIterable {
    /// No link and none being attempted.
    case disconnected
    /// Scanning or connecting.
    case connecting
    /// GATT connected; services and notifications not yet in place.
    case connected
    /// Notifications enabled; frames are arriving.
    case streaming
    /// The link dropped after it had streamed, and a retry is scheduled.
    case recovering
}

/// Where the link is — the phase **and** whether this link has ever streamed.
///
/// The second half used to be a separate `hasStreamed` flag beside the phase,
/// and that was the bug rather than a detail. Three cells of the transition
/// table behaved differently depending on it, which means the phase was never
/// the state: a table indexed by phase alone had cells with two answers, and
/// the "five states, full matrix" claim was false the day it was written.
/// Folding it in makes the table exhaustive over what actually decides
/// behaviour, and the adversarial pass that found this is recorded in
/// docs/DECISIONS.md #18.
///
/// Two combinations are unrepresentable rather than merely unused: `streaming`
/// and `recovering` both imply the link has streamed, so neither carries the
/// flag. A state that cannot be written down cannot be reached by accident.
public enum LinkState: Hashable, Sendable, CaseIterable {
    /// `wantsLink` is carried only here. In every other phase the app wants a
    /// link by construction — there is no path into `connecting` or beyond
    /// except through `start` or a retry — so it decides nothing there. In
    /// `disconnected` it decides everything: whether a returning radio resumes.
    ///
    /// It is the second dimension this type absorbed, and it was found the same
    /// way as the first: the matrix, once indexed by `hasStreamed`, produced a
    /// cell with two answers depending on `wantsLink`.
    case disconnected(hasStreamed: Bool, wantsLink: Bool)
    case connecting(hasStreamed: Bool)
    case connected(hasStreamed: Bool)
    case streaming
    case recovering

    /// Every reachable state. Eight, not five — and not ten, because
    /// `streaming` and `recovering` have no never-streamed form.
    /// Every reachable state. Nine — and not twelve, because `streaming` and
    /// `recovering` have no never-streamed form, and not ten, because a link
    /// that has streamed and is no longer wanted cannot exist: `stop` clears
    /// `hasStreamed` with the session it ends.
    public static let allCases: [Self] = [
        .disconnected(hasStreamed: false, wantsLink: false),
        .disconnected(hasStreamed: false, wantsLink: true),
        .disconnected(hasStreamed: true, wantsLink: true),
        .connecting(hasStreamed: false), .connecting(hasStreamed: true),
        .connected(hasStreamed: false), .connected(hasStreamed: true),
        .streaming, .recovering
    ]

    public var phase: LinkPhase {
        switch self {
        case .disconnected: return .disconnected
        case .connecting: return .connecting
        case .connected: return .connected
        case .streaming: return .streaming
        case .recovering: return .recovering
        }
    }

    /// Whether this link has ever reached `streaming`. The one bit that
    /// separates "trying again, data is being missed" from "trying, there was
    /// never anything there".
    /// Whether the app wants a link. True by construction outside
    /// `disconnected`, where it is the whole question.
    public var wantsLink: Bool {
        switch self {
        case let .disconnected(_, wantsLink): return wantsLink
        case .connecting, .connected, .streaming, .recovering: return true
        }
    }

    public var hasStreamed: Bool {
        switch self {
        case let .disconnected(hasStreamed, _): return hasStreamed
        case let .connecting(hasStreamed): return hasStreamed
        case let .connected(hasStreamed): return hasStreamed
        case .streaming, .recovering: return true
        }
    }
}

/// Everything that can happen to the link. The adapter produces these and
/// nothing else; the machine consumes these and nothing else.
public enum LinkEvent: Equatable, Sendable {
    /// The app wants a link.
    case start
    /// The app no longer wants a link. Idempotent.
    case stop
    case radioReady
    case radioUnavailable(RadioUnavailable)
    case peripheralConnected
    case servicesResolved
    case notificationsEnabled
    case frameReceived
    /// The peripheral went away — a disconnect, a failed connect, a timeout on
    /// the radio's own terms.
    case linkLost
    /// The deadline the machine armed has passed.
    case timeout
    /// The retry backoff the machine scheduled has elapsed.
    case retryDue

    /// One of each case, for the exhaustive transition matrix in the tests.
    /// Hand-written because associated values rule out `CaseIterable`, and a
    /// missing entry here would silently shrink that matrix — so the test
    /// asserts this list covers every case name the type declares.
    public static let allKinds: [Self] = [
        .start, .stop, .radioReady, .radioUnavailable(.poweredOff),
        .peripheralConnected, .servicesResolved, .notificationsEnabled,
        .frameReceived, .linkLost, .timeout, .retryDue
    ]

    /// The case name, used by the coverage assertion on `allKinds`.
    public var kind: String {
        switch self {
        case .start: return "start"
        case .stop: return "stop"
        case .radioReady: return "radioReady"
        case .radioUnavailable: return "radioUnavailable"
        case .peripheralConnected: return "peripheralConnected"
        case .servicesResolved: return "servicesResolved"
        case .notificationsEnabled: return "notificationsEnabled"
        case .frameReceived: return "frameReceived"
        case .linkLost: return "linkLost"
        case .timeout: return "timeout"
        case .retryDue: return "retryDue"
        }
    }
}

/// What the machine asks the radio to do. The adapter executes these and makes
/// no decisions of its own — that is what keeps the untestable surface thin.
public enum LinkEffect: Equatable, Sendable {
    case scanAndConnect
    case discoverServices
    case enableNotifications
    case cancelConnection
    /// Arm the single deadline. A later `armTimeout` replaces the earlier one.
    case armTimeout(afterMs: Int)
    case clearTimeout
    case scheduleRetry(afterMs: Int)
    case cancelRetry
}

/*
 * The invariant these effects exist to keep:
 *
 *   Every scheduled effect has an owner state, and leaving that state cancels
 *   it.
 *
 * A deadline is owned by the state that armed it and a retry by the state that
 * scheduled it. Without `cancelRetry` the second half was unenforced: switching
 * Bluetooth off while a retry was pending left the timer running, and it later
 * delivered `retryDue` into `disconnected`, where the machine rejected it and
 * the driver counted the radio as having done something impossible. A timer
 * that outlives its state is a message from the past arriving as news.
 */

/// Timeouts and backoff, in one place so the README can quote them.
public enum LinkTiming {
    /// A connect that has not landed in this long is not going to.
    public static let connectTimeoutMs = 10_000
    /// Service discovery plus notification subscription.
    public static let discoveryTimeoutMs = 10_000
    /// Notifications can stop without the link dropping — a peripheral that
    /// wedges looks exactly like one that is idle. This is the difference.
    public static let streamStallMs = 15_000

    /// First retry delay; each attempt doubles it to the cap.
    public static let retryBaseMs = 1_000
    /// Slower than the dashboard socket's 15 s cap on purpose: a phone scanning
    /// for a peripheral that is out of range burns a radio, not a socket.
    public static let retryCapMs = 30_000

    public static func retryDelayMs(forAttempt attempt: Int) -> Int {
        let doublings = max(0, attempt)
        if doublings >= 32 { return retryCapMs }
        return min(retryBaseMs << doublings, retryCapMs)
    }
}
