// The parts of Apple's Foundation that Linux's Foundation doesn't have. On Linux, URLSession and friends
// live in FoundationNetworking, with weaker (pre-Sendable) signatures, so the checked files don't see that
// module; these declarations stand in, copied from developer.apple.com (one URL per declaration, as markdown:
// append ".md"). check.sh imports this module implicitly into every checked file, as Foundation would on iOS.
// Linux's own Foundation supplies the rest (URL, Data, URLError, POSIXErrorCode, CGRect, NSObject, NSData...).
@_exported import Foundation

// MARK: - KVO

// https://developer.apple.com/documentation/swift/_keyvaluecodingandobserving/observe(_:options:changehandler:)
// (NSObject conforms; the docs list it under NSObject)
public protocol _KeyValueCodingAndObserving {}
extension NSObject: _KeyValueCodingAndObserving {}
extension _KeyValueCodingAndObserving {
  @preconcurrency public func observe<Value>(
    _ keyPath: KeyPath<Self, Value>,
    options: NSKeyValueObservingOptions = [],
    changeHandler: @escaping @Sendable (Self, NSKeyValueObservedChange<Value>) -> Void
  ) -> NSKeyValueObservation { fatalError() }
}

// https://developer.apple.com/documentation/foundation/nskeyvalueobservation
public class NSKeyValueObservation: NSObject, @unchecked Sendable {
  public func invalidate() { fatalError() }
}

// https://developer.apple.com/documentation/foundation/nskeyvalueobservedchange
public struct NSKeyValueObservedChange<Value>: @unchecked Sendable {
  public typealias Kind = NSKeyValueChange
  public let kind: NSKeyValueObservedChange<Value>.Kind
  public let newValue: Value?
  public let oldValue: Value?
  public let indexes: IndexSet?
  public let isPrior: Bool
}

// https://developer.apple.com/documentation/foundation/nskeyvaluechange
public enum NSKeyValueChange: UInt, Sendable {
  case setting = 1, insertion, removal, replacement
}

// https://developer.apple.com/documentation/foundation/nskeyvalueobservingoptions
public struct NSKeyValueObservingOptions: OptionSet, Sendable {
  public let rawValue: UInt
  public init(rawValue: UInt) { self.rawValue = rawValue }
  public static let new = NSKeyValueObservingOptions(rawValue: 1)
  public static let old = NSKeyValueObservingOptions(rawValue: 2)
  public static let initial = NSKeyValueObservingOptions(rawValue: 4)
  public static let prior = NSKeyValueObservingOptions(rawValue: 8)
}

// MARK: - URL

extension URL {
  // https://developer.apple.com/documentation/foundation/url/documentsdirectory (iOS 16)
  public static var documentsDirectory: URL { fatalError() }
}

// MARK: - Loading (FoundationNetworking on Linux)

// https://developer.apple.com/documentation/foundation/urlrequest
public struct URLRequest: Hashable, Sendable {
  // https://developer.apple.com/documentation/foundation/urlrequest/cachepolicy-swift.typealias (NSURLRequest.CachePolicy)
  public enum CachePolicy: UInt, Sendable {
    case useProtocolCachePolicy = 0, reloadIgnoringLocalCacheData = 1, returnCacheDataElseLoad = 2, returnCacheDataDontLoad = 3
  }
  // https://developer.apple.com/documentation/foundation/urlrequest/init(url:cachepolicy:timeoutinterval:)
  public init(url: URL, cachePolicy: URLRequest.CachePolicy = .useProtocolCachePolicy, timeoutInterval: TimeInterval = 60.0) { fatalError() }
  // https://developer.apple.com/documentation/foundation/urlrequest/url
  public var url: URL? { get { fatalError() } set { fatalError() } }
}

// https://developer.apple.com/documentation/foundation/urlresponse
open class URLResponse: NSObject, @unchecked Sendable {}

// https://developer.apple.com/documentation/foundation/httpcookie
open class HTTPCookie: NSObject, @unchecked Sendable {
  // https://developer.apple.com/documentation/foundation/httpcookie/name (and value, domain, path, isSecure, isHTTPOnly, expiresDate)
  open var name: String { fatalError() }
  open var value: String { fatalError() }
  open var domain: String { fatalError() }
  open var path: String { fatalError() }
  open var isSecure: Bool { fatalError() }
  open var isHTTPOnly: Bool { fatalError() }
  open var expiresDate: Date? { fatalError() }
}

// https://developer.apple.com/documentation/foundation/urlsessiondelegate
public protocol URLSessionDelegate: NSObjectProtocol, Sendable {}

// https://developer.apple.com/documentation/foundation/urlsessionconfiguration
open class URLSessionConfiguration: NSObject, @unchecked Sendable {
  // https://developer.apple.com/documentation/foundation/urlsessionconfiguration/default
  open class var `default`: URLSessionConfiguration { fatalError() }
}

// https://developer.apple.com/documentation/foundation/urlsession
open class URLSession: NSObject, @unchecked Sendable {
  // https://developer.apple.com/documentation/foundation/urlsession/init(configuration:delegate:delegatequeue:)
  public init(configuration: URLSessionConfiguration, delegate: (any URLSessionDelegate)?, delegateQueue queue: OperationQueue?) { fatalError() }
  // https://developer.apple.com/documentation/foundation/urlsession/websockettask(with:protocols:)
  open func webSocketTask(with url: URL, protocols: [String]) -> URLSessionWebSocketTask { fatalError() }
  // https://developer.apple.com/documentation/foundation/urlsession/invalidateandcancel()
  open func invalidateAndCancel() { fatalError() }
}

// https://developer.apple.com/documentation/foundation/urlsessiontask
open class URLSessionTask: NSObject, @unchecked Sendable {
  // https://developer.apple.com/documentation/foundation/urlsessiontask/resume()
  open func resume() { fatalError() }
  // https://developer.apple.com/documentation/foundation/urlsessiontask/cancel()
  open func cancel() { fatalError() }
}

// https://developer.apple.com/documentation/foundation/urlsessionwebsockettask
open class URLSessionWebSocketTask: URLSessionTask, @unchecked Sendable {
  // https://developer.apple.com/documentation/foundation/urlsessionwebsockettask/message
  public enum Message: Sendable {
    case data(Data)
    case string(String)
  }

  // https://developer.apple.com/documentation/foundation/urlsessionwebsockettask/closecode-swift.enum
  public enum CloseCode: Int, Sendable {
    case invalid = 0, normalClosure = 1000, goingAway = 1001, protocolError = 1002, unsupportedData = 1003,
      noStatusReceived = 1005, abnormalClosure = 1006, invalidFramePayloadData = 1007, policyViolation = 1008,
      messageTooBig = 1009, mandatoryExtensionMissing = 1010, internalServerError = 1011, tlsHandshakeFailure = 1015
  }

  // https://developer.apple.com/documentation/foundation/urlsessionwebsockettask/send(_:completionhandler:)
  @preconcurrency public func send(_ message: URLSessionWebSocketTask.Message, completionHandler: @escaping @Sendable ((any Error)?) -> Void) { fatalError() }
  // https://developer.apple.com/documentation/foundation/urlsessionwebsockettask/receive(completionhandler:)
  @preconcurrency public func receive(completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, any Error>) -> Void) { fatalError() }
  // https://developer.apple.com/documentation/foundation/urlsessionwebsockettask/cancel(with:reason:)
  open func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) { fatalError() }
}
