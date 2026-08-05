import Foundation

/*
 * The wire contract, hand-written in Swift.
 *
 * packages/protocol is the source of truth and there is no code generation
 * here — a generator would make these types a projection of the schema and
 * prove nothing about the bytes. Instead the honesty check is external: the
 * tests in Tests/MaekbeatKitTests/GoldenContractTests.swift decode the very
 * same packages/vitals-sim/golden/<scenario>.ndjson fixtures the TypeScript suites
 * pin, so a rename on either side breaks a test that neither side owns.
 *
 * What that mechanism covers and what it cannot is written down in
 * apps/ios/README.md; read it before trusting these types with anything.
 */

/// The protocol version this client speaks. A receiver rejects anything else
/// rather than guessing — the evolution policy in packages/protocol/README.md.
public let protocolVersion = 1

/// Transport-validity bounds, mirroring `VITALS_BOUNDS` in
/// packages/protocol/src/vitals.ts. These are the sensor-representable range,
/// **not** clinical thresholds: an SpO2 of 45 is a reading this pipeline exists
/// to surface, and judging severity belongs to the server's alert engine.
public enum VitalsBounds {
    public static let heartRateBpm: ClosedRange<Int> = 0...300
    public static let spo2Pct: ClosedRange<Double> = 0...100
    public static let respirationRpm: ClosedRange<Double> = 0...120
    public static let motion: ClosedRange<Double> = 0...1
}

/// Why a payload that parsed as JSON is still not a frame this client accepts.
public enum ContractError: Error, Equatable {
    /// The payload announced a protocol version this client does not speak.
    case unsupportedVersion(Int)
    /// A field decoded but fell outside its transport-validity bound.
    case outOfBounds(field: String, value: Double)
    /// A discriminated union carried a `type` this client does not know.
    case unknownMessageType(String)
}

extension ContractError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case let .unsupportedVersion(version):
            return "protocol version \(version) is not version \(protocolVersion)"
        case let .outOfBounds(field, value):
            return "\(field) is outside its transport bound: \(value)"
        case let .unknownMessageType(type):
            return "unknown message type: \(type)"
        }
    }
}

/// One vitals reading as it travels the wire, mirroring `vitalsFrameSchema`.
public struct VitalsFrame: Codable, Equatable, Sendable {
    public let v: Int
    public let deviceId: String
    public let seq: Int
    /// Device clock, epoch ms. Charts use this; alerts never do.
    public let capturedAtMs: Int
    public let heartRateBpm: Int
    public let spo2Pct: Double
    public let respirationRpm: Double
    public let motion: Double

    public init(
        v: Int = protocolVersion,
        deviceId: String,
        seq: Int,
        capturedAtMs: Int,
        heartRateBpm: Int,
        spo2Pct: Double,
        respirationRpm: Double,
        motion: Double
    ) {
        self.v = v
        self.deviceId = deviceId
        self.seq = seq
        self.capturedAtMs = capturedAtMs
        self.heartRateBpm = heartRateBpm
        self.spo2Pct = spo2Pct
        self.respirationRpm = respirationRpm
        self.motion = motion
    }

    /// The version and bounds checks `vitalsFrameSchema` performs at parse time.
    /// Decoding alone does not run them; `VitalsDecoder` does.
    public func validated() throws -> Self {
        guard v == protocolVersion else { throw ContractError.unsupportedVersion(v) }
        guard VitalsBounds.heartRateBpm.contains(heartRateBpm) else {
            throw ContractError.outOfBounds(field: "heartRateBpm", value: Double(heartRateBpm))
        }
        guard VitalsBounds.spo2Pct.contains(spo2Pct) else {
            throw ContractError.outOfBounds(field: "spo2Pct", value: spo2Pct)
        }
        guard VitalsBounds.respirationRpm.contains(respirationRpm) else {
            throw ContractError.outOfBounds(field: "respirationRpm", value: respirationRpm)
        }
        guard VitalsBounds.motion.contains(motion) else {
            throw ContractError.outOfBounds(field: "motion", value: motion)
        }
        return self
    }
}

/// A frame after ingest: the wire frame plus the two stamps apps/server adds,
/// mirroring `storedVitalsFrameSchema`. This is the shape the app actually
/// receives, over REST and over the fan-out socket alike.
public struct StoredVitalsFrame: Codable, Equatable, Sendable {
    public let v: Int
    public let deviceId: String
    public let seq: Int
    public let capturedAtMs: Int
    public let heartRateBpm: Int
    public let spo2Pct: Double
    public let respirationRpm: Double
    public let motion: Double
    /// Server clock at ingest. `receivedAtMs - capturedAtMs` is the drift signal
    /// of docs/ARCHITECTURE.md.
    public let receivedAtMs: Int
    /// Bumped when the device reboots or its `seq` regresses past the server's
    /// reorder window (docs/DECISIONS.md #11).
    public let sessionEpoch: Int

    /// The device clock's offset from the server's, in milliseconds. Negative
    /// means the device is behind; the simulator replaying faster than realtime
    /// drives it deeply negative, which is replay speed, not latency.
    public var clockDeltaMs: Int { receivedAtMs - capturedAtMs }

    /// The wire frame underneath the server's stamps.
    public var wireFrame: VitalsFrame {
        VitalsFrame(
            v: v,
            deviceId: deviceId,
            seq: seq,
            capturedAtMs: capturedAtMs,
            heartRateBpm: heartRateBpm,
            spo2Pct: spo2Pct,
            respirationRpm: respirationRpm,
            motion: motion
        )
    }

    /// Runs the wire frame's checks; the stamps add no bounds of their own.
    public func validated() throws -> Self {
        _ = try wireFrame.validated()
        return self
    }
}

/// The one place JSON becomes contract types, so the version and bounds checks
/// cannot be skipped by a caller that decodes directly.
public enum VitalsDecoder {
    public static let json = JSONDecoder()

    public static func frame(from data: Data) throws -> VitalsFrame {
        try json.decode(VitalsFrame.self, from: data).validated()
    }
}
