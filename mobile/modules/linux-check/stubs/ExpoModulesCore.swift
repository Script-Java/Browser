// ExpoModulesCore 58.1.0 (with the ExpoModulesJSI 58.0.23 protocols it needs): the public declarations
// the modules use, copied from node_modules/expo-modules-core/ios with bodies cut. The generic
// signatures and overload sets of the DSL are kept as they are, since that's where inference fails.
// Paths below are relative to expo-modules-core/ios (or expo-modules-jsi/apple/Sources/ExpoModulesJSI).
@_exported import UIKit
import Dispatch

// MARK: - ExpoModulesJSI (only what conformances need)

// JavaScriptActor.swift
@globalActor public actor JavaScriptActor {
  public static let shared = JavaScriptActor()
}
public final class JavaScriptRuntime {}
public final class JavaScriptValue {}
public final class JavaScriptUnownedValue {}
public final class JavaScriptObject {}
public struct JavaScriptValueKinds: OptionSet, Sendable {
  public let rawValue: Int
  public init(rawValue: Int) { self.rawValue = rawValue }
  public static let all = JavaScriptValueKinds(rawValue: ~0)
}

// Coding/JavaScriptDecodable.swift
public protocol JavaScriptDecodable: ~Copyable {
  @JavaScriptActor
  static func decode(_ value: borrowing JavaScriptValue, in runtime: borrowing JavaScriptRuntime) throws -> Self
  @JavaScriptActor
  static func decode(_ value: borrowing JavaScriptUnownedValue, in runtime: borrowing JavaScriptRuntime) throws -> Self
  static var decodableKinds: JavaScriptValueKinds { get }
}

extension JavaScriptDecodable where Self: ~Copyable {
  @JavaScriptActor
  public static func decode(_ value: borrowing JavaScriptValue, in runtime: borrowing JavaScriptRuntime) throws -> Self { fatalError() }
  @JavaScriptActor
  public static func decode(_ value: borrowing JavaScriptUnownedValue, in runtime: borrowing JavaScriptRuntime) throws -> Self { fatalError() }
  public static var decodableKinds: JavaScriptValueKinds { .all }
}

// Coding/JavaScriptEncodable.swift (encode(_:into:in:) has a default and is left out)
public protocol JavaScriptEncodable: ~Copyable {
  @JavaScriptActor
  static func encode(_ value: consuming Self, in runtime: borrowing JavaScriptRuntime) throws -> JavaScriptValue
}

// Coding/JavaScriptCodable.swift
public typealias JavaScriptCodable = JavaScriptDecodable & JavaScriptEncodable

// Coding/JavaScriptCodable+Primitives.swift
extension String: JavaScriptCodable {
  public static func encode(_ value: consuming String, in runtime: borrowing JavaScriptRuntime) throws -> JavaScriptValue { fatalError() }
}
extension Int: JavaScriptCodable {
  public static func encode(_ value: consuming Int, in runtime: borrowing JavaScriptRuntime) throws -> JavaScriptValue { fatalError() }
}
extension Double: JavaScriptCodable {
  public static func encode(_ value: consuming Double, in runtime: borrowing JavaScriptRuntime) throws -> JavaScriptValue { fatalError() }
}
extension Bool: JavaScriptCodable {
  public static func encode(_ value: consuming Bool, in runtime: borrowing JavaScriptRuntime) throws -> JavaScriptValue { fatalError() }
}

// MARK: - Arguments

// Core/DynamicTypes/AnyDynamicType.swift
public protocol AnyDynamicType {}

// Core/Arguments/AnyArgument.swift
public protocol AnyArgument: ~Copyable {
  nonisolated static func getDynamicType() -> AnyDynamicType
}
extension AnyArgument {
  public static func getDynamicType() -> AnyDynamicType { fatalError() }
}
extension Bool: AnyArgument {}
extension Int: AnyArgument {}
extension Int8: AnyArgument {}
extension Int16: AnyArgument {}
extension Int32: AnyArgument {}
extension Int64: AnyArgument {}
extension UInt: AnyArgument {}
extension UInt8: AnyArgument {}
extension UInt16: AnyArgument {}
extension UInt32: AnyArgument {}
extension UInt64: AnyArgument {}
extension Float32: AnyArgument {}
extension Double: AnyArgument {}
extension CGFloat: AnyArgument {}
extension String: AnyArgument {}
extension Optional: AnyArgument where Wrapped: AnyArgument {}
extension Dictionary: AnyArgument where Key: Hashable {}
extension Array: AnyArgument {}
extension Data: AnyArgument {}
extension JavaScriptValue: AnyArgument {}

// Core/Arguments/Convertible.swift
public protocol Convertible: AnyArgument {
  static func convert(from value: Any?, appContext: AppContext) throws -> Self
  static func convertResult(_ result: Any, appContext: AppContext) throws -> Any
}
extension Convertible {
  public static func convertResult(_ result: Any, appContext: AppContext) throws -> Any { result }
}

// Core/Arguments/Convertibles.swift
extension URL: Convertible {
  public static func convert(from value: Any?, appContext: AppContext) throws -> URL { fatalError() }
}

// Core/Views/ViewDefinition.swift
extension UIView: @MainActor AnyArgument {}

// Core/Arguments/Enumerable.swift
public protocol Enumerable: AnyArgument, CaseIterable, JavaScriptDecodable, JavaScriptEncodable {
  static func create<RawValueType>(fromRawValue rawValue: RawValueType) throws -> Self
  static var allRawValues: [Any] { get }
  static func getRawValueDynamicType() -> AnyDynamicType
  var anyRawValue: Any { get }
}

public extension Enumerable where Self: RawRepresentable, Self: Hashable {
  static func create<ArgType>(fromRawValue rawValue: ArgType) throws -> Self { fatalError() }
  var anyRawValue: Any { rawValue }
  static var allRawValues: [Any] { allCases.map { $0.rawValue } }
  static func getRawValueDynamicType() -> AnyDynamicType { fatalError() }
}

// Core/Coding/JavaScriptCodable+Enumerable.swift
extension Enumerable where Self: RawRepresentable, RawValue: JavaScriptCodable {
  public static var decodableKinds: JavaScriptValueKinds { .all }
  @JavaScriptActor
  public static func decode(_ value: borrowing JavaScriptValue, in runtime: borrowing JavaScriptRuntime) throws -> Self { fatalError() }
  @JavaScriptActor
  public static func decode(_ value: borrowing JavaScriptUnownedValue, in runtime: borrowing JavaScriptRuntime) throws -> Self { fatalError() }
  @JavaScriptActor
  public static func encode(_ value: Self, in runtime: borrowing JavaScriptRuntime) throws -> JavaScriptValue { fatalError() }
}

// MARK: - Records

// Core/Records/Record.swift
public protocol Record: Convertible, JavaScriptDecodable, JavaScriptEncodable {
  typealias Dict = [String: Any]
  nonisolated init()
  init(from: Dict, appContext: AppContext) throws
  @JavaScriptActor
  static func from(object: borrowing JavaScriptObject, appContext: AppContext) throws -> Self
  static func from(dictionary: Dict, appContext: AppContext) throws -> Self
  func toDictionary(appContext: AppContext?) -> Dict
  @JavaScriptActor
  func toObject(appContext: AppContext) throws -> JavaScriptObject
}

public extension Record {
  static func convert(from value: Any?, appContext: AppContext) throws -> Self { fatalError() }
  init(from dict: Dict, appContext: AppContext) throws { fatalError() }
  @JavaScriptActor
  static func from(object: borrowing JavaScriptObject, appContext: AppContext) throws -> Self { fatalError() }
  static func from(dictionary: Dict, appContext: AppContext) throws -> Self { fatalError() }
  func toDictionary(appContext: AppContext? = nil) -> Dict { fatalError() }
  @JavaScriptActor
  func toObject(appContext: AppContext) throws -> JavaScriptObject { fatalError() }
}

// Core/Coding/JavaScriptCodable+Record.swift
extension Record {
  public static var decodableKinds: JavaScriptValueKinds { .all }
  @JavaScriptActor
  public static func decode(_ value: borrowing JavaScriptUnownedValue, in runtime: borrowing JavaScriptRuntime) throws -> Self { fatalError() }
  @JavaScriptActor
  public static func encode(_ value: Self, in runtime: borrowing JavaScriptRuntime) throws -> JavaScriptValue { fatalError() }
}

// Core/Records/FieldOption.swift
public struct FieldOption: Equatable, Hashable, ExpressibleByIntegerLiteral, ExpressibleByStringLiteral, Sendable {
  public let rawValue: Int
  public let key: String?
  public init(_ rawValue: Int, key: String? = nil) { fatalError() }
  public init(integerLiteral value: Int) { fatalError() }
  public init(stringLiteral value: String) { fatalError() }
}

// Core/Records/Field.swift
@propertyWrapper
public final class Field<Type: AnyArgument>: @unchecked Sendable {
  public var wrappedValue: Type
  public init(wrappedValue: Type, _ options: FieldOption...) { fatalError() }
  public init(wrappedValue: Type, _ options: [FieldOption]) { fatalError() }
  public init(wrappedValue: Type = nil) where Type: ExpressibleByNilLiteral { fatalError() }
  public init(wrappedValue: Type = nil, _ options: FieldOption...) where Type: ExpressibleByNilLiteral { fatalError() }
  public func get() -> Any { fatalError() }
}

// MARK: - Exceptions

// Core/Exceptions/CodedError.swift
public protocol CodedError: Error, CustomStringConvertible {
  var code: String { get }
  var description: String { get }
}

// Core/Exceptions/ChainableException.swift
public protocol ChainableException: Error, AnyObject {
  var cause: Error? { get set }
}

// Core/Exceptions/Exception.swift (JavaScriptThrowable left out)
open class Exception: CodedError, ChainableException, CustomStringConvertible, CustomDebugStringConvertible, @unchecked Sendable {
  open lazy var name: String = String(describing: Self.self)
  open var reason: String { fatalError() }
  public init(file: String = #fileID, line: UInt = #line, function: String = #function) { fatalError() }
  public init(name: String, description: String, code: String? = nil, file: String = #fileID, line: UInt = #line, function: String = #function) { fatalError() }
  open var code: String { fatalError() }
  open var cause: Error?
  open var description: String { fatalError() } // `open lazy var` in Expo
  open var debugDescription: String { fatalError() }
  open var message: String { fatalError() }
}

// MARK: - App context, utilities, promises, events

// Utilities/Utilities.swift
public struct Utilities {
  public static func urlFrom(string: String) -> URL? { fatalError() }
  @MainActor
  public static func keyWindow() -> UIWindow? { fatalError() }
  nonisolated public func currentViewController() -> UIViewController? { fatalError() }
}

// Core/AppContext.swift (EXAppContextProtocol, an ObjC protocol, left out)
public class AppContext: NSObject, @unchecked Sendable {
  public var utilities: Utilities? = Utilities()
}

// Core/Promise.swift (legacyResolver/legacyRejecter, ObjC block types, left out)
public struct Promise: AnyArgument, Sendable {
  public typealias ResolveClosure = @Sendable (_ value: consuming JavaScriptValue) -> Void
  public typealias RejectClosure = @Sendable (Exception) -> Void

  public var resolver: ResolveClosure
  public var rejecter: RejectClosure

  public func resolve(_ value: Any? = nil) { fatalError() }
  public func resolve<T: AnyArgument>(_ value: sending T) { fatalError() }
  public func resolve(_ value: Any, dynamicType: AnyDynamicType) { fatalError() }
  public func reject(_ error: Error) { fatalError() }
  public func reject(_ error: Exception) { fatalError() }
  public func reject(_ code: String, _ description: String) { fatalError() }
  public func settle<ValueType, ExceptionType: Exception>(with result: Result<ValueType, ExceptionType>) { fatalError() }
}

// Core/Events/EventDispatcher.swift
public final class EventDispatcher {
  public var onEventSent: (([String: Any]) -> Void)?
  public init(_ customName: String? = nil) {}
  public func callAsFunction(_ payload: [String: Any]) { fatalError() }
  public func callAsFunction(_ payload: any Record) { fatalError() }
  public func callAsFunction() { fatalError() }
}

// MARK: - Modules

// Core/Protocols/AnyDefinition.swift
public protocol AnyDefinition: ~Copyable {
  var _definitionClassification: DefinitionClassification { get }
}
extension AnyDefinition where Self: ~Copyable {
  public var _definitionClassification: DefinitionClassification { fatalError() }
}
public struct DefinitionClassification {}

// Core/Objects/ObjectDefinition.swift (JavaScriptObjectBuilder left out)
public class ObjectDefinition: AnyDefinition {
  init(definitions: [AnyDefinition]) {}
}

// Core/Modules/ModuleDefinition.swift
public final class ModuleDefinition: ObjectDefinition {}
public struct EventsDefinition: AnyDefinition {
  let names: [String]
}

// Core/Modules/ModuleDefinitionBuilder.swift
@resultBuilder
public struct ModuleDefinitionBuilder {
  public static func buildBlock(_ definitions: AnyDefinition...) -> ModuleDefinition { fatalError() }
}

// Core/Protocols/AnyModule.swift (_classTypes and _decorateModule, both defaulted, left out)
public protocol AnyModule: AnyObject, AnyArgument {
  init(appContext: AppContext)
  @ModuleDefinitionBuilder
  func definition() -> ModuleDefinition
  static var _jsName: String { get }
  func _synthesizedDefinition() -> [AnyDefinition]
  func didCreate()
  func willDestroy()
  func didStartListening(event: String)
  func didStopListening(event: String)
}

extension AnyModule {
  public static var _jsName: String { fatalError() }
  @ModuleDefinitionBuilder
  public func definition() -> ModuleDefinition {}
  public func _synthesizedDefinition() -> [AnyDefinition] { [] }
  public func didCreate() {}
  public func willDestroy() {}
  public func didStartListening(event: String) {}
  public func didStopListening(event: String) {}
}

// Core/Modules/Module.swift
open class BaseModule {
  public private(set) weak var appContext: AppContext?
  @available(*, unavailable, message: "Module's initializer cannot be overridden, override the \"didCreate\" lifecycle hook instead.")
  public init() {}
  required public init(appContext: AppContext) {}
  public func sendEvent(_ eventName: String, _ body: [String: Any?] = [:]) { fatalError() }
  open func didCreate() {}
  open func willDestroy() {}
  open func didStartListening(event: String) {}
  open func didStopListening(event: String) {}
}
public typealias Module = AnyModule & BaseModule

// MARK: - Functions

// Core/Functions/AnyFunctionDefinition.swift
internal protocol AnyFunctionDefinition: AnyDefinition {
  var takesOwner: Bool { get set }
}

// Core/Functions/AsyncFunctionDefinition.swift
internal protocol AnyAsyncFunctionDefinition: AnyFunctionDefinition {
  @discardableResult
  func runOnQueue(_ queue: DispatchQueue?) -> Self
}
public class AsyncFunctionDefinition<Args, FirstArgType, ReturnType>: AnyAsyncFunctionDefinition, @unchecked Sendable {
  var takesOwner: Bool = false
  public func runOnQueue(_ queue: DispatchQueue?) -> Self { fatalError() }
}

// Core/Functions/ConcurrentFunctionDefinition.swift
internal protocol AnyConcurrentFunctionDefinition: AnyFunctionDefinition {
  var requiresMainActor: Bool { get set }
}
public class ConcurrentFunctionDefinition<Args, FirstArgType, ReturnType>: AnyConcurrentFunctionDefinition, @unchecked Sendable {
  var takesOwner: Bool = false
  var requiresMainActor: Bool = false
}

// Core/Functions/SyncFunctionDefinition.swift
public class SyncFunctionDefinition<Args, FirstArgType, ReturnType>: AnyFunctionDefinition, @unchecked Sendable {
  var takesOwner: Bool = false
}

// Core/Functions/OptimizedAsyncFunctionDefinition.swift, OptimizedSyncFunctionDefinition.swift
public struct OptimizedFunctionDescriptor {}
public final class OptimizedAsyncFunctionDefinition: AnyAsyncFunctionDefinition, @unchecked Sendable {
  var takesOwner: Bool = false
  public func runOnQueue(_ queue: DispatchQueue?) -> Self { fatalError() }
}
public final class OptimizedSyncFunctionDefinition: AnyFunctionDefinition, @unchecked Sendable {
  var takesOwner: Bool = false
}

// Api/Factories/AsyncFunctionFactories.swift
public func AsyncFunction(
  _ name: String,
  _ descriptor: OptimizedFunctionDescriptor
) -> OptimizedAsyncFunctionDefinition { fatalError() }

public func AsyncFunction<R>(
  _ name: String,
  @_implicitSelfCapture _ closure: @escaping () throws -> R
) -> AsyncFunctionDefinition<(), Void, R> { fatalError() }

public func AsyncFunction<R, A0: AnyArgument, each A: AnyArgument>(
  _ name: String,
  @_implicitSelfCapture _ closure: @escaping (A0, repeat each A) throws -> R
) -> AsyncFunctionDefinition<(A0, repeat each A), A0, R> { fatalError() }

// Api/Factories/ConcurrentFunctionFactories.swift
public func AsyncFunction<R>(
  _ name: String,
  @_inheritActorContext @_implicitSelfCapture _ closure: sending @escaping @Sendable () async throws -> sending R
) -> ConcurrentFunctionDefinition<(), Void, R> { fatalError() }

public func AsyncFunction<R, A0: AnyArgument, each A: AnyArgument>(
  _ name: String,
  @_inheritActorContext @_implicitSelfCapture _ closure: sending @escaping @Sendable (A0, repeat each A) async throws -> sending R
) -> ConcurrentFunctionDefinition<(A0, repeat each A), A0, R> { fatalError() }

// Api/Factories/SyncFunctionFactories.swift
public func Function(
  _ name: String,
  _ descriptor: OptimizedFunctionDescriptor
) -> OptimizedSyncFunctionDefinition { fatalError() }

public func Function<R>(
  _ name: String,
  @_implicitSelfCapture _ closure: @escaping () throws -> R
) -> SyncFunctionDefinition<(), Void, R> { fatalError() }

public func Function<R, A0: AnyArgument, each A: AnyArgument>(
  _ name: String,
  @_implicitSelfCapture _ closure: @escaping (A0, repeat each A) throws -> R
) -> SyncFunctionDefinition<(A0, repeat each A), A0, R> { fatalError() }

// Api/Factories/ModuleFactories.swift
public func Name(_ name: String) -> AnyDefinition { fatalError() }

// Api/Factories/ObjectFactories.swift
public func Events(_ names: String...) -> EventsDefinition { fatalError() }
public func Events(_ names: [String]) -> EventsDefinition { fatalError() }

// Api/Factories/EventListenersFactories.swift
public func OnDestroy(@_implicitSelfCapture _ closure: @escaping () -> Void) -> AnyDefinition { fatalError() }

// MARK: - Views

// Core/Protocols/AnyExpoView.swift
public protocol AnyExpoView: UIView {
  var appContext: AppContext? { get }
  init(appContext: AppContext?)
  func updateProps(_ rawProps: [String: Any])
  func supportsProp(withName name: String) -> Bool
}

// Fabric/ExpoFabricViewObjC.h: an Objective-C UIView subclass (via RCTViewComponentView), so preconcurrency
@preconcurrency @MainActor open class ExpoFabricViewObjC: UIView {
  open func updateProps(_ props: [String: Any]) { fatalError() }
  open func viewDidUpdateProps() { fatalError() }
  open func supportsProp(withName name: String) -> Bool { fatalError() }
}

// Fabric/ExpoFabricView.swift
open class ExpoFabricView: ExpoFabricViewObjC, AnyExpoView {
  public weak var appContext: AppContext?
  public init() { fatalError() }
  public override init(frame: CGRect) { fatalError() }
  required public init(appContext: AppContext? = nil) { fatalError() }
  public required init?(coder: NSCoder) { fatalError() }
  public override func updateProps(_ props: [String: Any]) { fatalError() }
  public override func viewDidUpdateProps() { fatalError() }
  public override func supportsProp(withName name: String) -> Bool { fatalError() }
}

// Core/Views/ExpoView.swift
public typealias ExpoView = ExpoFabricView

// Core/Protocols/AnyViewDefinition.swift
public protocol AnyViewDefinition: Sendable {}

// Core/Views/ViewDefinition.swift
public class ViewDefinition<ViewType>: ObjectDefinition, AnyViewDefinition, @unchecked Sendable {}
public protocol AnyViewDefinitionElement: AnyDefinition {}
public protocol ViewDefinitionFunctionElement: AnyViewDefinitionElement {
  associatedtype ViewType
}
extension AsyncFunctionDefinition: ViewDefinitionFunctionElement {
  public typealias ViewType = FirstArgType
}
extension ConcurrentFunctionDefinition: ViewDefinitionFunctionElement {
  public typealias ViewType = FirstArgType
}
public struct ViewNameDefinition: AnyViewDefinitionElement {}

// Core/Views/AnyViewProp.swift
public protocol AnyViewProp: AnyViewDefinitionElement {}

// Core/Views/ConcreteViewProp.swift
public final class ConcreteViewProp<ViewType: UIView, PropType: AnyArgument>: AnyViewProp, @unchecked Sendable {}

// Core/Views/ViewLifecycleMethod.swift
public final class ViewLifecycleMethod<ViewType>: AnyDefinition {
  public typealias Closure = @MainActor (ViewType) -> Void
}
extension ConcreteViewProp: AnyViewDefinitionElement {}
extension EventsDefinition: AnyViewDefinitionElement {}
extension ViewLifecycleMethod: AnyViewDefinitionElement {}

// Api/Builders/ViewDefinitionBuilder.swift
@resultBuilder
public struct ViewDefinitionBuilder<ViewType: UIView> {
  public static func buildBlock(_ elements: AnyViewDefinitionElement...) -> [AnyViewDefinitionElement] { elements }
  public static func buildExpression(_ element: EventsDefinition) -> AnyViewDefinitionElement { element }
  public static func buildExpression(_ element: ViewNameDefinition) -> AnyViewDefinitionElement { element }
  public static func buildExpression<PropType: AnyArgument>(_ element: ConcreteViewProp<ViewType, PropType>) -> AnyViewDefinitionElement { element }
  public static func buildExpression(_ element: ViewLifecycleMethod<ViewType>) -> AnyViewDefinitionElement { element }
  public static func buildExpression<ElementType: ViewDefinitionFunctionElement>(
    _ element: ElementType
  ) -> AnyViewDefinitionElement { element }
  public static func buildExpression<ElementType: ViewDefinitionFunctionElement>(
    _ element: ElementType
  ) -> AnyViewDefinitionElement where ElementType.ViewType == ViewType { element }
}

// Core/Views/SwiftUI/*: kept for the View(...) overload set. SwiftUI isn't on Linux, so
// ExpoSwiftUIView drops its SwiftUI.View and AnyChild refinements and ViewProps its ObservableObject.
public struct ExpoSwiftUI {}
public protocol ExpoSwiftUIView<Props>: AnyArgument {
  associatedtype Props: ExpoSwiftUI.ViewProps
  var props: Props { get }
  init(props: Props)
}
extension ExpoSwiftUI {
  open class ViewProps: Record {
    public required init() {}
  }
  public typealias View = ExpoSwiftUIView
  public typealias ViewDefinition = SwiftUIViewDefinition
  public final class SwiftUIViewDefinition<Props: ExpoSwiftUI.ViewProps, ViewType: ExpoSwiftUI.View<Props>>: ExpoModulesCore.ViewDefinition<ViewType>, @unchecked Sendable {}

  @resultBuilder
  public struct ViewDefinitionBuilder<ViewType: ExpoSwiftUI.View> {
    public static func buildBlock(_ elements: AnyViewDefinitionElement...) -> [AnyViewDefinitionElement] { elements }
    public static func buildExpression(_ element: ViewNameDefinition) -> AnyViewDefinitionElement { element }
    public static func buildExpression<ElementType: ViewDefinitionFunctionElement>(
      _ element: ElementType
    ) -> AnyViewDefinitionElement { element }
    public static func buildExpression<ElementType: ViewDefinitionFunctionElement>(
      _ element: ElementType
    ) -> AnyViewDefinitionElement where ElementType.ViewType == ViewType { element }
  }
}

// Api/Factories/ViewFactories.swift
public func View<ViewType: UIView>(
  _ viewType: ViewType.Type,
  @ViewDefinitionBuilder<ViewType> _ elements: @escaping () -> [AnyViewDefinitionElement]
) -> ViewDefinition<ViewType> { fatalError() }

public func View<Props: ExpoSwiftUI.ViewProps, ViewType: ExpoSwiftUI.View>(
  _ viewType: ViewType.Type
) -> ExpoSwiftUI.ViewDefinition<Props, ViewType> { fatalError() }

public func View<Props: ExpoSwiftUI.ViewProps, ViewType: ExpoSwiftUI.View>(
  _ viewType: ViewType.Type,
  @ExpoSwiftUI.ViewDefinitionBuilder<ViewType> _ elements: @escaping () -> [AnyViewDefinitionElement]
) -> ExpoSwiftUI.ViewDefinition<Props, ViewType> { fatalError() }

public func Prop<ViewType: UIView, PropType: AnyArgument>(
  _ name: String,
  @_implicitSelfCapture _ setter: @escaping @MainActor (ViewType, PropType) -> Void
) -> ConcreteViewProp<ViewType, PropType> { fatalError() }

public func Prop<ViewType: UIView, PropType: AnyArgument>(
  _ name: String,
  _ defaultValue: PropType,
  @_implicitSelfCapture _ setter: @escaping @MainActor (ViewType, PropType) -> Void
) -> ConcreteViewProp<ViewType, PropType> { fatalError() }

public func OnViewDidUpdateProps<ViewType: UIView>(
  @_implicitSelfCapture _ closure: @escaping @MainActor (_ view: ViewType) -> Void
) -> ViewLifecycleMethod<ViewType> { fatalError() }

public func ViewName(_ name: String) -> ViewNameDefinition { fatalError() }
