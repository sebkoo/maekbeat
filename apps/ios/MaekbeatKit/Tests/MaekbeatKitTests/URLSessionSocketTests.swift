import XCTest
@testable import MaekbeatKit

/*
 * The one test in this package that opens a real socket.
 *
 * Everything else drives `FakeSocket`, which is right: reconnect logic tested
 * against a live server is a test that fails when a port is busy. But the
 * default `SocketFactory` is what actually ships, and a port that nothing is
 * listening on is a deterministic way to reach its failure path — a refused
 * connection on loopback answers immediately and needs no fixture.
 *
 * The named limit, so it is not mistaken for more than it is: this covers
 * construction, the failure branch, and close. The success path — a handshake,
 * a delivered frame — has no coverage here, because proving it needs a real
 * apps/server process, which is what apps/web's C13 smoke suite does for the
 * dashboard and what apps/ios does not have yet. It is on the record in
 * apps/ios/README.md rather than implied away.
 */
@MainActor
final class URLSessionSocketTests: XCTestCase {
    /// Port 1 on loopback: privileged, unbound, and refused immediately.
    private let unreachable = URL(string: "ws://127.0.0.1:1/devices/sim-001/stream")!

    func testTheRealSocketReportsARefusedConnectionAsAClose() {
        let closed = expectation(description: "the socket reported a close")
        let socket = URLSessionStreamSocket.make(url: unreachable, handlers: SocketHandlers(
            onOpen: { XCTFail("nothing is listening; there is no open to report") },
            onMessage: { _ in XCTFail("nothing is listening; there is no message") },
            onClose: { closed.fulfill() }
        ))

        wait(for: [closed], timeout: 10)
        socket.close()
    }

    /// The uplink's real socket, same method: a refused port covers its
    /// construction, its receive-failure branch and its close. The send path
    /// and the handshake are the integration suite's, not this one's.
    func testTheRealUplinkSocketReportsARefusedConnectionAsAClose() {
        let closed = expectation(description: "the uplink socket reported a close")
        let socket = URLSessionIngestSocket.make(url: unreachable, handlers: IngestHandlers(
            onOpen: {},
            onText: { _ in XCTFail("nothing is listening; there is no reply") },
            onClose: { closed.fulfill() }
        ))
        // Legal before the handshake resolves: URLSession queues it, and the
        // failure arrives as a close rather than as a throw.
        socket.send("{}")

        wait(for: [closed], timeout: 10)
        socket.close()
    }

    /// The client's retry loop over the real factory: a refused connection is a
    /// failure like any other, so the backoff runs rather than the badge
    /// freezing on "connecting" forever.
    func testTheClientRetriesOverTheRealSocketFactory() {
        let reconnecting = expectation(description: "the client scheduled a retry")
        var delays: [Int] = []
        let recorder = StreamRecorder()

        let client = StreamClient(
            url: unreachable,
            handlers: recorder.handlers,
            schedule: { delayMs, _ in
                delays.append(delayMs)
                reconnecting.fulfill()
                return {}
            }
        )
        client.open()

        wait(for: [reconnecting], timeout: 10)
        client.close()

        XCTAssertEqual(delays.first, backoffBaseMs)
        XCTAssertEqual(recorder.states.first, .connecting)
    }
}
