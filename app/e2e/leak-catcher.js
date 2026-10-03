// The browser under test uses this as its HTTP proxy for everything except
// the app's own addresses (see playwright.config.js). So any request that
// reaches it went around Badger's proxy, straight from the browser to a
// site: a leak. It refuses them and remembers each one.
//
// The tests read and reset the list over plain HTTP (GET/DELETE /__seen).

import { createServer } from "node:http";

const seen = [];

const server = createServer((req, res) => {
	// a proxied request carries an absolute URL; ours is just a path
	if (req.url === "/__seen") {
		if (req.method === "DELETE") seen.length = 0;
		res.setHeader("content-type", "application/json");
		return res.end(JSON.stringify(seen));
	}
	seen.push(`${req.method} ${req.url}`);
	res.writeHead(403).end();
});

// https:// and wss:// go through CONNECT
server.on("connect", (req, socket) => {
	seen.push(`CONNECT ${req.url}`);
	socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
});

server.listen(Number(process.env.PORT), "127.0.0.1");
