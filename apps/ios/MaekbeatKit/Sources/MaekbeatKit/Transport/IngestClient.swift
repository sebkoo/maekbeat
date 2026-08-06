import Foundation

/*
 * The uplink socket: device → server, the leg C14 derived a URL for and never
 * opened. Third and last module in this package that touches the network, and
 * the source scan in SourceDisciplineTests.swift now allows exactly three.
 *
 * Same shape as the fan-out client: an injected socket, an injected timer, and
 * the same capped backoff, so a phone that loses wifi behaves the way the
 * dashboard does. What is different is that this one sends, and therefore has
 * to answer a question the dashboard never faced — what to send after a
 * reconnect. UplinkQueue answers it; this client only carries the bytes.
 */

/// A socket that can send. Deliberately separate from `StreamSocket`, which is
/// receive-only by contract because the fan-out route ignores anything a
/// dashboard sends.
@MainActor
public protocol IngestSocket: AnyObject {
    func send(_ text: String)
    func close()
}

/// What an uplink socket tells its owner. Closures rather than a delegate
/// object, so nothing non-Sendable is captured by the receive loop — the same
/// shape `SocketHandlers` uses on the fan-out side.
public struct IngestHandlers: Sendable {
    public let onOpen: @Sendable @MainActor () -> Void
    public let onText: @Sendable @MainActor (String) -> Void
    public let onClose: @Sendable @MainActor () -> Void

    public init(
        onOpen: @escaping @Sendable @MainActor () -> Void,
        onText: @escaping @Sendable @MainActor (String) -> Void,
        onClose: @escaping @Sendable @MainActor () -> Void
    ) {
        self.onOpen = onOpen
        self.onText = onText
        self.onClose = onClose
    }
}

public typealias IngestSocketFactory = @MainActor (URL, IngestHandlers) -> IngestSocket

/// Opens `/ingest` and keeps it open, reporting replies and reconnects.
@MainActor
public final class IngestClient {
    public private(set) var state: ConnectionState = .connecting
    /// Replies that did not satisfy the contract: counted, never acted on.
    public private(set) var undecodableReplies = 0

    public var onReply: (IngestReply) -> Void = { _ in }
    public var onState: (ConnectionState) -> Void = { _ in }
    /// Fired after a re-open, never the first open. The caller resumes.
    public var onReconnect: () -> Void = {}

    private let url: URL
    private let createSocket: IngestSocketFactory
    private let schedule: Scheduler
    private var socket: IngestSocket?
    private var cancelRetry: (() -> Void)?
    private var failures = 0
    private var hasConnected = false
    private var closedByCaller = false
    private var reported: ConnectionState?

    public init(
        url: URL,
        createSocket: IngestSocketFactory? = nil,
        schedule: Scheduler? = nil
    ) {
        self.url = url
        self.createSocket = createSocket ?? URLSessionIngestSocket.make
        self.schedule = schedule ?? StreamClient.defaultScheduler
    }

    public func open() { connect() }

    public func close() {
        closedByCaller = true
        cancelRetry?()
        cancelRetry = nil
        socket?.close()
        socket = nil
    }

    /// Returns false when there is no open socket, so the caller keeps the
    /// frame buffered rather than believing it was delivered.
    @discardableResult
    public func send(_ frame: VitalsFrame) -> Bool {
        guard !closedByCaller, state == .live, let socket else { return false }
        guard let json = try? JSONEncoder().encode(frame),
              let text = String(bytes: json, encoding: .utf8) else { return false }
        socket.send(text)
        return true
    }

    // MARK: - Socket callbacks

    private func handleOpen() {
        guard !closedByCaller else { return }
        failures = 0
        let reopened = hasConnected
        hasConnected = true
        setState(.live)
        if reopened { onReconnect() }
    }

    private func handleText(_ text: String) {
        guard !closedByCaller else { return }
        guard let reply = try? IngestReply.decode(Data(text.utf8)) else {
            undecodableReplies += 1
            return
        }
        onReply(reply)
    }

    private func handleClose() {
        guard !closedByCaller else { return }
        socket = nil
        failures += 1
        setState(currentState())
        cancelRetry = schedule(backoffMs(forAttempt: failures - 1)) { [weak self] in
            self?.connect()
        }
    }

    // MARK: -

    private func currentState() -> ConnectionState {
        if failures >= disconnectedAfterAttempts { return .disconnected }
        return hasConnected ? .reconnecting : .connecting
    }

    private func setState(_ next: ConnectionState) {
        guard !closedByCaller, next != reported else { return }
        reported = next
        state = next
        onState(next)
    }

    private func connect() {
        guard !closedByCaller else { return }
        setState(currentState())
        let opened = createSocket(url, IngestHandlers(
            onOpen: { [weak self] in self?.handleOpen() },
            onText: { [weak self] text in self?.handleText(text) },
            onClose: { [weak self] in self?.handleClose() }
        ))
        if closedByCaller { opened.close() } else { socket = opened }
    }
}

/// The real uplink socket. Its send and receive paths are exercised against a
/// live apps/server by the macOS integration suite; on the simulator gate only
/// its construction runs.
public final class URLSessionIngestSocket: NSObject, IngestSocket {
    private final class Flag: @unchecked Sendable {
        private let lock = NSLock()
        private var value = false
        var isSet: Bool { lock.withLock { value } }
        func set() { lock.withLock { value = true } }
    }

    private let task: URLSessionWebSocketTask
    private let closed = Flag()

    @MainActor
    public static func make(url: URL, handlers: IngestHandlers) -> IngestSocket {
        URLSessionIngestSocket(url: url, handlers: handlers)
    }

    private init(url: URL, handlers: IngestHandlers) {
        task = URLSession.shared.webSocketTask(with: url)
        super.init()
        task.resume()
        // A WebSocket task reports no "open" of its own without a session
        // delegate. Sending is legal immediately — URLSession queues until the
        // handshake completes — so the socket is announced open as soon as the
        // task is running, and a handshake that then fails arrives as a close.
        Task { @MainActor in handlers.onOpen() }
        receive(handlers: handlers)
    }

    private nonisolated func receive(handlers: IngestHandlers) {
        task.receive { [weak self] result in
            guard let self, !self.closed.isSet else { return }
            switch result {
            case let .success(message):
                if case let .string(text) = message {
                    Task { @MainActor in handlers.onText(text) }
                }
                self.receive(handlers: handlers)
            case .failure:
                self.closed.set()
                Task { @MainActor in handlers.onClose() }
            }
        }
    }

    public func send(_ text: String) {
        task.send(.string(text)) { _ in }
    }

    public func close() {
        closed.set()
        task.cancel(with: .goingAway, reason: nil)
    }
}
