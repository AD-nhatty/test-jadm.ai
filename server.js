/*
 * JADM Review — a comment layer on top of the live jadm.ai.
 *
 * The usual way in is a personal "JADM Comment" bookmark button: reviewers
 * use the real jadm.ai, signed in their normal way (Google included), and the
 * button loads the review widget onto the page. The widget talks to this
 * server across origins with the reviewer's own token, which the button
 * carries. /__review/setup hands out the button after the name and team
 * password.
 *
 * Optionally (MIRROR=1, or when a test login is set) this server is also a
 * live mirror of jadm.ai: every page and API call fetched from jadm.ai when
 * asked for, with the widget added on the way through. That needs a jadm.ai
 * login that works away from jadm.ai's own address, which Google sign-in
 * does not.
 *
 * Everything the review itself needs lives under /__review/, a path jadm.ai
 * does not use; nothing on jadm.ai changes.
 *
 * Settings (environment variables):
 *   TARGET_URL      the site to mirror              default https://jadm.ai
 *   TEAM_PASSWORD   asked once with the name; keeps strangers out (recommended)
 *   SESSION_SECRET  signs the "who is reviewing" cookie; any long random text
 *   DATABASE_URL    PostgreSQL for the comments; without it they go to ./data
 *   PORT            default 8080
 *   MIRROR          "1" serves the live mirror at this server's root as well
 *   JADM_LOGIN_EMAIL, JADM_LOGIN_PASSWORD
 *                   one jadm.ai email-and-password test login; turns the
 *                   mirror on and signs reviewers in to it for them.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { databaseUrl, openStore } from "./store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = new URL(process.env.TARGET_URL || "https://jadm.ai");
const PORT = Number(process.env.PORT || 8080);
const TEAM_PASSWORD = (process.env.TEAM_PASSWORD || "").trim();
// Vercel runs this as functions (api/index.js), several copies at once, so the
// key that signs names into cookies and buttons must be the same everywhere.
// Without SESSION_SECRET it comes from the team password through scrypt, which
// is slow on purpose: someone holding one button cannot afford to test
// password guesses against it offline. (Forging a name is no gain anyway;
// anyone with the password can type any name at the door.)
const VERCEL = Boolean(process.env.VERCEL);
const HOSTED = VERCEL || Boolean(process.env.RENDER);
const SECRET =
  process.env.SESSION_SECRET ||
  (TEAM_PASSWORD
    ? crypto.scryptSync(TEAM_PASSWORD, "jadm-review|session-key|v2", 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("hex")
    : crypto.randomBytes(32).toString("hex"));
const P = "/__review";
const COOKIE = "jadm_reviewer";
// Vercel refuses request bodies over 4.5 MB; a screenshot is well under that.
const MAX_BODY = (VERCEL ? 4 : 12) * 1024 * 1024;

const LOGIN_EMAIL = (process.env.JADM_LOGIN_EMAIL || "").trim().toLowerCase();
const LOGIN_PASSWORD = process.env.JADM_LOGIN_PASSWORD || "";
const AUTO_LOGIN = Boolean(LOGIN_EMAIL && LOGIN_PASSWORD);
const MIRROR = process.env.MIRROR === "1" || AUTO_LOGIN;
// Under /api/auth on purpose: jadm.ai's session cookie is scoped to that path,
// so this is the one address of ours the browser sends it to.
const AUTO_PATH = "/api/auth/__review-signin";
const JADM_SESSION_COOKIE = "jadm_session";

const KINDS = ["bug", "design", "wording", "idea", "question"];
const PRIORITIES = ["high", "medium", "low"];
const STATUSES = ["open", "fixed", "wontfix"];

// What is missing before this site can work, said on every page rather than
// as a crash: on a public address (Render, Vercel) a team password is a must,
// or anyone who found it could read the comments; and comments need somewhere
// to live. Only settings count here. A database that is merely slow to answer
// is retried on the next request (getStore), never remembered as "not set up".
let setupProblem = null;
if (HOSTED && !TEAM_PASSWORD) {
  setupProblem = "TEAM_PASSWORD is not set. Add it in the project's Environment Variables, then redeploy.";
} else if (VERCEL && !databaseUrl()) {
  setupProblem =
    "No database is connected. In Vercel open the project → Storage → Create Database → Neon (Postgres), connect it to this project, then redeploy.";
}

let store = null;
let opening = null;
function getStore() {
  opening ??= openStore().then(
    (s) => (store = s),
    (err) => {
      opening = null;
      throw err;
    },
  );
  return opening;
}
if (!setupProblem) await getStore().catch((err) => console.error("comments store:", err.message));

// --- small helpers ------------------------------------------------------------

function send(res, status, body, type = "text/plain; charset=utf-8", extra = {}) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...extra });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), "application/json; charset=utf-8");
const redirect = (res, to, status = 302) => send(res, status, "", "text/plain", { location: to });
const wantsHtml = (req) => String(req.headers.accept || "").includes("text/html");
const isHttps = (req) => String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// Text as PostgreSQL will take it: no NUL characters, and no half of an emoji
// (a lone surrogate, which cutting at `max` could also make) — either would
// make the database refuse the whole comment.
const str = (v, max) =>
  typeof v === "string"
    ? v
        .replace(/\u0000/g, "")
        .trim()
        .slice(0, max)
        .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    : "";
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);

// Only a path on this site; never an absolute URL, and never back to the door.
// Browsers read "/\evil.com" and "/<tab>/evil.com" as "//evil.com", so the
// value is parsed the way a browser would and must stay on this origin.
function safeNext(v) {
  if (typeof v !== "string" || !v.startsWith("/") || /[\\\x00-\x1f\x7f]/.test(v)) return "/";
  let u;
  try {
    u = new URL(v, "http://mirror");
  } catch {
    return "/";
  }
  if (u.origin !== "http://mirror") return "/";
  const out = u.pathname + u.search + u.hash;
  return out.startsWith("//") || out.startsWith(`${P}/enter`) ? "/" : out;
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  try {
    return JSON.parse((await readBody(req)).toString("utf8") || "{}");
  } catch (err) {
    if (err.status) throw err;
    throw Object.assign(new Error("bad json"), { status: 400 });
  }
}

// --- who is reviewing (a signed cookie holding the name) ----------------------

// The key includes the team password, so changing the password signs everyone out.
const sign = (v) => crypto.createHmac("sha256", `${SECRET}|${TEAM_PASSWORD}`).update(v).digest("base64url");

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// The cookie on this site, or the same signed value as a token in the
// x-review-token header, from the widget on jadm.ai.
function reviewer(req) {
  return nameFrom(cookies(req)[COOKIE]) || nameFrom(req.headers["x-review-token"]);
}

// A screenshot's own key, handed out with the comment list. An <img> cannot
// send the token header, and the token must not travel in addresses (they get
// copied, pasted and opened in new tabs), so each picture has a key that opens
// that picture and nothing else.
const shotKey = (id) => sign(`shot|${id}`).slice(0, 22);
const withShotKey = (c) => (c.shot ? { ...c, shotKey: shotKey(c.id) } : c);

function nameFrom(raw) {
  if (typeof raw !== "string" || !raw) return null;
  const [value, mac] = raw.split(".");
  // A real signature is always 43 base64url characters; anything else (other
  // lengths, or characters that are more than one byte) is simply not one.
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(mac || "")) return null;
  const expected = sign(value);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    return Buffer.from(value, "base64url").toString("utf8") || null;
  } catch {
    return null;
  }
}

function tokenFor(name) {
  const value = Buffer.from(name, "utf8").toString("base64url");
  return `${value}.${sign(value)}`;
}

function reviewerCookie(req, name, maxAge = 30 * 24 * 3600) {
  return `${COOKIE}=${tokenFor(name)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${isHttps(req) ? "; Secure" : ""}`;
}

// This server's own public address, as the reviewer's browser reached it.
function originOf(req) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? `${isHttps(req) ? "https" : "http"}://${host}` : "";
}

// The address a reviewer's button points at. Never just "whatever address
// served the setup page": on Vercel the same site also answers on
// per-deployment addresses, which sit behind Vercel's own sign-in and vanish
// with old deployments, so a button made there would fail for its owner.
// PUBLIC_URL pins it by hand; otherwise the host's production address.
function publicOrigin(req) {
  const pinned = (process.env.PUBLIC_URL || "").trim();
  if (pinned) {
    try {
      return new URL(pinned).origin;
    } catch { /* not a URL; fall through */ }
  }
  if (VERCEL && process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.RENDER_EXTERNAL_URL) {
    try {
      return new URL(process.env.RENDER_EXTERNAL_URL).origin;
    } catch { /* fall through */ }
  }
  return originOf(req);
}

// The widget on jadm.ai calls this server from jadm.ai's origin, and only from
// there. The token travels in a header, never in a cookie, so no credentials
// mode is needed and other sites get nothing.
function allowJadm(req, res) {
  if (req.headers.origin !== TARGET.origin) return false;
  res.setHeader("access-control-allow-origin", TARGET.origin);
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-allow-headers", "content-type, x-review-token");
  res.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("access-control-max-age", "600");
  // Chrome asks before a public page may reach a server on this computer;
  // only matters when trying the button against a local copy.
  if (req.headers["access-control-request-private-network"] === "true") {
    res.setHeader("access-control-allow-private-network", "true");
  }
  return true;
}

function passwordOk(given) {
  if (!TEAM_PASSWORD) return true;
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(TEAM_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function enterPage(next, error, name = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>JADM Review</title><style>
:root{--bg:#f4f4f4;--panel:#fff;--text:#161616;--muted:#525252;--field:#f4f4f4;--line:#8d8d8d;--blue:#0f62fe;--blue2:#0353e9;--red:#da1e28}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--panel:#262626;--text:#f4f4f4;--muted:#c6c6c6;--field:#393939;--line:#6f6f6f;--blue:#4589ff;--blue2:#6ea6ff;--red:#fa4d56}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.45 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
form{background:var(--panel);padding:32px;width:min(400px,100%);border-top:4px solid var(--blue)}
h1{font-size:22px;font-weight:600;margin:0 0 6px}p.lead{margin:0 0 24px;color:var(--muted);font-size:14px}
label{display:block;font-size:12px;color:var(--muted);margin:16px 0 6px}
input{width:100%;padding:12px;border:0;border-bottom:1px solid var(--line);background:var(--field);color:var(--text);font:inherit}
input:focus{outline:2px solid var(--blue);outline-offset:-2px}
button{margin-top:24px;width:100%;padding:13px;border:0;background:var(--blue);color:#fff;font:inherit;cursor:pointer}button:hover{background:var(--blue2)}
.err{color:var(--red);font-size:14px;margin:16px 0 0}.how{margin:24px 0 0;padding:0 0 0 18px;color:var(--muted);font-size:13px}.how li{margin:4px 0}
</style></head><body><form method="post" action="${P}/enter">
<h1>JADM Review</h1><p class="lead">You are about to review the live jadm.ai. Your comments are shared with the whole review team.</p>
<label for="n">Your name</label><input id="n" name="name" value="${esc(name)}" maxlength="40" autocomplete="name" required autofocus>
${TEAM_PASSWORD ? '<label for="p">Team password</label><input id="p" name="password" type="password" autocomplete="current-password" required>' : ""}
<input type="hidden" name="next" value="${esc(next)}">
${error ? `<p class="err">${esc(error)}</p>` : ""}
<button type="submit">Start reviewing</button>
<ol class="how"><li>Use the site as normal.</li><li>Press <b>Comment</b> (bottom right), then click the spot you want to talk about.</li><li>Write what is wrong. Everyone sees it.</li></ol>
</form></body></html>`;
}

// Wrong team passwords: five per address and fifty in all per fifteen minutes,
// then the door waits. The overall cap is what stops a guesser who changes
// address; reviewers already in keep their cookie and are not affected.
const WINDOW_MS = 15 * 60 * 1000;
const fails = new Map();
let allFails = { n: 0, since: Date.now() };

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
}

function tooManyFails(ip) {
  const now = Date.now();
  if (now - allFails.since > WINDOW_MS) allFails = { n: 0, since: now };
  const mine = fails.get(ip);
  if (mine && now - mine.since > WINDOW_MS) fails.delete(ip);
  return (fails.get(ip)?.n || 0) >= 5 || allFails.n >= 50;
}

function noteFail(ip) {
  const now = Date.now();
  const mine = fails.get(ip);
  if (!mine || now - mine.since > WINDOW_MS) fails.set(ip, { n: 1, since: now });
  else mine.n++;
  allFails.n++;
  if (fails.size > 10_000) fails.clear();
}

async function enter(req, res, url) {
  if (req.method === "GET") return send(res, 200, enterPage(safeNext(url.searchParams.get("next")), ""), "text/html; charset=utf-8");
  if (req.method !== "POST") return send(res, 405, "Method not allowed");
  // A name and a password; anything bigger is not a sign-in.
  const form = new URLSearchParams((await readBody(req, 8 * 1024)).toString("utf8"));
  const name = str(form.get("name"), 40).replace(/\s+/g, " ");
  const next = safeNext(form.get("next"));
  if (!name) return send(res, 400, enterPage(next, "Please type your name."), "text/html; charset=utf-8");
  const ip = clientIp(req);
  if (TEAM_PASSWORD && tooManyFails(ip)) {
    return send(res, 429, enterPage(next, "Too many wrong tries. Wait 15 minutes and try again.", name), "text/html; charset=utf-8", {
      "retry-after": "900",
    });
  }
  if (!passwordOk(form.get("password"))) {
    noteFail(ip);
    await new Promise((r) => setTimeout(r, 1000));
    return send(res, 401, enterPage(next, "That team password is not right.", name), "text/html; charset=utf-8");
  }
  fails.delete(ip);
  send(res, 303, "", "text/plain", { location: next, "set-cookie": reviewerCookie(req, name) });
}

// --- the personal "JADM Comment" button -----------------------------------------

/*
 * A bookmarklet: on jadm.ai it hands the widget the reviewer's token and loads
 * it from this server. Anywhere else it says where to use it. jadm.ai sends
 * no Content-Security-Policy, so the page accepts the script.
 */
function bookmarklet(token, origin) {
  const code =
    `(function(){if(location.hostname!==${JSON.stringify(TARGET.hostname)}){alert("Open ${TARGET.hostname} first, then click JADM Comment.");return}` +
    // Already on in this tab: hand it this (perhaps newer) token instead of
    // loading a second copy.
    `if(window.__jadmReview){window.__jadmReview.setToken&&window.__jadmReview.setToken(${JSON.stringify(token)});return}` +
    `window.__jadmReviewToken=${JSON.stringify(token)};` +
    `var s=document.createElement("script");s.src=${JSON.stringify(`${origin}${P}/widget.js`)}+"?v="+Date.now();` +
    // Names the address it tried, so a button made on another copy of the
    // site (a local one, say) is easy to tell apart.
    `s.onerror=function(){alert(${JSON.stringify(`The review site (${new URL(origin || "http://unknown").host}) did not answer. Open ${origin || "the review link"} once, then click JADM Comment again. If it still fails, get a new button from the review link.`)})};` +
    `document.body.appendChild(s)})()`;
  return `javascript:${encodeURIComponent(code)}`;
}

function setupPage(name, origin) {
  const href = bookmarklet(tokenFor(name), origin);
  const site = TARGET.hostname;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Your JADM Comment button</title><style>
:root{--bg:#f4f4f4;--panel:#fff;--text:#161616;--muted:#525252;--line:#e0e0e0;--blue:#0f62fe;--blue2:#0353e9;--code:#f4f4f4}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--panel:#262626;--text:#f4f4f4;--muted:#c6c6c6;--line:#393939;--blue:#4589ff;--blue2:#6ea6ff;--code:#161616}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:40px 16px 64px}h1{font-size:28px;font-weight:600;margin:0 0 4px}.lead{color:var(--muted);margin:0 0 32px}
ol{list-style:none;padding:0;margin:0;display:grid;gap:12px;counter-reset:s}
li{background:var(--panel);padding:20px 20px 20px 64px;position:relative;counter-increment:s}
li::before{content:counter(s);position:absolute;left:20px;top:18px;width:28px;height:28px;border-radius:50%;background:var(--blue);color:#fff;display:grid;place-items:center;font-weight:600;font-size:14px}
li>b{display:block;margin-bottom:4px}li p{margin:0;color:var(--muted)}kbd{font:inherit;font-size:14px;background:var(--code);border:1px solid var(--line);padding:1px 6px}
.drag{display:inline-flex;align-items:center;gap:10px;margin:14px 0 6px;padding:12px 20px;background:var(--blue);color:#fff;text-decoration:none;font-weight:600;border-radius:4px;cursor:grab;box-shadow:0 2px 8px rgba(0,0,0,.2)}
.drag:hover{background:var(--blue2)}a{color:var(--blue)}
details{margin-top:24px;background:var(--panel);padding:16px 20px}summary{cursor:pointer;font-weight:600}
textarea{width:100%;height:84px;margin-top:8px;font:12px/1.4 ui-monospace,monospace;background:var(--code);color:var(--text);border:1px solid var(--line);padding:8px;resize:none}
.copy{margin-top:8px;padding:8px 14px;border:0;background:var(--blue);color:#fff;font:inherit;font-size:14px;cursor:pointer}
.foot{margin-top:24px;font-size:14px;color:var(--muted)}
</style></head><body><main>
<h1>Your JADM Comment button</h1>
<p class="lead">Hi ${esc(name)}. This button puts the comment tool on top of the real ${esc(site)}. Your comments are signed with your name and the whole team sees them.</p>
<ol>
<li><b>Show your bookmarks bar</b><p>Press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>B</kbd> (on a Mac <kbd>⌘</kbd> + <kbd>Shift</kbd> + <kbd>B</kbd>).</p></li>
<li><b>Drag this button up to your bookmarks bar</b>
<a class="drag" href="${esc(href)}" id="bm" title="Drag me to your bookmarks bar">💬 JADM Comment</a>
<p>Hold it with the mouse and drop it on the bar at the top of the browser.</p></li>
<li><b>Open ${esc(site)} and sign in like you always do</b><p>Google is fine. <a href="${esc(TARGET.origin)}/" target="_blank" rel="noopener">Open ${esc(site)}</a></p></li>
<li><b>Click “JADM Comment” in your bookmarks bar</b><p>The <b>Comment</b> button and everyone's pins appear at the bottom right. After you reload a page, click it once more.</p></li>
</ol>
<details><summary>Cannot drag it? Add it by hand</summary>
<p>Press <b>Copy</b>, then make a new bookmark named <b>JADM Comment</b> and paste this as its address (URL):</p>
<ul style="margin:8px 0;padding-left:20px;color:var(--muted)">
<li style="background:none;padding:0;margin:2px 0;counter-increment:none"><b>Chrome / Edge:</b> right-click the bookmarks bar → <i>Add page…</i> (Edge: <i>Add favorite</i>)</li>
<li style="background:none;padding:0;margin:2px 0;counter-increment:none"><b>Firefox:</b> right-click the bookmarks toolbar → <i>Add Bookmark…</i></li>
<li style="background:none;padding:0;margin:2px 0;counter-increment:none"><b>Safari:</b> bookmark any page (<kbd>⌘</kbd> + <kbd>D</kbd>), then in <i>Bookmarks → Edit Bookmarks</i> change its address to this</li>
</ul>
<textarea readonly id="code">${esc(href)}</textarea><button class="copy" type="button" id="copy">Copy</button></details>
<p class="foot">This button works with <b>${esc(new URL(origin || "http://unknown").host)}</b>. Already have a JADM Comment bookmark from somewhere else? Delete it and use this one.</p>
<p class="foot">This button is yours: it signs comments as ${esc(name)}, so do not send it to anyone. · <a href="${P}/">See all feedback</a> · <a href="${P}/leave">Not ${esc(name)}?</a></p>
</main><script>
document.getElementById("bm").addEventListener("click",function(e){e.preventDefault();alert("Drag this button up to your bookmarks bar, then click it while you are on ${esc(site)}.")});
document.getElementById("copy").addEventListener("click",function(){var t=document.getElementById("code");t.select();try{navigator.clipboard.writeText(t.value)}catch(_){document.execCommand("copy")}this.textContent="Copied"});
</script></body></html>`;
}

// --- the review's own pages and API -------------------------------------------

function file(res, name, type) {
  fs.readFile(path.join(HERE, "public", name), (err, buf) => {
    if (err) return send(res, 404, "Not found");
    send(res, 200, buf, type, { "cache-control": "no-cache" });
  });
}

function parseShot(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  return m ? { type: m[1], buf: Buffer.from(m[2], "base64") } : null;
}

// The page's last problems, kept short: every comment's copy is sent to every
// reviewer with the list.
function cleanTech(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(-15).map((e) => ({
    type: oneOf(e?.type, ["error", "console", "request"], "error"),
    text: str(e?.text, 300),
    at: num(e?.at),
  }));
}

async function own(req, res, url, name) {
  const p = url.pathname.replace(/\/+$/, "") || P;
  const m = /^\/__review\/api\/comments\/([0-9a-f-]{36})$/.exec(p);

  if (req.method === "GET" && p === P) return file(res, "board.html", "text/html; charset=utf-8");
  if (req.method === "GET" && p === `${P}/leave`) {
    return send(res, 302, "", "text/plain", { location: `${P}/enter`, "set-cookie": reviewerCookie(req, "", 0) });
  }
  if (req.method === "GET" && p === `${P}/setup`) {
    return send(res, 200, setupPage(name, publicOrigin(req)), "text/html; charset=utf-8");
  }
  if (req.method === "GET" && p === `${P}/api/me`) {
    return json(res, 200, { name, store: store.kind, autoLogin: AUTO_LOGIN, mirror: MIRROR, target: TARGET.origin });
  }

  // Every open tab asks every few seconds. With ?v= it says which version it
  // already has, and an unchanged list costs a few bytes instead of all of it.
  if (req.method === "GET" && p === `${P}/api/comments`) {
    const v = await store.version();
    if (url.searchParams.get("v") === v) return json(res, 200, { v, unchanged: true });
    return json(res, 200, { v, comments: (await store.list()).map(withShotKey) });
  }

  if (req.method === "POST" && p === `${P}/api/comments`) {
    const b = await readJson(req);
    const text = str(b.text, 4000);
    if (!text) return json(res, 400, { error: "text_required" });
    const page = b.page || {};
    const target = b.target || {};
    const viewport = b.viewport || {};
    const now = new Date().toISOString();
    const comment = await store.create(
      {
        author: name,
        createdAt: now,
        updatedAt: now,
        kind: oneOf(b.kind, KINDS, "bug"),
        priority: oneOf(b.priority, PRIORITIES, "medium"),
        status: "open",
        text,
        page: { origin: str(page.origin, 200), url: str(page.url, 2000), key: str(page.key, 1000), title: str(page.title, 300) },
        target: {
          selector: str(target.selector, 1000),
          label: str(target.label, 200),
          xPct: num(target.xPct),
          yPct: num(target.yPct),
          pageX: num(target.pageX),
          pageY: num(target.pageY),
        },
        viewport: { w: num(viewport.w), h: num(viewport.h), dpr: num(viewport.dpr) },
        userAgent: str(req.headers["user-agent"], 400),
        tech: cleanTech(b.tech),
        replies: [],
      },
      parseShot(b.screenshot),
    );
    return json(res, 201, { comment: withShotKey(comment) });
  }

  if (m && req.method === "PATCH") {
    const b = await readJson(req);
    const replyText = b.reply ? str(b.reply.text, 4000) : "";
    if (b.reply && !replyText) return json(res, 400, { error: "text_required" });
    const now = new Date().toISOString();
    const comment = await store.update(m[1], (c) => {
      const next = { ...c, updatedAt: now, replies: [...(c.replies || [])] };
      if (b.status !== undefined && STATUSES.includes(b.status) && b.status !== c.status) {
        next.status = b.status;
        next.statusBy = name;
        next.statusAt = now;
      }
      if (b.priority !== undefined) next.priority = oneOf(b.priority, PRIORITIES, c.priority);
      if (b.kind !== undefined) next.kind = oneOf(b.kind, KINDS, c.kind);
      if (replyText) next.replies.push({ author: name, text: replyText, at: now });
      return next;
    });
    return comment ? json(res, 200, { comment: withShotKey(comment) }) : json(res, 404, { error: "not_found" });
  }

  if (m && req.method === "DELETE") {
    const c = await store.get(m[1]);
    if (!c) return json(res, 404, { error: "not_found" });
    // Only the person who wrote it; anyone else marks it fixed or won't-fix.
    if (c.author !== name) return json(res, 403, { error: "only_the_author_can_delete" });
    await store.remove(m[1]);
    return send(res, 204, "");
  }

  const s = /^\/__review\/shots\/([0-9a-f-]{36})$/.exec(p);
  if (s && req.method === "GET") return sendShot(res, s[1]);

  send(res, 404, "Not found");
}

async function sendShot(res, id) {
  const shot = await store.shot(id);
  if (!shot) return send(res, 404, "Not found");
  return send(res, 200, shot.buf, shot.type, { "cache-control": "private, max-age=86400" });
}

// A screenshot opened by its own key (see shotKey), with no login needed.
function shotByKey(url) {
  const s = /^\/__review\/shots\/([0-9a-f-]{36})$/.exec(url.pathname);
  const k = url.searchParams.get("k");
  if (!s || typeof k !== "string" || k.length !== 22) return null;
  const a = Buffer.from(k);
  const b = Buffer.from(shotKey(s[1]));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? s[1] : null;
}

// --- signing reviewers in to jadm.ai ------------------------------------------------

/*
 * jadm.ai's own sign-in, done by this server with the test login, the way its
 * sign-in screen does it: POST /api/auth/sign-in sets the session cookie, and
 * the app, landing on "?signin=complete", trades that cookie for a token
 * (session.tsx takeRedirectOutcome → renewSession). A session the browser
 * already has is continued (/api/auth/refresh) rather than replaced, which
 * keeps the number of sign-ins low; jadm.ai allows 30 per 10 minutes from one
 * address, and every reviewer comes from this server's address.
 */
function withSignin(next) {
  const u = new URL(next, "http://mirror");
  u.searchParams.set("signin", "complete");
  return u.pathname + u.search + u.hash;
}

function signinProblemPage(next, message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>JADM Review</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f4f4;color:#161616;font:16px/1.5 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{background:#fff;padding:32px;width:min(480px,100%);border-top:4px solid #da1e28}h1{font-size:20px;margin:0 0 8px}
p{margin:0 0 16px;color:#393939}code{background:#f4f4f4;padding:2px 6px;font-size:14px}a{color:#0f62fe;margin-right:16px}
</style></head><body><main><h1>Could not sign you in to jadm.ai</h1>
<p>The review copy tried to sign in with the shared test login, and jadm.ai said:</p><p><code>${esc(message)}</code></p>
<p>Please tell the person who sent you this link.</p>
<p><a href="${AUTO_PATH}?next=${encodeURIComponent(next)}">Try again</a><a href="${P}/">See the feedback board</a></p></main></body></html>`;
}

async function jadmAuth(req, path, body, cookie) {
  const r = await fetch(`${TARGET.origin}/api/auth/${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": String(req.headers["user-agent"] || "jadm-review"),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok && Boolean(data.accessToken), status: r.status, data, cookies: r.headers.getSetCookie() };
}

async function autoSignIn(req, res, url) {
  const next = safeNext(url.searchParams.get("next"));
  if (!AUTO_LOGIN) return redirect(res, next);
  try {
    const held = cookies(req)[JADM_SESSION_COOKIE];
    let out = held ? await jadmAuth(req, "refresh", null, `${JADM_SESSION_COOKIE}=${held}`) : null;
    if (!out?.ok) out = await jadmAuth(req, "sign-in", { email: LOGIN_EMAIL, password: LOGIN_PASSWORD });
    if (!out.ok) {
      const why =
        out.data.status && out.data.status !== "signed-in"
          ? "The test login asks for a second step (a code). Ask for a test login without two-step sign-in."
          : out.data.message || `jadm.ai answered ${out.status}`;
      console.error(`auto sign-in failed (${out.status}): ${why}`);
      return send(res, 502, signinProblemPage(next, why), "text/html; charset=utf-8");
    }
    res.writeHead(303, {
      location: withSignin(next),
      "set-cookie": out.cookies.map((c) => c.replace(/;\s*domain=[^;]*/gi, "")),
      "cache-control": "no-store",
    });
    res.end();
  } catch (err) {
    console.error("auto sign-in: jadm.ai did not answer:", err.message);
    send(res, 502, signinProblemPage(next, "jadm.ai did not answer. Try again in a minute."), "text/html; charset=utf-8");
  }
}

// Google and Microsoft send people back to the address registered for jadm.ai,
// never to this copy, so those buttons cannot work here; say so instead of
// leaving the reviewer on jadm.ai itself.
function oauthHere(req, res) {
  if (AUTO_LOGIN) return redirect(res, `${AUTO_PATH}?next=%2F`);
  send(
    res,
    200,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JADM Review</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f4f4;font:16px/1.5 system-ui,sans-serif;padding:16px">
<main style="background:#fff;padding:32px;max-width:440px;border-top:4px solid #0f62fe"><h1 style="font-size:20px;margin:0 0 8px">Google and Microsoft sign-in do not work here</h1>
<p>On the review copy, sign in with an email and password. <a href="/">Back to sign-in</a></p></main></body></html>`,
    "text/html; charset=utf-8",
  );
}

// --- the mirror -----------------------------------------------------------------

const HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade", "host",
]);

// Collects console errors, uncaught errors and failed requests from the moment
// the page starts, so a comment can carry "what went wrong technically" too.
// Inline and first in <head>, so it is in place before the app's own code runs.
const EARLY = `<script>(function(){if(window.__jadmReviewLog)return;var L=window.__jadmReviewLog=[];
function add(t,x){try{L.push({type:t,text:String(x).slice(0,500),at:Date.now()});if(L.length>30)L.shift()}catch(_){}}
function mine(u){return String(u||"").indexOf("${P}/")>=0}
addEventListener("error",function(e){if(e&&e.message)add("error",e.message+(e.filename?" ("+String(e.filename).split("/").pop()+":"+e.lineno+")":""))},true);
addEventListener("unhandledrejection",function(e){var r=e&&e.reason;add("error","Unhandled: "+(r&&r.message||r))});
var ce=console.error;console.error=function(){try{add("console",Array.prototype.map.call(arguments,function(a){return a&&a.message?a.message:typeof a==="string"?a:JSON.stringify(a)}).join(" "))}catch(_){}return ce.apply(console,arguments)};
var f=window.fetch;if(f)window.fetch=function(i,o){var u=typeof i==="string"?i:i&&i.url||String(i);var m=(o&&o.method)||(i&&i.method)||"GET";
return f.apply(this,arguments).then(function(r){if(r.status>=400&&!mine(u))add("request",m+" "+String(u).replace(location.origin,"")+" -> "+r.status);return r},
function(e){if(!mine(u))add("request",m+" "+String(u).replace(location.origin,"")+" -> failed ("+(e&&e.message)+")");throw e})};
var xo=XMLHttpRequest.prototype.open,xs=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open=function(m,u){this.__jr=[m,u];return xo.apply(this,arguments)};
XMLHttpRequest.prototype.send=function(){var x=this;x.addEventListener("loadend",function(){if(x.__jr&&(x.status>=400||x.status===0)&&!mine(x.__jr[1]))add("request",x.__jr[0]+" "+x.__jr[1]+" -> "+(x.status||"failed"))});return xs.apply(this,arguments)};
})();</script>${
  AUTO_LOGIN
    ? // A tab with no jadm.ai token goes through the automatic sign-in once.
      // "jadm.session" is where the app keeps its token (token-store.ts). The
      // 30-second guard means a failed sign-in can never loop.
      `<script>(function(){try{var s=sessionStorage;if(s.getItem("jadm.session")||/[?&]signin(_error)?=/.test(location.search))return;
if(/^\\/(preview|design|screens\\.html)/.test(location.pathname))return;
var t=+(s.getItem("jadm-review-auto")||0);if(Date.now()-t<30000)return;s.setItem("jadm-review-auto",String(Date.now()));
location.replace("${AUTO_PATH}?next="+encodeURIComponent(location.pathname+location.search+location.hash))}catch(_){}})();</script>`
    : ""
}<meta name="robots" content="noindex">`;
const WIDGET = `<script src="${P}/widget.js" defer></script>`;

function injectInto(html) {
  // Absolute links to the live site stay inside the mirror.
  html = html.split(TARGET.origin).join("");
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + EARLY) : EARLY + html;
  const at = html.toLowerCase().lastIndexOf("</body>");
  return at >= 0 ? html.slice(0, at) + WIDGET + html.slice(at) : html + WIDGET;
}

const DECODERS = {
  identity: (s) => s,
  gzip: (s) => s.pipe(zlib.createGunzip()),
  "x-gzip": (s) => s.pipe(zlib.createGunzip()),
  deflate: (s) => s.pipe(zlib.createInflate()),
  br: (s) => s.pipe(zlib.createBrotliDecompress()),
  ...(typeof zlib.createZstdDecompress === "function" ? { zstd: (s) => s.pipe(zlib.createZstdDecompress()) } : {}),
};

function localize(location) {
  if (typeof location !== "string") return location;
  for (const origin of [TARGET.origin, TARGET.origin.replace(/^https:/, "http:")]) {
    if (location === origin) return "/";
    if (location.startsWith(`${origin}/`)) return location.slice(origin.length);
  }
  return location;
}

function proxy(req, res, url) {
  const page = req.method === "GET" && wantsHtml(req);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  headers.host = TARGET.host;
  // Our own cookie is ours; jadm.ai never sees it.
  const theirs = String(req.headers.cookie || "")
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(`${COOKIE}=`))
    .join("; ");
  if (theirs) headers.cookie = theirs;
  else delete headers.cookie;
  if (headers.origin) headers.origin = TARGET.origin;
  if (headers.referer) {
    try {
      const r = new URL(headers.referer);
      headers.referer = TARGET.origin + r.pathname + r.search;
    } catch {
      delete headers.referer;
    }
  }
  for (const k of Object.keys(headers)) if (k.startsWith("x-forwarded-")) delete headers[k];
  // Pages come back uncompressed so the widget can be added; everything else
  // only in encodings this server can also read, in case it turns out to be HTML.
  headers["accept-encoding"] = page ? "identity" : "gzip, deflate, br";
  if (page) {
    delete headers["if-none-match"];
    delete headers["if-modified-since"];
  }

  const client = TARGET.protocol === "https:" ? https : http;
  const up = client.request(
    {
      protocol: TARGET.protocol,
      hostname: TARGET.hostname,
      port: TARGET.port || undefined,
      method: req.method,
      path: url.pathname + url.search,
      headers,
      // Only the wait for jadm.ai to start answering; some of its AI calls
      // take a minute or more. Once it answers, downloads may take as long as
      // they need.
      timeout: 300_000,
    },
    (upRes) => {
      up.setTimeout(0);
      const out = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (HOP.has(k) || k === "strict-transport-security") continue;
        if (k === "set-cookie") out[k] = v.map((c) => c.replace(/;\s*domain=[^;]*/gi, ""));
        else if (k === "location") out[k] = localize(v);
        else out[k] = v;
      }
      const html = String(upRes.headers["content-type"] || "").includes("text/html");
      const enc = String(upRes.headers["content-encoding"] || "").trim().toLowerCase();
      const decode = DECODERS[enc || "identity"];
      // Anything that is not a page, or a page in an encoding we cannot read,
      // goes through untouched.
      if (!html || !decode || req.method === "HEAD" || upRes.statusCode === 204 || upRes.statusCode === 304) {
        res.writeHead(upRes.statusCode, out);
        upRes.pipe(res);
        return;
      }
      const body = decode(upRes);
      const chunks = [];
      body.on("data", (c) => chunks.push(c));
      body.on("error", () => res.destroy());
      body.on("end", () => {
        const buf = Buffer.from(injectInto(Buffer.concat(chunks).toString("utf8")), "utf8");
        delete out["content-encoding"];
        delete out.etag;
        delete out["last-modified"];
        out["content-length"] = buf.length;
        out["cache-control"] = "no-cache";
        res.writeHead(upRes.statusCode, out);
        res.end(buf);
      });
    },
  );
  up.on("timeout", () => up.destroy(new Error("jadm.ai took too long to answer")));
  up.on("error", (err) => {
    if (res.headersSent) return res.destroy();
    send(
      res,
      502,
      page
        ? `<!doctype html><meta charset="utf-8"><title>JADM Review</title><body style="font:16px system-ui;padding:32px"><h1 style="font-size:20px">jadm.ai did not answer</h1><p>${esc(err.message)}</p><p><a href="">Try again</a></p></body>`
        : JSON.stringify({ error: "upstream_unreachable", message: err.message }),
      page ? "text/html; charset=utf-8" : "application/json",
    );
  });
  res.on("close", () => {
    if (!res.writableFinished) up.destroy();
  });
  req.pipe(up);
}

// --- routing --------------------------------------------------------------------

function setupProblemPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JADM Review</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f4f4;color:#161616;font:16px/1.5 system-ui,sans-serif;padding:16px">
<main style="background:#fff;padding:32px;max-width:520px;border-top:4px solid #da1e28"><h1 style="font-size:20px;margin:0 0 8px">JADM Review is not set up yet</h1>
<p>${esc(setupProblem)}</p><p style="color:#525252;font-size:14px">The README in the project says how.</p></main></body></html>`;
}

// One request in, one answer out. Run as a server below, or as the Vercel
// function in api/index.js.
export async function handle(req, res) {
  try {
    const url = new URL(req.url, "http://mirror");
    const ours = url.pathname === P || url.pathname.startsWith(`${P}/`);
    if (ours && allowJadm(req, res) && req.method === "OPTIONS") return send(res, 204, "");
    if (setupProblem) {
      return wantsHtml(req)
        ? send(res, 503, setupProblemPage(), "text/html; charset=utf-8")
        : json(res, 503, { error: "not_set_up", message: setupProblem });
    }
    if (url.pathname === `${P}/health`) return send(res, 200, "ok");
    // The widget holds no secrets; the button loads it before any token is checked.
    if (url.pathname === `${P}/widget.js` && req.method === "GET") return file(res, "widget.js", "text/javascript; charset=utf-8");
    if (url.pathname === `${P}/enter`) return await enter(req, res, url);
    // Everything else needs the comments. A database that does not answer
    // right now is tried again on the next request.
    try {
      await getStore();
    } catch (err) {
      console.error("comments store:", err.message);
      const msg = "The comments database could not be reached just now. Wait a few seconds and try again.";
      return wantsHtml(req) ? send(res, 503, msg) : json(res, 503, { error: "db_unavailable", message: msg });
    }
    const keyed = req.method === "GET" && shotByKey(url);
    if (keyed) return await sendShot(res, keyed);
    const name = reviewer(req);
    if (!name) {
      if (req.method === "GET" && wantsHtml(req)) return redirect(res, `${P}/enter?next=${encodeURIComponent(req.url)}`);
      return json(res, 401, { error: "enter_your_name_first", enter: `${P}/enter` });
    }
    if (ours) return await own(req, res, url, name);
    // Without the mirror, this site's front door is the button page.
    if (!MIRROR) {
      if (req.method === "GET" && wantsHtml(req)) return redirect(res, `${P}/setup`);
      return json(res, 404, { error: "not_found" });
    }
    if (url.pathname === AUTO_PATH && req.method === "GET") return await autoSignIn(req, res, url);
    if (url.pathname.startsWith("/api/auth/oauth/") && req.method === "GET") return oauthHere(req, res);
    proxy(req, res, url);
  } catch (err) {
    if (!err.status) console.error(err);
    if (!res.headersSent) json(res, err.status || 500, { error: err.status ? err.message : "server_error" });
    else res.destroy();
  }
}

if (!VERCEL) {
  http.createServer(handle).listen(PORT, () => {
    console.log(`JADM Review on http://localhost:${PORT}  ->  ${TARGET.origin}${MIRROR ? " (mirror on)" : " (comment button; mirror off)"}`);
    if (setupProblem) return console.log(`  NOT SET UP: ${setupProblem}`);
    console.log(`  comments: ${!store ? "database not reachable yet" : store.kind === "postgres" ? "PostgreSQL" : "./data (local files)"}`);
    console.log(`  team password: ${TEAM_PASSWORD ? "on" : "OFF - anyone with the link can enter"}`);
    console.log(`  jadm.ai sign-in: ${AUTO_LOGIN ? `automatic, as ${LOGIN_EMAIL}` : "each reviewer signs in themselves"}`);
  });
}
