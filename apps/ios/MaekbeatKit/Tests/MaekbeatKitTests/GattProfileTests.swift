import XCTest
@testable import MaekbeatKit

/*
 * The profile's codec and its MTU arithmetic.
 *
 * A payload is bytes, so all of this runs with no radio anywhere. What it does
 * not prove is that any peripheral ever sends these bytes — none exists. The
 * profile is a contract for a device this project does not have, written down
 * in docs/ble-gatt-profile.md.
 */
final class GattProfileTests: XCTestCase {
    private func frame(
        seq: Int = 7,
        capturedAtMs: Int = 1_754_265_600_000,
        heartRateBpm: Int = 62,
        spo2Pct: Double = 97.5,
        respirationRpm: Double = 13.7,
        motion: Double = 0.0031
    ) -> VitalsFrame {
        VitalsFrame(
            deviceId: "peripheral-1",
            seq: seq,
            capturedAtMs: capturedAtMs,
            heartRateBpm: heartRateBpm,
            spo2Pct: spo2Pct,
            respirationRpm: respirationRpm,
            motion: motion
        )
    }

    // MARK: - MTU, which is the constraint the layout answers to

    /// The arithmetic docs/ble-gatt-profile.md states, asserted rather than
    /// claimed. A layout that outgrew the default MTU would need fragmentation
    /// this profile deliberately does not have, and the failure would otherwise
    /// only show on hardware nobody here can run.
    func testAFrameFitsOneNotificationAtTheDefaultMtu() {
        XCTAssertEqual(GattProfile.defaultAttMtu, 23)
        XCTAssertEqual(GattProfile.attNotificationOverhead, 3)
        XCTAssertEqual(GattProfile.usableBytes(atMtu: 23), 20)
        XCTAssertEqual(GattProfile.payloadSize, 19)
        XCTAssertTrue(GattProfile.fitsWithoutFragmentation(atMtu: 23))
        XCTAssertEqual(
            GattProfile.usableBytes(atMtu: 23) - GattProfile.payloadSize,
            1,
            "one byte of headroom — the margin the profile doc quotes"
        )
    }

    func testAnMtuBelowTheDefaultWouldNotFitAndSaysSo() {
        XCTAssertFalse(GattProfile.fitsWithoutFragmentation(atMtu: 21))
        XCTAssertEqual(GattProfile.usableBytes(atMtu: 2), 0, "never negative")
        XCTAssertTrue(GattProfile.fitsWithoutFragmentation(atMtu: 185))
    }

    /// The encoder is held to the size the arithmetic assumes. This is the
    /// assertion that fails if a field is ever widened.
    func testEveryEncodedFrameIsExactlyThePayloadSize() {
        for seq in [0, 1, 65_535, 4_294_967_295] {
            let encoded = GattProfile.encode(frame(seq: seq))
            XCTAssertEqual(encoded.count, GattProfile.payloadSize, "seq \(seq)")
        }
    }

    // MARK: - The codec

    func testAFrameSurvivesTheRoundTripFieldByField() throws {
        let original = frame()
        let decoded = try GattProfile.decode(GattProfile.encode(original), deviceId: "peripheral-1")

        XCTAssertEqual(decoded.v, 1)
        XCTAssertEqual(decoded.deviceId, "peripheral-1")
        XCTAssertEqual(decoded.seq, 7)
        XCTAssertEqual(decoded.capturedAtMs, 1_754_265_600_000)
        XCTAssertEqual(decoded.heartRateBpm, 62)
        XCTAssertEqual(decoded.spo2Pct, 97.5, accuracy: 0.005)
        XCTAssertEqual(decoded.respirationRpm, 13.7, accuracy: 0.005)
        XCTAssertEqual(decoded.motion, 0.0031, accuracy: 0.00005)
    }

    /// The scaling is the lossy part, so its resolution is pinned rather than
    /// assumed: two decimals on the percentages, four on motion.
    func testTheFixedPointScalingKeepsTheResolutionTheContractNeeds() throws {
        let precise = frame(spo2Pct: 88.37, respirationRpm: 21.09, motion: 0.9999)
        let decoded = try GattProfile.decode(GattProfile.encode(precise), deviceId: "p")
        XCTAssertEqual(decoded.spo2Pct, 88.37, accuracy: 0.005)
        XCTAssertEqual(decoded.respirationRpm, 21.09, accuracy: 0.005)
        XCTAssertEqual(decoded.motion, 0.9999, accuracy: 0.00005)
    }

    /// A 48-bit millisecond field is the reason the frame fits. It has to hold
    /// a real epoch timestamp, not just a small one.
    func testTheSixByteTimestampHoldsARealEpochAndThenSome() throws {
        let far = frame(capturedAtMs: 281_474_976_710_655)
        let decoded = try GattProfile.decode(GattProfile.encode(far), deviceId: "p")
        XCTAssertEqual(decoded.capturedAtMs, 281_474_976_710_655)
    }

    /// The bounds live in the wire contract, and the radio path does not get to
    /// skip them: a peripheral sending nonsense is caught here rather than
    /// forwarded to the server.
    func testAPayloadDecodingOutsideTheTransportBoundsIsRejected() {
        var bytes = [UInt8](GattProfile.encode(frame()))
        bytes[13] = 0xFF
        bytes[14] = 0xFF      // spo2 x100 = 65535 → 655.35 %
        XCTAssertThrowsError(try GattProfile.decode(Data(bytes), deviceId: "p")) { error in
            guard case .outsideTransportBounds = error as? GattDecodeError else {
                return XCTFail("expected a bounds failure, got \(error)")
            }
        }
    }

    func testAShortOrLongPayloadIsRejected() {
        let good = GattProfile.encode(frame())
        XCTAssertThrowsError(try GattProfile.decode(good.dropLast(), deviceId: "p")) { error in
            XCTAssertEqual(error as? GattDecodeError, .wrongLength(18))
        }
        XCTAssertThrowsError(try GattProfile.decode(good + Data([0]), deviceId: "p")) { error in
            XCTAssertEqual(error as? GattDecodeError, .wrongLength(20))
        }
        XCTAssertThrowsError(try GattProfile.decode(Data(), deviceId: "p")) { error in
            XCTAssertEqual(error as? GattDecodeError, .wrongLength(0))
        }
    }

    func testAPayloadFromAFutureProfileVersionIsRefusedRatherThanGuessedAt() {
        var bytes = [UInt8](GattProfile.encode(frame()))
        bytes[0] = 2
        XCTAssertThrowsError(try GattProfile.decode(Data(bytes), deviceId: "p")) { error in
            XCTAssertEqual(error as? GattDecodeError, .unsupportedPayloadVersion(2))
        }
    }

    /// The device identity is the peripheral's, not the payload's — the reason
    /// the frame fits in 19 bytes at all.
    func testTheDeviceIdComesFromTheCentralAndNotTheAir() throws {
        let payload = GattProfile.encode(frame())
        let first = try GattProfile.decode(payload, deviceId: "peripheral-a")
        let second = try GattProfile.decode(payload, deviceId: "peripheral-b")
        XCTAssertEqual(first.deviceId, "peripheral-a")
        XCTAssertEqual(second.deviceId, "peripheral-b")
        XCTAssertEqual(first.seq, second.seq)
    }

    /// The bytes are little-endian, and a decoder that read them the other way
    /// round would still round-trip against its own encoder. This pins the
    /// order against a hand-written payload instead.
    func testTheLayoutIsLittleEndianAgainstHandWrittenBytes() throws {
        var bytes = [UInt8](repeating: 0, count: 19)
        bytes[0] = 1
        bytes[1] = 0x02; bytes[2] = 0x01           // seq = 0x0102 = 258
        bytes[5] = 0x40; bytes[6] = 0x9C           // capturedAtMs = 0x9C40 = 40000
        bytes[11] = 0x48                           // hr = 72
        bytes[13] = 0x0C; bytes[14] = 0x27         // spo2 x100 = 0x270C = 9996
        bytes[15] = 0xB8; bytes[16] = 0x0B         // resp x100 = 0x0BB8 = 3000
        bytes[17] = 0xE8; bytes[18] = 0x03         // motion x10000 = 0x03E8 = 1000

        let decoded = try GattProfile.decode(Data(bytes), deviceId: "p")
        XCTAssertEqual(decoded.seq, 258)
        XCTAssertEqual(decoded.capturedAtMs, 40_000)
        XCTAssertEqual(decoded.heartRateBpm, 72)
        XCTAssertEqual(decoded.spo2Pct, 99.96, accuracy: 0.005)
        XCTAssertEqual(decoded.respirationRpm, 30, accuracy: 0.005)
        XCTAssertEqual(decoded.motion, 0.1, accuracy: 0.00005)
    }

    func testTheProfileIdentifiersAreStableAndDistinct() {
        XCTAssertNotEqual(GattProfile.serviceUUID, GattProfile.vitalsCharacteristicUUID)
        XCTAssertEqual(GattProfile.serviceUUID, "6D61656B-0001-4265-6174-000000000001")
        XCTAssertEqual(GattProfile.vitalsCharacteristicUUID, "6D61656B-0001-4265-6174-000000000002")
        XCTAssertEqual(
            UUID(uuidString: GattProfile.serviceUUID)?.uuidString,
            GattProfile.serviceUUID,
            "must be a well-formed 128-bit UUID"
        )
        XCTAssertEqual(
            UUID(uuidString: GattProfile.vitalsCharacteristicUUID)?.uuidString,
            GattProfile.vitalsCharacteristicUUID
        )
    }
}
