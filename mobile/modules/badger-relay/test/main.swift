// Self-check for ios/RelayProtocol.swift; runs on Linux too. From mobile/modules/badger-relay:
// swiftc ios/RelayProtocol.swift test/main.swift -o /tmp/relay-test && /tmp/relay-test
import Foundation

func hex(_ b: [UInt8]) -> String { b.map { String(format: "%02x", $0) }.joined() }
func check(_ ok: Bool, _ what: String, line: Int = #line) {
  if !ok { print("FAIL line \(line): \(what)"); exit(1) }
}

// routes
let routes: [String: Route] = ["example.co.uk": .direct, "a.example.co.uk": .relay, "1.2.3.4": .direct]
check(route(for: "example.co.uk", in: routes) == .direct, "exact")
check(route(for: "WWW.Example.co.uk.", in: routes) == .direct, "subdomain, case, trailing dot")
check(route(for: "x.a.example.co.uk", in: routes) == .relay, "nearest parent wins")
check(route(for: "badexample.co.uk", in: routes) == nil, "dot boundary")
check(route(for: "co.uk", in: routes) == nil, "parent of a site isn't the site")
check(route(for: "1.2.3.4", in: routes) == .direct, "ip exact")
check(route(for: "::1", in: routes) == nil, "ipv6, no dots")

// constant-time compare
check(constantTimeEqual([1, 2, 3], [1, 2, 3]), "equal")
check(!constantTimeEqual([1, 2, 3], [1, 2, 4]), "differs")
check(!constantTimeEqual([1, 2], [1, 2, 3]), "length")

// SOCKS: the whole handshake, fed one byte at a time
let user = "u", pass = "secret"
var s = Socks(username: user, password: pass)
let greeting: [UInt8] = [5, 2, 0, 2]
let auth: [UInt8] = [1, 1] + Array(user.utf8) + [6] + Array(pass.utf8)
let connect: [UInt8] = [5, 1, 0, 3, 11] + Array("example.com".utf8) + [0x01, 0xbb]
var replies: [UInt8] = []
var last: Socks.Next = .more
for byte in greeting + auth + connect {
  check(last == .more, "no early end")
  let (reply, next) = s.feed([byte])
  replies += reply
  last = next
}
check(replies == [5, 2, 1, 0], "method and auth replies: \(replies)")
check(last == .connect(host: "example.com", port: 443), "connect \(last)")
check(s.rest.isEmpty, "nothing left over")

// all at once, with early data after the request
s = Socks(username: user, password: pass)
var r = s.feed(greeting + auth + [5, 1, 0, 1, 93, 184, 216, 34, 0, 80] + [0x16, 0x03])
check(r.reply == [5, 2, 1, 0] && r.next == .connect(host: "93.184.216.34", port: 80), "ipv4 \(r)")
check(s.rest == [0x16, 0x03], "early data kept")

s = Socks(username: user, password: pass)
r = s.feed(greeting + auth + [5, 1, 0, 4, 0x20, 0x01, 0x0d, 0xb8] + [UInt8](repeating: 0, count: 11) + [1, 0x1f, 0x90])
check(r.next == .connect(host: "2001:db8:0:0:0:0:0:1", port: 8080), "ipv6 \(r)")

// refusals
s = Socks(username: user, password: pass)
r = s.feed([5, 1, 0])
check(r.reply == [5, 0xFF] && r.next == .close, "no auth offered")
s = Socks(username: user, password: pass)
r = s.feed(greeting + [1, 1] + Array(user.utf8) + [6] + Array("secreT".utf8))
check(r.reply == [5, 2, 1, 1] && r.next == .close, "wrong password")
s = Socks(username: user, password: pass)
r = s.feed(greeting + [1, 1] + Array(user.utf8) + [5] + Array("secre".utf8))
check(r.reply == [5, 2, 1, 1] && r.next == .close, "prefix of the password")
s = Socks(username: user, password: pass)
r = s.feed(greeting + auth + [5, 2, 0, 1, 1, 2, 3, 4, 0, 80])
check(r.reply == [5, 2, 1, 0] + Socks.reply(Socks.commandNotSupported) && r.next == .close, "bind")
s = Socks(username: user, password: pass)
r = s.feed(greeting + auth + [5, 3, 0, 1, 1, 2, 3, 4, 0, 80])
check(Array(r.reply.suffix(10)) == Socks.reply(7) && r.next == .close, "udp associate")
s = Socks(username: user, password: pass)
r = s.feed(greeting + auth + [5, 1, 0, 9, 1, 2, 3, 4, 0, 80])
check(Array(r.reply.suffix(10)) == Socks.reply(8) && r.next == .close, "bad address type")
s = Socks(username: user, password: pass)
check(s.feed([4, 1, 0, 80]).next == .close, "socks4")
s = Socks(username: user, password: pass)
check(s.feed([5]).next == .more, "partial greeting")
s = Socks(username: user, password: pass)
_ = s.feed(greeting)
check(s.feed([1]).next == .more, "partial auth, one byte")

// wisp: the hex is what the server's wisp-js (app/node_modules, packet.mjs) encodes for the same packets
check(hex(Wisp.connect(0x01020304, host: "example.com", port: 443)) == "010403020101bb016578616d706c652e636f6d", "connect")
check(hex(Wisp.info) == "05000000000200", "info")
check(hex(Wisp.packet(.data, 0xdeadbeef, [1, 2, 3])) == "02efbeadde010203", "data")
check(hex(Wisp.packet(.close, 9, [0x48])) == "040900000048", "close")
let cont = Wisp.parse([0x03, 0, 0, 0, 0, 0x80, 0, 0, 0])!
check(cont.kind == .continue && cont.stream == 0 && Wisp.u32(cont.payload) == 128, "continue")
let data = Wisp.parse([0x02, 0xef, 0xbe, 0xad, 0xde, 1, 2, 3])!
check(data.kind == .data && data.stream == 0xdeadbeef && Array(data.payload) == [1, 2, 3], "data parse")
check(Wisp.parse([0x03, 0, 0, 0]) == nil, "short")
check(Wisp.parse([0x09, 0, 0, 0, 0]) == nil, "unknown type")
check(Wisp.u32([0x80, 0, 0][...]) == nil, "short continue")
print("ok")
