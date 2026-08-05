import Foundation
import Observation

/// The device list screen's state. Everything the view draws is decided here,
/// where a test can drive it; the view itself is a rendering of this and holds
/// no logic of its own.
@MainActor
@Observable
public final class DeviceListModel {
    public private(set) var state: LoadState<[DeviceSummary]> = .loading
    public private(set) var ingest: IngestCounters?

    private let client: APIClient

    public init(client: APIClient) {
        self.client = client
    }

    /// A reachable server with no devices is `empty`, not an error and not an
    /// empty list rendered as data. The distinction is the whole point of the
    /// union: "nobody has connected a device yet" is a true and useful answer.
    public func load() async {
        state = .loading
        do {
            let list = try await client.devices()
            ingest = list.ingest
            state = list.devices.isEmpty ? .empty : .ready(list.devices)
        } catch let failure as APIFailure {
            state = .failed(failure)
        } catch {
            state = .failed(.network(error.localizedDescription))
        }
    }
}
