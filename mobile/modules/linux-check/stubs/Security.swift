// Security, only what BadgerWebView.certificate() uses. Signatures from developer.apple.com (append ".md").
// CFArray and CFData are toll-free bridged on Apple platforms; NSArray and NSData give the same `as?
// [SecCertificate]` and `as Data` bridging on Linux, so they stand in for the CoreFoundation types.
@_exported import Foundation

public typealias CFArray = NSArray
public typealias CFData = NSData

// https://developer.apple.com/documentation/security/sectrust
public final class SecTrust {}

// https://developer.apple.com/documentation/security/seccertificate
public final class SecCertificate {}

// https://developer.apple.com/documentation/security/sectrustcopycertificatechain(_:) (iOS 15)
public func SecTrustCopyCertificateChain(_ trust: SecTrust) -> CFArray? { fatalError() }

// https://developer.apple.com/documentation/security/seccertificatecopydata(_:)
public func SecCertificateCopyData(_ certificate: SecCertificate) -> CFData { fatalError() }
