import Foundation

/*
 * The Maekbeat vitals GATT profile, central side.
 *
 * The full profile — UUIDs, payload layout, MTU arithmetic, and what a real
 * product would do differently — is docs/ble-gatt-profile.md. This file is the
 * executable half: the identifiers and the codec, both testable without a
 * radio, because a payload is just bytes.
 *
 * No peripheral implementing this profile exists. It is a documented contract
 * for a device this project does not have, which is exactly what a central has
 * to be written against anyway.
 */
public enum GattProfile {
    /// Vendor service. Deliberately not a SIG-assigned UUID: this one
    /// characteristic carries four metrics in one packet, which is not what
    /// Heart Rate (0x180D) or Pulse Oximeter (0x1822) describe, and borrowing
    /// their identifiers would misdescribe the payload to any generic client.
    /// The trade-off is recorded in docs/ble-gatt-profile.md.
    public static let serviceUUID = "6D61656B-0001-4265-6174-000000000001"

    /// Notify-only. One notification is one vitals frame.
    public static let vitalsCharacteristicUUID = "6D61656B-0001-4265-6174-000000000002"

    /// The payload version this central speaks; a different one is refused
    /// rather than guessed at, the same rule the wire contract holds for `v`.
    public static let payloadVersion: UInt8 = 1

    /// Bytes in one notification payload.
    public static let payloadSize = 19

    /// ATT's own overhead in a notification: one opcode byte, two handle bytes.
    public static let attNotificationOverhead = 3

    /// The MTU every BLE peer must accept without negotiating anything.
    public static let defaultAttMtu = 23

    /// Usable notification bytes at a given ATT MTU.
    public static func usableBytes(atMtu mtu: Int) -> Int {
        max(0, mtu - attNotificationOverhead)
    }

    /// Whether a frame fits without fragmentation at that MTU. At the default
    /// 23 the answer is yes with one byte to spare, which is the whole reason
    /// this profile has no reassembly layer — see docs/ble-gatt-profile.md.
    public static func fitsWithoutFragmentation(atMtu mtu: Int) -> Bool {
        payloadSize <= usableBytes(atMtu: mtu)
    }
}

/// Why a notification payload was not a frame.
public enum GattDecodeError: Error, Equatable {
    case wrongLength(Int)
    case unsupportedPayloadVersion(UInt8)
    /// Decoded cleanly and still failed the wire contract's bounds.
    case outsideTransportBounds(String)
}

extension GattProfile {
    /*
     * Layout, little-endian, 19 bytes. The arithmetic behind each width is in
     * docs/ble-gatt-profile.md; the short version is that the whole frame has
     * to fit in 20 bytes.
     *
     *   0   1  version
     *   1   4  seq                    uint32
     *   5   6  capturedAtMs           uint48  (epoch ms; good to the year 10889)
     *  11   2  heartRateBpm           uint16
     *  13   2  spo2Pct        x100    uint16
     *  15   2  respirationRpm x100    uint16
     *  17   2  motion         x10000  uint16
     *
     * `deviceId` is not on the air. It is the peripheral's identity, supplied
     * by the central — putting it in every notification would cost more bytes
     * than the readings do.
     */

    private static let spo2Scale = 100.0
    private static let respirationScale = 100.0
    private static let motionScale = 10_000.0

    public static func decode(_ payload: Data, deviceId: String) throws -> VitalsFrame {
        guard payload.count == payloadSize else {
            throw GattDecodeError.wrongLength(payload.count)
        }
        let bytes = [UInt8](payload)
        guard bytes[0] == payloadVersion else {
            throw GattDecodeError.unsupportedPayloadVersion(bytes[0])
        }

        let frame = VitalsFrame(
            deviceId: deviceId,
            seq: Int(readUInt32(bytes, at: 1)),
            capturedAtMs: Int(readUInt48(bytes, at: 5)),
            heartRateBpm: Int(readUInt16(bytes, at: 11)),
            spo2Pct: Double(readUInt16(bytes, at: 13)) / spo2Scale,
            respirationRpm: Double(readUInt16(bytes, at: 15)) / respirationScale,
            motion: Double(readUInt16(bytes, at: 17)) / motionScale
        )

        do {
            return try frame.validated()
        } catch {
            throw GattDecodeError.outsideTransportBounds(error.localizedDescription)
        }
    }

    /// The peripheral's side of the codec. No peripheral runs it; the tests do,
    /// which is what makes the decoder's round trip provable rather than
    /// asserted against bytes written by the same hand that reads them.
    public static func encode(_ frame: VitalsFrame) -> Data {
        var bytes = [UInt8]()
        bytes.reserveCapacity(payloadSize)
        bytes.append(payloadVersion)
        appendUInt32(&bytes, UInt32(truncatingIfNeeded: frame.seq))
        appendUInt48(&bytes, UInt64(frame.capturedAtMs))
        appendUInt16(&bytes, UInt16(clamping: frame.heartRateBpm))
        appendUInt16(&bytes, UInt16(clamping: Int((frame.spo2Pct * spo2Scale).rounded())))
        appendUInt16(&bytes, UInt16(clamping: Int((frame.respirationRpm * respirationScale).rounded())))
        appendUInt16(&bytes, UInt16(clamping: Int((frame.motion * motionScale).rounded())))
        return Data(bytes)
    }

    // MARK: - Little-endian primitives

    private static func readUInt16(_ bytes: [UInt8], at offset: Int) -> UInt16 {
        UInt16(bytes[offset]) | (UInt16(bytes[offset + 1]) << 8)
    }

    private static func readUInt32(_ bytes: [UInt8], at offset: Int) -> UInt32 {
        var value: UInt32 = 0
        for index in (0..<4).reversed() {
            value = (value << 8) | UInt32(bytes[offset + index])
        }
        return value
    }

    private static func readUInt48(_ bytes: [UInt8], at offset: Int) -> UInt64 {
        var value: UInt64 = 0
        for index in (0..<6).reversed() {
            value = (value << 8) | UInt64(bytes[offset + index])
        }
        return value
    }

    private static func appendUInt16(_ bytes: inout [UInt8], _ value: UInt16) {
        bytes.append(UInt8(value & 0xFF))
        bytes.append(UInt8((value >> 8) & 0xFF))
    }

    private static func appendUInt32(_ bytes: inout [UInt8], _ value: UInt32) {
        for shift in stride(from: 0, to: 32, by: 8) {
            bytes.append(UInt8((value >> UInt32(shift)) & 0xFF))
        }
    }

    private static func appendUInt48(_ bytes: inout [UInt8], _ value: UInt64) {
        for shift in stride(from: 0, to: 48, by: 8) {
            bytes.append(UInt8((value >> UInt64(shift)) & 0xFF))
        }
    }
}
