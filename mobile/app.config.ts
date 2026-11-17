import type { ExpoConfig } from "expo/config";

// Apple grants these on request (PLAN-5-OF-5.md 6.1, 6.5), and a signed build
// whose App ID lacks them fails. So they're off until Apple says yes.
const browserEntitlements = process.env.BADGER_BROWSER_ENTITLEMENTS === "1";

const config: ExpoConfig = {
	name: "Badger",
	slug: "badger",
	version: "1.0.0",
	orientation: "default",
	icon: "./assets/icon.png",
	userInterfaceStyle: "automatic",
	platforms: ["ios"],
	ios: {
		bundleIdentifier: "com.badgerbrowser.app",
		supportsTablet: true,
		entitlements: browserEntitlements
			? {
					"com.apple.developer.web-browser": true,
					"com.apple.developer.web-browser.public-key-credential": true,
				}
			: {},
		infoPlist: {
			NSCameraUsageDescription: "Sites you allow can use the camera, for video calls.",
			NSMicrophoneUsageDescription: "Sites you allow can use the microphone, for calls.",
			NSFaceIDUsageDescription: "Face ID unlocks your saved data.",
		},
	},
	owner: "atrin",
	extra: { eas: { projectId: "8865b1d7-5785-4851-a2d5-49b36b2ba23f" } },
	plugins: [
		["expo-build-properties", { ios: { deploymentTarget: "26.0" } }],
		["expo-secure-store", { faceIDPermission: "Face ID unlocks your saved data." }],
	],
};

export default config;
