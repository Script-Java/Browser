// For `pnpm test`: resolves the app's extensionless imports (./sites, ./scripts)
// to their .ts files, as Metro and TypeScript do.
import { registerHooks } from "node:module";

const RETRY = new Set(["ERR_MODULE_NOT_FOUND", "ERR_UNSUPPORTED_DIR_IMPORT"]);

registerHooks({
	resolve(specifier, context, next) {
		try {
			return next(specifier, context);
		} catch (err) {
			if (!RETRY.has(err?.code) || !/^\.\.?\//.test(specifier)) throw err;
			for (const ending of [".ts", ".tsx", "/index.ts"])
				try {
					return next(specifier + ending, context);
				} catch {
					// the next one
				}
			throw err;
		}
	},
});
