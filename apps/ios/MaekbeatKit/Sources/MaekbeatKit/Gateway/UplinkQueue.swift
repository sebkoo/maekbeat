import Foundation

/*
 * The gateway's offline buffer — docs/ARCHITECTURE.md's "buffer frames
 * on-device while offline, replay in seq order, idempotent", and the half of
 * the C6 dedupe contract that lives on the phone.
 *
 * packages/protocol/README.md recorded the promise this file has to keep: the
 * gateway resumes from its last delivered `seq` on reconnect and never replays
 * older frames, because the server's reorder window is 64 frames wide and a
 * whole-session replay past it forks a spurious epoch. Replaying is not merely
 * wasteful here; it corrupts the session the server believes it is in.
 *
 * A pure value type. The socket lives elsewhere.
 */
public struct UplinkQueue: Equatable, Sendable {
    /// What happened to a frame offered by the BLE side.
    public enum Offer: Equatable, Sendable {
        case queued
        /// Already acknowledged by the server; the gateway does not send it
        /// twice. This is the resume promise, enforced at the point of entry.
        case alreadyDelivered
        /// The peripheral's `seq` went backwards. On a BLE connection
        /// notifications are ordered, so this is a reboot, not a reorder.
        case peripheralRebooted(previousHighSeq: Int)
        /// The buffer was full and the oldest pending frame was dropped to make
        /// room. Counted, and visible.
        case queuedAfterDroppingOldest
    }

    /// The regression past which a lower `seq` means a reboot rather than a
    /// retransmit — the same 64 frames as `SEQ_REORDER_WINDOW` in
    /// apps/server/src/store.ts, and the same number on purpose. The phone
    /// could claim better information than the server (notifications are
    /// ordered within one BLE connection, so any regression looks like a
    /// reboot), but a peripheral that reconnects and re-sends its last
    /// unacknowledged notification produces a regression that is not one. Using
    /// the server's own window means the two ends agree about what a reboot is,
    /// and inherit the same blind spot rather than two different ones.
    public static let reorderWindow = 64

    /// Frames held while the server is unreachable. At 1 Hz this is about
    /// seventeen minutes of buffer; past that the oldest goes, because on a
    /// monitoring screen the newest reading is the one somebody needs.
    public static let defaultCapacity = 1_024

    public private(set) var pending: [VitalsFrame] = []
    /// The highest `seq` the server has acknowledged in the current peripheral
    /// session. Resume starts here, not at zero.
    public private(set) var lastAckedSeq: Int?
    /// The highest `seq` the peripheral has offered in this session.
    public private(set) var highestOfferedSeq: Int?
    /// The highest `seq` handed to the socket and not yet acknowledged. It is
    /// cleared on reconnect, because a frame written to a socket that then died
    /// may never have arrived — that, and not a counter reset, is what makes a
    /// reconnect resend the tail without resending the session.
    public private(set) var inFlightThroughSeq: Int?
    public private(set) var droppedOldest = 0
    public private(set) var rebootsObserved = 0

    private let capacity: Int

    public init(capacity: Int = Self.defaultCapacity) {
        self.capacity = max(1, capacity)
    }

    public var isEmpty: Bool { pending.isEmpty }
    public var count: Int { pending.count }

    /// Offer a frame decoded from a notification.
    @discardableResult
    public mutating func offer(_ frame: VitalsFrame) -> Offer {
        if let high = highestOfferedSeq, frame.seq < high - Self.reorderWindow {
            return reboot(from: high, with: frame)
        }
        if let acked = lastAckedSeq, frame.seq <= acked {
            // Delivered already: the peripheral is retransmitting, or a
            // reconnect re-offered what the server has. Either way, sending it
            // again would be the replay the contract forbids.
            return .alreadyDelivered
        }
        if pending.contains(where: { $0.seq == frame.seq }) {
            return .alreadyDelivered
        }

        highestOfferedSeq = max(highestOfferedSeq ?? frame.seq, frame.seq)
        var dropped = false
        if pending.count >= capacity {
            pending.removeFirst()
            droppedOldest += 1
            dropped = true
        }
        pending.append(frame)
        return dropped ? .queuedAfterDroppingOldest : .queued
    }

    /// A peripheral reboot. The pre-reboot buffer is discarded rather than
    /// replayed across the boundary: those frames belong to a `seq` line the
    /// device has abandoned, and pushing them after the low ones would drag the
    /// server's high-water mark back up and fork another session — the residual
    /// limit named in packages/protocol/README.md.
    private mutating func reboot(from high: Int, with frame: VitalsFrame) -> Offer {
        rebootsObserved += 1
        pending.removeAll()
        lastAckedSeq = nil
        inFlightThroughSeq = nil
        highestOfferedSeq = frame.seq
        pending.append(frame)
        return .peripheralRebooted(previousHighSeq: high)
    }

    /// The server accepted, or deduplicated, everything up to `seq`.
    public mutating func acknowledge(seq: Int) {
        lastAckedSeq = max(lastAckedSeq ?? seq, seq)
        pending.removeAll { $0.seq <= seq }
    }

    /// Everything through `seq` is on the socket, awaiting a reply.
    public mutating func markSent(through seq: Int) {
        inFlightThroughSeq = max(inFlightThroughSeq ?? seq, seq)
    }

    /// A new socket. Only the in-flight mark is dropped: what the server
    /// acknowledged stays acknowledged, so the resend starts at the tail rather
    /// than at the beginning of the session.
    public mutating func socketReconnected() {
        inFlightThroughSeq = nil
    }

    /// What to send next, oldest first — everything past the in-flight mark.
    ///
    /// It does not also filter on `lastAckedSeq`, and that is deliberate rather
    /// than an omission: `acknowledge` removes the acknowledged frames and
    /// `offer` refuses any that come back, so `pending` cannot contain one. A
    /// second filter for a state that cannot occur was removed here after a
    /// mutation showed nothing could observe it (docs/ai/mutation-log.md).
    public func nextBatch(limit: Int = 32) -> [VitalsFrame] {
        let floor = inFlightThroughSeq ?? Int.min
        let due = pending.filter { $0.seq > floor }.sorted { $0.seq < $1.seq }
        return Array(due.prefix(max(0, limit)))
    }
}
