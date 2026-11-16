// Small JSON files in the app's documents: tabs, workspaces, site settings.
import { File, Paths } from "expo-file-system";
import { useEffect, useState } from "react";

/** The saved value, or `fallback` when there's none (or it's unreadable). Objects get the fallback's missing keys. */
export function readJson<T>(name: string, fallback: T): T {
	// the temporary copy, when a write was cut off between its two steps
	for (const file of [new File(Paths.document, name), new File(Paths.document, name + ".tmp")])
		try {
			if (!file.exists) continue;
			const saved = JSON.parse(file.textSync());
			if (Array.isArray(fallback)) return Array.isArray(saved) ? (saved as T) : fallback;
			if (saved && typeof saved === "object" && !Array.isArray(saved)) return { ...fallback, ...saved };
		} catch (err) {
			console.warn(`${name}:`, err);
		}
	return fallback;
}

/** Written whole to a temporary file, then moved over the old one, so a crash mid-write doesn't leave half a file. */
export function writeJson(name: string, value: unknown) {
	try {
		const tmp = new File(Paths.document, name + ".tmp");
		tmp.writeSync(JSON.stringify(value));
		tmp.moveSync(new File(Paths.document, name), { overwrite: true });
	} catch (err) {
		console.warn(`${name}:`, err);
	}
}

/** useState, kept in a JSON file. */
export function usePersisted<T>(name: string, fallback: () => T) {
	const [value, setValue] = useState(() => readJson(name, fallback()));
	useEffect(() => writeJson(name, value), [name, value]);
	return [value, setValue] as const;
}
