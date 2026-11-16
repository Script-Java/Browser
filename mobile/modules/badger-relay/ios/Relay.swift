// The relay: a SOCKS5 server on 127.0.0.1 that the tabs' data stores use as their proxy. Each
// connection goes over the server's wisp WebSocket (relay) or straight from the phone (direct).
import Foundation
import Network

private let chunk = 64 * 1024
private let ignore = NWConnection.SendCompletion.contentProcessed { _ in }

final class Relay {
  /// Everything (module calls, sockets, the WebSocket) runs here, one thing at a time.
  static let queue = DispatchQueue(label: "badger.relay")
  /// Picked at the first start and kept for the launch: tabs' proxies were fixed with it.
  private static var port = NWEndpoint.Port.any

  /// Per launch too, for the same reason: a second start (another server) mustn't strand open tabs.
  private static let credentials = (username: secret(), password: secret())
  let username = Relay.credentials.username, password = Relay.credentials.password
  /// Change these through setRoute and setDefaultRoute, which close what's open on the old route.
  private(set) var defaultRoute: Route
  private(set) var routes: [String: Route] = [:]
  /// Open connections and the route each took. WebKit keeps connections for minutes, so a
  /// site moved from Direct to Relay would go on seeing the phone's address through them.
  private var open: [(local: NWConnection, host: String, route: Route)] = []
  private let wisp: WispConnection
  private var listener: NWListener?
  private var ready: ((Result<UInt16, Error>) -> Void)?
  private var stopped = false

  init(wispUrl: URL, defaultRoute: Route) {
    wisp = WispConnection(url: wispUrl)
    self.defaultRoute = defaultRoute
  }

  func start(_ ready: @escaping (Result<UInt16, Error>) -> Void) {
    self.ready = ready
    listen()
  }

  func stop() {
    stopped = true
    listener?.cancel()
    listener = nil
    wisp.stop()
  }

  private func listen() {
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: Relay.port)
    params.allowLocalEndpointReuse = true
    let listener: NWListener
    do { listener = try NWListener(using: params) } catch { return failed(error) }
    self.listener = listener
    listener.newConnectionHandler = { [weak self] in self?.accept($0) }
    listener.stateUpdateHandler = { [weak self, weak listener] state in
      guard let self, let listener, self.listener === listener else { return }
      switch state {
      case .ready:
        Relay.port = listener.port ?? Relay.port
        self.ready?(.success(Relay.port.rawValue))
        self.ready = nil
      case .failed(let error):
        listener.cancel()
        self.listener = nil
        self.failed(error)
      default: break
      }
    }
    listener.start(queue: Relay.queue)
  }

  // Before the first ready, start fails. After it, iOS invalidated a suspended app's listener:
  // come back on the same port.
  private func failed(_ error: Error) {
    if let ready {
      self.ready = nil
      return ready(.failure(error))
    }
    Relay.queue.asyncAfter(deadline: .now() + 1) { [weak self] in
      guard let self, !self.stopped, self.listener == nil else { return }
      self.listen()
    }
  }

  private func accept(_ local: NWConnection) {
    let socks = Socks(username: username, password: password)
    func read() {
      local.receive(minimumIncompleteLength: 1, maximumLength: 1024) { [weak self] data, _, _, error in
        guard let self, !self.stopped, let data, error == nil else { return local.cancel() }
        let (reply, next) = socks.feed([UInt8](data))
        if !reply.isEmpty { local.send(content: Data(reply), completion: ignore) }
        switch next {
        case .more: read()
        case .close: Relay.finish(local)
        case .connect(let host, let port):
          let chosen = self.routeNow(host)
          self.open.removeAll { Relay.ended($0.local) }
          self.open.append((local, host, chosen))
          if chosen == .direct {
            Relay.direct(local, host, port, early: socks.rest)
          } else {
            self.wisp.open(local, host, port, early: socks.rest)
          }
        }
      }
    }
    local.start(queue: Relay.queue)
    read()
  }

  func setRoute(_ site: String, _ route: Route?) {
    routes[site.lowercased()] = route
    closeRerouted()
  }

  func setDefaultRoute(_ route: Route) {
    defaultRoute = route
    closeRerouted()
  }

  private func routeNow(_ host: String) -> Route {
    route(for: host, in: routes) ?? defaultRoute
  }

  /// Closes the connections whose site now takes the other route; WebKit opens new ones, on it.
  private func closeRerouted() {
    open.removeAll { entry in
      if Relay.ended(entry.local) { return true }
      if routeNow(entry.host) == entry.route { return false }
      entry.local.cancel()
      return true
    }
  }

  private static func ended(_ connection: NWConnection) -> Bool {
    switch connection.state {
    case .cancelled, .failed: return true
    default: return false
    }
  }

  private static func direct(_ local: NWConnection, _ host: String, _ port: UInt16, early: [UInt8]) {
    let remote = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port) ?? .any, using: .tcp)
    remote.stateUpdateHandler = { state in
      switch state {
      case .ready:
        remote.stateUpdateHandler = nil
        local.send(content: Data(Socks.reply(Socks.succeeded)), completion: ignore)
        if !early.isEmpty { remote.send(content: Data(early), completion: ignore) }
        Relay.pipe(local, remote)
        Relay.pipe(remote, local)
      // .waiting too: NWConnection waits out a refused connection, but WebKit should hear now
      case .waiting(let error), .failed(let error):
        remote.stateUpdateHandler = nil
        remote.cancel()
        Relay.fail(local, Relay.code(error))
      default: break
      }
    }
    remote.start(queue: Relay.queue)
  }

  // One chunk in flight each way, so the slow side holds back the fast one.
  // shortcut: no half-close, either side's end closes both once flushed; fine for HTTP and TLS, upgrade if something needs a TCP half-close
  private static func pipe(_ from: NWConnection, _ to: NWConnection) {
    from.receive(minimumIncompleteLength: 1, maximumLength: chunk) { data, _, isComplete, error in
      let end = isComplete || error != nil
      to.send(content: data, contentContext: end ? .finalMessage : .defaultMessage, completion: .contentProcessed { sendError in
        if end || sendError != nil {
          from.cancel()
          to.cancel()
        } else {
          Relay.pipe(from, to)
        }
      })
    }
  }

  static func fail(_ local: NWConnection, _ code: UInt8) {
    local.send(content: Data(Socks.reply(code)), completion: ignore)
    finish(local)
  }

  /// FIN after whatever's queued, then let go.
  static func finish(_ local: NWConnection) {
    local.send(content: nil, contentContext: .finalMessage, completion: .contentProcessed { _ in local.cancel() })
  }

  private static func code(_ error: NWError) -> UInt8 {
    switch error {
    case .posix(.ECONNREFUSED): return Socks.refused
    case .posix(.ENETUNREACH), .posix(.ENETDOWN): return Socks.networkUnreachable
    case .posix(.EHOSTUNREACH), .posix(.EHOSTDOWN), .dns: return Socks.hostUnreachable
    case .posix(.ETIMEDOUT): return Socks.ttlExpired
    default: return Socks.generalFailure
    }
  }

  // SystemRandomNumberGenerator is cryptographically secure on Apple platforms.
  private static func secret() -> String {
    let alphabet = Array("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
    return String((0..<32).map { _ in alphabet.randomElement()! })
  }
}

/// The relay route: one WebSocket to the server, each relayed connection a wisp stream on it.
final class WispConnection {
  private final class WispStream {
    let local: NWConnection
    /// DATA packets the server will still take (its CONTINUE count)
    var credit: UInt32
    /// out of credit, waiting on a CONTINUE before reading more from WebKit
    var stalled = false
    /// bytes handed to WebKit that it hasn't taken yet
    var pending = 0
    init(_ local: NWConnection, credit: UInt32) {
      self.local = local
      self.credit = credit
    }
  }

  /// Past this much unread by WebKit, stop reading the WebSocket. Wisp has no flow control
  /// toward the client, so this holds back every stream, not just the slow one.
  private static let maxBacklog = 8 << 20

  private let url: URL
  private let session: URLSession
  private var task: URLSessionWebSocketTask?
  /// The server's per-stream buffer, known once the handshake's done.
  private var credit: UInt32?
  private var waiting: [(Bool) -> Void] = []
  private var streams: [UInt32: WispStream] = [:]
  private var nextId: UInt32 = 1
  private var paused = false

  init(url: URL) {
    self.url = url
    let callbacks = OperationQueue()
    callbacks.underlyingQueue = Relay.queue
    callbacks.maxConcurrentOperationCount = 1
    // A default configuration uses HTTPCookieStorage.shared, where the sign-in's session cookie is.
    session = URLSession(configuration: .default, delegate: nil, delegateQueue: callbacks)
  }

  func stop() {
    drop()
    session.invalidateAndCancel()
  }

  func open(_ local: NWConnection, _ host: String, _ port: UInt16, early: [UInt8]) {
    guard let credit else {
      waiting.append { [weak self] ok in
        if ok, let self { self.open(local, host, port, early: early) } else { Relay.fail(local, Socks.generalFailure) }
      }
      if task == nil { connect() }
      return
    }
    let id = nextId
    nextId = nextId == .max ? 1 : nextId + 1
    let stream = WispStream(local, credit: credit)
    streams[id] = stream
    send(Wisp.connect(id, host: host, port: port))
    // Wisp never says a stream connected, so WebKit hears of a failure as the connection closing.
    local.send(content: Data(Socks.reply(Socks.succeeded)), completion: ignore)
    if !early.isEmpty {
      stream.credit -= 1
      send(Wisp.packet(.data, id, early))
    }
    up(id, stream)
  }

  private func connect() {
    // Offering wisp-v2 gets a v2 server's INFO first; a v1 server sends its CONTINUE straight away.
    let task = session.webSocketTask(with: url, protocols: ["wisp-v2"])
    self.task = task
    task.resume()
    receive()
  }

  /// The socket's gone: its streams fail, and the next new one reconnects.
  private func drop() {
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    credit = nil
    paused = false
    for stream in streams.values { stream.local.forceCancel() }
    streams = [:]
    let waiting = self.waiting
    self.waiting = []
    for open in waiting { open(false) }
  }

  private func send(_ packet: [UInt8], then: (() -> Void)? = nil) {
    // a failed send fails the receive too, and drop() handles it there
    task?.send(.data(Data(packet))) { error in if error == nil { then?() } }
  }

  private func receive() {
    guard let task else { return }
    task.receive { [weak self] result in
      guard let self, self.task === task else { return }
      switch result {
      case .success(.data(let data)): self.handle([UInt8](data))
      case .success: break
      case .failure: return self.drop()
      }
      guard self.task === task else { return }
      if self.backlog < WispConnection.maxBacklog { self.receive() } else { self.paused = true }
    }
  }

  private var backlog: Int { streams.values.reduce(0) { $0 + $1.pending } }

  private func resume() {
    guard paused, backlog < WispConnection.maxBacklog else { return }
    paused = false
    receive()
  }

  private func handle(_ bytes: [UInt8]) {
    guard let packet = Wisp.parse(bytes) else { return }
    let (kind, id, payload) = packet
    guard credit != nil else {
      if kind == .info {
        send(Wisp.info)
      } else if kind == .continue, id == 0, let initial = Wisp.u32(payload) {
        self.credit = initial
        let waiting = self.waiting
        self.waiting = []
        for open in waiting { open(true) }
      }
      return
    }
    guard let stream = streams[id] else { return }
    switch kind {
    case .data:
      let n = payload.count
      stream.pending += n
      stream.local.send(content: Data(payload), completion: .contentProcessed { [weak self] error in
        stream.pending -= n
        if error != nil { self?.close(id, Wisp.networkError) }
        self?.resume()
      })
    case .continue:
      guard let count = Wisp.u32(payload) else { return }
      stream.credit = count
      if stream.stalled, count > 0 {
        stream.stalled = false
        up(id, stream)
      }
    case .close:
      streams[id] = nil
      // the server's side ended cleanly: let WebKit read the rest, then FIN; otherwise a reset, so a cut-off response isn't taken as whole
      if payload.first == Wisp.voluntary { Relay.finish(stream.local) } else { stream.local.forceCancel() }
      resume()
    default: break
    }
  }

  // WebKit to the server: one packet in flight, within the server's credit.
  private func up(_ id: UInt32, _ stream: WispStream) {
    guard stream.credit > 0 else {
      stream.stalled = true
      return
    }
    stream.local.receive(minimumIncompleteLength: 1, maximumLength: chunk) { [weak self] data, _, isComplete, error in
      guard let self, self.streams[id] === stream else { return }
      let end = { if isComplete || error != nil { self.close(id, error == nil ? Wisp.voluntary : Wisp.networkError) } }
      guard let data, !data.isEmpty else { return end() }
      stream.credit -= 1
      self.send(Wisp.packet(.data, id, [UInt8](data))) {
        guard self.streams[id] === stream else { return }
        if isComplete || error != nil { end() } else { self.up(id, stream) }
      }
    }
  }

  // shortcut: wisp has no half-close, so WebKit's FIN closes the whole stream; fine for HTTP and TLS
  private func close(_ id: UInt32, _ reason: UInt8) {
    guard let stream = streams.removeValue(forKey: id) else { return }
    send(Wisp.packet(.close, id, [reason]))
    if reason == Wisp.voluntary { stream.local.cancel() } else { stream.local.forceCancel() }
    resume()
  }
}
