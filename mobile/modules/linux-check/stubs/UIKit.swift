// UIKit, only what the modules and the ExpoModulesCore stub touch. Signatures from developer.apple.com
// (append ".md" to fetch). UIKit is Objective-C: Swift treats imported C/ObjC declarations as
// @preconcurrency, so each @MainActor here is `@preconcurrency @MainActor` to match how Swift 5 mode
// checks calls into the real SDK. CGRect and NSCoder come from Linux's Foundation.
@_exported import AppleFoundationExtras

// https://developer.apple.com/documentation/uikit/uiresponder
@preconcurrency @MainActor open class UIResponder: NSObject {}

// https://developer.apple.com/documentation/uikit/uiview
@preconcurrency @MainActor open class UIView: UIResponder {
  // https://developer.apple.com/documentation/uikit/uiview/init(frame:)
  public init(frame: CGRect) { fatalError() }
  // https://developer.apple.com/documentation/uikit/uiview/init(coder:) (required: NSCoding)
  public required init?(coder: NSCoder) { fatalError() }
  // https://developer.apple.com/documentation/uikit/uiview/bounds
  open var bounds: CGRect { get { fatalError() } set { fatalError() } }
  // https://developer.apple.com/documentation/uikit/uiview/frame
  open var frame: CGRect { get { fatalError() } set { fatalError() } }
  // https://developer.apple.com/documentation/uikit/uiview/addsubview(_:)
  open func addSubview(_ view: UIView) { fatalError() }
  // https://developer.apple.com/documentation/uikit/uiview/removefromsuperview()
  open func removeFromSuperview() { fatalError() }
  // https://developer.apple.com/documentation/uikit/uiview/autoresizingmask-swift.property
  open var autoresizingMask: UIView.AutoresizingMask { get { fatalError() } set { fatalError() } }
  // https://developer.apple.com/documentation/uikit/uiview/window
  open var window: UIWindow? { fatalError() }

  // https://developer.apple.com/documentation/uikit/uiview/autoresizingmask-swift.struct
  public struct AutoresizingMask: OptionSet, Sendable {
    public let rawValue: UInt
    public init(rawValue: UInt) { self.rawValue = rawValue }
    public static let flexibleLeftMargin = AutoresizingMask(rawValue: 1 << 0)
    public static let flexibleWidth = AutoresizingMask(rawValue: 1 << 1)
    public static let flexibleRightMargin = AutoresizingMask(rawValue: 1 << 2)
    public static let flexibleTopMargin = AutoresizingMask(rawValue: 1 << 3)
    public static let flexibleHeight = AutoresizingMask(rawValue: 1 << 4)
    public static let flexibleBottomMargin = AutoresizingMask(rawValue: 1 << 5)
  }
}

// https://developer.apple.com/documentation/uikit/uiwindow
@preconcurrency @MainActor open class UIWindow: UIView {}

// https://developer.apple.com/documentation/uikit/uiviewcontroller
@preconcurrency @MainActor open class UIViewController: UIResponder {
  // https://developer.apple.com/documentation/uikit/uiviewcontroller/present(_:animated:completion:)
  open func present(_ viewControllerToPresent: UIViewController, animated flag: Bool, completion: (() -> Void)? = nil) { fatalError() }
}

// https://developer.apple.com/documentation/uikit/uialertcontroller
@preconcurrency @MainActor open class UIAlertController: UIViewController {
  // https://developer.apple.com/documentation/uikit/uialertcontroller/style
  public enum Style: Int, Sendable {
    case actionSheet = 0, alert = 1
  }
  // https://developer.apple.com/documentation/uikit/uialertcontroller/init(title:message:preferredstyle:)
  public convenience init(title: String?, message: String?, preferredStyle: UIAlertController.Style) { fatalError() }
  // https://developer.apple.com/documentation/uikit/uialertcontroller/addaction(_:)
  open func addAction(_ action: UIAlertAction) { fatalError() }
  // https://developer.apple.com/documentation/uikit/uialertcontroller/addtextfield(configurationhandler:)
  open func addTextField(configurationHandler: ((UITextField) -> Void)? = nil) { fatalError() }
  // https://developer.apple.com/documentation/uikit/uialertcontroller/textfields
  open var textFields: [UITextField]? { fatalError() }
}

// https://developer.apple.com/documentation/uikit/uialertaction
@preconcurrency @MainActor open class UIAlertAction: NSObject {
  // https://developer.apple.com/documentation/uikit/uialertaction/style-swift.enum
  public enum Style: Int, Sendable {
    case `default` = 0, cancel = 1, destructive = 2
  }
  // https://developer.apple.com/documentation/uikit/uialertaction/init(title:style:handler:)
  public convenience init(title: String?, style: UIAlertAction.Style, handler: ((UIAlertAction) -> Void)? = nil) { fatalError() }
}

// https://developer.apple.com/documentation/uikit/uitextfield (a UIControl, which is a UIView)
@preconcurrency @MainActor open class UITextField: UIView {
  // https://developer.apple.com/documentation/uikit/uitextfield/text
  open var text: String? { get { fatalError() } set { fatalError() } }
}

// https://developer.apple.com/documentation/uikit/uifindinteraction (iOS 16)
@preconcurrency @MainActor open class UIFindInteraction: NSObject {
  // https://developer.apple.com/documentation/uikit/uifindinteraction/presentfindnavigator(showingreplace:)
  open func presentFindNavigator(showingReplace: Bool) { fatalError() }
}
