import Foundation

/// Every message the fan-out socket can send, mirroring `streamMessageSchema`.
///
/// A `type` this client does not know is an error rather than a silent skip:
/// rendering a message you did not understand is how a monitoring surface
/// starts showing something that is not there.
public enum StreamMessage: Equatable, Sendable {
    /// Sent once on subscribe, before any frame.
    case ready(Ready)
    case frame(StoredVitalsFrame)
    case alert(AlertEvent)
    case decision(AlertDecisionEvent)

    public struct Ready: Codable, Equatable, Sendable {
        public let deviceId: String
        public let serverTimeMs: Int
        /// Frames the server keeps per device. A client away longer than this
        /// cannot recover the difference from anywhere — the span is a gap.
        public let ringCapacity: Int
    }

    private enum DiscriminatorKey: String, CodingKey {
        case type
    }

    private enum PayloadKey: String, CodingKey {
        case type
        case frame
        case alert
        case decision
    }
}

extension StreamMessage: Decodable {
    public init(from decoder: Decoder) throws {
        let discriminator = try decoder.container(keyedBy: DiscriminatorKey.self)
        let type = try discriminator.decode(String.self, forKey: .type)
        let payload = try decoder.container(keyedBy: PayloadKey.self)

        switch type {
        case "ready":
            self = .ready(try Ready(from: decoder))
        case "frame":
            self = .frame(try payload.decode(StoredVitalsFrame.self, forKey: .frame).validated())
        case "alert":
            self = .alert(try payload.decode(AlertEvent.self, forKey: .alert))
        case "decision":
            self = .decision(try payload.decode(AlertDecisionEvent.self, forKey: .decision))
        default:
            throw ContractError.unknownMessageType(type)
        }
    }
}

/// The one place a socket payload becomes a `StreamMessage`.
public enum StreamDecoder {
    public static func message(from data: Data) throws -> StreamMessage {
        try JSONDecoder().decode(StreamMessage.self, from: data)
    }
}
