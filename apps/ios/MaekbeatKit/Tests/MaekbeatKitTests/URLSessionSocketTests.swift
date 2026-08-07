import XCTest
@testable import MaekbeatKit

/*
 * The one test in this package that opens a real socket.
 *
 * Everything else drives `FakeSocket`, which is right: reconnect logic tested
 * against a live server is a test that fails when a port is busy. But the
 * default `SocketFactory` is what actually ships, and a port that nothing is
 * listening on is a deterministic way to reach its failure path — a refused
 * connection on loopback needs no fixture.
 *
 * How long that refusal takes, measured rather than believed. This file used to
 * claim it "answers immediately" and sized a 10 s ceiling from that claim; the
 * claim is false and the ceiling is what failed CI run 31195019557.
 *
 *   local, idle                 0.077 - 0.338 s   one test, 30 runs
 *   local, 12 cores loaded      0.245 - 6.083 s   one test, 7 runs
 *   CI, green run 31188295211   1.613 - 7.336 s   three tests, one run each
 *   CI, run 31195019557         exceeded 10 s     the failure
 *
 * Those rows are not one experiment. The local pairs repeat a single test to
 * find its spread; the CI row is the three tests in this file on one run, so
 * its range is across tests rather than across repeats.
 *
 * So the ceilings here are 60 s, roughly 8x that 7.336 s maximum. A ceiling on
 * a condition-wait bounds a hang; it is not an assertion about speed, and it
 * costs its full value only when the condition never arrives at all.
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
    /// Port 1 on loopback: privileged and unbound, so the connection is refused
    /// rather than left hanging. Refused is not the same as instant — see above.
    private let unreachable = URL(string: "ws://127.0.0.1:1/devices/sim-001/stream")!

    /// The hang detector every wait in this file uses. Sized from the table
    /// above, not from a guess about how fast loopback answers.
    private let refusalCeiling: TimeInterval = 60

    func testTheRealSocketReportsARefusedConnectionAsAClose() {
        let closed = expectation(description: "the socket reported a close")
        let socket = URLSessionStreamSocket.make(url: unreachable, handlers: SocketHandlers(
            onOpen: { XCTFail("nothing is listening; there is no open to report") },
            onMessage: { _ in XCTFail("nothing is listening; there is no message") },
            onClose: { closed.fulfill() }
        ))

        wait(for: [closed], timeout: refusalCeiling)
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

        wait(for: [closed], timeout: refusalCeiling)
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

        wait(for: [reconnecting], timeout: refusalCeiling)
        client.close()

        XCTAssertEqual(delays.first, backoffBaseMs)
        XCTAssertEqual(recorder.states.first, .connecting)
    }
}
