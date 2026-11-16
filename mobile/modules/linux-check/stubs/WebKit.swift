// WebKit, only what the web view module touches. Signatures from developer.apple.com (append ".md"
// to fetch). WebKit is Objective-C: imported declarations are @preconcurrency, imported methods are
// @discardableResult. Optional delegate methods: see WKNavigationDelegate. iOS 8 unless noted.
@_exported import UIKit
@_exported import Network
@_exported import Security

// https://developer.apple.com/documentation/webkit/wkwebsitedatastore
@preconcurrency @MainActor open class WKWebsiteDataStore: NSObject, @unchecked Sendable {
  // https://developer.apple.com/documentation/webkit/wkwebsitedatastore/nonpersistent()
  open class func nonPersistent() -> WKWebsiteDataStore { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkwebsitedatastore/init(foridentifier:) (iOS 17)
  public init(forIdentifier identifier: UUID) { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkwebsitedatastore/ispersistent
  open var isPersistent: Bool { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkwebsitedatastore/httpcookiestore
  open var httpCookieStore: WKHTTPCookieStore { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkwebsitedatastore/allwebsitedatatypes()
  open class func allWebsiteDataTypes() -> Set<String> { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkwebsitedatastore/removedata(oftypes:modifiedsince:completionhandler:)
  open func removeData(ofTypes dataTypes: Set<String>, modifiedSince date: Date, completionHandler: @escaping @MainActor @Sendable () -> Void) { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkwebsitedatastore/remove(foridentifier:completionhandler:) (iOS 17)
  open class func remove(forIdentifier identifier: UUID, completionHandler: @escaping @MainActor @Sendable ((any Error)?) -> Void) { fatalError() }
}

extension WKWebsiteDataStore {
  // https://developer.apple.com/documentation/webkit/wkwebsitedatastore/proxyconfigurations-cdc1 (iOS 17; a Swift extension)
  @MainActor @preconcurrency public var proxyConfigurations: [ProxyConfiguration] { get { fatalError() } set { fatalError() } }
}

// https://developer.apple.com/documentation/webkit/wkhttpcookiestore
@preconcurrency @MainActor open class WKHTTPCookieStore: NSObject {
  // https://developer.apple.com/documentation/webkit/wkhttpcookiestore/getallcookies(_:)
  open func getAllCookies(_ completionHandler: @escaping @MainActor @Sendable ([HTTPCookie]) -> Void) { fatalError() }
}

// https://developer.apple.com/documentation/webkit/wkwebviewconfiguration
@preconcurrency @MainActor open class WKWebViewConfiguration: NSObject {
  public override init() { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkwebviewconfiguration/websitedatastore
  open var websiteDataStore: WKWebsiteDataStore { get { fatalError() } set { fatalError() } }
  // https://developer.apple.com/documentation/webkit/wkwebviewconfiguration/preferences
  open var preferences: WKPreferences { get { fatalError() } set { fatalError() } }
  // https://developer.apple.com/documentation/webkit/wkwebviewconfiguration/usercontentcontroller
  open var userContentController: WKUserContentController { get { fatalError() } set { fatalError() } }
}

// https://developer.apple.com/documentation/webkit/wkpreferences
@preconcurrency @MainActor open class WKPreferences: NSObject {
  // https://developer.apple.com/documentation/webkit/wkpreferences/isfraudulentwebsitewarningenabled (iOS 13)
  open var isFraudulentWebsiteWarningEnabled: Bool { get { fatalError() } set { fatalError() } }
}

// https://developer.apple.com/documentation/webkit/wkusercontentcontroller
@preconcurrency @MainActor open class WKUserContentController: NSObject {
  // https://developer.apple.com/documentation/webkit/wkusercontentcontroller/adduserscript(_:)
  open func addUserScript(_ userScript: WKUserScript) { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkusercontentcontroller/removealluserscripts()
  open func removeAllUserScripts() { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkusercontentcontroller/add(_:contentworld:name:) (iOS 14)
  open func add(_ scriptMessageHandler: any WKScriptMessageHandler, contentWorld world: WKContentWorld, name: String) { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkusercontentcontroller/add(_:name:)
  open func add(_ scriptMessageHandler: any WKScriptMessageHandler, name: String) { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkusercontentcontroller/add(_:) (iOS 11)
  open func add(_ contentRuleList: WKContentRuleList) { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkusercontentcontroller/removeallcontentrulelists() (iOS 11)
  open func removeAllContentRuleLists() { fatalError() }
}

// https://developer.apple.com/documentation/webkit/wkcontentworld (iOS 14)
@preconcurrency @MainActor open class WKContentWorld: NSObject {
  // https://developer.apple.com/documentation/webkit/wkcontentworld/page
  open class var page: WKContentWorld { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkcontentworld/world(name:)
  open class func world(name: String) -> WKContentWorld { fatalError() }
}

// https://developer.apple.com/documentation/webkit/wkuserscriptinjectiontime
public enum WKUserScriptInjectionTime: Int, Sendable {
  case atDocumentStart = 0, atDocumentEnd = 1
}

// https://developer.apple.com/documentation/webkit/wkuserscript
@preconcurrency @MainActor open class WKUserScript: NSObject {
  // https://developer.apple.com/documentation/webkit/wkuserscript/init(source:injectiontime:formainframeonly:in:) (iOS 14)
  public init(source: String, injectionTime: WKUserScriptInjectionTime, forMainFrameOnly: Bool, in contentWorld: WKContentWorld) { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkuserscript/init(source:injectiontime:formainframeonly:)
  public init(source: String, injectionTime: WKUserScriptInjectionTime, forMainFrameOnly: Bool) { fatalError() }
}

// https://developer.apple.com/documentation/webkit/wkcontentrulelist (iOS 11)
@preconcurrency @MainActor open class WKContentRuleList: NSObject, @unchecked Sendable {}

// https://developer.apple.com/documentation/webkit/wkcontentruleliststore (iOS 11)
@preconcurrency @MainActor open class WKContentRuleListStore: NSObject {
  // https://developer.apple.com/documentation/webkit/wkcontentruleliststore/default()
  open class func `default`() -> Self! { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkcontentruleliststore/lookupcontentrulelist(foridentifier:completionhandler:)
  open func lookUpContentRuleList(forIdentifier identifier: String!, completionHandler: ((WKContentRuleList?, (any Error)?) -> Void)!) { fatalError() }
  // ...and its async form, from the same page
  open func contentRuleList(forIdentifier identifier: String!) async throws -> WKContentRuleList? { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkcontentruleliststore/compilecontentrulelist(foridentifier:encodedcontentrulelist:completionhandler:)
  open func compileContentRuleList(forIdentifier identifier: String!, encodedContentRuleList: String!, completionHandler: ((WKContentRuleList?, (any Error)?) -> Void)!) { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkcontentruleliststore/getavailablecontentrulelistidentifiers(_:)
  open func getAvailableContentRuleListIdentifiers(_ completionHandler: (([String]?) -> Void)!) { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkcontentruleliststore/removecontentrulelist(foridentifier:completionhandler:)
  open func removeContentRuleList(forIdentifier identifier: String!, completionHandler: (((any Error)?) -> Void)!) { fatalError() }
}

// https://developer.apple.com/documentation/webkit/wkwebview
@preconcurrency @MainActor open class WKWebView: UIView {
  // https://developer.apple.com/documentation/webkit/wkwebview/init(frame:configuration:)
  public init(frame: CGRect, configuration: WKWebViewConfiguration) { fatalError() }
  public required init?(coder: NSCoder) { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkwebview/configuration
  open var configuration: WKWebViewConfiguration { fatalError() } // @NSCopying in the SDK
  // https://developer.apple.com/documentation/webkit/wkwebview/navigationdelegate
  weak open var navigationDelegate: (any WKNavigationDelegate)?
  // https://developer.apple.com/documentation/webkit/wkwebview/uidelegate
  weak open var uiDelegate: (any WKUIDelegate)?
  // https://developer.apple.com/documentation/webkit/wkwebview/isfindinteractionenabled (iOS 16)
  open var isFindInteractionEnabled: Bool { get { fatalError() } set { fatalError() } }
  // https://developer.apple.com/documentation/webkit/wkwebview/findinteraction (iOS 16)
  open var findInteraction: UIFindInteraction? { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkwebview/allowsbackforwardnavigationgestures
  open var allowsBackForwardNavigationGestures: Bool { get { fatalError() } set { fatalError() } }
  // https://developer.apple.com/documentation/webkit/wkwebview/customuseragent (iOS 9)
  open var customUserAgent: String? { get { fatalError() } set { fatalError() } }
  // https://developer.apple.com/documentation/webkit/wkwebview/isinspectable (iOS 16.4)
  open var isInspectable: Bool { get { fatalError() } set { fatalError() } }
  // https://developer.apple.com/documentation/webkit/wkwebview/url
  open var url: URL? { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkwebview/title
  open var title: String? { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkwebview/isloading
  open var isLoading: Bool { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkwebview/estimatedprogress
  open var estimatedProgress: Double { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkwebview/cangoback
  open var canGoBack: Bool { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkwebview/cangoforward
  open var canGoForward: Bool { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkwebview/hasonlysecurecontent
  open var hasOnlySecureContent: Bool { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkwebview/servertrust (iOS 10)
  open var serverTrust: SecTrust? { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkwebview/interactionstate (iOS 15)
  open var interactionState: Any? { get { fatalError() } set { fatalError() } }
  // https://developer.apple.com/documentation/webkit/wkwebview/load(_:)-5siv6
  @discardableResult open func load(_ request: URLRequest) -> WKNavigation? { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkwebview/reload()
  @discardableResult open func reload() -> WKNavigation? { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkwebview/goback()
  @discardableResult open func goBack() -> WKNavigation? { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkwebview/goforward()
  @discardableResult open func goForward() -> WKNavigation? { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkwebview/stoploading()
  open func stopLoading() { fatalError() }
}

// https://developer.apple.com/documentation/webkit/wknavigation
@preconcurrency @MainActor open class WKNavigation: NSObject {}

// https://developer.apple.com/documentation/webkit/wkwindowfeatures
@preconcurrency @MainActor open class WKWindowFeatures: NSObject {}

// https://developer.apple.com/documentation/webkit/wksecurityorigin (iOS 9)
@preconcurrency @MainActor open class WKSecurityOrigin: NSObject {
  // https://developer.apple.com/documentation/webkit/wksecurityorigin/protocol
  open var `protocol`: String { fatalError() }
  // https://developer.apple.com/documentation/webkit/wksecurityorigin/host
  open var host: String { fatalError() }
  // https://developer.apple.com/documentation/webkit/wksecurityorigin/port
  open var port: Int { fatalError() }
}

// https://developer.apple.com/documentation/webkit/wkframeinfo
@preconcurrency @MainActor open class WKFrameInfo: NSObject {
  // https://developer.apple.com/documentation/webkit/wkframeinfo/ismainframe
  open var isMainFrame: Bool { fatalError() }
  // https://developer.apple.com/documentation/webkit/wkframeinfo/securityorigin (iOS 9)
  open var securityOrigin: WKSecurityOrigin { fatalError() }
}

// https://developer.apple.com/documentation/webkit/wknavigationaction
@preconcurrency @MainActor open class WKNavigationAction: NSObject {
  // https://developer.apple.com/documentation/webkit/wknavigationaction/targetframe
  open var targetFrame: WKFrameInfo? { fatalError() } // @NSCopying in the SDK
  // https://developer.apple.com/documentation/webkit/wknavigationaction/request
  open var request: URLRequest { fatalError() }
  // https://developer.apple.com/documentation/webkit/wknavigationaction/shouldperformdownload (iOS 14.5)
  open var shouldPerformDownload: Bool { fatalError() }
}

// https://developer.apple.com/documentation/webkit/wknavigationresponse
@preconcurrency @MainActor open class WKNavigationResponse: NSObject {
  // https://developer.apple.com/documentation/webkit/wknavigationresponse/isformainframe
  open var isForMainFrame: Bool { fatalError() }
  // https://developer.apple.com/documentation/webkit/wknavigationresponse/canshowmimetype
  open var canShowMIMEType: Bool { fatalError() }
}

// https://developer.apple.com/documentation/webkit/wkwebpagepreferences (iOS 13)
@preconcurrency @MainActor open class WKWebpagePreferences: NSObject {
  // https://developer.apple.com/documentation/webkit/wkwebpagepreferences/allowscontentjavascript (iOS 14)
  open var allowsContentJavaScript: Bool { get { fatalError() } set { fatalError() } }
  // https://developer.apple.com/documentation/webkit/wkwebpagepreferences/islockdownmodeenabled (iOS 16)
  open var isLockdownModeEnabled: Bool { get { fatalError() } set { fatalError() } }
}

// https://developer.apple.com/documentation/webkit/wknavigationactionpolicy
public enum WKNavigationActionPolicy: Int, Sendable {
  case cancel = 0, allow = 1, download = 2
}

// https://developer.apple.com/documentation/webkit/wknavigationresponsepolicy
public enum WKNavigationResponsePolicy: Int, Sendable {
  case cancel = 0, allow = 1, download = 2
}

// https://developer.apple.com/documentation/webkit/wkmediacapturetype (iOS 15)
public enum WKMediaCaptureType: Int, Sendable {
  case camera = 0, microphone = 1, cameraAndMicrophone = 2
}

// https://developer.apple.com/documentation/webkit/wkpermissiondecision (iOS 15)
public enum WKPermissionDecision: Int, Sendable {
  case prompt = 0, grant = 1, deny = 2
}

// https://developer.apple.com/documentation/webkit/wkdownload (iOS 14.5)
@preconcurrency @MainActor open class WKDownload: NSObject {
  // https://developer.apple.com/documentation/webkit/wkdownload/delegate
  weak open var delegate: (any WKDownloadDelegate)?
  // https://developer.apple.com/documentation/webkit/wkdownload/originalrequest
  open var originalRequest: URLRequest? { fatalError() }
}

// https://developer.apple.com/documentation/webkit/wkscriptmessage
@preconcurrency @MainActor open class WKScriptMessage: NSObject {
  // https://developer.apple.com/documentation/webkit/wkscriptmessage/body
  open var body: Any { fatalError() }
}

// https://developer.apple.com/documentation/webkit/wkscriptmessagehandler
@preconcurrency @MainActor public protocol WKScriptMessageHandler: NSObjectProtocol {
  // https://developer.apple.com/documentation/webkit/wkscriptmessagehandler/usercontentcontroller(_:didreceive:) (required)
  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage)
}

// https://developer.apple.com/documentation/webkit/wknavigationdelegate
// Every method here is `optional` in the SDK, where a wrong signature compiles and is never called.
// The stub lists only the optional methods BadgerWebView implements, and makes them required, so a
// misspelt or mistyped one fails to conform. A new delegate method needs its signature added here.
@preconcurrency @MainActor public protocol WKNavigationDelegate: NSObjectProtocol {
  // https://developer.apple.com/documentation/webkit/wknavigationdelegate/webview(_:decidepolicyfor:preferences:decisionhandler:) (iOS 13)
  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, preferences: WKWebpagePreferences, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy, WKWebpagePreferences) -> Void)
  // https://developer.apple.com/documentation/webkit/wknavigationdelegate/webview(_:decidepolicyfor:decisionhandler:)-19mn2
  func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void)
  // https://developer.apple.com/documentation/webkit/wknavigationdelegate/webview(_:navigationaction:didbecome:) (iOS 14.5)
  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload)
  // https://developer.apple.com/documentation/webkit/wknavigationdelegate/webview(_:navigationresponse:didbecome:) (iOS 14.5)
  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload)
  // https://developer.apple.com/documentation/webkit/wknavigationdelegate/webview(_:didfinish:)
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!)
  // https://developer.apple.com/documentation/webkit/wknavigationdelegate/webview(_:didfailprovisionalnavigation:witherror:)
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error)
  // https://developer.apple.com/documentation/webkit/wknavigationdelegate/webview(_:didfail:witherror:)
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error)
  // https://developer.apple.com/documentation/webkit/wknavigationdelegate/webviewwebcontentprocessdidterminate(_:) (iOS 9)
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView)
}


// https://developer.apple.com/documentation/webkit/wkuidelegate (optional methods made required, as above)
@preconcurrency @MainActor public protocol WKUIDelegate: NSObjectProtocol {
  // https://developer.apple.com/documentation/webkit/wkuidelegate/webview(_:createwebviewwith:for:windowfeatures:)
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView?
  // https://developer.apple.com/documentation/webkit/wkuidelegate/webview(_:requestmediacapturepermissionfor:initiatedbyframe:type:decisionhandler:) (iOS 15)
  func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void)
  // https://developer.apple.com/documentation/webkit/wkuidelegate/webview(_:runjavascriptalertpanelwithmessage:initiatedbyframe:completionhandler:)
  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable () -> Void)
  // https://developer.apple.com/documentation/webkit/wkuidelegate/webview(_:runjavascriptconfirmpanelwithmessage:initiatedbyframe:completionhandler:)
  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (Bool) -> Void)
  // https://developer.apple.com/documentation/webkit/wkuidelegate/webview(_:runjavascripttextinputpanelwithprompt:defaulttext:initiatedbyframe:completionhandler:)
  func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (String?) -> Void)
}


// https://developer.apple.com/documentation/webkit/wkdownloaddelegate (iOS 14.5)
@preconcurrency @MainActor public protocol WKDownloadDelegate: NSObjectProtocol {
  // https://developer.apple.com/documentation/webkit/wkdownloaddelegate/download(_:decidedestinationusing:suggestedfilename:completionhandler:) (required)
  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping @MainActor @Sendable (URL?) -> Void)
  // https://developer.apple.com/documentation/webkit/wkdownloaddelegate/downloaddidfinish(_:) (optional, made required as above)
  func downloadDidFinish(_ download: WKDownload)
  // https://developer.apple.com/documentation/webkit/wkdownloaddelegate/download(_:didfailwitherror:resumedata:) (optional, made required as above)
  func download(_ download: WKDownload, didFailWithError error: any Error, resumeData: Data?)
}

