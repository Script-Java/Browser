// The server's block lists, compiled into WebKit's content rules: at start,
// then once a day. WebKit keeps compiled lists across launches, so blocking
// works before the server answers.
import { useEffect, useState } from "react";
import { AppState } from "react-native";

import BadgerWebViewModule from "../modules/badger-webview";
import type { Session } from "./server/types";
import { readJson, writeJson } from "./storage";

const FILE = "rules.json";
const DAY = 24 * 60 * 60 * 1000;

type Saved = { version: string; ids: string[] };

/** The ids of the compiled lists, for tabs whose site has blocking on. */
export function useContentRules(session: Session): string[] {
	const [ids, setIds] = useState(() => readJson<Saved>(FILE, { version: "", ids: [] }).ids);

	useEffect(() => {
		let checked = 0;
		const update = async () => {
			if (Date.now() - checked < DAY) return;
			checked = Date.now();
			try {
				const saved = readJson<Saved>(FILE, { version: "", ids: [] });
				const compiled = await BadgerWebViewModule.contentRuleIds();
				// with every list still compiled, the server sends lists only when they changed
				const since = saved.ids.every((id) => compiled.includes(id)) ? saved.version : undefined;
				const { version, lists } = await session.contentRules(since);
				if (!lists.length) return setIds(saved.ids);
				const next = lists.map((list) => list.id);
				for (const list of lists) await BadgerWebViewModule.compileContentRules(list.id, list.json);
				for (const id of compiled) if (!next.includes(id)) await BadgerWebViewModule.removeContentRules(id);
				writeJson(FILE, { version, ids: next });
				setIds(next);
			} catch (err) {
				checked = 0; // again at the next chance
				console.warn("content rules:", err);
			}
		};
		update();
		const hourly = setInterval(update, 60 * 60 * 1000);
		const foreground = AppState.addEventListener("change", (state) => state === "active" && update());
		return () => {
			clearInterval(hourly);
			foreground.remove();
		};
	}, [session]);

	return ids;
}
