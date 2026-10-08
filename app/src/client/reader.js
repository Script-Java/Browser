// Reader view (bundled to /bios/reader.js, which page.js loads into a page
// when the app asks for it): the page's article alone, in a plain layout over
// the page. Mozilla's Readability (Firefox's reader view) finds the article.

import { Readability } from "@mozilla/readability";

// What the article may keep: what Readability leaves is text, links, images
// and tables, but it isn't a sanitizer.
const DROP = "script,style,iframe,frame,object,embed,form,input,button,textarea,select,link,meta,base";

/**
 * Shows the reader view, or takes it away when it's open.
 * @param {Window} win
 * @param {any} client The page's Scramjet client.
 */
export function toggle(win, client) {
	const doc = win.document;
	const open = doc.getElementById("bios-reader");
	if (open) return void open.remove();

	const article = new Readability(doc.cloneNode(true), { charThreshold: 200 }).parse();
	// The page's own markup, its addresses already the proxy's: put in with
	// the browser's own innerHTML, which Scramjet's would rewrite once more.
	const text = doc.createElement("div");
	text.className = "text";
	client.descriptors.set("Element.prototype.innerHTML", text, article?.content || "");
	for (const el of text.querySelectorAll(DROP)) el.remove();
	for (const el of text.querySelectorAll("*"))
		for (const { name, value } of [...el.attributes])
			if (/^on/i.test(name) || /^\s*javascript:/i.test(value) || name === "style") el.removeAttribute(name);
	if (!text.textContent.trim()) {
		const none = doc.createElement("p");
		none.textContent = "There's no article on this page to show.";
		text.append(none);
	}

	const host = doc.createElement("div");
	host.id = "bios-reader";
	host.style.cssText = "position:fixed;inset:0;z-index:2147483647;overflow:auto;-webkit-overflow-scrolling:touch";
	const root = host.attachShadow({ mode: "open" });
	const style = doc.createElement("style");
	style.textContent = `
:host{all:initial;display:block;background:#faf7f0;color:#1f1d1a}
@media (prefers-color-scheme:dark){:host{background:#1c1b19;color:#e8e4dc}a{color:#9cc3ff}}
article{max-width:38em;margin:0 auto;padding:24px 20px 64px;font:19px/1.6 Georgia,"Times New Roman",serif}
h1{font:700 1.6em/1.25 -apple-system,system-ui,sans-serif;margin:.6em 0 .3em}
.by{font:15px -apple-system,system-ui,sans-serif;opacity:.7;margin:0 0 1.5em}
img,video,figure{max-width:100%;height:auto}
pre{white-space:pre-wrap;font-size:.85em}
table{border-collapse:collapse;max-width:100%;display:block;overflow:auto}
td,th{border:1px solid #8884;padding:4px 8px}
.close{position:sticky;top:0;display:flex;justify-content:flex-end;padding:10px 16px}
.close button{font:15px -apple-system,system-ui,sans-serif;padding:8px 14px;border-radius:10px;border:0;background:#0001;color:inherit}
`;
	const bar = doc.createElement("div");
	bar.className = "close";
	const close = doc.createElement("button");
	close.type = "button";
	close.textContent = "Close reader view";
	close.addEventListener("click", () => host.remove());
	bar.append(close);
	const page = doc.createElement("article");
	page.id = "bios-reader-page";
	const title = doc.createElement("h1");
	title.textContent = article?.title || doc.title || "";
	const by = doc.createElement("p");
	by.className = "by";
	by.textContent = [article?.byline, article?.siteName].filter(Boolean).join(" · ");
	page.append(title, by, text);
	root.append(style, bar, page);
	(doc.body || doc.documentElement).append(host);
	host.scrollTop = 0;
}
