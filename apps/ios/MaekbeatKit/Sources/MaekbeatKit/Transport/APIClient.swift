import Foundation

/*
 * The REST half of the transport. Two modules in this package touch the
 * network — this one and StreamClient.swift — and a source scan in
 * Tests/MaekbeatKitTests/SourceDisciplineTests.swift fails the build if a
 * third appears. apps/web holds the same line for the same reason: a view that
 * can open its own connection is a view whose failure states nobody designed.
 */

/// Why a read failed, split by cause rather than by status code, because the
/// interface has to tell "the server is down" apart from "the server said no".
public enum APIFailure: Error, Equatable {
    /// The request never reached a server.
    case network(String)
    /// The server answered with a failure status.
    case http(status: Int, message: String?)
    /// The server answered, and the answer did not satisfy the wire contract.
    case contract(String)

    /// True when nothing was reached at all — the `disconnected` state rather
    /// than the `error` state.
    public var isDisconnected: Bool {
        if case .network = self { return true }
        return false
    }
}

extension APIFailure: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case let .network(detail):
            return detail
        case let .http(status, message):
            return message.map { "\(status): \($0)" } ?? "the server answered \(status)"
        case let .contract(detail):
            return "the response did not match the wire contract — \(detail)"
        }
    }
}

/// The injected seam. Tests hand in a closure; the app hands in `URLSession`.
public typealias HTTPTransport = @Sendable (URLRequest) async throws -> (Data, URLResponse)

/// A typed client over the apps/server read surface.
///
/// The six HTTP routes here are the ones apps/server/src/openapi.test.ts pins.
/// `POST /devices/:id/alerts/:id/decisions` arrived at C16 with the commit that
/// calls it: a notification action records a decision, and it has to land in
/// the same append-only log the dashboard writes to, under the same `alertId`.
/// Until then it was deliberately absent, because a route nobody calls is a
/// claim about a feature.
public struct APIClient: Sendable {
    public let baseURL: URL
    private let transport: HTTPTransport
    private let decoder: JSONDecoder

    public init(baseURL: URL, transport: HTTPTransport? = nil) {
        self.baseURL = baseURL
        self.transport = transport ?? Self.urlSession
        self.decoder = JSONDecoder()
    }

    /// A stored property rather than a default argument. Written as
    /// `transport: @escaping HTTPTransport = { try await URLSession.shared... }`
    /// it segfaults in `swift_task_dealloc` under Swift 5.10 whenever the call
    /// is made from an async context — the default-argument generator emits the
    /// async closure's context onto the caller's task stack and then frees it
    /// twice. Every unit test passed a transport explicitly, so the first call
    /// site to take the default from an `async` function was C16's integration
    /// test, and it crashed the process rather than failing.
    private static let urlSession: HTTPTransport = {
        try await URLSession.shared.data(for: $0)
    }

    /// The default server a simulator build talks to. `127.0.0.1` resolves to
    /// the host Mac from the iOS Simulator, which is the only reason this works
    /// without a LAN address; a device build needs `MAEKBEAT_API_BASE_URL`.
    public static let defaultBaseURL = URL(string: "http://127.0.0.1:3000")!

    // MARK: - Routes

    public func health() async throws -> Health {
        try await get(Health.self, path: "/healthz")
    }

    public func devices() async throws -> DeviceList {
        try await get(DeviceList.self, path: "/devices")
    }

    public func frames(
        deviceId: String,
        since: Int? = nil,
        limit: Int = 100
    ) async throws -> FramesPage {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let since { query.append(URLQueryItem(name: "since", value: String(since))) }
        return try await get(FramesPage.self, path: framesPath(deviceId), query: query)
    }

    public func alerts(deviceId: String) async throws -> AlertsPage {
        try await get(AlertsPage.self, path: alertsPath(deviceId))
    }

    /// Records a caregiver's decision on one alert — the write half of the
    /// C12 acknowledgement contract, and the last leg of the C16 circuit.
    ///
    /// The server appends rather than updates, so a change of mind is a second
    /// event and the newest one is in force. A refusal is surfaced, never
    /// swallowed: the phone must not show a decision the log does not hold.
    @discardableResult
    public func recordDecision(
        deviceId: String,
        alertId: String,
        decision: AlertDecision,
        actor: String = "ios-gateway"
    ) async throws -> AlertDecisionEvent {
        let path = "\(alertsPath(deviceId))/\(escape(alertId))/decisions"
        return try await post(
            AlertDecisionEvent.self,
            path: path,
            body: ["decision": decision.rawValue, "actor": actor]
        )
    }

    /// The fan-out socket `StreamClient` opens — the same endpoint the
    /// dashboard uses, so this app is a second subscriber and not a second
    /// protocol.
    public func streamURL(deviceId: String) -> URL {
        webSocketURL(path: "/devices/\(escape(deviceId))/stream")
    }

    /// The device-to-server ingest leg. Derived here so the URL exists in one
    /// place when C15's gateway needs it; nothing in this app sends on it, and
    /// a source scan asserts that.
    public func ingestURL() -> URL {
        webSocketURL(path: "/ingest")
    }

    // MARK: - Plumbing

    private func framesPath(_ deviceId: String) -> String {
        "/devices/\(escape(deviceId))/frames"
    }

    private func alertsPath(_ deviceId: String) -> String {
        "/devices/\(escape(deviceId))/alerts"
    }

    /// Percent-encodes one path segment. `urlPathAllowed` keeps `/`, which is
    /// the one character that must not survive: a `deviceId` containing a slash
    /// would otherwise invent a route rather than name a device.
    private func escape(_ segment: String) -> String {
        let encoded = segment.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
        return (encoded ?? segment).replacingOccurrences(of: "/", with: "%2F")
    }

    /// Built from `percentEncodedPath` rather than `appendingPathComponent`,
    /// which would encode the `%` of an already-escaped segment a second time.
    private func makeURL(path: String, query: [URLQueryItem] = []) -> URL? {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        var prefix = components?.percentEncodedPath ?? ""
        if prefix.hasSuffix("/") { prefix.removeLast() }
        components?.percentEncodedPath = prefix + path
        if !query.isEmpty { components?.queryItems = query }
        return components?.url
    }

    private func webSocketURL(path: String) -> URL {
        var components = URLComponents(url: makeURL(path: path) ?? baseURL,
                                       resolvingAgainstBaseURL: false)
        components?.scheme = baseURL.scheme == "https" ? "wss" : "ws"
        return components?.url ?? baseURL
    }

    private func post<T: Decodable>(
        _ type: T.Type,
        path: String,
        body: [String: String]
    ) async throws -> T {
        guard let url = makeURL(path: path) else {
            throw APIFailure.network("could not build a URL for \(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONEncoder().encode(body)
        return try await send(type, request: request)
    }

    private func get<T: Decodable>(
        _ type: T.Type,
        path: String,
        query: [URLQueryItem] = []
    ) async throws -> T {
        guard let url = makeURL(path: path, query: query) else {
            throw APIFailure.network("could not build a URL for \(path)")
        }
        return try await send(type, request: URLRequest(url: url))
    }

    private func send<T: Decodable>(_ type: T.Type, request: URLRequest) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await transport(request)
        } catch {
            throw APIFailure.network(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIFailure.contract("the response was not HTTP")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIFailure.http(status: http.statusCode, message: serverMessage(in: data))
        }

        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIFailure.contract(String(describing: error))
        }
    }

    /// apps/server's error bodies are `{statusCode, message}`; anything else is
    /// carried as no message rather than as a guess.
    private func serverMessage(in data: Data) -> String? {
        struct ErrorBody: Decodable { let message: String }
        return try? JSONDecoder().decode(ErrorBody.self, from: data).message
    }
}
