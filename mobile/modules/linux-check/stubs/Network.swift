// Network.framework, only what the relay and the web view's proxy use. Network's API is Swift, so
// its @preconcurrency and @Sendable marks are copied as the docs show them. Signatures from
// developer.apple.com (append ".md" to fetch); Network.framework is iOS 12 unless noted.
@_exported import Foundation
import Dispatch

// https://developer.apple.com/documentation/network/nwendpoint
public enum NWEndpoint: Hashable, Sendable, CustomDebugStringConvertible {
  // https://developer.apple.com/documentation/network/nwendpoint/hostport(host:port:)
  case hostPort(host: NWEndpoint.Host, port: NWEndpoint.Port)
  case service(name: String, type: String, domain: String, interface: NWInterface?)
  case unix(path: String)
  case url(URL)
  // case opaque(nw_endpoint_t) omitted: a C type

  public var debugDescription: String { fatalError() }

  // https://developer.apple.com/documentation/network/nwendpoint/host
  public enum Host: Hashable, Sendable, CustomDebugStringConvertible, ExpressibleByStringLiteral {
    case name(String, NWInterface?)
    // https://developer.apple.com/documentation/network/nwendpoint/host/ipv4(_:)
    case ipv4(IPv4Address)
    case ipv6(IPv6Address)
    // https://developer.apple.com/documentation/network/nwendpoint/host/init(_:)
    public init(_ string: String) { fatalError() }
    public init(stringLiteral value: String) { fatalError() }
    public var debugDescription: String { fatalError() }
  }

  // https://developer.apple.com/documentation/network/nwendpoint/port
  // (conforms to RawRepresentable with RawValue UInt16, and ExpressibleByIntegerLiteral)
  public struct Port: Hashable, Sendable, CustomDebugStringConvertible, ExpressibleByIntegerLiteral, RawRepresentable {
    // https://developer.apple.com/documentation/network/nwendpoint/port/any
    public static let any: NWEndpoint.Port = 0
    // https://developer.apple.com/documentation/network/nwendpoint/port/init(_:)
    public init?(_ service: String) { fatalError() }
    public init(integerLiteral value: UInt16) { fatalError() }
    public init?(rawValue: UInt16) { fatalError() }
    public var rawValue: UInt16 { fatalError() }
    public var debugDescription: String { fatalError() }
  }
}

// https://developer.apple.com/documentation/network/nwinterface
public struct NWInterface: Hashable, Sendable {}

// https://developer.apple.com/documentation/network/ipv4address
public struct IPv4Address: Hashable, Sendable, CustomDebugStringConvertible {
  // https://developer.apple.com/documentation/network/ipv4address/loopback
  public static let loopback: IPv4Address = { fatalError() }()
  public var debugDescription: String { fatalError() }
}

// https://developer.apple.com/documentation/network/ipv6address
public struct IPv6Address: Hashable, Sendable {}

// https://developer.apple.com/documentation/network/proxyconfiguration (iOS 17)
public struct ProxyConfiguration: Sendable, CustomDebugStringConvertible {
  // https://developer.apple.com/documentation/network/proxyconfiguration/init(socksv5proxy:)
  public init(socksv5Proxy: NWEndpoint) { fatalError() }
  // https://developer.apple.com/documentation/network/proxyconfiguration/applycredential(username:password:)
  public func applyCredential(username: String, password: String) { fatalError() }
  public var debugDescription: String { fatalError() }
}

// https://developer.apple.com/documentation/network/nwerror
public enum NWError: Error, Equatable, Sendable, CustomDebugStringConvertible {
  // https://developer.apple.com/documentation/network/nwerror/posix(_:)
  case posix(POSIXErrorCode)
  // https://developer.apple.com/documentation/network/nwerror/dns(_:) (DNSServiceErrorType is Int32)
  case dns(Int32)
  // https://developer.apple.com/documentation/network/nwerror/tls(_:) (OSStatus is Int32)
  case tls(Int32)
  case wifiAware(Int32)
  public var debugDescription: String { fatalError() }
}

// https://developer.apple.com/documentation/network/nwparameters
public final class NWParameters: Sendable, CustomDebugStringConvertible {
  // https://developer.apple.com/documentation/network/nwparameters/tcp
  public final class var tcp: NWParameters { fatalError() }
  // https://developer.apple.com/documentation/network/nwparameters/requiredlocalendpoint
  public final var requiredLocalEndpoint: NWEndpoint? { get { fatalError() } set { fatalError() } }
  // https://developer.apple.com/documentation/network/nwparameters/allowlocalendpointreuse
  public final var allowLocalEndpointReuse: Bool { get { fatalError() } set { fatalError() } }
  public var debugDescription: String { fatalError() }
}

// https://developer.apple.com/documentation/network/nwlistener
public final class NWListener: Sendable, CustomDebugStringConvertible {
  // https://developer.apple.com/documentation/network/nwlistener/state-swift.enum
  public enum State: Equatable, Sendable {
    case setup
    case waiting(NWError)
    case ready
    case failed(NWError)
    case cancelled
  }

  // https://developer.apple.com/documentation/network/nwlistener/init(using:on:)
  public init(using: NWParameters, on: NWEndpoint.Port = .any) throws { fatalError() }
  // https://developer.apple.com/documentation/network/nwlistener/newconnectionhandler
  @preconcurrency public final var newConnectionHandler: (@Sendable (NWConnection) -> Void)? { get { fatalError() } set { fatalError() } }
  // https://developer.apple.com/documentation/network/nwlistener/stateupdatehandler
  @preconcurrency public final var stateUpdateHandler: (@Sendable (NWListener.State) -> Void)? { get { fatalError() } set { fatalError() } }
  // https://developer.apple.com/documentation/network/nwlistener/port
  public final var port: NWEndpoint.Port? { fatalError() }
  // https://developer.apple.com/documentation/network/nwlistener/start(queue:)
  public final func start(queue: DispatchQueue) { fatalError() }
  // https://developer.apple.com/documentation/network/nwlistener/cancel()
  public final func cancel() { fatalError() }
  public var debugDescription: String { fatalError() }
}

// https://developer.apple.com/documentation/network/nwconnection
public final class NWConnection: Sendable, CustomDebugStringConvertible {
  // https://developer.apple.com/documentation/network/nwconnection/state-swift.enum
  public enum State: Equatable, Sendable {
    case setup
    case waiting(NWError)
    case preparing
    case ready
    case failed(NWError)
    case cancelled
  }

  // https://developer.apple.com/documentation/network/nwconnection/sendcompletion
  public enum SendCompletion {
    // https://developer.apple.com/documentation/network/nwconnection/sendcompletion/contentprocessed(_:)
    @preconcurrency case contentProcessed(@Sendable (NWError?) -> Void)
    case idempotent
  }

  // https://developer.apple.com/documentation/network/nwconnection/contentcontext
  public final class ContentContext: Sendable {
    // https://developer.apple.com/documentation/network/nwconnection/contentcontext/defaultmessage
    public static let defaultMessage: NWConnection.ContentContext = { fatalError() }()
    // https://developer.apple.com/documentation/network/nwconnection/contentcontext/finalmessage
    public static let finalMessage: NWConnection.ContentContext = { fatalError() }()
  }

  // https://developer.apple.com/documentation/network/nwconnection/init(host:port:using:)
  public convenience init(host: NWEndpoint.Host, port: NWEndpoint.Port, using: NWParameters) { fatalError() }
  // https://developer.apple.com/documentation/network/nwconnection/stateupdatehandler
  // https://developer.apple.com/documentation/network/nwconnection/state-swift.property
  public final var state: NWConnection.State { fatalError() }
  @preconcurrency public final var stateUpdateHandler: (@Sendable (NWConnection.State) -> Void)? { get { fatalError() } set { fatalError() } }
  // https://developer.apple.com/documentation/network/nwconnection/start(queue:)
  public final func start(queue: DispatchQueue) { fatalError() }
  // https://developer.apple.com/documentation/network/nwconnection/cancel()
  public final func cancel() { fatalError() }
  // https://developer.apple.com/documentation/network/nwconnection/forcecancel()
  public final func forceCancel() { fatalError() }
  // https://developer.apple.com/documentation/network/nwconnection/send(content:contentcontext:iscomplete:completion:)-5ecuz
  @preconcurrency public final func send(content: Data?, contentContext: NWConnection.ContentContext = .defaultMessage, isComplete: Bool = true, completion: NWConnection.SendCompletion) { fatalError() }
  // https://developer.apple.com/documentation/network/nwconnection/send(content:contentcontext:iscomplete:completion:)-3mfmt (iOS 13)
  @preconcurrency public final func send<Content>(content: Content?, contentContext: NWConnection.ContentContext = .defaultMessage, isComplete: Bool = true, completion: NWConnection.SendCompletion) where Content: DataProtocol { fatalError() }
  // https://developer.apple.com/documentation/network/nwconnection/receive(minimumincompletelength:maximumlength:completion:)
  @preconcurrency public final func receive(minimumIncompleteLength: Int, maximumLength: Int, completion: @escaping @Sendable (Data?, NWConnection.ContentContext?, Bool, NWError?) -> Void) { fatalError() }
  public var debugDescription: String { fatalError() }

  private init() {}
}
