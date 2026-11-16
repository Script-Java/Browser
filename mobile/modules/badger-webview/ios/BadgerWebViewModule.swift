import ExpoModulesCore
import WebKit

public class BadgerWebViewModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BadgerWebView")

    // WebKit's stores and Shared are main-actor only: these run on the main queue.
    AsyncFunction("compileContentRules") { (id: String, json: String, promise: Promise) in
      MainActor.assumeIsolated {
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: id, encodedContentRuleList: json) { _, error in
          if let error { promise.reject(error) } else { promise.resolve() }
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("contentRuleIds") { (promise: Promise) in
      MainActor.assumeIsolated {
        WKContentRuleListStore.default().getAvailableContentRuleListIdentifiers { promise.resolve($0 ?? []) }
      }
    }.runOnQueue(.main)

    AsyncFunction("removeContentRules") { (id: String, promise: Promise) in
      MainActor.assumeIsolated {
        WKContentRuleListStore.default().removeContentRuleList(forIdentifier: id) { error in
          if let error { promise.reject(error) } else { promise.resolve() }
        }
      }
    }.runOnQueue(.main)

    // Called synchronously on the JavaScript thread.
    Function("resolveNavigation") { (requestId: String, allow: Bool) in
      DispatchQueue.main.async { MainActor.assumeIsolated { Shared.resolve(requestId, allow) } }
    }

    Function("resolvePermission") { (requestId: String, grant: Bool) in
      DispatchQueue.main.async { MainActor.assumeIsolated { Shared.resolve(requestId, grant) } }
    }

    AsyncFunction("cookies") { (store: StoreRecord, url: String, promise: Promise) in
      let host = URL(string: url)?.host()?.lowercased() ?? ""
      try MainActor.assumeIsolated {
        try Shared.dataStore(store).httpCookieStore.getAllCookies { cookies in
          promise.resolve(cookies.filter { cookieDomain($0.domain, matches: host) }.map(cookieDictionary))
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("clearStore") { (store: StoreRecord, promise: Promise) in
      try MainActor.assumeIsolated {
        try Shared.dataStore(store).removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {
          promise.resolve()
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("removeStore") { (id: String, promise: Promise) in
      MainActor.assumeIsolated {
        // Dropped first: WebKit removes a store only once nothing holds it. An ephemeral one just goes.
        let removed = Shared.stores.removeValue(forKey: id)
        guard removed?.isPersistent != false, let uuid = UUID(uuidString: id) else {
          return promise.resolve()
        }
        WKWebsiteDataStore.remove(forIdentifier: uuid) { error in
          if let error { promise.reject(error) } else { promise.resolve() }
        }
      }
    }.runOnQueue(.main)

    View(BadgerWebView.self) {
      Events("onNavigationState", "onShouldStart", "onOpenWindow", "onDownload", "onPermissionRequest", "onMessage", "onLoadError", "onSessionState")

      Prop("url") { (view: BadgerWebView, url: String) in view.url = url }
      Prop("sessionState") { (view: BadgerWebView, state: String?) in view.sessionState = state }
      Prop("store") { (view: BadgerWebView, store: StoreRecord) in view.store = store }
      Prop("level") { (view: BadgerWebView, level: String) in view.level = level }
      Prop("lockdown") { (view: BadgerWebView, lockdown: Bool) in view.lockdown = lockdown }
      Prop("contentRules") { (view: BadgerWebView, ids: [String]) in view.contentRules = ids }
      Prop("pageScripts") { (view: BadgerWebView, scripts: [String]) in view.pageScripts = scripts }
      Prop("isolatedScripts") { (view: BadgerWebView, scripts: [String]) in view.isolatedScripts = scripts }
      Prop("fraudWarnings") { (view: BadgerWebView, on: Bool) in view.fraudWarnings = on }
      Prop("userAgent") { (view: BadgerWebView, userAgent: String?) in view.userAgent = userAgent }
      Prop("askBeforeNavigating", false) { (view: BadgerWebView, ask: Bool) in view.askBeforeNavigating = ask }

      OnViewDidUpdateProps { (view: BadgerWebView) in view.update() }

      // `_ =` keeps each result Void: WKNavigation can't cross to JavaScript.
      AsyncFunction("load") { (view: BadgerWebView, url: String) in view.load(url) }
      AsyncFunction("goBack") { (view: BadgerWebView) in _ = view.webView?.goBack() }
      AsyncFunction("goForward") { (view: BadgerWebView) in _ = view.webView?.goForward() }
      AsyncFunction("reload") { (view: BadgerWebView) in _ = view.webView?.reload() }
      AsyncFunction("stop") { (view: BadgerWebView) in _ = view.webView?.stopLoading() }
      AsyncFunction("find") { (view: BadgerWebView) in
        _ = view.webView?.findInteraction?.presentFindNavigator(showingReplace: false)
      }
      AsyncFunction("certificate") { (view: BadgerWebView) in view.certificate() }
    }
  }
}

/// RFC 6265 domain-match: the host is the cookie's domain or a subdomain of it.
private func cookieDomain(_ domain: String, matches host: String) -> Bool {
  let lowered = domain.lowercased()
  let bare = lowered.hasPrefix(".") ? String(lowered.dropFirst()) : lowered
  return host == bare || host.hasSuffix("." + bare)
}

private func cookieDictionary(_ cookie: HTTPCookie) -> [String: Any] {
  var dictionary: [String: Any] = [
    "name": cookie.name,
    "value": cookie.value,
    "domain": cookie.domain,
    "path": cookie.path,
    "secure": cookie.isSecure,
    "httpOnly": cookie.isHTTPOnly,
  ]
  if let expires = cookie.expiresDate {
    dictionary["expires"] = expires.timeIntervalSince1970
  }
  return dictionary
}
