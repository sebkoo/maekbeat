import Foundation

/*
 * The server's per-message reply on `/ingest`, mirroring what
 * apps/server/src/ingest.ts sends. This is the direction C14 did not have: the
 * dashboard only ever read, and the gateway writes.
 *
 * The reply is what makes resume checkable rather than hopeful. `ack` carries
 * the `sessionEpoch` the server filed the frame under and whether that epoch is
 * new, so the phone learns about a session fork from the server rather than
 * predicting one; `rejected: duplicate` is the server saying a frame was sent
 * twice, which is precisely the outcome UplinkQueue exists to avoid.
 */
public enum IngestReply: Equatable, Sendable {
    case ack(Ack)
    case rejected(Rejection)

    public struct Ack: Codable, Equatable, Sendable {
        public let deviceId: String
        public let seq: Int
        public let sessionEpoch: Int
        public let receivedAtMs: Int
        /// True when this frame opened a new server-side session — a reboot the
        /// server inferred from a `seq` regression past its reorder window.
        public let newSession: Bool
    }

    public struct Rejection: Codable, Equatable, Sendable {
        public let reason: Reason

        public enum Reason: String, Codable, Sendable, CaseIterable {
            case invalidJson = "invalid_json"
            case invalidFrame = "invalid_frame"
            case duplicate
        }
    }

    private enum TypeKey: String, CodingKey {
        case type
    }
}

extension IngestReply: Decodable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: TypeKey.self)
        switch try container.decode(String.self, forKey: .type) {
        case "ack":
            self = .ack(try Ack(from: decoder))
        case "rejected":
            self = .rejected(try Rejection(from: decoder))
        case let other:
            throw ContractError.unknownMessageType(other)
        }
    }

    public static func decode(_ data: Data) throws -> IngestReply {
        try JSONDecoder().decode(IngestReply.self, from: data)
    }
}
