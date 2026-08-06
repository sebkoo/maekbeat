import Foundation

/*
 * The BLE link state machine — the part of C15 that can actually be proved.
 *
 * A value type with no radio, no clock, no I/O and no framework import. Every
 * decision the gateway makes about the link is here, and everything below it
 * (CoreBluetoothCentral) only translates. That split is deliberate: a simulator
 * has no Bluetooth stack and a CI runner has no peripheral, so anything living
 * in the adapter cannot be executed by the gate.
 *
 * The state is `LinkState`, which carries the phase *and* whether this link has
 * ever streamed, because both decide behaviour. It used to carry only the
 * phase, with `hasStreamed` beside it as a field — and three cells of the
 * transition table then had two answers depending on a value the table did not
 * index. docs/DECISIONS.md #18 records what that cost.
 *
 * Illegal transitions are rejected rather than ignored. A machine that quietly
 * absorbs `notificationsEnabled` while disconnected is a machine that will one
 * day report streaming with no link behind it.
 */
public struct BLELinkMachine: Equatable, Sendable {
    /// What happened to an event.
    public enum Outcome: Equatable, Sendable {
        /// A transition, possibly to the same state, with what to do about it.
        case moved(from: LinkState, to: LinkState, effects: [LinkEffect])
        /// Legal here and deliberately nothing — `stop` when already stopped.
        case ignored(LinkEvent, in: LinkState)
        /// Not legal in this state. The caller has a bug, or the radio does.
        case rejected(LinkEvent, in: LinkState)
    }

    public private(set) var state: LinkState = .disconnected(hasStreamed: false, wantsLink: false)
    /// Consecutive failed attempts since the last success. Reset on streaming.
    public private(set) var attempt = 0
    /// The last reason the radio was unusable, kept for the interface to show.
    public private(set) var unavailable: RadioUnavailable?
    public private(set) var framesReceived = 0

    public init() {}

    public var phase: LinkPhase { state.phase }
    public var hasStreamed: Bool { state.hasStreamed }
    public var wantsLink: Bool { state.wantsLink }

    /// Where a failed attempt goes: back to trying, or to recovering if there
    /// was something to recover.
    private var retryState: LinkState {
        state.hasStreamed ? .recovering : .connecting(hasStreamed: false)
    }

    public mutating func apply(_ event: LinkEvent) -> Outcome {
        switch state {
        case .disconnected: return applyDisconnected(event)
        case .connecting: return applyConnecting(event)
        case .connected: return applyConnected(event)
        case .streaming: return applyStreaming(event)
        case .recovering: return applyRecovering(event)
        }
    }

    // MARK: - Per-state tables

    private mutating func applyDisconnected(_ event: LinkEvent) -> Outcome {
        switch event {
        case .start:
            return beginAttempt(resettingAttempt: true)
        case .radioReady:
            unavailable = nil
            guard state.wantsLink else { return .ignored(event, in: state) }
            return beginAttempt(resettingAttempt: true)
        case let .radioUnavailable(reason):
            unavailable = reason
            return .ignored(event, in: state)
        case .stop:
            guard state.wantsLink else { return .ignored(event, in: state) }
            return halt()
        default:
            return .rejected(event, in: state)
        }
    }

    private mutating func applyConnecting(_ event: LinkEvent) -> Outcome {
        switch event {
        case .peripheralConnected:
            return move(to: .connected(hasStreamed: state.hasStreamed), [
                .discoverServices, .armTimeout(afterMs: LinkTiming.discoveryTimeoutMs)
            ])
        case .timeout, .linkLost:
            return failAttempt(cancelling: event == .timeout)
        case .retryDue:
            return beginAttempt(resettingAttempt: false)
        case .stop:
            return halt()
        case let .radioUnavailable(reason):
            return radioLost(reason)
        case .start, .radioReady:
            return .ignored(event, in: state)
        default:
            return .rejected(event, in: state)
        }
    }

    private mutating func applyConnected(_ event: LinkEvent) -> Outcome {
        switch event {
        case .servicesResolved:
            return move(to: state, [
                .enableNotifications, .armTimeout(afterMs: LinkTiming.discoveryTimeoutMs)
            ])
        case .notificationsEnabled:
            attempt = 0
            return move(to: .streaming, [.armTimeout(afterMs: LinkTiming.streamStallMs)])
        case .timeout, .linkLost:
            return failAttempt(cancelling: event == .timeout)
        case .stop:
            return halt()
        case let .radioUnavailable(reason):
            return radioLost(reason)
        case .start, .radioReady:
            return .ignored(event, in: state)
        default:
            return .rejected(event, in: state)
        }
    }

    private mutating func applyStreaming(_ event: LinkEvent) -> Outcome {
        switch event {
        case .frameReceived:
            framesReceived += 1
            // Re-arming on every frame is what makes the stall deadline mean
            // "nothing has arrived for this long" rather than "the link has
            // been up for this long".
            return move(to: .streaming, [.armTimeout(afterMs: LinkTiming.streamStallMs)])
        case .timeout, .linkLost:
            return failAttempt(cancelling: event == .timeout)
        case .stop:
            return halt()
        case let .radioUnavailable(reason):
            return radioLost(reason)
        case .start, .radioReady:
            return .ignored(event, in: state)
        default:
            return .rejected(event, in: state)
        }
    }

    private mutating func applyRecovering(_ event: LinkEvent) -> Outcome {
        switch event {
        case .retryDue:
            return beginAttempt(resettingAttempt: false)
        case .stop:
            return halt()
        case let .radioUnavailable(reason):
            return radioLost(reason)
        case .start, .radioReady:
            return .ignored(event, in: state)
        case .linkLost:
            // Already lost, already waiting. Radios report this more than once.
            return .ignored(event, in: state)
        default:
            return .rejected(event, in: state)
        }
    }

    // MARK: - Shared moves

    /// A fresh start resets the counter; a scheduled retry keeps the count
    /// `failAttempt` already raised, so the backoff keeps growing.
    ///
    /// A fresh start also cancels any retry still pending from the last one:
    /// `start` after `stop` must not inherit a timer the stopped session owned.
    private mutating func beginAttempt(resettingAttempt: Bool) -> Outcome {
        var effects: [LinkEffect] = []
        if resettingAttempt {
            attempt = 0
            effects.append(.cancelRetry)
        }
        effects.append(.scanAndConnect)
        effects.append(.armTimeout(afterMs: LinkTiming.connectTimeoutMs))
        return move(to: .connecting(hasStreamed: state.hasStreamed), effects)
    }

    /// An attempt failed: count it, stop waiting on the radio, and schedule the
    /// next try. Where it lands says whether data is being missed.
    private mutating func failAttempt(cancelling: Bool) -> Outcome {
        let next = retryState
        attempt += 1
        var effects: [LinkEffect] = cancelling ? [.cancelConnection] : []
        effects.append(.clearTimeout)
        effects.append(.scheduleRetry(afterMs: LinkTiming.retryDelayMs(forAttempt: attempt - 1)))
        return move(to: next, effects)
    }

    /// The app no longer wants a link. This ends the session, so the next one
    /// starts with nothing to recover — `hasStreamed` goes with it. Keeping it
    /// is how a fresh start's first failure came to report "readings are being
    /// missed" when nothing had ever been received.
    private mutating func halt() -> Outcome {
        attempt = 0
        return move(to: .disconnected(hasStreamed: false, wantsLink: false), [
            .cancelConnection, .clearTimeout, .cancelRetry
        ])
    }

    /// The radio went away. `wantsLink` survives, so `radioReady` resumes — and
    /// so does `hasStreamed`, because this is the same session interrupted
    /// rather than a new one begun.
    private mutating func radioLost(_ reason: RadioUnavailable) -> Outcome {
        unavailable = reason
        attempt = 0
        return move(to: .disconnected(hasStreamed: state.hasStreamed, wantsLink: true), [
            .cancelConnection, .clearTimeout, .cancelRetry
        ])
    }

    private mutating func move(to next: LinkState, _ effects: [LinkEffect]) -> Outcome {
        let previous = state
        state = next
        return .moved(from: previous, to: next, effects: effects)
    }
}
