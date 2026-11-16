import CryptoKit
import ExpoModulesCore

extension Route: Enumerable {}

struct StartOptions: Record {
  @Field var wispUrl: String = ""
  @Field var defaultRoute: Route = .relay
}

public class BadgerRelayModule: Module {
  // only touched on Relay.queue
  private var relay: Relay?

  public func definition() -> ModuleDefinition {
    Name("BadgerRelay")

    AsyncFunction("start") { (options: StartOptions, promise: Promise) in
      guard let url = URL(string: options.wispUrl), url.scheme == "wss" || url.scheme == "ws" else {
        throw Exception(name: "BadWispUrl", description: "wispUrl must be a ws:// or wss:// URL")
      }
      self.relay?.stop()
      let relay = Relay(wispUrl: url, defaultRoute: options.defaultRoute)
      self.relay = relay
      relay.start { result in
        switch result {
        case .success(let port): promise.resolve(["port": Int(port), "username": relay.username, "password": relay.password])
        case .failure(let error): promise.reject(error)
        }
      }
    }.runOnQueue(Relay.queue)

    AsyncFunction("setRoute") { (site: String, route: Route?) in
      self.relay?.setRoute(site, route)
    }.runOnQueue(Relay.queue)

    AsyncFunction("setDefaultRoute") { (route: Route) in
      self.relay?.setDefaultRoute(route)
    }.runOnQueue(Relay.queue)

    AsyncFunction("stop") {
      self.relay?.stop()
      self.relay = nil
    }.runOnQueue(Relay.queue)

    // The server's sign-in puzzle (app/src/auth.js): the first n whose SHA-256 of
    // "challenge:n" starts with `bits` zero bits. Off the relay's queue.
    AsyncFunction("solveChallenge") { (challenge: String, bits: Int) throws -> Int in
      // a server asking for more would keep the phone busy for hours
      guard (0...24).contains(bits) else {
        throw Exception(name: "BadChallenge", description: "The server asked for \(bits) bits")
      }
      for n in 0... where zeroBits(SHA256.hash(data: Data("\(challenge):\(n)".utf8))) >= bits {
        return n
      }
      return 0
    }

    OnDestroy {
      Relay.queue.async {
        self.relay?.stop()
        self.relay = nil
      }
    }
  }
}

private func zeroBits(_ digest: SHA256.Digest) -> Int {
  var bits = 0
  for byte in digest {
    if byte != 0 {
      return bits + byte.leadingZeroBitCount
    }
    bits += 8
  }
  return bits
}
