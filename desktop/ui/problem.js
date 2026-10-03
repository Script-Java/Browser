// Shown in a tab when its page failed to load or crashed (main.js).
const params = new URLSearchParams(location.search);
const url = params.get("url") || "";
const host = /^https?:/.test(url) ? new URL(url).hostname : "";
if (params.get("kind") === "crashed") {
	document.getElementById("title").textContent = "This page crashed";
	document.getElementById("text").textContent = `${host || "The page"} stopped working twice in a row, so Badger didn't reload it again.`;
} else {
	document.getElementById("text").textContent =
		`${host || "The site"} couldn't be reached` + (params.get("detail") ? ` (${params.get("detail")}).` : ".") +
		" Check your connection, or try again in a moment.";
}
const retry = document.getElementById("retry");
if (host) retry.href = url;
else retry.remove();
document.title = host || "Problem loading page";
