import Foundation
@testable import MaekbeatKit

/*
 * The fakes the transport tests drive. No real socket, no real timer, no wall
 * clock: every reconnect in this suite happens because a test said so, which is
 * why the suite finishes in milliseconds and cannot flake on a slow machine.
 */

@MainActor
final class FakeSocket: StreamSocket {
    let url: URL
    let handlers: SocketHandlers
    private(set) var closeCount = 0

    init(url: URL, handlers: SocketHandlers) {
        self.url = url
        self.handlers = handlers
    }

    func close() { closeCount += 1 }

    // The three things a real socket does to its owner.
    func open() { handlers.onOpen() }
    func deliver(_ text: String) { handlers.onMessage(Data(text.utf8)) }
    func deliver(_ data: Data) { handlers.onMessage(data) }
    func drop() { handlers.onClose() }
}

/// A socket factory plus a scheduler, both recording what they were asked for.
@MainActor
final class FakeTransport {
    private(set) var sockets: [FakeSocket] = []
    private(set) var scheduledDelaysMs: [Int] = []
    private(set) var cancellations = 0

    private var pending: [() -> Void] = []

    var latest: FakeSocket? { sockets.last }

    var factory: SocketFactory {
        { [weak self] url, handlers in
            let socket = FakeSocket(url: url, handlers: handlers)
            self?.sockets.append(socket)
            return socket
        }
    }

    var scheduler: Scheduler {
        { [weak self] delayMs, run in
            self?.scheduledDelaysMs.append(delayMs)
            let index = self?.pending.count ?? 0
            self?.pending.append(run)
            return { [weak self] in
                self?.cancellations += 1
                if let self, index < self.pending.count { self.pending[index] = {} }
            }
        }
    }

    /// Runs every retry scheduled so far. Time passes only here.
    func fireScheduled() {
        let due = pending
        pending = []
        for run in due { run() }
    }

    var pendingCount: Int { pending.count }
}

/// A queued-answer HTTP transport. `@unchecked Sendable` because the closure
/// crosses into an async call and every use of it is single-threaded within one
/// test — there is no concurrency here to be unsafe about.
final class StubHTTP: @unchecked Sendable {
    /// Consumed in order, one per request; the last answer repeats.
    var answers: [(Data, Int)] = []
    var thrown: Error?
    private(set) var requested: [URL] = []

    init(answers: [(Data, Int)] = [], thrown: Error? = nil) {
        self.answers = answers
        self.thrown = thrown
    }

    func transport(_ request: URLRequest) throws -> (Data, URLResponse) {
        guard let url = request.url else { throw URLError(.badURL) }
        requested.append(url)
        if let thrown { throw thrown }
        let fallback = (Data("{}".utf8), 200)
        let (data, status) = answers.count > 1 ? answers.removeFirst() : (answers.first ?? fallback)
        guard let response = HTTPURLResponse(
            url: url, statusCode: status, httpVersion: nil, headerFields: nil
        ) else {
            throw URLError(.badServerResponse)
        }
        return (data, response)
    }

    var client: APIClient {
        APIClient(baseURL: Self.baseURL) { [self] in try transport($0) }
    }

    static let baseURL = URL(string: "http://127.0.0.1:3000") ?? APIClient.defaultBaseURL
}

/// Records everything a `StreamClient` told its caller.
@MainActor
final class StreamRecorder {
    private(set) var messages: [StreamMessage] = []
    private(set) var states: [ConnectionState] = []
    private(set) var reconnects = 0
    private(set) var invalid: [Data] = []

    var handlers: StreamHandlers {
        StreamHandlers(
            onMessage: { [weak self] in self?.messages.append($0) },
            onState: { [weak self] in self?.states.append($0) },
            onReconnect: { [weak self] in self?.reconnects += 1 },
            onInvalidMessage: { [weak self] data, _ in self?.invalid.append(data) }
        )
    }
}

/// A fake uplink socket: records what was sent, and lets a test open, drop and
/// reopen it without a server.
@MainActor
final class FakeIngestSocket: IngestSocket {
    let handlers: IngestHandlers
    private(set) var sent: [String] = []
    private(set) var closeCount = 0

    init(handlers: IngestHandlers) {
        self.handlers = handlers
    }

    func send(_ text: String) { sent.append(text) }
    func close() { closeCount += 1 }

    func open() { handlers.onOpen() }
    func drop() { handlers.onClose() }
    func reply(_ text: String) { handlers.onText(text) }

    /// The seqs of the frames written to this socket, in order.
    var sentSeqs: [Int] {
        sent.compactMap { text in
            guard let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)),
                  let dictionary = object as? [String: Any] else { return nil }
            return dictionary["seq"] as? Int
        }
    }
}

/// Hands out fake uplink sockets and remembers each one.
@MainActor
final class FakeIngestTransport {
    private(set) var sockets: [FakeIngestSocket] = []
    var latest: FakeIngestSocket? { sockets.last }

    var factory: IngestSocketFactory {
        { [weak self] _, handlers in
            let socket = FakeIngestSocket(handlers: handlers)
            self?.sockets.append(socket)
            return socket
        }
    }

    /// Everything every socket ever sent, in order — the check that matters for
    /// resume is what crossed the wire in total, not per connection.
    var allSentSeqs: [Int] { sockets.flatMap(\.sentSeqs) }
}

enum IngestWire {
    static func ack(seq: Int, sessionEpoch: Int = 1, newSession: Bool = false) -> String {
        """
        {"type":"ack","deviceId":"sim-001","seq":\(seq),"sessionEpoch":\(sessionEpoch),\
        "receivedAtMs":1754265600120,"newSession":\(newSession)}
        """
    }

    static func rejected(_ reason: String) -> String {
        #"{"type":"rejected","reason":"\#(reason)"}"#
    }
}

// MARK: - Wire fixtures

enum Wire {
    static func frame(
        seq: Int,
        capturedAtMs: Int = 1_754_265_600_000,
        sessionEpoch: Int = 1,
        spo2: Double = 97.5,
        deviceId: String = "sim-001"
    ) -> String {
        """
        {"v":1,"deviceId":"\(deviceId)","seq":\(seq),"capturedAtMs":\(capturedAtMs),\
        "heartRateBpm":62,"spo2Pct":\(spo2),"respirationRpm":13.7,"motion":0.01,\
        "receivedAtMs":\(capturedAtMs + 120),"sessionEpoch":\(sessionEpoch)}
        """
    }

    static func frameMessage(
        seq: Int,
        capturedAtMs: Int = 1_754_265_600_000,
        sessionEpoch: Int = 1,
        spo2: Double = 97.5
    ) -> String {
        let inner = frame(
            seq: seq,
            capturedAtMs: capturedAtMs,
            sessionEpoch: sessionEpoch,
            spo2: spo2
        )
        return #"{"type":"frame","frame":"# + inner + "}"
    }

    static let ready = """
    {"type":"ready","deviceId":"sim-001","serverTimeMs":1754265600500,\
    "ringCapacity":1024}
    """

    static func alertMessage(
        alertId: String = "sim-001:spo2-low:1",
        state: String = "raised",
        resolvedAtMs: Int? = nil
    ) -> String {
        let resolved = resolvedAtMs.map { #","resolvedAtMs":\#($0)"# } ?? ""
        return """
        {"type":"alert","alert":{"alertId":"\(alertId)","deviceId":"sim-001",\
        "metric":"spo2Pct","direction":"low","state":"\(state)",\
        "raisedAtMs":1754265640000\(resolved),"windowStats":{"windowMs":15000,\
        "sampleCount":12,"breachCount":5,"minValue":87.5,"maxValue":91.2}}}
        """
    }

    static func decisionMessage(
        eventId: String = "sim-001:decision:1",
        alertId: String = "sim-001:spo2-low:1",
        decision: String = "acknowledged",
        recordedAtMs: Int = 1_754_265_700_000
    ) -> String {
        """
        {"type":"decision","decision":{"eventId":"\(eventId)","alertId":"\(alertId)",\
        "deviceId":"sim-001","decision":"\(decision)","actor":"ios-app",\
        "recordedAtMs":\(recordedAtMs)}}
        """
    }

    static func framesPage(_ frames: [String], deviceId: String = "sim-001") -> Data {
        let body = frames.joined(separator: ",")
        let json = """
        {"deviceId":"\(deviceId)","count":\(frames.count),"frames":[\(body)]}
        """
        return Data(json.utf8)
    }

    static let emptyAlertsPage = Data("""
    {"deviceId":"sim-001","counters":{"raised":0,"resolved":0,"suppressed":0,\
    "acknowledged":0,"dismissed":0},"alerts":[],"decisions":[]}
    """.utf8)

    static let deviceList = Data("""
    {"ingest":{"received":120,"accepted":120,"rejectedInvalid":0,\
    "duplicatesDropped":0,"sessionsStarted":1},\
    "devices":[{"deviceId":"sim-001","sessionEpoch":1,"frameCount":120,\
    "lastSeq":119,"lastReceivedAtMs":1754265719000,"duplicatesDropped":0,\
    "alertsForcedEvicted":0}]}
    """.utf8)

    static let emptyDeviceList = Data("""
    {"ingest":{"received":0,"accepted":0,"rejectedInvalid":0,\
    "duplicatesDropped":0,"sessionsStarted":0},"devices":[]}
    """.utf8)
}
