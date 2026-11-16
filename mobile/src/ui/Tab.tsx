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
import { hostOf } from "../address";
import { isRobotCheck, type Warning, WARNINGS, warningFor } from "../navigation";
import type { Relay } from "../relay/types";
import { scriptsFor } from "../scripts";
import type { Session } from "../server/types";
import { effective, type Settings, type SiteSettings, type Sites, siteOf } from "../sites";
import { colors, useAfterRender } from "./kit";

export type TabInfo = { id: string; url: string; title: string; workspace: string; private?: boolean };

type Handler<K extends keyof BadgerWebViewProps> = NonNullable<BadgerWebViewProps[K]>;

// hosts the person chose to open despite a warning, until the app closes (as the old app)
const bypassed = new Set<string>();
const NO_RULES: string[] = [];
const PERMISSION_KINDS = { camera: "your camera", microphone: "your microphone", cameraAndMicrophone: "your camera and microphone" };

type Props = {
	tab: TabInfo;
	visible: boolean;
	session: Session;
	relay: Relay;
	settings: Settings;
	sites: Sites;
	rules: string[];
	/** the private tabs' store, new each launch */
	privateStore: string;
	views: Map<string, RefObject<BadgerWebViewRef | null>>;
	onState: (id: string, state: NavigationState) => void;
	onOpenWindow: (url: string, opener: TabInfo) => void;
	onDownload: (download: Download) => void;
	onSiteChange: (site: string, change: SiteSettings) => void;
};

export const Tab = memo(function Tab({ tab, visible, session, relay, settings, sites, rules, privateStore, views, onState, onOpenWindow, onDownload, onSiteChange }: Props) {
	const view = useRef<BadgerWebViewRef>(null);
	// the first address only: later ones go through view.load()
	const [first] = useState(tab.url);
	// the site whose settings and scripts the tab has: the one it's opening or showing
	const [site, setSite] = useState(() => siteOf(tab.url));
	const [warning, setWarning] = useState<Warning | null>(null);
	// a navigation's answer, or a reload, waits for the new site's props to reach the native view
	const later = useAfterRender();
	// sites this tab has offered Direct for at a robot check, which reports its state many times
	const offered = useRef(new Set<string>());

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

	const offerDirect = (asking: string, why: string, then: () => void) =>
		Alert.alert(
			`Connect to ${asking} directly?`,
			`${why} Through the relay, ${asking} sees the server's address, which others share. Direct connects from this phone: the site sees your address instead.`,
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

	const onShouldStart: Handler<"onShouldStart"> = async ({ nativeEvent: { requestId, url } }) => {
		const next = siteOf(url);
		let host = "";
		try {
			host = new URL(url).hostname;
		} catch {
			// not an address with a host
		}
		const warn = host && !bypassed.has(host) ? await warningFor(url, of(next).route, (h) => session.threat(h)) : null;
		if (warn) {
			BadgerWebViewModule.resolveNavigation(requestId, false);
			return setWarning(warn);
		}
		setWarning(null);
		// the new site's scripts, level and Lockdown first, then the page
		setSite(next);
		later(() => BadgerWebViewModule.resolveNavigation(requestId, true));
	};

	const onNavigationState: Handler<"onNavigationState"> = ({ nativeEvent: state }) => {
		onState(tab.id, state);
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
		if (code === -999 || code === 102) return;
		setWarning({ kind: certificateError ? "cert" : "unreachable", host: hostOf(url), url });
	};

	const proceed = () => {
		if (!warning) return;
		if (warning.kind !== "unreachable") bypassed.add(warning.host);
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
				store={store}
				level={here.level}
				lockdown={here.lockdown}
				contentRules={here.blocking ? rules : NO_RULES}
				pageScripts={scripts.page}
				isolatedScripts={scripts.isolated}
				fraudWarnings
				askBeforeNavigating
				onShouldStart={onShouldStart}
				onNavigationState={onNavigationState}
				onOpenWindow={({ nativeEvent }) => onOpenWindow(nativeEvent.url, tab)}
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
