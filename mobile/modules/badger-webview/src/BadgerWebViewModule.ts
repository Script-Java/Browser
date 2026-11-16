import { NativeModule, requireNativeModule } from "expo";

import type { BadgerWebViewModuleEvents, Cookie, Store } from "./BadgerWebView.types";

declare class BadgerWebViewModule extends NativeModule<BadgerWebViewModuleEvents> {
	/** WKContentRuleListStore: compiles Safari content-blocker JSON (at most 150,000 rules) under this id. */
	compileContentRules(id: string, json: string): Promise<void>;
	/** ids already compiled, kept across launches */
	contentRuleIds(): Promise<string[]>;
	removeContentRules(id: string): Promise<void>;
	/** answers a tab's onShouldStart; an unanswered one is refused after 10 seconds */
	resolveNavigation(requestId: string, allow: boolean): void;
	/** answers a tab's onPermissionRequest; an unanswered one is denied after 60 seconds */
	resolvePermission(requestId: string, grant: boolean): void;
	cookies(store: Store, url: string): Promise<Cookie[]>;
	/** deletes everything the store holds */
	clearStore(store: Store): Promise<void>;
	/** deletes a persistent store itself (a removed workspace); its tabs must be closed first */
	removeStore(id: string): Promise<void>;
}

export default requireNativeModule<BadgerWebViewModule>("BadgerWebView");
