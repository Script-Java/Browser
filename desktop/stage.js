// Copies the look shared with the web app (stylesheet, logos, icons) from
// ../app/public into ui/shared, so both use one copy of each.

import { cpSync, rmSync } from "node:fs";

const out = new URL("./ui/shared/", import.meta.url);
rmSync(out, { recursive: true, force: true });
for (const name of ["index.css", "logo.png", "favicon.ico", "icons"])
	cpSync(new URL(`../app/public/${name}`, import.meta.url), new URL(name, out), { recursive: true });
