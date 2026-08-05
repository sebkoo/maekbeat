import Foundation

/*
 * The simulator transport: a WebSocket client against apps/server's fan-out
 * route, `GET /devices/:deviceId/stream` — the same endpoint apps/web's
 * dashboard subscribes to. There is no second protocol for the phone, and
 * there is no radio here: frames reach this app because a server sends them.
 *
 * The socket and the timer are both ports, so the tests drive a fake socket and
 * a fake clock and never wait on wall time. That is the same seam
 * apps/web/src/api/stream.ts opens (`createSocket`, `schedule`), and the retry
 * rules below are deliberately the same numbers — two clients that reconnect
 * differently would be two answers to one question.
 */

/// What the connection is doing, in the user's terms rather than the socket's.
public enum ConnectionState: String, Sendable, CaseIterable {
    case connecting
    case live
    case reconnecting
    case disconnected
}

/// First retry delay; each attempt doubles it up to the cap.
public let backoffBaseMs = 500
/// The cap: a phone left on a bedside table retries every 15 s, not every hour.
public let maxBackoffMs = 15_000
/// Consecutive failed attempts before the UI says disconnected rather than
/// reconnecting. Retries continue; the app stops implying data is imminent.
public let disconnectedAfterAttempts = 3

/// Capped exponential backoff: 500 ms, 1 s, 2 s, 4 s, 8 s, then 15 s forever.
public func backoffMs(forAttempt attempt: Int) -> Int {
    let doublings = max(0, attempt)
    // Cap the exponent before shifting: 1 << 64 is undefined, and a socket that
    // has failed sixty-four times is exactly when a crash is least welcome.
    if doublings >= 32 { return maxBackoffMs }
    return min(backoffBaseMs << doublings, maxBackoffMs)
}

/// What a socket tells its owner. Mirrors the three events apps/web listens for.
public struct SocketHandlers: Sendable {
    public let onOpen: @Sendable @MainActor () -> Void
    public let onMessage: @Sendable @MainActor (Data) -> Void
    public let onClose: @Sendable @MainActor () -> Void

    public init(
        onOpen: @escaping @Sendable @MainActor () -> Void,
        onMessage: @escaping @Sendable @MainActor (Data) -> Void,
        onClose: @escaping @Sendable @MainActor () -> Void
    ) {
        self.onOpen = onOpen
        self.onMessage = onMessage
        self.onClose = onClose
    }
}

/// A socket the client can let go of. Main-actor isolated because the client
/// is: everything about a connection this app owns happens where the screen is.
@MainActor
public protocol StreamSocket: AnyObject {
    func close()
}

/// Injectable socket constructor; the default wraps `URLSessionWebSocketTask`.
public typealias SocketFactory = @MainActor (URL, SocketHandlers) -> StreamSocket

/// Injectable timer; returns its own canceller, exactly as the web's does.
public typealias Scheduler = @MainActor (Int, @escaping @MainActor () -> Void) -> () -> Void

/// What the caller of a stream wants to hear about.
public struct StreamHandlers {
    /// Every message that satisfies the contract.
    public var onMessage: @MainActor (StreamMessage) -> Void
    public var onState: @MainActor (ConnectionState) -> Void
    /// Fired after a re-open, never after the first open: the caller back-fills
    /// over REST rather than resuming as though nothing had been missed.
    public var onReconnect: @MainActor () -> Void
    /// A payload the contract rejects: dropped, counted, never rendered.
    public var onInvalidMessage: @MainActor (Data, Error) -> Void

    public init(
        onMessage: @escaping @MainActor (StreamMessage) -> Void,
        onState: @escaping @MainActor (ConnectionState) -> Void = { _ in },
        onReconnect: @escaping @MainActor () -> Void = {},
        onInvalidMessage: @escaping @MainActor (Data, Error) -> Void = { _, _ in }
    ) {
        self.onMessage = onMessage
        self.onState = onState
        self.onReconnect = onReconnect
        self.onInvalidMessage = onInvalidMessage
    }
}

/// Opens the fan-out socket and keeps it open: on close it retries with capped
/// exponential backoff, and every successful re-open tells the caller to
/// back-fill. Silence is never treated as continuity.
@MainActor
public final class StreamClient {
    private let url: URL
    private let handlers: StreamHandlers
    private let createSocket: SocketFactory
    private let schedule: Scheduler

    private var socket: StreamSocket?
    private var cancelRetry: (() -> Void)?
    private var failures = 0
    private var hasConnected = false
    private var closedByCaller = false
    private var reported: ConnectionState?

    /// The last state reported to the caller, for a view that wants to read it
    /// rather than track it.
    public var state: ConnectionState { reported ?? .connecting }

    /// The ports default to the real socket and the real timer. They are
    /// resolved in the body rather than as default arguments because a default
    /// argument is evaluated outside the actor, and both defaults live on it.
    public init(
        url: URL,
        handlers: StreamHandlers,
        createSocket: SocketFactory? = nil,
        schedule: Scheduler? = nil
    ) {
        self.url = url
        self.handlers = handlers
        self.createSocket = createSocket ?? URLSessionStreamSocket.make
        self.schedule = schedule ?? Self.defaultScheduler
    }

    /// Opens the socket. Separate from `init` so a test can assert what happens
    /// before the first attempt.
    public func open() {
        connect()
    }

    public func close() {
        closedByCaller = true
        cancelRetry?()
        cancelRetry = nil
        socket?.close()
        socket = nil
    }

    // MARK: - The retry loop

    /// Transitions only: a retry loop repeating "disconnected" is not news.
    private func setState(_ next: ConnectionState) {
        guard !closedByCaller, next != reported else { return }
        reported = next
        handlers.onState(next)
    }

    /// One rule for the label, used before and after every attempt. Deriving it
    /// in two places is what let apps/web call a connection that never existed
    /// a reconnection.
    private func currentState() -> ConnectionState {
        if failures >= disconnectedAfterAttempts { return .disconnected }
        return hasConnected ? .reconnecting : .connecting
    }

    private func retryAfterFailure() {
        failures += 1
        setState(currentState())
        guard !closedByCaller else { return }
        cancelRetry = schedule(backoffMs(forAttempt: failures - 1)) { [weak self] in
            self?.connect()
        }
    }

    private func connect() {
        guard !closedByCaller else { return }
        setState(currentState())

        let opened = createSocket(url, SocketHandlers(
            onOpen: { [weak self] in self?.handleOpen() },
            onMessage: { [weak self] data in self?.handleMessage(data) },
            onClose: { [weak self] in self?.handleClose() }
        ))

        // A caller that closed us while the socket was being built must not be
        // left holding one that nobody will ever close.
        if closedByCaller { opened.close() } else { socket = opened }
    }

    private func handleOpen() {
        guard !closedByCaller else { return }
        failures = 0
        let reopened = hasConnected
        hasConnected = true
        setState(.live)
        if reopened { handlers.onReconnect() }
    }

    private func handleMessage(_ data: Data) {
        // Delivery stops at close(), not just state reporting: a socket the
        // caller let go of must not push into a screen that moved on.
        guard !closedByCaller else { return }
        do {
            handlers.onMessage(try StreamDecoder.message(from: data))
        } catch {
            handlers.onInvalidMessage(data, error)
        }
    }

    private func handleClose() {
        guard !closedByCaller else { return }
        socket = nil
        retryAfterFailure()
    }

    /// The real timer. Returns its canceller so a pending retry dies with the
    /// screen that wanted it.
    public static let defaultScheduler: Scheduler = { delayMs, run in
        let work = DispatchWorkItem { MainActor.assumeIsolated { run() } }
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(delayMs), execute: work)
        return { work.cancel() }
    }
}

/// The real socket: `URLSessionWebSocketTask` behind the `StreamSocket` port.
///
/// Server to client only. This app never sends on the fan-out socket, because
/// frames enter the system through `/ingest` and nowhere else — and nothing
/// here opens `/ingest` either.
public final class URLSessionStreamSocket: NSObject, StreamSocket {
    /// A flag the receive queue reads and the main actor sets. The `Sendable`
    /// conformance is earned by the lock rather than asserted around it.
    private final class CloseFlag: @unchecked Sendable {
        private let lock = NSLock()
        private var value = false

        var isSet: Bool { lock.withLock { value } }

        func set() {
            lock.withLock { value = true }
        }
    }

    private let task: URLSessionWebSocketTask
    private let closed = CloseFlag()

    @MainActor
    public static func make(url: URL, handlers: SocketHandlers) -> StreamSocket {
        URLSessionStreamSocket(url: url, handlers: handlers)
    }

    private init(url: URL, handlers: SocketHandlers) {
        task = URLSession.shared.webSocketTask(with: url)
        super.init()
        task.resume()
        // A WebSocket task reports neither "open" nor "closed" without a
        // delegate, so the first successful receive is the open signal and the
        // first failed one is the close. That collapses connecting → live at
        // the first message rather than at the handshake, which is the honest
        // reading anyway: a socket that never delivers is not a live feed.
        receive(handlers: handlers, isFirst: true)
    }

    private nonisolated func receive(handlers: SocketHandlers, isFirst: Bool) {
        task.receive { [weak self] result in
            guard let self, !self.closed.isSet else { return }
            switch result {
            case let .success(message):
                let data: Data? = {
                    switch message {
                    case let .data(payload): return payload
                    case let .string(text): return text.data(using: .utf8)
                    @unknown default: return nil
                    }
                }()
                Task { @MainActor in
                    if isFirst { handlers.onOpen() }
                    if let data { handlers.onMessage(data) }
                }
                self.receive(handlers: handlers, isFirst: false)
            case .failure:
                self.closed.set()
                Task { @MainActor in handlers.onClose() }
            }
        }
    }

    public func close() {
        closed.set()
        task.cancel(with: .goingAway, reason: nil)
    }
}
