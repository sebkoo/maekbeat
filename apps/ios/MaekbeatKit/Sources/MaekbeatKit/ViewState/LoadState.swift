import Foundation

/*
 * States are designed, not fallbacks.
 *
 * apps/web routes every read through one union so no screen can render nothing
 * and call it a view. This is the same union in Swift, and the same four
 * panels come out of it: loading, empty, error, disconnected. A monitoring
 * surface that cannot say "no data yet" or "connection lost" will eventually
 * say them by drawing a blank, and a blank reads as calm.
 */

/// Which designed state a screen is showing. `nil` means it is showing data.
public enum StatusVariant: String, Sendable, CaseIterable {
    case loading
    case empty
    case error
    case disconnected
}

/// Every read in the app lands in one of these. `empty` is a state a model
/// chooses, not an accident of an array being short: a reachable server holding
/// no frames is a different thing from a server that did not answer.
public enum LoadState<Value: Equatable & Sendable>: Equatable, Sendable {
    case loading
    case empty
    case ready(Value)
    case failed(APIFailure)

    public var variant: StatusVariant? {
        switch self {
        case .loading: return .loading
        case .empty: return .empty
        case .ready: return nil
        case let .failed(failure): return failure.isDisconnected ? .disconnected : .error
        }
    }

    public var value: Value? {
        if case let .ready(value) = self { return value }
        return nil
    }

    public var failure: APIFailure? {
        if case let .failed(failure) = self { return failure }
        return nil
    }
}

/// The words a `StatusVariant` puts on screen, resolved in one place so a view
/// cannot invent its own and a test can assert every variant has copy.
public struct StatusCopy: Equatable, Sendable {
    public let title: String
    public let detail: String

    public static func forDevices(
        _ variant: StatusVariant,
        failure: APIFailure? = nil
    ) -> Self {
        switch variant {
        case .loading:
            return Self(title: Copy.loadingDevicesTitle, detail: Copy.loadingDevicesDetail)
        case .empty:
            return Self(title: Copy.emptyDevicesTitle, detail: Copy.emptyDevicesDetail)
        case .error:
            return Self(
                title: Copy.readFailedTitle,
                detail: failure?.localizedDescription ?? Copy.readFailedTitle
            )
        case .disconnected:
            return Self(title: Copy.disconnectedTitle, detail: Copy.disconnectedDetail)
        }
    }

    public static func forFrames(
        _ variant: StatusVariant,
        failure: APIFailure? = nil
    ) -> Self {
        switch variant {
        case .loading:
            return Self(title: Copy.loadingFramesTitle, detail: Copy.loadingFramesDetail)
        case .empty:
            return Self(title: Copy.emptyFramesTitle, detail: Copy.emptyFramesDetail)
        case .error:
            return Self(
                title: Copy.readFailedTitle,
                detail: failure?.localizedDescription ?? Copy.readFailedTitle
            )
        case .disconnected:
            return Self(title: Copy.disconnectedTitle, detail: Copy.disconnectedDetail)
        }
    }
}
