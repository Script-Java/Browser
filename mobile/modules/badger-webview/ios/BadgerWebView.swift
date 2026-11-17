import ExpoModulesCore
import Network
import Security
import WebKit

struct ProxyRecord: Record {
  @Field var port: Int = 0
  @Field var username: String = ""
  @Field var password: String = ""
}

struct StoreRecord: Record {
  @Field var id: String = ""
  @Field var persistent: Bool = false
  @Field var proxy: ProxyRecord?
}

/// What every tab and the module share.
@MainActor
enum Shared {
  static var stores: [String: WKWebsiteDataStore] = [:]
  /// onShouldStart and onPermissionRequest answers, by requestId
  static var answers: [String: (Bool) -> Void] = [:]
  /// Windows WebKit made for pages, by onOpenWindow's windowId, until a tab adopts them.
  static var windows: [String: OpenedWindow] = [:]

  static func dataStore(_ store: StoreRecord) throws -> WKWebsiteDataStore {
    if let existing = stores[store.id] {
      return existing
    }
    let dataStore: WKWebsiteDataStore
    if store.persistent {
      guard let uuid = UUID(uuidString: store.id) else {
        throw Exception(name: "ERR_STORE_ID", description: "A persistent store's id must be a UUID, got '\(store.id)'")
      }
      dataStore = WKWebsiteDataStore(forIdentifier: uuid)
    } else {
      dataStore = .nonPersistent()
    }
    // Only here, at creation: WebKit misbehaves when a store in use changes proxy.
    if let proxy = store.proxy {
      // Fail closed: a store without its proxy would show sites the phone's address.
      guard let port = NWEndpoint.Port(String(proxy.port)), port != .any else {
        throw Exception(name: "ERR_PROXY_PORT", description: "Invalid proxy port \(proxy.port)")
      }
      let config = ProxyConfiguration(socksv5Proxy: .hostPort(host: NWEndpoint.Host("127.0.0.1"), port: port))
      config.applyCredential(username: proxy.username, password: proxy.password)
      dataStore.proxyConfigurations = [config]
    }
    stores[store.id] = dataStore
    return dataStore
  }

  /// Holds `answer` until resolve(), or refuses after `seconds`. Every WebKit decision handler must be called.
  static func ask(timeout seconds: Int, _ answer: @escaping (Bool) -> Void) -> String {
    let id = UUID().uuidString
    answers[id] = answer
    Task {
      try? await Task.sleep(for: .seconds(seconds))
      Shared.resolve(id, false)
    }
    return id
  }

  static func resolve(_ id: String, _ value: Bool) {
    answers.removeValue(forKey: id)?(value)
  }
}

/// One tab: a WKWebView whose engine settings follow the props.
final class BadgerWebView: ExpoView, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
  let onNavigationState = EventDispatcher()
  let onShouldStart = EventDispatcher()
  let onOpenWindow = EventDispatcher()
  let onDownload = EventDispatcher()
  let onPermissionRequest = EventDispatcher()
  let onMessage = EventDispatcher()
  let onLoadError = EventDispatcher()
  let onSessionState = EventDispatcher()

  var url = ""
  var sessionState: String?
  var openedWindow: String?
  var store: StoreRecord?
  var level = "standard"
  var lockdown = false
  var askBeforeNavigating = false
  var contentRules: [String] = [] {
    didSet { Task { await applyRules() } }
  }
  var pageScripts: [String] = [] {
    didSet { applyScripts() }
  }
  var isolatedScripts: [String] = [] {
    didSet { applyScripts() }
  }
  var fraudWarnings = true {
    didSet { webView?.configuration.preferences.isFraudulentWebsiteWarningEnabled = fraudWarnings }
  }
  var userAgent: String? {
    didSet { webView?.customUserAgent = userAgent }
  }

  private(set) var webView: WKWebView?
  /// The next main-frame decision is the app's: load(), a restore or reload(); historyByApp, goBack()
  /// or goForward(), only if it's a history move, since within a page (pushState, #) they reach none.
  var byApp = false
  var historyByApp = false
  /// Level and lockdown at the last main-frame allow, and of the page showing (from its commit).
  private var answered: (level: String, lockdown: Bool)?
  private var committed: (level: String, lockdown: Bool)?
  /// The rule lists in use, for the windows this tab's pages open: WebKit can't list them.
  private var ruleLists: [WKContentRuleList] = []
  private var storeId: String?
  private var observations: [NSKeyValueObservation] = []
  // shortcut: downloads belong to their tab, so closing it mid-download loses the events; move them to Shared when downloads should outlive tabs.
  private var downloads: [WKDownload: (id: String, file: URL)] = [:]

  /// Creates the web view once all props are in, and again when the tab moves to another store.
  func update() {
    guard let store, store.id != storeId else {
      return
    }
    // Fail closed: no valid store and proxy, no page.
    guard let dataStore = try? Shared.dataStore(store) else {
      return
    }
    let start = webView?.url?.absoluteString ?? url
    // a tab brought back: its pages and their back and forward, not just its address
    let restore = webView == nil ? sessionState.flatMap { Data(base64Encoded: $0) } : nil
    // a window its page opened, which keeps the page its opener and the initiator of its first load
    let opened = webView == nil ? openedWindow.flatMap { Shared.windows.removeValue(forKey: $0) } : nil
    // WebKit gives a window its opener's store: in another, the tab loads `url` itself.
    let adopted = opened?.webView.configuration.websiteDataStore === dataStore ? opened : nil
    if adopted == nil {
      opened?.drop()
    }
    webView?.removeFromSuperview()
    storeId = store.id

    let webView: WKWebView
    if let adopted {
      webView = adopted.webView
      webView.frame = bounds
      adopted.handler.target = self
    } else {
      let config = WKWebViewConfiguration()
      config.websiteDataStore = dataStore
      config.userContentController.add(WeakMessageHandler(self), contentWorld: .world(name: "badger"), name: "badger")
      webView = WKWebView(frame: bounds, configuration: config)
      webView.navigationDelegate = self
    }
    webView.configuration.preferences.isFraudulentWebsiteWarningEnabled = fraudWarnings
    webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    webView.isFindInteractionEnabled = true
    webView.allowsBackForwardNavigationGestures = true
    webView.customUserAgent = userAgent
    #if DEBUG
    webView.isInspectable = true
    #endif
    webView.uiDelegate = self
    addSubview(webView)
    self.webView = webView

    func watch<Value>(_ keyPath: KeyPath<WKWebView, Value>) -> NSKeyValueObservation {
      webView.observe(keyPath) { [weak self] _, _ in
        MainActor.assumeIsolated { self?.sendState() }
      }
    }
    observations = [
      watch(\.url), watch(\.title), watch(\.isLoading), watch(\.estimatedProgress),
      watch(\.canGoBack), watch(\.canGoForward), watch(\.hasOnlySecureContent),
    ]

    applyScripts()
    Task {
      // Rules first, so the first page is blocked too.
      await applyRules()
      if let adopted {
        adopted.handOver(to: self)
      } else if let restore {
        byApp = true
        webView.interactionState = restore
      } else {
        load(start)
      }
    }
  }

  func load(_ address: String) {
    guard let target = URL(string: address) else {
      return
    }
    if let webView {
      byApp = true
      webView.load(URLRequest(url: target))
    } else {
      url = address
    }
  }

  /// The page goes to `address` itself, so it stays the navigation's initiator (its cookies, Referer
  /// and Sec-Fetch-Site). From the app's world, where the page can't replace location.assign; assign, not replace, so Back still reaches the page the link was on.
  func navigateFromPage(_ address: String) throws {
    guard let target = URL(string: address), ["http", "https"].contains(target.scheme?.lowercased()) else {
      throw Exception(name: "ERR_URL", description: "navigateFromPage takes an http(s) URL, got '\(address)'")
    }
    guard let webView, let page = webView.url, page.absoluteString != "about:blank" else {
      return load(target.absoluteString)
    }
    // A JSON string is a JavaScript string literal, so the URL can't end it.
    let literal = String(decoding: try JSONEncoder().encode(target.absoluteString), as: UTF8.self)
    webView.evaluateJavaScript("location.assign(\(literal))", in: nil, in: .world(name: "badger"))
  }

  /// The page's chain, leaf first, as base64 DER.
  func certificate() -> [String]? {
    guard webView?.url?.scheme == "https", let trust = webView?.serverTrust,
      let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate] else {
      return nil
    }
    return chain.map { (SecCertificateCopyData($0) as Data).base64EncodedString() }
  }

  private func applyScripts() {
    guard let controller = webView?.configuration.userContentController else {
      return
    }
    controller.removeAllUserScripts()
    for source in pageScripts {
      controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
    }
    for source in isolatedScripts {
      controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentEnd, forMainFrameOnly: false, in: .world(name: "badger")))
    }
  }

  private func applyRules() async {
    let ids = contentRules
    var lists: [WKContentRuleList] = []
    for id in ids {
      if let list = try? await WKContentRuleListStore.default().contentRuleList(forIdentifier: id) {
        lists.append(list)
      }
    }
    // A newer set may have arrived during the lookups.
    guard ids == contentRules, let controller = webView?.configuration.userContentController else {
      return
    }
    ruleLists = lists
    controller.removeAllContentRuleLists()
    for list in lists {
      controller.add(list)
    }
  }

  private func sendState() {
    guard let webView else {
      return
    }
    onNavigationState([
      "url": webView.url?.absoluteString ?? "",
      "title": webView.title ?? "",
      "loading": webView.isLoading,
      "progress": webView.estimatedProgress,
      "canGoBack": webView.canGoBack,
      "canGoForward": webView.canGoForward,
      "secure": webView.url?.scheme == "https" && webView.hasOnlySecureContent,
    ])
  }

  // MARK: - WKNavigationDelegate

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    preferences: WKWebpagePreferences,
    decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
  ) {
    let isMainFrame = navigationAction.targetFrame?.isMainFrame == true
    let byApp = isMainFrame && (self.byApp || (historyByApp && navigationAction.navigationType == .backForward))
    if isMainFrame {
      self.byApp = false
      historyByApp = false
    }
    if navigationAction.shouldPerformDownload {
      return decisionHandler(.download, preferences)
    }
    guard isMainFrame else {
      // The page's settings: the props may already be for a main-frame navigation that never commits.
      return decisionHandler(.allow, engineSettings(preferences, committed ?? (level, lockdown)))
    }
    // Read at the answer: the app sets the new site's props, then answers.
    let answer = { [weak self] (allow: Bool) in
      guard allow, let self else {
        return decisionHandler(.cancel, preferences)
      }
      let settings = (level: self.level, lockdown: self.lockdown)
      self.answered = settings
      decisionHandler(.allow, self.engineSettings(preferences, settings))
    }
    guard askBeforeNavigating else {
      return answer(true)
    }
    let requestId = Shared.ask(timeout: 10, answer)
    onShouldStart(["requestId": requestId, "url": navigationAction.request.url?.absoluteString ?? "", "isMainFrame": true, "byApp": byApp])
  }

  /// The engine's settings for a page. Lockdown is page-wide in WebKit, so frames get their page's anyway.
  private func engineSettings(_ preferences: WKWebpagePreferences, _ settings: (level: String, lockdown: Bool)) -> WKWebpagePreferences {
    // Only ever turned on: setting false would override the device's own Lockdown Mode.
    if settings.lockdown {
      preferences.isLockdownModeEnabled = true
    }
    preferences.allowsContentJavaScript = settings.level != "safest"
    return preferences
  }

  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    committed = answered
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationResponse: WKNavigationResponse,
    decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void
  ) {
    decisionHandler(navigationResponse.isForMainFrame && !navigationResponse.canShowMIMEType ? .download : .allow)
  }

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    download.delegate = self
  }

  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    download.delegate = self
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    if let state = webView.interactionState as? Data {
      onSessionState(["state": state.base64EncodedString()])
    }
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
    sendError(error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
    sendError(error)
  }

  // shortcut: a page that crashes its process every time reloads every time; count crashes and show an error when that happens.
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    webView.reload()
  }

  private func sendError(_ error: any Error) {
    let nsError = error as NSError
    let urlError = error as? URLError
    // Stopped, superseded, refused or turned into a download (WebKitErrorFrameLoadInterruptedByPolicyChange): not failures.
    if urlError?.code == .cancelled || (nsError.domain == "WebKitErrorDomain" && nsError.code == 102) {
      return
    }
    let certificateCodes: [URLError.Code] = [
      .serverCertificateHasBadDate, .serverCertificateUntrusted, .serverCertificateHasUnknownRoot,
      .serverCertificateNotYetValid, .clientCertificateRejected, .clientCertificateRequired,
    ]
    onLoadError([
      "url": urlError?.failingURL?.absoluteString ?? webView?.url?.absoluteString ?? "",
      "code": nsError.code,
      "description": nsError.localizedDescription,
      "certificateError": urlError.map { certificateCodes.contains($0.code) } ?? false,
    ])
  }

  // MARK: - WKUIDelegate

  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    // Made here, not by the app's new tab, so the page stays its opener and the initiator of its first
    // load: its SameSite cookies, Referer, Sec-Fetch-Site and a POST's body. WebKit's configuration
    // shares this tab's content controller, so the window gets its own, with this tab's scripts and rules
    // until its tab's are in.
    // shortcut: the window still shares this tab's WKPreferences (WebKit copies the configuration shallowly), so fraudWarnings set on one sets both; give it its own if that prop ever differs between tabs.
    let controller = WKUserContentController()
    for script in webView.configuration.userContentController.userScripts {
      controller.addUserScript(script)
    }
    for list in ruleLists {
      controller.add(list)
    }
    let handler = WeakMessageHandler(nil)
    controller.add(handler, contentWorld: .world(name: "badger"), name: "badger")
    configuration.userContentController = controller
    let window = OpenedWindow(configuration, handler)
    let windowId = UUID().uuidString
    Shared.windows[windowId] = window
    Task {
      try? await Task.sleep(for: .seconds(10))
      Shared.windows.removeValue(forKey: windowId)?.drop()
    }
    onOpenWindow(["url": navigationAction.request.url?.absoluteString ?? "", "windowId": windowId])
    return window.webView
  }

  func webView(
    _ webView: WKWebView,
    requestMediaCapturePermissionFor origin: WKSecurityOrigin,
    initiatedByFrame frame: WKFrameInfo,
    type: WKMediaCaptureType,
    decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void
  ) {
    let kind = switch type {
    case .camera: "camera"
    case .microphone: "microphone"
    default: "cameraAndMicrophone"
    }
    let requestId = Shared.ask(timeout: 60) { decisionHandler($0 ? .grant : .deny) }
    let port = origin.port == 0 ? "" : ":\(origin.port)"
    onPermissionRequest(["requestId": requestId, "origin": "\(origin.`protocol`)://\(origin.host)\(port)", "kind": kind])
  }

  // alert, confirm and prompt: without these, confirm() is always false and prompt() always null.
  func webView(
    _ webView: WKWebView,
    runJavaScriptAlertPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping @MainActor @Sendable () -> Void
  ) {
    let alert = dialog(message, frame)
    alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
    present(alert) { completionHandler() }
  }

  func webView(
    _ webView: WKWebView,
    runJavaScriptConfirmPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping @MainActor @Sendable (Bool) -> Void
  ) {
    let alert = dialog(message, frame)
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
    alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
    present(alert) { completionHandler(false) }
  }

  func webView(
    _ webView: WKWebView,
    runJavaScriptTextInputPanelWithPrompt prompt: String,
    defaultText: String?,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping @MainActor @Sendable (String?) -> Void
  ) {
    let alert = dialog(prompt, frame)
    alert.addTextField { $0.text = defaultText }
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
    alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak alert] _ in
      completionHandler(alert?.textFields?.first?.text ?? "")
    })
    present(alert) { completionHandler(nil) }
  }

  /// Titled with the frame's host, so a frame from another site can't pass as the page.
  private func dialog(_ message: String, _ frame: WKFrameInfo) -> UIAlertController {
    UIAlertController(title: frame.securityOrigin.host, message: message, preferredStyle: .alert)
  }

  /// WebKit waits for an answer, so with nowhere to show the dialog, answer at once.
  private func present(_ alert: UIAlertController, otherwise: () -> Void) {
    guard window != nil, let controller = appContext?.utilities?.currentViewController() else {
      return otherwise()
    }
    controller.present(alert, animated: true)
  }

  // MARK: - WKDownloadDelegate

  func download(
    _ download: WKDownload,
    decideDestinationUsing response: URLResponse,
    suggestedFilename: String,
    completionHandler: @escaping @MainActor @Sendable (URL?) -> Void
  ) {
    let file = Self.downloadFile(named: suggestedFilename)
    downloads[download] = (UUID().uuidString, file)
    sendDownload(download, "started")
    completionHandler(file)
  }

  func downloadDidFinish(_ download: WKDownload) {
    sendDownload(download, "finished")
  }

  func download(_ download: WKDownload, didFailWithError error: any Error, resumeData: Data?) {
    sendDownload(download, "failed", error)
  }

  private func sendDownload(_ download: WKDownload, _ state: String, _ error: (any Error)? = nil) {
    guard let entry = downloads[download] else {
      return
    }
    if state != "started" {
      downloads[download] = nil
    }
    var event: [String: Any] = [
      "id": entry.id,
      "url": download.originalRequest?.url?.absoluteString ?? "",
      "filename": entry.file.lastPathComponent,
      "state": state,
    ]
    if state == "finished" {
      event["path"] = entry.file.absoluteString
    }
    if let error {
      event["error"] = error.localizedDescription
    }
    onDownload(event)
  }

  /// A new file in Documents/Downloads.
  private static func downloadFile(named suggested: String) -> URL {
    let folder = URL.documentsDirectory.appending(path: "Downloads", directoryHint: .isDirectory)
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    // The site picks the name: keep it a plain, visible file inside the folder.
    var name = suggested.replacingOccurrences(of: "/", with: "_")
    if name.isEmpty || name.hasPrefix(".") {
      name = "download" + name
    }
    let base = (name as NSString).deletingPathExtension
    let ext = (name as NSString).pathExtension
    var file = folder.appending(path: name)
    var copy = 1
    while FileManager.default.fileExists(atPath: file.path(percentEncoded: false)) {
      copy += 1
      file = folder.appending(path: ext.isEmpty ? "\(base) (\(copy))" : "\(base) (\(copy)).\(ext)")
    }
    return file
  }

  // MARK: - WKScriptMessageHandler (the "badger" world only)

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    // The isolated scripts post strings, JSON for anything structured.
    if let data = message.body as? String {
      onMessage(["data": data])
    }
  }
}

/// A window WebKit made for a page (window.open, target=_blank), until a tab adopts it. Its navigations
/// wait, so nothing loads before the tab's settings are in.
@MainActor
final class OpenedWindow: NSObject, WKNavigationDelegate {
  let webView: WKWebView
  /// its "badger" handler, pointed at the tab that adopts it
  let handler: WeakMessageHandler
  private var held: [(WKNavigationAction, WKWebpagePreferences, @MainActor @Sendable (WKNavigationActionPolicy, WKWebpagePreferences) -> Void)] = []

  init(_ configuration: WKWebViewConfiguration, _ handler: WeakMessageHandler) {
    // Apple: "The web view returned must be created with the specified configuration."
    webView = WKWebView(frame: .zero, configuration: configuration)
    self.handler = handler
    super.init()
    webView.navigationDelegate = self
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    preferences: WKWebpagePreferences,
    decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
  ) {
    held.append((navigationAction, preferences, decisionHandler))
  }

  /// The tab becomes the delegate and decides what was held, as its own navigations.
  // the tab's own type, not WKNavigationDelegate: there this method is optional, and a held decision
  // that's never called crashes WebKit
  func handOver(to tab: BadgerWebView) {
    webView.navigationDelegate = tab
    for (action, preferences, decide) in held {
      tab.webView(webView, decidePolicyFor: action, preferences: preferences, decisionHandler: decide)
    }
    held = []
  }

  /// Not adopted: what it held is refused, and the window goes once nothing holds it.
  func drop() {
    for (_, preferences, decide) in held {
      decide(.cancel, preferences)
    }
    held = []
  }
}

/// WKUserContentController keeps its handlers alive; this one lets a closed tab go.
final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
  weak var target: WKScriptMessageHandler?

  init(_ target: WKScriptMessageHandler?) {
    self.target = target
    super.init()
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.userContentController(userContentController, didReceive: message)
  }
}
