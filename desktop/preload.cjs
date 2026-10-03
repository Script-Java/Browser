// The UI window's bridge to the main process. Only the UI window loads this;
// sites never see it.

const { contextBridge, ipcRenderer } = require("electron");

const EVENTS = new Set(["tab", "open", "threat", "shortcut", "focus", "blocked"]);

contextBridge.exposeInMainWorld("badger", {
	ready: () => ipcRenderer.invoke("ui:ready"),
	focusUi: () => ipcRenderer.invoke("ui:focus"),
	loadStore: () => ipcRenderer.invoke("store:load"),
	saveStore: (name, value) => ipcRenderer.invoke("store:save", name, value),
	createTab: (id) => ipcRenderer.invoke("tab:create", id),
	load: (id, url) => ipcRenderer.invoke("tab:load", id, url),
	closeTab: (id) => ipcRenderer.invoke("tab:close", id),
	command: (id, cmd) => ipcRenderer.invoke("tab:cmd", id, cmd),
	show: (ids, top) => ipcRenderer.invoke("tabs:show", ids, top),
	getSettings: () => ipcRenderer.invoke("settings:get"),
	setSettings: (next) => ipcRenderer.invoke("settings:set", next),
	siteOf: (url) => ipcRenderer.invoke("site:of", url),
	proceed: (id, url) => ipcRenderer.invoke("threat:proceed", id, url),
	clearSiteData: () => ipcRenderer.invoke("data:clear"),
	status: () => ipcRenderer.invoke("status"),
	on: (name, fn) => {
		if (EVENTS.has(name)) ipcRenderer.on(name, (event, data) => fn(data));
	},
});
