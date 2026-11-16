// The look-alike check is the old app's own (../app/src/sw/lookalike.js): pure,
// with tldts its only import. That import resolves to this app's tldts, since
// ../app/node_modules isn't installed in builds.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const config = getDefaultConfig(__dirname);
const shared = path.resolve(__dirname, "../app/src/sw");

config.watchFolders = [...config.watchFolders, shared];
config.resolver.resolveRequest = (context, name, platform) =>
	context.resolveRequest(
		context.originModulePath.startsWith(shared + path.sep) && !name.startsWith(".")
			? { ...context, originModulePath: path.join(__dirname, "index.ts") }
			: context,
		name,
		platform
	);

module.exports = config;
