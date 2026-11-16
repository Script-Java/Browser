#!/usr/bin/env bash
# Type-checks the iOS modules' Swift on Linux, against stub modules for the Apple frameworks and Expo.
#
# Proves: our code compiles, in Swift 5 mode as the podspecs set, against the declarations in stubs/
# (copied from developer.apple.com and from node_modules/expo-modules-core/ios), with the same
# argument labels, optionals, throws/async, @MainActor/@Sendable/@preconcurrency marks and Expo DSL
# overloads; that each WebKit delegate method we implement has Apple's name and type (the stub makes
# those optional methods required); and runs the relay's pure-Swift self-check.
# Doesn't prove: that the stubs match the real SDK (they're hand-copied, and only cover what we use),
# anything about linking, Objective-C runtime behaviour (@objc selectors, KVO), or runtime behaviour.
#
# Usage: SWIFTC=/path/to/swiftc mobile/modules/linux-check/check.sh
set -euo pipefail

: "${SWIFTC:?set SWIFTC to a swiftc (Swift 6.x for Linux)}"
here="$(cd "$(dirname "$0")" && pwd)"
modules="$(dirname "$here")"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

stub() { # stub <module> [deps...]: a .swiftmodule from stubs/<module>.swift
  "$SWIFTC" -emit-module -parse-as-library -swift-version 5 -module-name "$1" -I "$out" \
    "$here/stubs/$1.swift" -emit-module-path "$out/$1.swiftmodule"
}
for m in AppleFoundationExtras UIKit Security Network CryptoKit WebKit ExpoModulesCore; do stub "$m"; done

status=0
typecheck() { # typecheck <module name> <files...>: one pod is one module; AppleFoundationExtras stands in for Apple's Foundation
  local name=$1; shift
  echo "== $name"
  "$SWIFTC" -typecheck -parse-as-library -swift-version 5 -D DEBUG -module-name "$name" -I "$out" \
    -Xfrontend -import-module -Xfrontend AppleFoundationExtras "$@" || status=1
}
typecheck BadgerWebView "$modules"/badger-webview/ios/*.swift
typecheck BadgerRelay "$modules"/badger-relay/ios/*.swift

echo "== relay self-check"
"$SWIFTC" "$modules/badger-relay/ios/RelayProtocol.swift" "$modules/badger-relay/test/main.swift" -o "$out/relay-test"
"$out/relay-test" || status=1

[ "$status" = 0 ] && echo "== all clean" || echo "== FAILED"
exit "$status"
