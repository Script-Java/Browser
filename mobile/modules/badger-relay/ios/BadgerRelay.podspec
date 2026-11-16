Pod::Spec.new do |s|
  s.name           = 'BadgerRelay'
  s.version        = '1.0.0'
  s.summary        = 'The on-device SOCKS5 relay that carries tabs over wisp or straight out'
  s.description    = 'The on-device SOCKS5 relay that carries tabs over wisp or straight out'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '26.0'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Network'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
