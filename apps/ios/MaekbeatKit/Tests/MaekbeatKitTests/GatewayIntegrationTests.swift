#if os(macOS)
import Foundation
import XCTest
@testable import MaekbeatKit

/*
 * The resume promise, checked against the server that has to honour it.
 *
 * Every other test in this package asserts what UplinkQueue does. This one
 * launches a real apps/server, drives the real IngestClient over a real
 * WebSocket, and reads the server's own `ack` and `rejected` replies — so the
 * oracle is apps/server/src/store.ts rather than a Swift restatement of what
 * that file is believed to do. If the server's dedupe rule changes, these fail
 * without anyone remembering to update a mirror of it.
 *
 * macOS only, because it spawns a process and an iOS Simulator test cannot.
 * That puts it outside the coverage gate, which runs on the simulator — stated
 * in apps/ios/README.md rather than left to be discovered. It runs as its own
 * CI step.
 *
 * Skipped rather than failed when the workspace has no installed dependencies,
 * which is the one case where the suite is being asked something the checkout
 * cannot answer. Every other failure is a failure.
 */
@MainActor
final class GatewayIntegrationTests: XCTestCase {
    private var server: ServerProcess?

    override func tearDownWithError() throws {
        server?.stop()
        server = nil
        try super.tearDownWithError()
    }

    // MARK: - The promise

    /// Reconnect and carry on: what the server acknowledged is never sent
    /// again, and the server never calls anything a duplicate.
    func testResumingFromTheLastAcknowledgedSeqProducesNoDuplicates() throws {
        let rig = try start()
        rig.streamFrames(1...80)
        rig.waitForAcks(80)
        XCTAssertEqual(rig.duplicates, 0)

        rig.dropTheSocket()
        rig.streamFrames(81...120)
        rig.waitForAcks(120)

        XCTAssertEqual(rig.duplicates, 0, "a resume must not re-offer a delivered frame")
        XCTAssertEqual(rig.accepted, 120)
        XCTAssertEqual(rig.sessionEpochs, [1], "one session throughout")
    }

    /// The counter-test, and the reason the resume exists: replaying the
    /// session from the start is not merely wasteful, the server calls it a
    /// duplicate. Asserted against the server rather than assumed.
    func testReplayingFromTheStartIsRefusedByTheRealServerAsDuplicates() throws {
        let rig = try start()
        rig.streamFrames(1...40)
        rig.waitForAcks(40)

        rig.resendRaw(1...40)
        rig.waitForReplies(80)

        XCTAssertEqual(rig.duplicates, 40, "the server refuses every replayed frame")
        XCTAssertEqual(rig.accepted, 40)
    }

    /// The named threat, against the server that would report it: the uplink
    /// reconnects and the peripheral re-offers frames the server already filed.
    /// The acknowledged mark survives the socket, so nothing goes out and the
    /// server never counts a duplicate.
    func testAPeripheralRetransmitAfterAReconnectIsRefusedBeforeItReachesTheServer() throws {
        let rig = try start()
        rig.streamFrames(1...40)
        rig.waitForAcks(40)

        rig.dropTheSocket()
        rig.reofferFrames(35...40)
        rig.settle()

        XCTAssertEqual(rig.duplicates, 0, "the gateway refused them; the server was never asked")
        XCTAssertEqual(rig.accepted, 40, "and nothing new was accepted either")
    }

    // MARK: - The reboot rule, as the server actually implements it

    /// A `seq` regression past the server's reorder window opens a new epoch.
    /// The number 64 is apps/server/src/store.ts's, and this asks that server
    /// rather than quoting it — which is how the second half of the assertion
    /// was learned: the server also calls a device's very first frame a new
    /// session, so a run with one reboot in it reports two.
    func testARebootPastTheReorderWindowOpensANewServerSession() throws {
        let rig = try start()
        rig.streamFrames(1...100)
        rig.waitForAcks(100)
        XCTAssertEqual(rig.newSessions, 1, "the first frame from a new device opens session 1")

        rig.streamFrames(0...0)
        rig.waitForAcks(101)

        XCTAssertEqual(rig.sessionEpochs, [1, 2], "the server filed a second session")
        XCTAssertEqual(rig.newSessions, 2, "session 1 at first contact, session 2 at the reboot")
        XCTAssertEqual(rig.duplicates, 0)
    }

    /// The residual limit, demonstrated — and it is worse than
    /// packages/protocol/README.md predicted, which is why this test exists in
    /// this form rather than confirming that paragraph.
    ///
    /// The README expected an in-window reboot to be "absorbed as duplicates"
    /// by the server. It never reaches the server: the gateway's own resume
    /// rule refuses to send anything at or below the last acknowledged `seq`,
    /// so a peripheral that reboots before its counter passes the window has
    /// its new session's early frames dropped on the phone, silently, until
    /// `seq` climbs past the old high-water mark. That is data loss, not
    /// deduplication, and the fix is the same one the protocol README already
    /// names: a wire-level boot id, which is a `v` bump and not this commit.
    func testAnInWindowRebootHasItsFramesDroppedByTheGatewayBeforeTheServerSeesThem() throws {
        let rig = try start()
        rig.streamFrames(1...10)
        rig.waitForAcks(10)

        rig.streamFrames(0...0)
        rig.settle()

        XCTAssertEqual(rig.accepted, 10, "the rebooted frame never left the phone")
        XCTAssertEqual(rig.duplicates, 0, "the server was never asked, so it refused nothing")
        XCTAssertEqual(rig.sessionEpochs, [1], "one epoch: the server saw no regression at all")
        XCTAssertEqual(rig.observedReboots, 0, "and the gateway did not call it a reboot either")
    }

    // MARK: - Harness

    private func start() throws -> Rig {
        let process = try ServerProcess.launch()
        server = process
        return Rig(port: process.port)
    }
}
#endif
