// The relay's wire formats and routing, with nothing Apple-only, so they compile and test on Linux.
import Foundation

enum Route: String, CaseIterable {
  case relay, direct
}

/// The route listed for host or its nearest parent domain (on a dot boundary), if any.
func route(for host: String, in routes: [String: Route]) -> Route? {
  var name = Substring(host.lowercased())
  if name.hasSuffix(".") { name = name.dropLast() }
  while true {
    if let route = routes[String(name)] { return route }
    guard let dot = name.firstIndex(of: ".") else { return nil }
    name = name[name.index(after: dot)...]
  }
}

/// Doesn't stop at the first difference, so timing can't tell a caller how much of a guess was right.
func constantTimeEqual(_ a: [UInt8], _ b: [UInt8]) -> Bool {
  guard a.count == b.count else { return false }
  return zip(a, b).reduce(0) { $0 | ($1.0 ^ $1.1) } == 0
}

/// The server side of SOCKS5 (RFC 1928) up to CONNECT, with username/password auth (RFC 1929) only.
/// A class, so NWConnection's @Sendable receive handlers can feed it without mutating a captured var.
final class Socks {
  static let succeeded: UInt8 = 0, generalFailure: UInt8 = 1, networkUnreachable: UInt8 = 3,
    hostUnreachable: UInt8 = 4, refused: UInt8 = 5, ttlExpired: UInt8 = 6,
    commandNotSupported: UInt8 = 7, addressNotSupported: UInt8 = 8

  /// A CONNECT reply; the bound address (0.0.0.0:0) means nothing to WebKit.
  static func reply(_ code: UInt8) -> [UInt8] { [5, code, 0, 1, 0, 0, 0, 0, 0, 0] }

  enum Next: Equatable {
    case more, close
    case connect(host: String, port: UInt16)
  }

  /// The RFC 1929 request we accept, after its version byte: ULEN UNAME PLEN PASSWD.
  private let auth: [UInt8]
  /// Bytes not yet parsed; after .connect, early data to pass on.
  private(set) var rest: [UInt8] = []
  private var stage = 0

  init(username: String, password: String) {
    let u = Array(username.utf8), p = Array(password.utf8)
    auth = [UInt8(u.count)] + u + [UInt8(p.count)] + p
  }

  /// Send back `reply`, then do `next`. After .connect, the caller sends the CONNECT reply.
  func feed(_ bytes: [UInt8]) -> (reply: [UInt8], next: Next) {
    rest += bytes
    var reply: [UInt8] = []
    while true {
      let b = rest
      switch stage {
      case 0: // VER NMETHODS METHODS
        if let v = b.first, v != 5 { return (reply, .close) }
        guard b.count >= 2, b.count >= 2 + Int(b[1]) else { return (reply, .more) }
        guard b[2..<2 + Int(b[1])].contains(2) else { return (reply + [5, 0xFF], .close) }
        reply += [5, 2]
        rest.removeFirst(2 + Int(b[1]))
        stage = 1
      case 1: // VER ULEN UNAME PLEN PASSWD
        if let v = b.first, v != 1 { return (reply, .close) }
        guard b.count >= 2, b.count >= 3 + Int(b[1]) else { return (reply, .more) }
        let end = 3 + Int(b[1]) + Int(b[2 + Int(b[1])])
        guard b.count >= end else { return (reply, .more) }
        guard constantTimeEqual(Array(b[1..<end]), auth) else { return (reply + [1, 1], .close) }
        reply += [1, 0]
        rest.removeFirst(end)
        stage = 2
      default: // VER CMD RSV ATYP DST.ADDR DST.PORT
        if let v = b.first, v != 5 { return (reply, .close) }
        guard b.count >= 5 else { return (reply, .more) }
        guard b[1] == 1 else { return (reply + Socks.reply(Socks.commandNotSupported), .close) }
        let length: Int
        switch b[3] {
        case 1: length = 4
        case 3: length = 1 + Int(b[4])
        case 4: length = 16
        default: return (reply + Socks.reply(Socks.addressNotSupported), .close)
        }
        let end = 4 + length + 2
        guard b.count >= end else { return (reply, .more) }
        let a = Array(b[4..<4 + length])
        let host: String
        switch b[3] {
        case 1: host = a.map(String.init).joined(separator: ".")
        case 3: host = String(decoding: a.dropFirst(), as: UTF8.self)
        default: host = stride(from: 0, to: 16, by: 2).map { String(UInt16(a[$0]) << 8 | UInt16(a[$0 + 1]), radix: 16) }.joined(separator: ":")
        }
        rest.removeFirst(end)
        return (reply, .connect(host: host, port: UInt16(b[end - 2]) << 8 | UInt16(b[end - 1])))
      }
    }
  }
}

/// Wisp packets (github.com/MercuryWorkshop/wisp-protocol) as wisp-js lays them out:
/// type, stream id (u32), payload; every number little-endian.
enum Wisp {
  enum Kind: UInt8 { case connect = 1, data, `continue`, close, info }

  static let voluntary: UInt8 = 2, networkError: UInt8 = 3

  static func packet(_ kind: Kind, _ stream: UInt32, _ payload: [UInt8]) -> [UInt8] {
    [kind.rawValue, UInt8(stream & 0xFF), UInt8(stream >> 8 & 0xFF), UInt8(stream >> 16 & 0xFF), UInt8(stream >> 24)] + payload
  }

  static func connect(_ stream: UInt32, host: String, port: UInt16) -> [UInt8] {
    packet(.connect, stream, [1 /* TCP */, UInt8(port & 0xFF), UInt8(port >> 8)] + Array(host.utf8))
  }

  /// Our answer to a v2 server's INFO: version 2.0, no extensions.
  static let info = packet(.info, 0, [2, 0])

  static func parse(_ bytes: [UInt8]) -> (kind: Kind, stream: UInt32, payload: ArraySlice<UInt8>)? {
    guard bytes.count >= 5, let kind = Kind(rawValue: bytes[0]), let stream = u32(bytes[1..<5]) else { return nil }
    return (kind, stream, bytes[5...])
  }

  static func u32(_ b: ArraySlice<UInt8>) -> UInt32? {
    guard b.count >= 4 else { return nil }
    let i = b.startIndex
    return UInt32(b[i]) | UInt32(b[i + 1]) << 8 | UInt32(b[i + 2]) << 16 | UInt32(b[i + 3]) << 24
  }
}
