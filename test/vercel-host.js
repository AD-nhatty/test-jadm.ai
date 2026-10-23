// Answers requests the way Vercel does: VERCEL is set, so server.js starts no
// server of its own, and every request goes to the function in api/index.js.
import http from "node:http";

process.env.VERCEL = "1";
const { default: handler } = await import("../api/index.js");
http.createServer((req, res) => handler(req, res)).listen(Number(process.argv[2]));
