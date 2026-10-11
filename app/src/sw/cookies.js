// Scramjet's cookie jar only looks at a cookie's Expires: one sent with
// Max-Age never expired, so a site signing someone out (Max-Age=0) left the
// cookie in place. Max-Age wins over Expires, as in browsers.

/**
 * `cookie` (a Set-Cookie value) with Max-Age written as the Expires it means.
 * @param {string} cookie
 * @param {number} now ms since the epoch
 */
export function expiresFromMaxAge(cookie, now = Date.now()) {
	const parts = String(cookie).split(";");
	const age = parts
		.slice(1)
		.find((part) => /^\s*max-age\s*=/i.test(part))
		?.split("=")[1]
		.trim();
	if (!age || !/^-?\d+$/.test(age)) return cookie;
	// (browsers keep a cookie 400 days at most)
	const when = Number(age) <= 0 ? 0 : now + Math.min(Number(age), 400 * 86_400) * 1000;
	const kept = [parts[0], ...parts.slice(1).filter((part) => !/^\s*(max-age|expires)\s*=/i.test(part))];
	return kept.join(";") + "; Expires=" + new Date(when).toUTCString();
}
