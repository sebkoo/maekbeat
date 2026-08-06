#if os(macOS)
import Foundation
import XCTest
@testable import MaekbeatKit

/// A real apps/server, launched for one test and killed after it.
final class ServerProcess {
    let port: Int
    private let process: Process

    static var repositoryRoot: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url = url.deletingLastPathComponent() }
        return url
    }

    static func launch() throws -> ServerProcess {
        let root = repositoryRoot
        let tsx = root.appendingPathComponent("apps/server/node_modules/.bin/tsx")
        guard FileManager.default.isExecutableFile(atPath: tsx.path) else {
            // The one honest skip in this package: the checkout has no
            // installed workspace, so there is no server to ask. CI installs it
            // and then fails the step if this suite reports a skip, so the skip
            // cannot go unnoticed where it matters.
            throw XCTSkip("apps/server dependencies are not installed — run `pnpm install`")
        }

        let port = try freePort()
        let process = Process()
        process.executableURL = tsx
        process.arguments = ["src/main.ts"]
        process.currentDirectoryURL = root.appendingPathComponent("apps/server")
        process.environment = ProcessInfo.processInfo.environment.merging([
            "HOST": "127.0.0.1",
            "PORT": String(port),
            "NODE_ENV": "test",
            "LOG_LEVEL": "silent"
        ]) { _, new in new }
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        try process.run()

        let server = ServerProcess(port: port, process: process)
        try server.waitUntilHealthy()
        return server
    }

    private init(port: Int, process: Process) {
        self.port = port
        self.process = process
    }

    func stop() {
        guard process.isRunning else { return }
        process.terminate()
        process.waitUntilExit()
    }

    var baseURL: URL {
        URL(string: "http://127.0.0.1:\(port)") ?? APIClient.defaultBaseURL
    }

    /// Asks the OS for a port nobody is using, then hands it to the server.
    private static func freePort() throws -> Int {
        let handle = socket(AF_INET, SOCK_STREAM, 0)
        guard handle >= 0 else { throw Failure.noPort }
        defer { close(handle) }

        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        address.sin_port = 0

        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(handle, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else { throw Failure.noPort }

        var assigned = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &assigned) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(handle, $0, &length)
            }
        }
        guard named == 0 else { throw Failure.noPort }
        return Int(assigned.sin_port.byteSwapped)
    }

    private func waitUntilHealthy() throws {
        let deadline = Date().addingTimeInterval(30)
        let health = baseURL.appendingPathComponent("healthz")
        while Date() < deadline {
            if (try? Data(contentsOf: health)) != nil { return }
            // A blocking sleep, not a run loop: this runs before any async work
            // and must not depend on the cooperative pool.
            Thread.sleep(forTimeInterval: 0.1)
        }
        stop()
        throw Failure.neverStarted
    }

    enum Failure: Error {
        case noPort
        case neverStarted
    }
}

/// A real uplink socket the test can cut, which is what a network drop looks
/// like to the client. The server keeps its state, so the reconnect exercises
/// resume against the same dedupe table rather than a fresh one.
@MainActor
final class ControllableIngestSocket: IngestSocket {
    private let underlying: IngestSocket
    private let handlers: IngestHandlers
    private var cut = false

    init(url: URL, handlers: IngestHandlers) {
        self.handlers = handlers
        underlying = URLSessionIngestSocket.make(url: url, handlers: handlers)
    }

    func send(_ text: String) {
        guard !cut else { return }
        underlying.send(text)
    }

    func close() {
        cut = true
        underlying.close()
    }

    /// Cut the connection without the caller asking, the way wifi does.
    func forceDrop() {
        guard !cut else { return }
        cut = true
        underlying.close()
        handlers.onClose()
    }
}

/// Drives the real gateway against the real server.
@MainActor
final class Rig {
    private let model: GatewayModel
    private let driver: BLEDriver
    private let ingest: IngestClient

    let port: Int

    /// The server this rig is driving, for tests that also want the REST side.
    var baseURL: URL {
        URL(string: "http://127.0.0.1:\(port)") ?? APIClient.defaultBaseURL
    }

    init(port: Int) {
        self.port = port
        let url = URL(string: "ws://127.0.0.1:\(port)/ingest")
            ?? APIClient.defaultBaseURL
        var made: [ControllableIngestSocket] = []
        let client = IngestClient(url: url, createSocket: { socketURL, handlers in
            let socket = ControllableIngestSocket(url: socketURL, handlers: handlers)
            made.append(socket)
            return socket
        })
        driver = BLEDriver(port: MockPeripheralPort())
        ingest = client
        model = GatewayModel(driver: driver, ingest: client)
        model.start()
        for event in [LinkEvent.peripheralConnected, .servicesResolved, .notificationsEnabled] {
            driver.handle(event)
        }
        socketsProvider = { made }
    }

    /// Separate from `init` because it awaits: a Swift initialiser cannot.
    func open() async {
        await wait(until: { self.model.uplink == .live }, "the uplink to open")
    }

    private var socketsProvider: () -> [ControllableIngestSocket] = { [] }

    var accepted: Int { model.accepted }
    var duplicates: Int { model.duplicatesRefused }
    var newSessions: Int { model.serverSessionsOpened }
    var sessionEpochs: [Int] { model.serverSessionEpochsSeen.sorted() }
    var observedReboots: Int { model.peripheralReboots }

    /// Lets anything in flight land, for assertions about what did *not*
    /// happen. A bare assertion after a send would pass before the server had
    /// a chance to disagree.
    func settle(seconds: TimeInterval = 1.5) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    /// Frames as the radio would deliver them: encoded to the GATT payload and
    /// pushed through the driver, so the queue and its resume rule are the ones
    /// under test.
    func streamFrames(_ range: ClosedRange<Int>) {
        for seq in range {
            driver.receive(payload: GattProfile.encode(frame(seq)), from: "sim-001")
        }
    }

    /// Re-offers frames through the queue, the way a peripheral retransmitting
    /// after a reconnect would. Unlike `resendRaw` this goes through the
    /// gateway's own rules, so a refusal here is the gateway's.
    func reofferFrames(_ range: ClosedRange<Int>) {
        for seq in range {
            driver.receive(payload: GattProfile.encode(frame(seq)), from: "sim-001")
        }
    }

    /// Bypasses the queue to write frames the server has already filed — the
    /// replay the resume rule exists to prevent.
    func resendRaw(_ range: ClosedRange<Int>) {
        for seq in range { ingest.send(frame(seq)) }
    }

    func dropTheSocket() async {
        socketsProvider().last?.forceDrop()
        await wait(until: { self.model.uplink == .live }, "the uplink to come back", timeout: 30)
    }

    func waitForAcks(_ count: Int) async {
        await wait(until: { self.model.accepted >= count }, "\(count) acks")
        XCTAssertEqual(model.accepted, count, "more frames were accepted than were sent")
    }

    func waitForReplies(_ count: Int) async {
        await wait(until: { self.model.accepted + self.model.duplicatesRefused >= count },
                   "\(count) replies")
    }

    /// Raises a real alert on the real engine by streaming the anomaly the
    /// server's own rules fire on, and stops as soon as the episode is open.
    ///
    /// Streaming the whole fixture would not do: it dips and then recovers, so
    /// the last frame leaves the episode `resolved` and there is no standing
    /// alert for a caregiver to be notified about. Feeding it a chunk at a time
    /// and stopping at the first open episode is also the honest shape — this
    /// is what a phone sees mid-breach, which is the only moment a notification
    /// makes sense.
    func raiseRealAlert() async throws -> AlertEvent {
        let api = APIClient(baseURL: baseURL)
        let frames = takeAnomalyFrames()
        var sent = 0

        while sent < frames.count {
            let chunk = frames[sent..<min(sent + 10, frames.count)]
            for frame in chunk {
                driver.receive(payload: GattProfile.encode(frame), from: "sim-001")
            }
            sent += chunk.count
            await waitForAcks(sent)

            let page = try await api.alerts(deviceId: "sim-001")
            if let open = page.alerts.first(where: { $0.state != .resolved }) {
                return open
            }
        }
        throw Failure.noAlertRaised
    }

    enum Failure: Error { case noAlertRaised }

    /// The desaturation the C7 rules raise on, as the goldens hold it.
    private func takeAnomalyFrames() -> [VitalsFrame] {
        let lines = (try? GoldenFixture.lines(for: .anomaly))?.frames ?? []
        return lines.compactMap { try? VitalsDecoder.frame(from: $0) }
    }

    private func frame(_ seq: Int) -> VitalsFrame {
        VitalsFrame(
            deviceId: "sim-001",
            seq: seq,
            capturedAtMs: 1_754_265_600_000 + seq * 1_000,
            heartRateBpm: 62,
            spo2Pct: 97.5,
            respirationRpm: 13.7,
            motion: 0.01
        )
    }

    /// Polls with `Task.sleep` rather than by spinning a run loop:
    /// `RunLoop.run(until:)` is unavailable from an async context, and every
    /// test in this suite is async since one of them awaits a REST read. The
    /// sync version blocked the cooperative thread and took the process with it.
    private func wait(
        until condition: () -> Bool,
        _ what: String,
        timeout: TimeInterval = 30,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("timed out waiting for \(what)", file: file, line: line)
    }
}
#endif
