Pod::Spec.new do |s|
  s.name           = 'BadgerWebView'
  s.version        = '1.0.0'
  s.summary        = "Badger's browser tab: one WKWebView per tab"
  s.description    = 'The native tab view for Badger: a WKWebView per tab with per-workspace data stores behind a local SOCKS5 proxy, content blocking, user scripts in their own content world, Lockdown Mode per site, downloads and permission prompts.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '26.0'
  }
  # Swift 5 mode, as Expo's own WKWebView module (@expo/dom-webview): view AsyncFunctions call the view from main-queue closures.
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.frameworks     = 'WebKit', 'Network'

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
