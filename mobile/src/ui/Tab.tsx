// One tab: the native web view, with its site's settings and scripts, the
// checks before each page, and the offers of Direct where Relay gets in the way.
import { memo, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";

import BadgerWebViewModule, {
	BadgerWebView,
	type BadgerWebViewProps,
	type BadgerWebViewRef,
	type Download,
	type NavigationState,
	type Store,
} from "../../modules/badger-webview";
import { bounceTarget, withoutTracking } from "../../../app/src/sw/navrules.js";
import { hostOf } from "../address";
import { isRobotCheck, type Warning, WARNINGS, warningFor } from "../navigation";
import type { Relay } from "../relay/types";
import { NO_PREFETCH, type NavRules } from "../rules";
import { scriptsFor } from "../scripts";
import type { Session } from "../server/types";
import { effective, type Settings, type SiteSettings, type Sites, siteOf } from "../sites";
import { colors, useAfterRender } from "./kit";

/**
 * `session`: WebKit's saved state of the tab, so it comes back with its back and forward.
 * `openedWindow`: the window WebKit made for a page's window.open, which the tab's view adopts; kept in memory only.
 */
export type TabInfo = { id: string; url: string; title: string; workspace: string; private?: boolean; session?: string; openedWindow?: string };

type Handler<K extends keyof BadgerWebViewProps> = NonNullable<BadgerWebViewProps[K]>;

// hosts the person chose to open despite a warning, until the app closes (as the old app)
const bypassed = new Set<string>();
// HTTPS-Only (as the old app's): sites opened over http after its warning, until the app closes,
// and hosts sent to https whose page hasn't opened yet: http again, or a failure, means no https there
const plainHttp = new Set<string>();
const upgrading = new Map<string, number>();
const UPGRADE_MS = 60_000;
const upgradingNow = (host: string) => Date.now() - (upgrading.get(host) ?? 0) < UPGRADE_MS;
// a navigation let go starts within this, or the page stopped it
// shortcut: one slower to start opens with the page's settings; have the native side report dropped navigations if that happens
const START_MS = 3000;
const PERMISSION_KINDS = { camera: "your camera", microphone: "your microphone", cameraAndMicrophone: "your camera and microphone" };

type Props = {
	tab: TabInfo;
	visible: boolean;
	session: Session;
	relay: Relay;
	settings: Settings;
	sites: Sites;
	rules: string[];
	navRules: NavRules;
	/** the private tabs' store, new each launch */
	privateStore: string;
	views: Map<string, RefObject<BadgerWebViewRef | null>>;
	onState: (id: string, state: NavigationState, isPrivate: boolean) => void;
	onSession: (id: string, state: string) => void;
	onOpenWindow: (url: string, windowId: string, opener: TabInfo) => void;
	onDownload: (download: Download) => void;
	onSiteChange: (site: string, change: SiteSettings) => void;
};

export const Tab = memo(function Tab({ tab, visible, session, relay, settings, sites, rules, navRules, privateStore, views, onState, onSession, onOpenWindow, onDownload, onSiteChange }: Props) {
	const view = useRef<BadgerWebViewRef>(null);
	// the first address only: later ones go through view.load()
	const [first] = useState(tab.url);
	const [restore] = useState(tab.session);
	const [opened] = useState(tab.openedWindow);
	// the site whose settings and scripts the tab has: the one it's opening or showing
	const [site, setSite] = useState(() => siteOf(tab.url));
	const [warning, setWarning] = useState<Warning | null>(null);
	// a navigation's answer, or a reload, waits for the new site's props to reach the native view
	const later = useAfterRender();
	// sites this tab has offered Direct for at a robot check, which reports its state many times
	const offered = useRef(new Set<string>());
	// the site of the page on screen, and the navigation let go that hasn't started yet
	const shown = useRef(site);
	const starting = useRef<object | null>(null);
	// a navigation the page cancelled (window.stop(), a 204, a download) leaves the page on screen: its settings again,
	// unless another navigation is on its way, which needs its own
	const resync = () => {
		if (!starting.current) setSite(shown.current);
	};

	useEffect(() => {
		views.set(tab.id, view);
		return () => void views.delete(tab.id);
	}, [views, tab.id]);

	const of = (s: string | null) => effective(s ? sites[s] : undefined, settings.level);
	const here = of(site);
	const scripts = useMemo(
		() => scriptsFor({ ...here, consent: settings.consent }),
		[here.route, here.blocking, here.level, here.passkeys, settings.consent] // eslint-disable-line react-hooks/exhaustive-deps
	);
	const store = useMemo<Store>(
		() => ({ id: tab.private ? privateStore : tab.workspace, persistent: !tab.private, proxy: relay.proxy }),
		[tab.private, tab.workspace, privateStore, relay.proxy]
	);
	const contentRules = useMemo(() => (here.route === "relay" ? [NO_PREFETCH] : []).concat(here.blocking ? rules : []), [here.route, here.blocking, rules]);

	const offerDirect = (asking: string, why: string, then: () => void) =>
		Alert.alert(
			`Connect to ${asking} directly?`,
			`${why} Through the relay, ${asking} sees the server's address, which others share. Direct connects from this phone: ${asking} sees your address instead, here and wherever other sites embed its content.`,
			[
				{ text: "Not now", style: "cancel" },
				{
					text: "Use Direct",
					onPress: () => {
						onSiteChange(asking, { route: "direct" });
						later(then);
					},
				},
			]
		);

	const onShouldStart: Handler<"onShouldStart"> = async ({ nativeEvent: { requestId, url, byApp } }) => {
		const next = siteOf(url);
		let target: URL | null = null;
		try {
			target = new URL(url);
		} catch {
			// not an address with a host
		}
		const host = target?.hostname ?? "";
		const instead = (to: string) => {
			BadgerWebViewModule.resolveNavigation(requestId, false);
			// the page's own navigations stay the page's, for SameSite cookies; a typed address mustn't get the page as its initiator
			if (byApp) view.current?.load(to);
			else view.current?.navigateFromPage(to);
		};
		if (target && next) {
			if (target.protocol === "http:" && settings.httpsOnly && !plainHttp.has(next)) {
				// sent to https a moment ago and back to http: the site has none
				if (upgradingNow(host)) {
					BadgerWebViewModule.resolveNavigation(requestId, false);
					return setWarning({ kind: "http", host, url });
				}
				upgrading.set(host, Date.now());
				target.protocol = "https:";
				return instead(target.href);
			}
			if (of(next).blocking) {
				// a bounce through a tracker goes straight to where it leads
				const leads = bounceTarget(target, navRules, siteOf);
				if (leads && of(siteOf(leads.href)).blocking) return instead(leads.href);
				// parameters that follow people between sites; a site's own links keep theirs
				const clean = next !== site ? withoutTracking(target, navRules) : null;
				if (clean) return instead(clean.href);
			}
		}
		const warn = host && !bypassed.has(host) ? await warningFor(url, of(next).route, (h) => session.threat(h)) : null;
		if (warn) {
			BadgerWebViewModule.resolveNavigation(requestId, false);
			return setWarning(warn);
		}
		setWarning(null);
		// the new site's scripts, level and Lockdown first, then the page
		const going = {};
		starting.current = going;
		setSite(next);
		later(() => {
			BadgerWebViewModule.resolveNavigation(requestId, true);
			// WebKit says nothing when the page stops a navigation before it starts
			setTimeout(() => {
				if (starting.current !== going) return;
				starting.current = null;
				resync();
			}, START_MS);
		});
	};

	const onNavigationState: Handler<"onNavigationState"> = ({ nativeEvent: state }) => {
		onState(tab.id, state, !!tab.private);
		if (state.loading) starting.current = null;
		else {
			shown.current = siteOf(state.url);
			resync();
		}
		// its https page opened: the upgrade worked
		if (!state.loading && state.url.startsWith("https:")) upgrading.delete(hostOf(state.url));
		const showing = siteOf(state.url);
		if (!showing || offered.current.has(showing) || of(showing).route !== "relay" || !isRobotCheck(state)) return;
		offered.current.add(showing);
		offerDirect(showing, "This site is asking whether you're a robot.", () => {
			// Google's check says where it was going; anywhere on the same site is fine
			const to = new URL(state.url).searchParams.get("continue");
			if (to && siteOf(to) === showing) view.current?.load(to);
			else view.current?.reload();
		});
	};

	const onPermissionRequest: Handler<"onPermissionRequest"> = ({ nativeEvent: { requestId, origin, kind } }) => {
		const asking = siteOf(origin) ?? origin;
		// calls need WebRTC, which relay sites don't get, and their media goes around any proxy
		if (site && of(site).route === "relay") {
			BadgerWebViewModule.resolvePermission(requestId, false);
			return offerDirect(site, "Calls don't work through the relay.", () => view.current?.reload());
		}
		// shortcut: asked every time; keep answers per site as the old app does when people tire of it
		Alert.alert(`${asking} wants to use ${PERMISSION_KINDS[kind]}`, "The site can see and hear what the camera and microphone pick up while it's open.", [
			{ text: "Don't allow", style: "cancel", onPress: () => BadgerWebViewModule.resolvePermission(requestId, false) },
			{ text: "Allow", onPress: () => BadgerWebViewModule.resolvePermission(requestId, true) },
		]);
	};

	const onLoadError: Handler<"onLoadError"> = ({ nativeEvent: { url, code, certificateError } }) => {
		// cancelled (another page started), or a page that became a download
		if (code === -999 || code === 102) return resync();
		// sent to https and it wouldn't open there
		if (url.startsWith("https:") && upgradingNow(hostOf(url))) {
			const plain = new URL(url);
			plain.protocol = "http:";
			return setWarning({ kind: "http", host: plain.hostname, url: plain.href });
		}
		setWarning({ kind: certificateError ? "cert" : "unreachable", host: hostOf(url), url });
	};

	const proceed = () => {
		if (!warning) return;
		if (warning.kind === "http") {
			plainHttp.add(siteOf(warning.url) ?? warning.host);
			upgrading.delete(warning.host);
		} else if (warning.kind !== "unreachable") bypassed.add(warning.host);
		setWarning(null);
		view.current?.load(warning.url);
	};

	return (
		<View
			style={[StyleSheet.absoluteFill, !visible && styles.hidden]}
			pointerEvents={visible ? "auto" : "none"}
			accessibilityElementsHidden={!visible}
			importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
		>
			<BadgerWebView
				ref={view}
				style={StyleSheet.absoluteFill}
				url={first}
				sessionState={restore}
				openedWindow={opened}
				onSessionState={({ nativeEvent }) => onSession(tab.id, nativeEvent.state)}
				store={store}
				level={here.level}
				lockdown={here.lockdown}
				contentRules={contentRules}
				pageScripts={scripts.page}
				isolatedScripts={scripts.isolated}
				fraudWarnings
				askBeforeNavigating
				onShouldStart={onShouldStart}
				onNavigationState={onNavigationState}
				onOpenWindow={({ nativeEvent }) => onOpenWindow(nativeEvent.url, nativeEvent.windowId, tab)}
				onDownload={({ nativeEvent }) => onDownload(nativeEvent)}
				onPermissionRequest={onPermissionRequest}
				onLoadError={onLoadError}
			/>
			{warning ? <WarningScreen warning={warning} onBack={() => setWarning(null)} onGo={proceed} /> : null}
		</View>
	);
});

function WarningScreen({ warning, onBack, onGo }: { warning: Warning; onBack: () => void; onGo: () => void }) {
	const { title, text, go } = WARNINGS[warning.kind];
	const danger = warning.kind !== "unreachable";
	return (
		<View style={[StyleSheet.absoluteFill, styles.warning, { backgroundColor: danger ? colors.warning : "#1b1b24" }]} accessibilityViewIsModal>
			<Text style={styles.warningTitle} accessibilityRole="header">
				{title}
			</Text>
			<Text style={styles.warningText}>{text.replace("{real}", warning.real ?? "")}</Text>
			<Text style={styles.warningHost} selectable>
				{warning.host}
			</Text>
			<View style={styles.warningButtons}>
				<Pressable accessibilityRole="button" style={styles.back} onPress={onBack}>
					<Text style={styles.backText}>Go back</Text>
				</Pressable>
				{go ? (
					<Pressable accessibilityRole="button" onPress={onGo} hitSlop={8}>
						<Text style={styles.goText}>{go}</Text>
					</Pressable>
				) : null}
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	hidden: { opacity: 0 },
	warning: { padding: 24, paddingTop: 48 },
	warningTitle: { fontSize: 24, fontWeight: "700", color: "#fff", marginBottom: 12 },
	warningText: { fontSize: 16, lineHeight: 23, color: "#fff", opacity: 0.9, marginBottom: 16 },
	warningHost: { alignSelf: "flex-start", fontFamily: "Menlo", fontSize: 14, color: "#fff", backgroundColor: "rgba(0,0,0,0.25)", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, marginBottom: 16 },
	warningButtons: { flexDirection: "row", alignItems: "center", gap: 16, flexWrap: "wrap" },
	back: { backgroundColor: "#fff", paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10 },
	backText: { fontSize: 16, color: "#111" },
	goText: { fontSize: 16, color: "#fff", textDecorationLine: "underline" },
});
