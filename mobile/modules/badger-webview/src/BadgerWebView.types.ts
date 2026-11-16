// The contract between the app (TypeScript) and the native tab (Swift).
// Additions are fine; renaming or removing anything breaks the other side.
import type { StyleProp, ViewStyle } from "react-native";

/** A SOCKS5 proxy on the device (the relay, src/relay), with per-launch credentials. */
export type Proxy = { host: "127.0.0.1"; port: number; username: string; password: string };

/**
 * Where a tab keeps its cookies and storage. Tabs with the same id share one.
 * persistent: a workspace, WKWebsiteDataStore(forIdentifier: UUID(id)).
 * ephemeral: private and Tor tabs, WKWebsiteDataStore.nonPersistent().
 * The native side creates a store on its first use in this launch and sets
 * its proxy then; a different proxy for the same id later is ignored
 * (WebKit misbehaves when a store in use changes proxy).
 */
export type Store = { id: string; persistent: boolean; proxy: Proxy | null };

export type Level = "standard" | "safer" | "safest";

export type NavigationState = {
	url: string;
	title: string;
	loading: boolean;
	/** 0 to 1 */
	progress: number;
	canGoBack: boolean;
	canGoForward: boolean;
	/** https with a certificate the system trusts */
	secure: boolean;
};

export type ShouldStart = {
	/** answer with BadgerWebViewModule.resolveNavigation(requestId, allow) */
	requestId: string;
	url: string;
	/** the main frame only; frames and subresources never ask */
	isMainFrame: true;
};

export type Download = {
	id: string;
	url: string;
	filename: string;
	state: "started" | "finished" | "failed";
	/** file:// path in the app's documents, when finished */
	path?: string;
	error?: string;
};

export type PermissionRequest = {
	/** answer with BadgerWebViewModule.resolvePermission(requestId, grant) */
	requestId: string;
	origin: string;
	kind: "camera" | "microphone" | "cameraAndMicrophone";
};

export type LoadError = { url: string; code: number; description: string; certificateError: boolean };

type Event<T> = (event: { nativeEvent: T }) => void;

export type BadgerWebViewProps = {
	style?: StyleProp<ViewStyle>;
	/** First address. Later navigations go through the ref's load(). */
	url: string;
	store: Store;
	level: Level;
	/** WKWebpagePreferences.isLockdownModeEnabled for this tab's pages */
	lockdown: boolean;
	/** ids from compileContentRules to apply; empty means no blocking */
	contentRules: string[];
	/** run at document start in every frame, in the page's world (fingerprinting, WebRTC/WebTransport off) */
	pageScripts: string[];
	/** run at document end in every frame, in a world of their own (cosmetic filters, cookie notices) */
	isolatedScripts: string[];
	/** WKPreferences.isFraudulentWebsiteWarningEnabled */
	fraudWarnings: boolean;
	userAgent?: string;
	onNavigationState?: Event<NavigationState>;
	/** without a handler, every navigation goes ahead */
	onShouldStart?: Event<ShouldStart>;
	/** window.open and target=_blank: the app opens a tab */
	onOpenWindow?: Event<{ url: string }>;
	onDownload?: Event<Download>;
	onPermissionRequest?: Event<PermissionRequest>;
	/** window.webkit.messageHandlers.badger.postMessage(data) from the isolated world only */
	onMessage?: Event<{ data: string }>;
	onLoadError?: Event<LoadError>;
};

/** The tab's methods, through a ref. */
export type BadgerWebViewRef = {
	load(url: string): Promise<void>;
	goBack(): Promise<void>;
	goForward(): Promise<void>;
	reload(): Promise<void>;
	stop(): Promise<void>;
	/** shows the system find bar (UIFindInteraction) */
	find(): Promise<void>;
	/** the page's certificate chain, leaf first, as base64 DER; null when not https */
	certificate(): Promise<string[] | null>;
};

export type Cookie = {
	name: string;
	value: string;
	domain: string;
	path: string;
	/** seconds since 1970; absent for a session cookie */
	expires?: number;
	secure: boolean;
	httpOnly: boolean;
};

export type BadgerWebViewModuleEvents = Record<string, never>;
