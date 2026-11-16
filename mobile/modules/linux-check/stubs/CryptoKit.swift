// CryptoKit, only SHA256. Signatures from developer.apple.com (append ".md"). DataProtocol and
// ContiguousBytes come from Linux's Foundation.
@_exported import Foundation

// https://developer.apple.com/documentation/cryptokit/digest
@preconcurrency public protocol Digest: ContiguousBytes, CustomStringConvertible, Hashable, Sendable, Sequence where Self.Element == UInt8 {}

// https://developer.apple.com/documentation/cryptokit/hashfunction
@preconcurrency public protocol HashFunction: Sendable {
  associatedtype Digest: CryptoKit.Digest
}

extension HashFunction {
  // https://developer.apple.com/documentation/cryptokit/hashfunction/hash(data:)
  public static func hash<D>(data: D) -> Self.Digest where D: DataProtocol { fatalError() }
}

// https://developer.apple.com/documentation/cryptokit/sha256
public struct SHA256: HashFunction {
  // https://developer.apple.com/documentation/cryptokit/sha256/digest
  public typealias Digest = SHA256Digest
}

// https://developer.apple.com/documentation/cryptokit/sha256digest
public struct SHA256Digest: CryptoKit.Digest {
  public func withUnsafeBytes<R>(_ body: (UnsafeRawBufferPointer) throws -> R) rethrows -> R { fatalError() }
  public var description: String { fatalError() }
  public func makeIterator() -> Array<UInt8>.Iterator { fatalError() }
}
