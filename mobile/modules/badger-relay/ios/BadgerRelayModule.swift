import ExpoModulesCore

public class BadgerRelayModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BadgerRelay")

    AsyncFunction("setValueAsync") { (value: String) in
    }
  }
}
