// The browser: address bar, the tabs, the toolbar, and the sheets over them.
import { randomUUID } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { type ComponentRef, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { ActionSheetIOS, Share, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import BadgerWebViewModule, { type BadgerWebViewRef, type Download, type NavigationState } from "../../modules/badger-webview";
import { addressFor, hostOf } from "../address";
import type { Relay } from "../relay/types";
import { useContentRules } from "../rules";
import type { Session } from "../server/types";
import { DEFAULT_SETTINGS, effective, type Settings, type SiteSettings, type Sites, siteOf } from "../sites";
import { readJson, usePersisted, writeJson } from "../storage";
import { DownloadsSheet } from "./DownloadsSheet";
import { SERVER_KEY } from "./FirstRun";
import { colors, IconButton, useAfterRender } from "./kit";
import { SettingsSheet } from "./SettingsSheet";
import { ShieldSheet } from "./ShieldSheet";
import { Tab, type TabInfo } from "./Tab";
import { TabsSheet, type Workspace } from "./TabsSheet";

// shortcut: three web views stay alive and the rest reopen at their address, without their back and forward history; keep more, or save WKWebView's interactionState, if people miss it
const MOUNTED = 3;
// private tabs' cookies and storage: one store, new each launch
const PRIVATE_STORE = randomUUID();

type SavedTabs = { tabs: TabInfo[]; active: string | null; workspace: string };

export function Browser({ session, relay, onSignOut }: { session: Session; relay: Relay; onSignOut: () => void }) {
	const insets = useSafeAreaInsets();
	const [settings, setSettings] = usePersisted<Settings>("settings.json", () => DEFAULT_SETTINGS);
	const [sites, setSites] = usePersisted<Sites>("sites.json", () => ({}));
	const [workspaces, setWorkspaces] = usePersisted<Workspace[]>("workspaces.json", () => [{ id: randomUUID(), name: "Personal" }]);
	const [saved] = useState(() => readJson<SavedTabs>("tabs.json", { tabs: [], active: null, workspace: "" }));
	const [tabs, setTabs] = useState(() => saved.tabs.filter((t) => workspaces.some((w) => w.id === t.workspace)));
	const [workspace, setWorkspace] = useState(() => (workspaces.some((w) => w.id === saved.workspace) ? saved.workspace : workspaces[0].id));
	// a private tab isn't saved: then the workspace's last one
	const [active, setActive] = useState(() => (tabs.some((t) => t.id === saved.active) ? saved.active : (tabs.findLast((t) => t.workspace === workspace)?.id ?? null)));
	// most recent first; the first MOUNTED keep their web views
	const [recent, setRecent] = useState<string[]>(() => (active ? [active] : []));
	const [navs, setNavs] = useState<Record<string, NavigationState>>({});
	const [downloads, setDownloads] = useState<Download[]>([]);
	const [sheet, setSheet] = useState<"tabs" | "shield" | "settings" | "downloads" | null>(null);
	const [typed, setTyped] = useState<string | null>(null);
	const [views] = useState(() => new Map<string, RefObject<BadgerWebViewRef | null>>());
	const later = useAfterRender();
	const addressBar = useRef<ComponentRef<typeof TextInput>>(null);
	const shieldChanged = useRef(false);
	const rules = useContentRules(session);

	const current = tabs.find((t) => t.id === active && t.workspace === workspace) ?? null;
	const nav = current ? navs[current.id] : undefined;
	const view = () => (current ? views.get(current.id)?.current : null);
	const shown = recent.slice(0, MOUNTED).flatMap((id) => tabs.filter((t) => t.id === id && t.url));

	useEffect(() => writeJson("tabs.json", { tabs: tabs.filter((t) => !t.private), active, workspace }), [tabs, active, workspace]);

	// the relay learns the sites' own routes once; changes go through changeSite
	useEffect(() => {
		for (const [site, s] of Object.entries(sites)) if (s.route) relay.setRoute(site, s.route);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [relay]);

	// a new tab opens with the address bar ready
	useEffect(() => {
		if (current && !current.url) addressBar.current?.focus();
	}, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

	const select = (id: string | null) => {
		setActive(id);
		if (id) setRecent((r) => [id, ...r.filter((x) => x !== id)]);
	};

	const newTab = (isPrivate: boolean, url = "", inWorkspace = workspace) => {
		const tab: TabInfo = { id: randomUUID(), url, title: "", workspace: inWorkspace, ...(isPrivate && { private: true }) };
		setTabs((all) => [...all, tab]);
		setWorkspace(inWorkspace);
		select(tab.id);
		setSheet(null);
	};

	const lastIn = (id: string, without?: string) =>
		recent.find((x) => x !== without && tabs.some((t) => t.id === x && t.workspace === id)) ?? tabs.findLast((t) => t.workspace === id && t.id !== without)?.id ?? null;

	const closeTab = (id: string) => {
		setTabs((all) => all.filter((t) => t.id !== id));
		setRecent((r) => r.filter((x) => x !== id));
		setNavs(({ [id]: _, ...rest }) => rest);
		if (id === active) select(lastIn(workspace, id));
	};

	const switchWorkspace = (id: string) => {
		setWorkspace(id);
		select(lastIn(id));
	};

	const removeWorkspace = (id: string) => {
		const gone = new Set(tabs.filter((t) => t.workspace === id).map((t) => t.id));
		setTabs((all) => all.filter((t) => !gone.has(t.id)));
		setRecent((r) => r.filter((x) => !gone.has(x)));
		setWorkspaces((all) => all.filter((w) => w.id !== id));
		if (workspace === id) {
			setWorkspace(workspaces[0].id);
			select(recent.find((x) => tabs.some((t) => t.id === x && t.workspace === workspaces[0].id)) ?? null);
		}
		// its store goes once its tabs' views have
		later(() => BadgerWebViewModule.removeStore(id).catch((err) => console.warn("workspace:", err)));
	};

	const go = (input: string) => {
		setTyped(null);
		if (!input.trim()) return;
		const url = addressFor(input, settings.search);
		const open = view();
		if (open) open.load(url);
		else if (current) setTabs((all) => all.map((t) => (t.id === current.id ? { ...t, url } : t)));
		else newTab(false, url);
	};

	const onState = useCallback((id: string, state: NavigationState) => {
		setNavs((all) => ({ ...all, [id]: state }));
		setTabs((all) => {
			const tab = all.find((t) => t.id === id);
			if (!tab || !state.url || (tab.url === state.url && tab.title === state.title)) return all;
			return all.map((t) => (t === tab ? { ...t, url: state.url, title: state.title } : t));
		});
	}, []);

	const changeSite = useCallback(
		(site: string, change: SiteSettings) => {
			// before the reload that follows, so its connections take the new route
			if (change.route) relay.setRoute(site, change.route);
			setSites((all) => ({ ...all, [site]: { ...all[site], ...change } }));
		},
		[relay, setSites]
	);

	const onOpenWindow = useCallback((url: string, opener: TabInfo) => newTab(!!opener.private, url, opener.workspace), []); // eslint-disable-line react-hooks/exhaustive-deps
	const onDownload = useCallback(
		(d: Download) => setDownloads((all) => (all.some((x) => x.id === d.id) ? all.map((x) => (x.id === d.id ? d : x)) : [d, ...all])),
		[]
	);

	const signOut = async () => {
		await session.signOut().catch((err) => console.warn("sign out:", err));
		await relay.close().catch((err) => console.warn("relay:", err));
		await SecureStore.deleteItemAsync(SERVER_KEY);
		onSignOut();
	};

	const menu = () => {
		const items: [string, () => void][] = [
			["New tab", () => newTab(false)],
			["New private tab", () => newTab(true)],
			["Find in page", () => view()?.find()],
			["Downloads", () => setSheet("downloads")],
			["Settings", () => setSheet("settings")],
			...(current ? [["Close tab", () => closeTab(current.id)] as [string, () => void]] : []),
		];
		ActionSheetIOS.showActionSheetWithOptions({ options: [...items.map(([name]) => name), "Cancel"], cancelButtonIndex: items.length }, (i) => items[i]?.[1]());
	};

	const site = siteOf(nav?.url || current?.url || "");
	const shield = effective(site ? sites[site] : undefined, settings.level);
	const workspaceTabs = tabs.filter((t) => t.workspace === workspace).length;

	return (
		<View style={[styles.page, { paddingTop: insets.top }]}>
			<View style={styles.bar}>
				<IconButton
					icon={nav && !nav.secure && nav.url.startsWith("http:") ? "exclamationmark.triangle" : "shield.lefthalf.filled"}
					label="Site protection"
					onPress={() => setSheet("shield")}
				/>
				<TextInput
					ref={addressBar}
					style={styles.address}
					value={typed ?? (nav?.url || current?.url ? hostOf(nav?.url || current!.url) : "")}
					placeholder={current?.private ? "Private: search or type a URL" : "Search or type a URL"}
					placeholderTextColor={colors.muted}
					accessibilityLabel="Address"
					autoCapitalize="none"
					autoCorrect={false}
					keyboardType="web-search"
					returnKeyType="go"
					selectTextOnFocus
					clearButtonMode="while-editing"
					onFocus={() => setTyped(nav?.url || current?.url || "")}
					onBlur={() => setTyped(null)}
					onChangeText={setTyped}
					onSubmitEditing={({ nativeEvent }) => go(nativeEvent.text)}
				/>
				{nav?.loading ? (
					<IconButton icon="xmark" label="Stop" onPress={() => view()?.stop()} />
				) : (
					<IconButton icon="arrow.clockwise" label="Reload" disabled={!nav} onPress={() => view()?.reload()} />
				)}
			</View>
			<View style={styles.progressTrack}>
				{nav?.loading ? <View style={[styles.progress, { width: `${Math.max(5, nav.progress * 100)}%` }]} /> : null}
			</View>

			<View style={styles.content}>
				{shown.map((tab) => (
					<Tab
						key={tab.id}
						tab={tab}
						visible={tab.id === current?.id}
						session={session}
						relay={relay}
						settings={settings}
						sites={sites}
						rules={rules}
						privateStore={PRIVATE_STORE}
						views={views}
						onState={onState}
						onOpenWindow={onOpenWindow}
						onDownload={onDownload}
						onSiteChange={changeSite}
					/>
				))}
				{current?.url ? null : (
					<View style={styles.blank}>
						<Text style={styles.blankText}>{current?.private ? "Private tab: nothing from it is kept." : "Search or type a URL above."}</Text>
					</View>
				)}
			</View>

			<View style={[styles.toolbar, { paddingBottom: Math.max(insets.bottom, 6) }]}>
				<IconButton icon="chevron.backward" label="Back" disabled={!nav?.canGoBack} onPress={() => view()?.goBack()} />
				<IconButton icon="chevron.forward" label="Forward" disabled={!nav?.canGoForward} onPress={() => view()?.goForward()} />
				<IconButton icon="square.and.arrow.up" label="Share" disabled={!nav?.url} onPress={() => nav && Share.share({ url: nav.url })} />
				<IconButton icon="square.on.square" label={`Tabs, ${workspaceTabs} open`} onPress={() => setSheet("tabs")} />
				<IconButton icon="ellipsis.circle" label="More" onPress={menu} />
			</View>

			{sheet === "tabs" ? (
				<TabsSheet
					tabs={tabs}
					active={active}
					workspaces={workspaces}
					workspace={workspace}
					onSelect={(id) => (select(id), setSheet(null))}
					onCloseTab={closeTab}
					onNewTab={(isPrivate) => newTab(isPrivate)}
					onWorkspace={switchWorkspace}
					onAddWorkspace={(name) => {
						const w = { id: randomUUID(), name };
						setWorkspaces((all) => [...all, w]);
						switchWorkspace(w.id);
					}}
					onRenameWorkspace={(id, name) => setWorkspaces((all) => all.map((w) => (w.id === id ? { ...w, name } : w)))}
					onRemoveWorkspace={removeWorkspace}
					onClose={() => setSheet(null)}
				/>
			) : sheet === "shield" ? (
				<ShieldSheet
					site={site}
					settings={shield}
					view={view}
					onChange={(change) => {
						if (!site) return;
						shieldChanged.current = true;
						changeSite(site, change);
					}}
					onClose={() => {
						setSheet(null);
						// the new settings take effect from the next page load
						if (shieldChanged.current) view()?.reload();
						shieldChanged.current = false;
					}}
				/>
			) : sheet === "settings" ? (
				<SettingsSheet
					settings={settings}
					server={session.origin}
					onChange={(change) => setSettings((s) => ({ ...s, ...change }))}
					onSignOut={signOut}
					onClose={() => setSheet(null)}
				/>
			) : sheet === "downloads" ? (
				<DownloadsSheet downloads={downloads} onClose={() => setSheet(null)} />
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	page: { flex: 1, backgroundColor: colors.chrome },
	bar: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, paddingVertical: 4 },
	address: { flex: 1, height: 38, paddingHorizontal: 12, borderRadius: 10, backgroundColor: colors.field, color: colors.text, fontSize: 16 },
	progressTrack: { height: 2 },
	progress: { height: 2, backgroundColor: colors.ink },
	content: { flex: 1, backgroundColor: colors.bg },
	blank: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
	blankText: { fontSize: 15, color: colors.muted, textAlign: "center" },
	toolbar: { flexDirection: "row", justifyContent: "space-around", paddingTop: 6, backgroundColor: colors.toolbar, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
});
