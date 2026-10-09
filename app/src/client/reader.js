// Reader view, for the shell (bundled to /bios/reader.js as window.BiosReader):
// Mozilla's Readability (https://github.com/mozilla/readability, Apache-2.0),
// which finds a page's article, and DOMPurify (https://github.com/cure53/DOMPurify,
// Apache-2.0/MPL-2.0), which strips everything that could run from it.
//
// The page sends its HTML; it's parsed here into an inert document (nothing in
// it runs or loads), cut down to the article and cleaned twice over before the
// shell shows any of it.

import { Readability } from "@mozilla/readability";
import DOMPurify from "dompurify";

const MAX_IMAGES = 40;

/**
 * @param {string} html the page's markup, as the page itself sees it
 * @param {string} url the page's address, for its relative links
 * @returns {{ title: string, byline: string, siteName: string, content: DocumentFragment, images: string[], length: number } | null}
 */
export function extract(html, url) {
	const doc = new DOMParser().parseFromString(String(html), "text/html");
	// links and images in the article become absolute against the page's address
	const base = doc.createElement("base");
	base.href = url;
	doc.head.prepend(base);
	const article = new Readability(doc, { charThreshold: 300, keepClasses: false }).parse();
	if (!article?.content) return null;

	const clean = DOMPurify.sanitize(article.content, {
		// nothing that loads by itself or holds code: images come back as data:
		// addresses the page fetched, links open through the app
		FORBID_TAGS: ["style", "form", "input", "button", "iframe", "object", "embed", "video", "audio", "source", "svg", "math", "link", "meta"],
		FORBID_ATTR: ["style", "srcset", "sizes", "background", "poster", "id", "class", "target"],
		ALLOWED_URI_REGEXP: /^(?:https?:|#)/i,
	});
	// Still inert: an image put into the app's own document would start loading.
	const inert = new DOMParser().parseFromString(clean, "text/html").body;
	const images = [];
	for (const img of inert.querySelectorAll("img")) {
		const src = img.getAttribute("src") || "";
		img.removeAttribute("src");
		img.setAttribute("loading", "lazy");
		if (/^https?:/i.test(src) && images.length < MAX_IMAGES) {
			img.dataset.src = src;
			images.push(src);
		} else img.remove();
	}
	for (const link of inert.querySelectorAll("a[href]")) {
		const href = link.getAttribute("href");
		link.removeAttribute("href");
		if (/^https?:/i.test(href)) {
			link.dataset.href = href;
			link.setAttribute("role", "link");
			link.tabIndex = 0;
		}
	}
	const content = document.createDocumentFragment();
	content.append(...document.importNode(inert, true).childNodes);
	const text = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 300) : "");
	return {
		title: text(article.title),
		byline: text(article.byline),
		siteName: text(article.siteName),
		content,
		images,
		length: Number(article.length) || 0,
	};
}
