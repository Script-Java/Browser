import ExpoModulesCore

public class BadgerWebViewModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BadgerWebView")

    Events("onChange")

    AsyncFunction("setValueAsync") { (value: String) in
      self.sendEvent("onChange", [
        "value": value
      ])
    }

    View(BadgerWebView.self) {
      Events("onTap")
    }
  }
}
