/*
 * JADM Review widget. Loaded onto the real jadm.ai by a reviewer's "JADM
 * Comment" bookmark button (which sets window.__jadmReviewToken first), or
 * added to every page of the mirror by server.js.
 *
 * "Comment" → click anything on the page → say what is wrong. Each comment
 * keeps the page, the element, where on it you clicked, your screen size, a
 * screenshot with the spot circled, and any errors the page hit. Comments
 * show as numbered pins on their page for everyone; /__review/ lists them all.
 *
 * Everything lives in one shadow root, so the site's styles cannot reach the
 * widget and the widget's cannot reach the site.
 */
(() => {
  if (window.top !== window) return; // the design canvas shows screens in iframes
  if (window.__jadmReview) return;
  window.__jadmReview = true;

  // Where the review server is: this script's own address. On the real
  // jadm.ai that is another site, reached with the button's token; on the
  // mirror it is this site, reached with its cookie.
  const ORIGIN = document.currentScript ? new URL(document.currentScript.src, location.href).origin : location.origin;
  const REMOTE = ORIGIN !== location.origin;
  // The reviewer's token. It can change while the tab is open: clicking a
  // newer button calls setToken instead of loading a second widget.
  let TOKEN = window.__jadmReviewToken || "";
  let AUTH = TOKEN ? { "x-review-token": TOKEN } : {};
  const BASE = `${ORIGIN}/__review`;
  const API = `${BASE}/api/comments`;
  // Each screenshot comes with its own key from the server, so the token
  // never appears in an address.
  const shotUrl = (c) => `${BASE}/shots/${encodeURIComponent(c.id)}?k=${encodeURIComponent(c.shotKey || "")}`;

  // The mirror starts this log before the app runs (server.js EARLY). On the
  // real jadm.ai it starts now, when the button is clicked: errors and failed
  // requests from here on go with each comment.
  if (!window.__jadmReviewLog) {
    const log = (window.__jadmReviewLog = []);
    const add = (type, text) => {
      log.push({ type, text: String(text).slice(0, 500), at: Date.now() });
      if (log.length > 30) log.shift();
    };
    const mine = (u) => String(u || "").includes("/__review/");
    addEventListener("error", (e) => { if (e?.message) add("error", `${e.message}${e.filename ? ` (${String(e.filename).split("/").pop()}:${e.lineno})` : ""}`); }, true);
    addEventListener("unhandledrejection", (e) => add("error", `Unhandled: ${e?.reason?.message || e?.reason}`));
    const ce = console.error;
    console.error = function (...args) {
      try { add("console", args.map((a) => a?.message || (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); } catch { /* unprintable */ }
      return ce.apply(console, args);
    };
    const f = window.fetch;
    window.fetch = function (input, init) {
      const u = typeof input === "string" ? input : input?.url || String(input);
      const m = init?.method || input?.method || "GET";
      return f.apply(this, arguments).then(
        (r) => { if (r.status >= 400 && !mine(u)) add("request", `${m} ${String(u).replace(location.origin, "")} -> ${r.status}`); return r; },
        (err) => { if (!mine(u)) add("request", `${m} ${String(u).replace(location.origin, "")} -> failed (${err?.message})`); throw err; },
      );
    };
  }
  const SHOT_LIB = "https://cdn.jsdelivr.net/npm/html2canvas-pro@1.5.8/dist/html2canvas-pro.min.js";
  const HIDE_KEY = "jadm-review-hide-pins";
  const KINDS = [
    ["bug", "Bug"],
    ["design", "Design"],
    ["wording", "Wording"],
    ["idea", "Idea"],
    ["question", "Question"],
  ];
  const PRIORITIES = [
    ["high", "High"],
    ["medium", "Medium"],
    ["low", "Low"],
  ];

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
  };

  let me = "";
  let comments = [];
  let picking = false;
  let hovered = null;
  let pinsHidden = store.get(HIDE_KEY) === "1";

  // The screen a comment belongs to: the path plus the app's hash route, read
  // the way jadm.ai's router reads it (router.ts parseHash), so "/", "/#/" and
  // "/#/dashboard" are one screen and "?filter=…" inside the hash is ignored.
  const normKey = (path, hash) => {
    let h = String(hash || "").replace(/^#\/?/, "").split("?")[0].replace(/\/+$/, "");
    if (!h) h = "dashboard";
    else if (h === "settings") h = "settings/general";
    else if (h === "admin") h = "admin/overview";
    return `${path}#/${h}`;
  };
  const pageKey = () => normKey(location.pathname, location.hash);
  const keyOf = (c) => {
    const k = c.page.key || "/";
    const i = k.indexOf("#");
    return i < 0 ? normKey(k, "") : normKey(k.slice(0, i), k.slice(i));
  };

  // --- shell ---------------------------------------------------------------

  const host = document.createElement("div");
  host.id = "jadm-review";
  host.setAttribute("dir", "ltr");
  const root = host.attachShadow({ mode: "open" });
  // Keys typed in the widget belong to the widget. jadm.ai listens for "/"
  // and Ctrl+K on the whole page and would jump to its own search.
  for (const t of ["keydown", "keypress", "keyup"]) host.addEventListener(t, (e) => e.stopPropagation());
  root.innerHTML = `<style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; }
    .bar { position: fixed; right: 16px; bottom: 16px; display: flex; gap: 1px; pointer-events: auto;
      box-shadow: 0 2px 12px rgba(0,0,0,.28); z-index: 2147483002; }
    .bar button { border: 0; height: 40px; padding: 0 14px; font-size: 14px; color: #fff; background: #161616; cursor: pointer;
      display: inline-flex; align-items: center; gap: 8px; }
    .bar button:hover { background: #353535; }
    .bar button:focus-visible, .card button:focus-visible, .pin:focus-visible { outline: 2px solid #4589ff; outline-offset: 2px; }
    .bar button.primary { background: #0f62fe; }
    .bar button.primary:hover { background: #0353e9; }
    .bar button.primary.on { background: #da1e28; }
    .bar button[hidden] { display: none; }
    .bar button[data-act="signin"] { background: #24a148; }
    .bar button[data-act="signin"]:hover { background: #198038; }
    .bar .count { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: #fff; color: #161616;
      font-size: 12px; font-weight: 600; display: inline-grid; place-items: center; }
    .hint { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); background: #161616; color: #fff; font-size: 14px;
      padding: 10px 16px; pointer-events: none; box-shadow: 0 2px 12px rgba(0,0,0,.28); z-index: 2147483002; max-width: calc(100vw - 32px); }
    .hint kbd { font: inherit; background: #393939; padding: 1px 6px; }
    .hl { position: fixed; border: 2px solid #da1e28; background: rgba(218,30,40,.08); pointer-events: none; z-index: 2147483001;
      transition: all 60ms linear; }
    .hl span { position: absolute; left: -2px; bottom: 100%; background: #da1e28; color: #fff; font-size: 12px; padding: 2px 6px;
      white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
    .pin { position: fixed; width: 28px; height: 28px; margin: -28px 0 0 0; border-radius: 50% 50% 50% 0; transform: rotate(-45deg);
      transform-origin: 0 100%; background: #da1e28; border: 2px solid #fff; box-shadow: 0 1px 6px rgba(0,0,0,.4); pointer-events: auto;
      cursor: pointer; display: grid; place-items: center; z-index: 2147483001; padding: 0; }
    .pin b { transform: rotate(45deg); color: #fff; font-size: 12px; font-weight: 600; }
    .pin[data-count]::after { content: attr(data-count); position: absolute; top: -8px; right: -8px; transform: rotate(45deg);
      min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: #161616; color: #fff; font-size: 10px;
      font-weight: 600; line-height: 16px; text-align: center; }
    .card .preview { margin-top: 10px; font-size: 12px; color: #525252; }
    .card .preview img { display: block; width: 100%; border: 1px solid #e0e0e0; margin-bottom: 4px; }
    .card .choice { display: block; width: 100%; text-align: left; border: 0; border-bottom: 1px solid #e0e0e0; background: #fff;
      padding: 10px 4px; font-size: 14px; color: #161616; cursor: pointer; }
    .card .choice:hover { background: #f4f4f4; }
    .card .choice span { color: #525252; font-size: 13px; }
    .pin.fixed { background: #24a148; }
    .pin.wontfix { background: #6f6f6f; }
    .pin.flash { animation: flash 0.6s ease-in-out 4; }
    @keyframes flash { 50% { box-shadow: 0 0 0 10px rgba(218,30,40,.35); } }
    .card { position: fixed; width: 340px; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px); max-height: calc(100dvh - 32px); overflow: auto; background: #fff;
      color: #161616; box-shadow: 0 4px 24px rgba(0,0,0,.3); pointer-events: auto; z-index: 2147483003; font-size: 14px; }
    .card header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 16px; border-bottom: 1px solid #e0e0e0;
      font-weight: 600; }
    .card header small { font-weight: 400; color: #6f6f6f; }
    .card header button { border: 0; background: none; font-size: 20px; line-height: 1; cursor: pointer; color: #525252; padding: 0 4px; }
    .card .body { padding: 12px 16px 16px; }
    .card label { display: block; font-size: 12px; color: #525252; margin: 12px 0 6px; }
    .card textarea { width: 100%; border: 0; border-bottom: 1px solid #8d8d8d; background: #f4f4f4; padding: 9px 10px;
      font-size: 14px; color: #161616; resize: vertical; min-height: 96px; }
    .card textarea:focus { outline: 2px solid #0f62fe; outline-offset: -2px; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chips button { border: 1px solid #c6c6c6; background: #fff; color: #161616; height: 30px; padding: 0 12px; border-radius: 15px;
      font-size: 13px; cursor: pointer; }
    .chips button[aria-pressed=true] { background: #161616; border-color: #161616; color: #fff; }
    .row { display: flex; gap: 8px; margin-top: 16px; }
    .row button { flex: 1; height: 40px; border: 0; font-size: 14px; cursor: pointer; }
    .row .go { background: #0f62fe; color: #fff; }
    .row .go:hover { background: #0353e9; }
    .row .go:disabled { background: #c6c6c6; cursor: default; }
    .row .ghost { background: #e0e0e0; color: #161616; }
    .row .ghost:hover { background: #c6c6c6; }
    .row .danger { background: #fff; color: #da1e28; border: 1px solid #da1e28; flex: 0 0 auto; padding: 0 12px; }
    .check { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 13px; color: #393939; }
    .target { font-size: 12px; color: #525252; background: #f4f4f4; padding: 6px 8px; margin-bottom: 4px; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; }
    .meta { font-size: 12px; color: #6f6f6f; margin-bottom: 8px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .tag { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 10px; background: #e0e0e0; color: #161616; }
    .tag.high { background: #ffd7d9; color: #a2191f; }
    .tag.medium { background: #fcf4d6; color: #8e6a00; }
    .tag.low { background: #e5f6ff; color: #00539a; }
    .tag.fixed { background: #defbe6; color: #0e6027; }
    .tag.wontfix { background: #e0e0e0; color: #393939; }
    .text { white-space: pre-wrap; word-wrap: break-word; margin: 0 0 8px; }
    .reply { border-top: 1px solid #e0e0e0; padding-top: 8px; margin-top: 8px; }
    .reply .who { font-size: 12px; color: #6f6f6f; }
    .shot { display: block; width: 100%; margin: 8px 0; border: 1px solid #e0e0e0; cursor: zoom-in; }
    .foot { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; margin-top: 12px; }
    a { color: #0f62fe; }
    .toast { position: fixed; right: 16px; bottom: 68px; background: #24a148; color: #fff; padding: 10px 16px; font-size: 14px;
      box-shadow: 0 2px 12px rgba(0,0,0,.28); z-index: 2147483003; max-width: calc(100vw - 32px); }
    .toast.err { background: #da1e28; }
    .stale { position: fixed; right: 16px; bottom: 68px; max-width: min(420px, calc(100vw - 32px)); background: #fff8e1; color: #161616;
      border-left: 4px solid #f1c21b; padding: 12px 16px; font-size: 14px; box-shadow: 0 2px 12px rgba(0,0,0,.28); z-index: 2147483003; }
  </style>
  <div class="layer"></div>
  <div class="bar" role="toolbar" aria-label="Review">
    <button class="primary" data-act="pick" title="Click, then click the spot on the page you want to comment on">Comment</button>
    <button data-act="pins" aria-label="Show or hide pins"><span class="count">0</span></button>
    <button data-act="board" title="Every comment from everyone">All feedback</button>
    <button data-act="signin" hidden title="Sign in to jadm.ai with the review login">Sign in again</button>
  </div>`;

  const layer = root.querySelector(".layer");
  const pickBtn = root.querySelector('[data-act="pick"]');
  const pinsBtn = root.querySelector('[data-act="pins"]');
  const countEl = root.querySelector(".count");
  const signinBtn = root.querySelector('[data-act="signin"]');
  let autoLogin = false;

  // Signed out of jadm.ai (the Sign out button, or its idle time-out) while
  // the review copy signs people in for them: offer the way back, without
  // forcing it, so the sign-in screen itself can still be commented on.
  // "jadm.session" is where the app keeps its token (token-store.ts).
  function updateSignin() {
    let signedIn = true;
    try { signedIn = Boolean(sessionStorage.getItem("jadm.session")); } catch { /* storage blocked */ }
    signinBtn.hidden = !(autoLogin && !signedIn && !/^\/(preview|design|screens\.html)/.test(location.pathname));
  }
  let hintEl = null;
  let hlEl = null;

  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const ago = (iso) => {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
  };
  const label = (list, v) => (list.find(([k]) => k === v) || [v, v])[1];

  function toast(msg, isErr, ms = 3500) {
    const t = el("div", `toast${isErr ? " err" : ""}`, esc(msg));
    t.setAttribute("role", "status");
    root.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  // --- data ---------------------------------------------------------------

  // The list's version as last seen: the server answers "unchanged" to an
  // up-to-date tab instead of sending every comment again.
  let version = "";
  async function refresh() {
    try {
      const r = await fetch(`${API}?v=${encodeURIComponent(version)}`, { cache: "no-store", credentials: "same-origin", headers: AUTH });
      if (r.status === 401) return toEnter();
      if (!r.ok) return;
      const d = await r.json();
      if (d.unchanged) return;
      version = d.v || "";
      comments = d.comments || [];
      renderPins();
    } catch { /* offline for a moment; the next tick retries */ }
  }

  // Not (or no longer) let in. On the mirror that means the name page. On
  // jadm.ai the button itself is out of date (the team password changed):
  // say so where it stays visible, and say where to get a new one.
  let staleEl = null;
  function toEnter() {
    if (!REMOTE) {
      location.href = `${BASE}/enter?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
      return;
    }
    if (staleEl) return;
    staleEl = el(
      "div",
      "stale",
      `Your JADM Comment button is out of date. <a href="${BASE}/setup" target="_blank" rel="noopener">Get a new one</a>, then click it here. Nothing you typed is lost.`,
    );
    staleEl.setAttribute("role", "alert");
    root.appendChild(staleEl);
  }

  window.__jadmReview = {
    setToken(t) {
      if (typeof t !== "string" || !t) return;
      TOKEN = t;
      AUTH = { "x-review-token": t };
      staleEl?.remove();
      staleEl = null;
      version = "";
      refresh();
      toast("Your new JADM Comment button is on.");
    },
  };

  async function send(method, url, body) {
    const r = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...AUTH },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) toEnter();
    if (!r.ok && r.status !== 204) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    version = ""; // something changed; the next refresh fetches the list again
    return r.status === 204 ? null : r.json();
  }

  // What went wrong with a save, in words a reviewer can act on.
  const saveProblem = (err) =>
    err?.status === 401
      ? "Your JADM Comment button is out of date. Get a new one from the review link; your text is kept."
      : err?.status === 413
        ? "That screenshot is too big to send. Untick the screenshot and save again."
        : "Could not save. Check the connection and try again.";

  // --- element identity ---------------------------------------------------

  // A path from a fixed starting point (an id, a test id, or <body>), so it
  // can only ever match the element that was clicked.
  function selectorFor(node) {
    if (!(node instanceof Element)) return "";
    const parts = [];
    let n = node;
    while (n && n.nodeType === 1 && n !== document.documentElement) {
      if (n === document.body) {
        parts.unshift("body");
        break;
      }
      // Generated ids change from render to render and from user to user
      // (React's useId gives ":r5:" or "«r5»"), so they are not anchors.
      if (n.id && !/\d{3,}|[:«»]|^radix-|^headlessui-/.test(n.id)) {
        parts.unshift(`#${CSS.escape(n.id)}`);
        break;
      }
      const testId = n.getAttribute("data-testid");
      if (testId) {
        parts.unshift(`[data-testid="${CSS.escape(testId)}"]`);
        break;
      }
      let part = n.tagName.toLowerCase();
      const parent = n.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === n.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
      parts.unshift(part);
      n = parent;
    }
    return parts.join(" > ");
  }

  // What an element says: its label, its text (for a chart, its axis labels).
  const ownText = (n) =>
    (n.getAttribute?.("aria-label") || (n instanceof SVGElement ? n.textContent : n.innerText) || n.getAttribute?.("placeholder") || n.getAttribute?.("alt") || "")
      .replace(/\s+/g, " ")
      .trim();
  const clip = (t) => `${t.slice(0, 80)}${t.length > 80 ? "…" : ""}`;
  const hasOwnText = (e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());

  // The element in words, shown as "On: …" and kept with the comment. One
  // that says nothing itself (an icon) is named by what it sits in:
  // 'svg in a · "Overdue, not on the ladder"'.
  function describe(node) {
    const tag = node.tagName.toLowerCase();
    const text = ownText(node);
    if (text) return `${tag} · "${clip(text)}"`;
    const named = node.parentElement?.closest("a,button,[role],li,tr,td,th,label,h1,h2,h3,h4,h5,h6,section");
    const t = named ? ownText(named) : "";
    return t ? `${tag} in ${named.tagName.toLowerCase()} · "${clip(t)}"` : tag;
  }
  // The same, with numbers taken out: how a comment recognises its element
  // again even after a count or an amount on it has changed, while a
  // different element (another bubble, another row) never passes.
  const fingerprint = (node) => describe(node).replace(/\d[\d.,]*/g, "#");

  // An element as big as the window: an invisible layer laid over the page
  // (jadm.ai has one), or the page background. Never what a reviewer means.
  const pageSized = (r) => r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9;

  // Things laid over the page that are not content: a see-through layer, a
  // dimming backdrop behind a menu or dialog. Looked through, never picked.
  function isVeil(e) {
    const r = e.getBoundingClientRect();
    if (pageSized(r)) return true;
    const area = r.width * r.height;
    const screen = innerWidth * innerHeight;
    if (e.matches?.('[class*="scrim"],[class*="backdrop"]') && area >= 0.5 * screen) return true;
    const pos = getComputedStyle(e).position;
    return (pos === "fixed" || pos === "absolute") && area >= 0.8 * screen && !ownText(e) && !e.querySelector("img,svg,canvas,video");
  }

  // The element painted on top at a point, past the widget and any veil.
  const topAt = (x, y) => document.elementsFromPoint(x, y).find((e) => e !== host && e !== document.documentElement && e !== document.body && !isVeil(e)) || null;

  // What is under the pointer, as the reviewer sees it: the element painted
  // on top there (past veils), or the nearest thing around it that is real
  // content — text, a control, a picture, a chart. Never something lying
  // underneath what is on top (under a glass top bar, say). Empty space
  // inside a card is the card, not the whole page grid.
  function pickTarget(x, y) {
    const top = topAt(x, y);
    if (!top) return document.body;
    const content = (e) => e.matches?.("a,button,input,select,textarea,label,summary,img,svg,video,canvas,[role]") || hasOwnText(e);
    let hit = null;
    for (let e = top; e && e !== document.body; e = e.parentElement) {
      if (content(e)) {
        hit = e;
        break;
      }
    }
    if (!hit) hit = top.closest("section, article, [class*='card'], header, aside, nav") || top;
    return stableTarget(hit);
  }

  // Whether a point on an element can really be seen right now: the element
  // is visible, the point is inside every box that clips it (a scrolling
  // sidebar, a folded group), and nothing else is painted over it there (the
  // top bar, a menu). Otherwise no pin: a pin is never drawn on something else.
  function placeable(n, x, y) {
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
    if (n.checkVisibility && !n.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    for (let a = n.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
        const r = a.getBoundingClientRect();
        if (x < r.left - 1 || x > r.right + 1 || y < r.top - 1 || y > r.bottom + 1) return false;
      }
      if (cs.position === "fixed") break;
    }
    const top = topAt(x, y);
    if (!top) return false;
    return top === n || n.contains(top) || (getComputedStyle(n).pointerEvents === "none" && top.contains(n));
  }

  // What a reviewer points at, as something that stays put. Inside a chart
  // the element under the pointer is often a line or a hover dot that the
  // chart redraws or removes; the chart as a whole is what stays, so the spot
  // is kept relative to the outermost <svg>.
  function stableTarget(n) {
    if (!(n instanceof SVGElement)) return n;
    let svg = n.closest("svg");
    while (svg?.parentElement?.closest("svg")) svg = svg.parentElement.closest("svg");
    return svg || n;
  }

  // The element a comment was made on, if it is on the screen now: its path
  // must name it, and it must still be the same element (its fingerprint).
  // Several matches, none, or one that is now something else all count as
  // "not here": a pin is never drawn on a look-alike.
  function targetNode(c) {
    const sel = c.target.selector;
    if (!sel) return null;
    let all;
    try {
      all = [...document.querySelectorAll(sel)];
    } catch {
      return null; // a selector this page cannot parse
    }
    const same = all.filter((n) => isItsElement(n, c));
    return same.length === 1 ? same[0] : null;
  }

  function isItsElement(n, c) {
    if (c.target.key) return fingerprint(n) === c.target.key;
    // Saved before fingerprints: only an element that said something can be
    // recognised; a bare "svg" or "div" could be any of many.
    return Boolean(c.target.label?.includes("·")) && describe(n) === c.target.label;
  }

  // Where a comment's spot is on the screen now, or null when it cannot be
  // shown exactly: its element is not here, is hidden or covered, or the
  // spot no longer falls inside it. jadm.ai shows different things at one
  // address (the sign-in page and the dashboard are both "/"), so a pin only
  // appears with the element it was made on; it never floats over something else.
  function findTarget(c) {
    const n = targetNode(c);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    if (!r.width || !r.height || pageSized(r)) return null;
    const t = c.target;
    // A big box (a card, empty space) keeps the spot by its distance from the
    // box's top-left corner: rows below may grow without moving it. Anything
    // else by its share of the box.
    const big = r.width > 400 || r.height > 300;
    let p;
    if (big && Number.isFinite(t.dx) && Number.isFinite(t.dy)) {
      if (t.dx > r.width || t.dy > r.height) return null;
      p = { x: r.left + t.dx, y: r.top + t.dy };
    } else {
      p = { x: r.left + r.width * t.xPct, y: r.top + r.height * t.yPct };
    }
    return placeable(n, p.x, p.y) ? p : null;
  }
  const cardSpot = () => ({ x: innerWidth / 2 - 170, y: 120 });

  // --- pins ---------------------------------------------------------------

  const onThisPage = () => {
    const key = pageKey();
    return comments.filter((c) => keyOf(c) === key);
  };

  // Pins are kept and moved, not rebuilt: a pin replaced between press and
  // release never gets its click, which on a phone is most taps.
  const pinEls = new Map(); // comment id -> pin button
  const pinSpots = new Map(); // comment id -> {x, y} where its pin is drawn
  // Every pin sits exactly on its own spot. Pins on (nearly) the same spot
  // overlap; clicking there lists every comment at that spot to choose from.
  const near = (a, b) => Math.abs(a.x - b.x) < 24 && Math.abs(a.y - b.y) < 24;
  layer.addEventListener("click", (e) => {
    const pin = e.target.closest?.(".pin");
    if (!pin) return;
    e.stopPropagation();
    const at = pinSpots.get(pin.dataset.id);
    if (!at) return;
    const here = [...pinSpots].filter(([, p]) => near(p, at)).map(([id]) => comments.find((v) => v.id === id)).filter(Boolean);
    if (here.length > 1) chooseComment(here, at.x, at.y);
    else showComment(pin.dataset.id, at.x, at.y);
  });

  function chooseComment(list, x, y) {
    if (!closeCard()) return;
    const card = el("div", "card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Comments on this spot");
    card.innerHTML = `<header><span>${list.length} comments on this spot</span><button type="button" aria-label="Close">×</button></header>
      <div class="body">${list
        .sort((a, b) => a.n - b.n)
        .map(
          (c) => `<button type="button" class="choice" data-id="${esc(c.id)}"><b>#${c.n}</b> ${esc(c.author)}${c.status === "open" ? "" : ` · ${c.status === "fixed" ? "fixed" : "won't fix"}`}<br><span>${esc(c.text.slice(0, 90))}${c.text.length > 90 ? "…" : ""}</span></button>`,
        )
        .join("")}</div>`;
    card.querySelector("header button").addEventListener("click", () => closeCard({ force: true }));
    card.querySelectorAll(".choice").forEach((b) => b.addEventListener("click", () => showComment(b.dataset.id, x, y)));
    placeCard(card, x, y);
  }

  function renderPins() {
    const mine = onThisPage();
    const open = mine.filter((c) => c.status === "open").length;
    countEl.textContent = String(open);
    pinsBtn.title = `${open} open on this page (${mine.length} in all). Click to ${pinsHidden ? "show" : "hide"} the pins.`;
    pinsBtn.style.opacity = pinsHidden ? "0.6" : "1";
    const shown = new Set();
    pinSpots.clear();
    if (!pinsHidden && !picking) {
      const placed = [];
      for (const c of mine) {
        const at = findTarget(c);
        if (!at) continue;
        const { x, y } = at;
        if (x < -20 || y < -20 || x > innerWidth + 20 || y > innerHeight + 20) continue;
        placed.push([c, at]);
      }
      for (const [c, at] of placed) {
        const { x, y } = at;
        pinSpots.set(c.id, at);
        shown.add(c.id);
        let pin = pinEls.get(c.id);
        if (!pin) {
          pin = el("button", "pin");
          pin.type = "button";
          pin.dataset.id = c.id;
          pinEls.set(c.id, pin);
          layer.appendChild(pin);
        }
        pin.classList.toggle("fixed", c.status === "fixed");
        pin.classList.toggle("wontfix", c.status === "wontfix");
        if (pin.textContent !== String(c.n)) pin.innerHTML = `<b>${c.n}</b>`;
        pin.style.left = `${x}px`;
        pin.style.top = `${y}px`;
        const together = placed.filter(([, p]) => near(p, at)).length;
        if (together > 1) pin.dataset.count = String(together);
        else delete pin.dataset.count;
        pin.title = together > 1 ? `${together} comments here` : `#${c.n} ${c.author}: ${c.text.slice(0, 120)}`;
        pin.setAttribute("aria-label", together > 1 ? `${together} comments on this spot` : `Comment ${c.n} by ${c.author}`);
      }
    }
    for (const [id, pin] of pinEls) {
      if (!shown.has(id)) {
        pin.remove();
        pinEls.delete(id);
      }
    }
  }

  let raf = 0;
  const schedulePins = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      renderPins();
    });
  };
  addEventListener("scroll", schedulePins, true);
  addEventListener("resize", schedulePins);
  // Moving to another screen closes a comment being read, but never one being
  // written: it keeps the screen it was started on and can still be saved.
  addEventListener("hashchange", () => {
    if (!draftOpen()) closeCard({ force: true });
    schedulePins();
  });
  // The app re-renders without telling anyone; keep the pins on their elements.
  setInterval(() => {
    schedulePins();
    updateSignin();
  }, 1000);
  // Everyone's new comments appear within a few seconds.
  setInterval(() => { if (!document.hidden) refresh(); }, 15000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

  // --- exact pictures ------------------------------------------------------
  /*
   * Chrome and Edge can photograph this very tab, pixel for pixel, the way
   * screen sharing does (getDisplayMedia with preferCurrentTab). Pressing
   * Comment asks "Share this tab?"; the picture is then taken from the real
   * screen at the moment the spot is clicked, and sharing stops at once.
   * Cancelled, or another browser: the drawn picture (capture, below).
   * The first time, the reviewer is told what the question is about.
   */
  const EXACT_KEY = "jadm-review-exact"; // "on", "off", or unset (not asked yet)
  const exactPossible =
    Boolean(navigator.mediaDevices?.getDisplayMedia) && /Chrome\/|Edg\//.test(navigator.userAgent) && !/Mobile|Android/.test(navigator.userAgent);
  let exactRefused = store.get(EXACT_KEY) === "off";
  let tabStream = null;

  function openTabCapture() {
    if (!exactPossible || exactRefused) return Promise.resolve(null);
    return navigator.mediaDevices
      .getDisplayMedia({
        video: { displaySurface: "browser" },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: "include",
        surfaceSwitching: "exclude",
        monitorTypeSurfaces: "exclude",
      })
      .then(
        (s) => {
          tabStream = s;
          s.getVideoTracks()[0]?.addEventListener("ended", () => {
            if (tabStream === s) tabStream = null;
          });
          return s;
        },
        // Cancel: not asked again on this page; the drawn picture is used.
        () => {
          exactRefused = true;
          return null;
        },
      );
  }

  function closeTabCapture() {
    tabStream?.getTracks().forEach((t) => t.stop());
    tabStream = null;
  }

  // When the page last scrolled, anywhere on it.
  let lastScrollAt = 0;
  addEventListener("scroll", () => (lastScrollAt = performance.now()), { capture: true, passive: true });
  const frame1 = () => new Promise((r) => requestAnimationFrame(r));

  // Waits until nothing moves: no scrolling for a moment, and the clicked
  // element in the same place for three frames in a row (a wheel flick keeps
  // the page gliding after the click). Gives up after a second.
  async function stillness(n) {
    const t0 = performance.now();
    let prev = "";
    let same = 0;
    while (performance.now() - t0 < 1000) {
      await frame1();
      const r = n.getBoundingClientRect();
      const now = `${scrollX},${scrollY},${r.left},${r.top},${r.width},${r.height}`;
      same = now === prev && performance.now() - lastScrollAt > 120 ? same + 1 : 0;
      prev = now;
      if (same >= 3) return now;
    }
    return null;
  }

  // The exact picture: one frame of this tab, with the circle placed from
  // where the clicked element is in that same frame. Any doubt — the page
  // would not settle, the element moved while the frame was taken, the frame
  // is not this page — and it returns nothing, so the drawn picture is used.
  async function grabTab(stream, spot, n) {
    const track = stream.getVideoTracks()[0];
    let video = null;
    try {
      if (!track || track.readyState !== "live" || !n?.isConnected) return null;
      // The widget is not part of the picture: hide it, let the screen redraw.
      host.style.visibility = "hidden";
      const before = await stillness(n);
      if (!before) return null;
      const r = n.getBoundingClientRect();
      const p = { x: r.left + r.width * spot.xPct, y: r.top + r.height * spot.yPct };
      // Tab-capture frames arrive a frame or two late.
      await frame1();
      await frame1();
      await new Promise((res) => setTimeout(res, 100));
      let frame;
      if ("ImageCapture" in window) {
        frame = await new ImageCapture(track).grabFrame();
      } else {
        video = document.createElement("video");
        video.muted = true;
        video.srcObject = stream;
        await video.play();
        await new Promise((res) => (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(() => res()) : setTimeout(res, 120)));
        frame = video;
      }
      const r2 = n.getBoundingClientRect();
      if (`${scrollX},${scrollY},${r2.left},${r2.top},${r2.width},${r2.height}` !== before) return null;
      const fw = frame.width || frame.videoWidth;
      const fh = frame.height || frame.videoHeight;
      // It must be this page's own area: the same shape as the window's inside.
      if (!fw || !fh || Math.abs(fw / innerWidth - fh / innerHeight) / (fw / innerWidth) > 0.03) return null;
      const out = Math.min(1, 1600 / fw);
      const c = document.createElement("canvas");
      c.width = Math.round(fw * out);
      c.height = Math.round(fh * out);
      const g = c.getContext("2d");
      g.drawImage(frame, 0, 0, c.width, c.height);
      const k = c.width / innerWidth;
      ring(g, p.x * k, p.y * k, k);
      window.__jadmReviewLastMark = { x: p.x, y: p.y, k, exact: true, marked: true, clientX: spot.clientX, clientY: spot.clientY };
      return { url: c.toDataURL("image/jpeg", 0.85), marked: true };
    } catch {
      return null;
    } finally {
      host.style.visibility = "";
      stream.getTracks().forEach((t) => t.stop());
      if (video) video.srcObject = null;
    }
  }

  // The red circle, in plain picture pixels.
  function ring(g, x, y, k) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.lineWidth = Math.max(3, 4 * k);
    g.strokeStyle = "#da1e28";
    g.beginPath();
    g.arc(x, y, Math.max(14, 22 * k), 0, Math.PI * 2);
    g.stroke();
  }

  // The Comment button. In Chrome/Edge, the first time, a short explanation
  // of the "Share this tab?" question comes first; its Continue click is what
  // lets the page ask.
  async function beginComment() {
    if (!closeCard()) return;
    if (exactPossible && !exactRefused && !store.get(EXACT_KEY)) return explainExact();
    if (exactPossible && !exactRefused) await openTabCapture();
    startPick();
  }

  function explainExact() {
    const card = el("div", "card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Exact screenshots");
    card.innerHTML = `<header><span>Exact screenshots</span><button type="button" aria-label="Close">×</button></header>
      <div class="body">
        <p class="text">So your comment comes with an exact picture of what you see, your browser will ask to <b>share this tab</b>. Press <b>Share</b>.</p>
        <p class="text" style="color:#525252">It takes one picture of this screen when you click your spot, then stops at once. Nothing is recorded, and only your comment's picture is saved.</p>
        <div class="row"><button type="button" class="ghost" data-quick>Quick pictures instead</button><button type="button" class="go" data-exact>Continue</button></div>
      </div>`;
    card.querySelector("header button").addEventListener("click", () => closeCard({ force: true }));
    card.querySelector("[data-exact]").addEventListener("click", async () => {
      store.set(EXACT_KEY, "on");
      closeCard({ force: true });
      await openTabCapture();
      startPick();
    });
    card.querySelector("[data-quick]").addEventListener("click", () => {
      store.set(EXACT_KEY, "off");
      exactRefused = true;
      closeCard({ force: true });
      startPick();
    });
    const b = pickBtn.getBoundingClientRect();
    placeCard(card, Math.max(16, b.left - 360), Math.max(16, b.top - 260));
  }

  // --- picking ------------------------------------------------------------

  function startPick() {
    if (!closeCard()) return;
    picking = true;
    pickBtn.classList.add("on");
    pickBtn.textContent = "Cancel";
    hintEl = el(
      "div",
      "hint",
      tabStream
        ? "Click the spot you want to comment on — the picture is taken exactly as you see it · <kbd>Esc</kbd> to cancel"
        : "Click the spot you want to comment on · <kbd>Esc</kbd> to cancel",
    );
    hlEl = el("div", "hl", "<span></span>");
    hlEl.style.display = "none";
    root.append(hintEl, hlEl);
    document.documentElement.style.cursor = "crosshair";
    renderPins();
  }

  function stopPick() {
    picking = false;
    hovered = null;
    // Cancelled before a spot was clicked: stop sharing now. (A click hands
    // the stream to grabTab first, which stops it after the picture.)
    closeTabCapture();
    pickBtn.classList.remove("on");
    pickBtn.textContent = "Comment";
    hintEl?.remove();
    hlEl?.remove();
    hintEl = hlEl = null;
    document.documentElement.style.cursor = "";
    renderPins();
  }

  const fromPage = (e) => !e.composedPath().includes(host);

  // jadm.ai's dialogs keep focus inside themselves (Carbon's Modal, the app's
  // own Tab trap). While one is open, moving into the review card must not
  // count as leaving it, or the dialog pulls focus back and the comment gets
  // typed into the app. Everywhere else jadm.ai must hear every blur as
  // normal: some of its fields save when you leave them. Carbon keeps closed
  // dialogs in the page, so only a visible one counts.
  const openTrap = () =>
    [...document.querySelectorAll(".cds--modal.is-visible, [role='dialog'][aria-modal='true']")].find(
      (d) => !host.contains(d) && d.getClientRects().length > 0 && getComputedStyle(d).visibility !== "hidden",
    ) || null;
  for (const type of ["focusout", "blur"]) {
    addEventListener(
      type,
      (e) => {
        if (e.target === host) return e.stopImmediatePropagation(); // leaving the widget: nothing of jadm.ai's
        if (e.relatedTarget === host && e.target instanceof Node && openTrap()?.contains(e.target)) e.stopImmediatePropagation();
      },
      true,
    );
  }
  for (const type of ["focusin", "focus"]) {
    addEventListener(type, (e) => { if (e.target === host && openTrap()) e.stopImmediatePropagation(); }, true);
  }

  document.addEventListener(
    "mousemove",
    (e) => {
      if (!picking || !fromPage(e)) return;
      // The highlight shows exactly what a click here will pick.
      const n = pickTarget(e.clientX, e.clientY);
      if (!n || n === host || n === hovered) return;
      hovered = n;
      const r = n.getBoundingClientRect();
      Object.assign(hlEl.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      hlEl.firstChild.textContent = describe(n);
    },
    true,
  );

  // Swallow the site's own reaction to the click that picks a spot.
  for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "touchend"]) {
    document.addEventListener(
      type,
      (e) => {
        if (picking && fromPage(e)) {
          if (e.cancelable && !type.startsWith("touch")) e.preventDefault();
          e.stopPropagation();
        }
      },
      { capture: true, passive: false },
    );
  }
  document.addEventListener(
    "click",
    (e) => {
      if (!picking || !fromPage(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const n = pickTarget(e.clientX, e.clientY);
      const r = n.getBoundingClientRect();
      const spot = {
        clientX: e.clientX,
        clientY: e.clientY,
        selector: selectorFor(n),
        label: describe(n),
        key: fingerprint(n),
        xPct: r.width ? (e.clientX - r.left) / r.width : 0.5,
        yPct: r.height ? (e.clientY - r.top) / r.height : 0.5,
        dx: e.clientX - r.left,
        dy: e.clientY - r.top,
        w: r.width,
        h: r.height,
        pageX: e.clientX + scrollX,
        pageY: e.clientY + scrollY,
        // The screen as it was when the spot was picked: the comment belongs
        // there even if the reviewer moves on before saving.
        page: { origin: location.origin, url: urlWithoutFocus(), key: pageKey(), title: document.title },
        viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio || 1 },
      };
      // The picture is taken now, as the reviewer saw it: from the screen
      // itself when sharing was allowed, otherwise drawn (see capture).
      const stream = tabStream;
      tabStream = null;
      spot.shot = stream ? grabTab(stream, spot, n).then((shot) => shot || capture(spot, n, false)) : capture(spot, n, true);
      stopPick();
      compose(spot);
    },
    true,
  );

  // First listener to see any key (window, capture). Keys typed in the widget
  // stop here, before the app's own page-wide key handling (its Tab trap runs
  // on the document in the capture phase), so the widget handles its own:
  // Escape closes, Ctrl+Enter saves. Typing and Tab still work as normal.
  addEventListener(
    "keydown",
    (e) => {
      const inWidget = !fromPage(e);
      if (e.key === "Escape") {
        if (picking) stopPick();
        else if (root.querySelector(".card")) closeCard();
      } else if (inWidget && e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        root.querySelector(".card [data-save]")?.click();
      }
      if (inWidget) e.stopImmediatePropagation();
    },
    true,
  );
  for (const t of ["keypress", "keyup"]) addEventListener(t, (e) => { if (!fromPage(e)) e.stopImmediatePropagation(); }, true);

  // --- cards --------------------------------------------------------------

  // Placed inside the part of the screen that is actually visible: on phones
  // the browser's toolbars and the keyboard take some of it.
  function placeCard(card, x, y) {
    if (!card.isConnected) root.appendChild(card);
    const vh = window.visualViewport?.height || innerHeight;
    card.style.maxHeight = `${vh - 32}px`;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    let left = x + 18;
    let top = y - 20;
    if (left + w > innerWidth - 16) left = Math.max(16, x - w - 18);
    if (top + h > vh - 16) top = Math.max(16, vh - h - 16);
    card.style.left = `${Math.max(16, Math.min(left, innerWidth - w - 16))}px`;
    card.style.top = `${Math.max(16, top)}px`;
    card.dataset.x = x;
    card.dataset.y = y;
    const img = card.querySelector("img.shot");
    if (img && !img.complete) img.addEventListener("load", () => placeCard(card, x, y), { once: true });
  }
  window.visualViewport?.addEventListener("resize", () => {
    const card = root.querySelector(".card");
    if (card) placeCard(card, Number(card.dataset.x), Number(card.dataset.y));
  });

  // A comment being written with text in it.
  const draftOpen = () => Boolean(root.querySelector('.card[data-draft] textarea')?.value.trim());

  // Closes the open card. A comment being written is only thrown away when
  // the reviewer asked for exactly that (Cancel, ×, a save) or agrees to it;
  // Escape, another pin or the Comment button ask first. Returns whether the
  // card is gone.
  function closeCard({ force = false } = {}) {
    if (!force && draftOpen() && !confirm("Throw away the comment you are writing?")) return false;
    root.querySelectorAll(".card").forEach((c) => c.remove());
    return true;
  }

  function chips(list, current, onPick, name) {
    const wrap = el("div", "chips");
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", name);
    for (const [k, text] of list) {
      const b = el("button", "", esc(text));
      b.type = "button";
      b.setAttribute("aria-pressed", String(k === current));
      b.addEventListener("click", () => {
        wrap.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
        onPick(k);
      });
      wrap.appendChild(b);
    }
    return wrap;
  }

  function compose(spot) {
    if (!closeCard()) return;
    let kind = "bug";
    let priority = "medium";
    const card = el("div", "card");
    card.dataset.draft = "";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "New comment");
    card.innerHTML = `<header><span>New comment <small>as ${esc(me)}</small></span><button type="button" aria-label="Close">×</button></header><div class="body"></div>`;
    const body = card.querySelector(".body");
    body.innerHTML = `<div class="target" title="${esc(spot.selector)}">On: ${esc(spot.label)}</div>
      <label>What kind</label><div data-kind></div>
      <label>How urgent</label><div data-pri></div>
      <label for="rv-text">What is wrong, or what should change?</label>
      <textarea id="rv-text" maxlength="4000" placeholder="Describe the problem. What did you expect to see?"></textarea>
      <label class="check"><input type="checkbox" checked data-shot> Attach a screenshot of this screen</label>
      <div class="preview" data-preview><span>Taking the picture…</span></div>
      <div class="row"><button type="button" class="ghost" data-cancel>Cancel</button><button type="button" class="go" data-save>Save comment</button></div>`;
    body.querySelector("[data-kind]").replaceWith(chips(KINDS, kind, (k) => (kind = k), "What kind"));
    body.querySelector("[data-pri]").replaceWith(chips(PRIORITIES, priority, (p) => (priority = p), "How urgent"));
    const forceClose = () => closeCard({ force: true });
    card.querySelector("header button").addEventListener("click", forceClose);
    body.querySelector("[data-cancel]").addEventListener("click", forceClose);
    const textEl = body.querySelector("#rv-text");
    const saveBtn = body.querySelector("[data-save]");
    const save = async () => {
      if (saveBtn.disabled) return; // already saving
      const text = textEl.value.trim();
      if (!text) return textEl.focus();
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      const wantShot = body.querySelector("[data-shot]").checked;
      card.style.visibility = "hidden";
      const working = el("div", "toast", "Saving…");
      working.setAttribute("role", "status");
      root.appendChild(working);
      const screenshot = wantShot ? (await spot.shot)?.url || null : null;
      try {
        const { comment } = await send("POST", API, {
          kind,
          priority,
          text,
          screenshot,
          page: spot.page,
          target: {
            selector: spot.selector,
            label: spot.label,
            key: spot.key,
            xPct: spot.xPct,
            yPct: spot.yPct,
            dx: spot.dx,
            dy: spot.dy,
            w: spot.w,
            h: spot.h,
            pageX: spot.pageX,
            pageY: spot.pageY,
          },
          viewport: spot.viewport,
          tech: (window.__jadmReviewLog || []).slice(-15),
        });
        // A refresh that landed while saving may already have it.
        if (!comments.some((v) => v.id === comment.id)) comments.push(comment);
        closeCard({ force: true });
        renderPins();
        toast(`Comment #${comment.n} saved — the whole team can see it${wantShot && !screenshot ? " (the screenshot could not be taken)" : ""}`);
      } catch (err) {
        card.style.visibility = "";
        saveBtn.disabled = false;
        saveBtn.textContent = "Save comment";
        toast(saveProblem(err), true, 8000);
      } finally {
        working.remove();
      }
    };
    saveBtn.addEventListener("click", save);
    placeCard(card, spot.clientX, spot.clientY);
    textEl.focus();
    // The picture as it will be saved, so the reviewer can see the circle is
    // on the right spot before saving.
    Promise.resolve(spot.shot).then((shot) => {
      const box = card.isConnected && card.querySelector("[data-preview]");
      if (!box) return;
      if (!shot) {
        box.innerHTML = "<span>The picture could not be taken; the comment still saves without it.</span>";
        return;
      }
      box.innerHTML = `<img alt="Your picture"><span>${
        shot.marked
          ? "Your picture. The red circle marks your spot; if it is not where you meant, press Cancel and click again."
          : "Your picture. Your spot could not be marked exactly in it, so it has no circle."
      }</span>`;
      box.querySelector("img").src = shot.url;
      box.querySelector("img").addEventListener("load", () => placeCard(card, spot.clientX, spot.clientY), { once: true });
    });
  }

  // The board's "Show on the page" puts review-focus inside the hash
  // ("#/receivables?review-focus=…"): jadm.ai's Google sign-in brings people
  // back with the hash but not the rest. Older links had it in the query.
  function focusIdFromUrl() {
    const h = location.hash;
    const i = h.indexOf("?");
    return new URLSearchParams(location.search).get("review-focus") || (i < 0 ? null : new URLSearchParams(h.slice(i + 1)).get("review-focus"));
  }

  function urlWithoutFocus() {
    const u = new URL(location.href);
    u.searchParams.delete("review-focus");
    const i = u.hash.indexOf("?");
    if (i >= 0) {
      const p = new URLSearchParams(u.hash.slice(i + 1));
      p.delete("review-focus");
      const rest = p.toString();
      u.hash = u.hash.slice(1, i) + (rest ? `?${rest}` : "");
    }
    return u.pathname + u.search + u.hash;
  }

  function showComment(id, x, y) {
    const c = comments.find((v) => v.id === id);
    if (!c) return;
    if (!closeCard()) return;
    const card = el("div", "card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", `Comment ${c.n}`);
    const statusTag = c.status === "open" ? "" : `<span class="tag ${c.status}">${c.status === "fixed" ? "Fixed" : "Won't fix"}${c.statusBy ? ` · ${esc(c.statusBy)}` : ""}</span>`;
    card.innerHTML = `<header><span>#${c.n} · ${esc(c.author)}</span><button type="button" aria-label="Close">×</button></header>
      <div class="body">
        <div class="meta"><span class="tag">${esc(label(KINDS, c.kind))}</span><span class="tag ${c.priority}">${esc(label(PRIORITIES, c.priority))}</span>${statusTag}<span>${esc(ago(c.createdAt))}</span></div>
        <p class="text">${esc(c.text)}</p>
        ${c.shot ? `<img class="shot" src="${esc(shotUrl(c))}" alt="Screenshot taken with the comment">` : ""}
        ${(c.replies || []).map((r) => `<div class="reply"><div class="who">${esc(r.author)} · ${esc(ago(r.at))}</div><p class="text">${esc(r.text)}</p></div>`).join("")}
        <label for="rv-reply">Reply</label>
        <textarea id="rv-reply" maxlength="4000" placeholder="Add detail, or say how it was fixed"></textarea>
        <div class="row">
          <button type="button" class="ghost" data-status>${c.status === "open" ? "Mark fixed" : "Reopen"}</button>
          <button type="button" class="go" data-reply>Reply</button>
          ${c.author === me ? '<button type="button" class="danger" data-del title="Delete this comment">Delete</button>' : ""}
        </div>
        <div class="foot"><a href="${BASE}/#c${c.n}" target="_blank" rel="noopener">Open on the feedback board</a></div>
      </div>`;
    card.querySelector("header button").addEventListener("click", closeCard);
    card.querySelector(".shot")?.addEventListener("click", () => open(shotUrl(c), "_blank"));
    // The list is replaced every few seconds; always act on its latest copy.
    const current = () => comments.find((v) => v.id === id) || c;
    const update = async (patch) => {
      try {
        const { comment } = await send("PATCH", `${API}/${id}`, patch);
        comments = comments.some((v) => v.id === id) ? comments.map((v) => (v.id === id ? comment : v)) : [...comments, comment];
        renderPins();
        showComment(id, x, y);
      } catch {
        toast("Could not save. Try again.", true);
      }
    };
    card.querySelector("[data-status]").addEventListener("click", () => update({ status: current().status === "open" ? "fixed" : "open" }));
    card.querySelector("[data-reply]").addEventListener("click", () => {
      const text = card.querySelector("#rv-reply").value.trim();
      if (text) update({ reply: { text } });
    });
    card.querySelector("[data-del]")?.addEventListener("click", async () => {
      if (!confirm(`Delete comment #${c.n}? This cannot be undone.`)) return;
      try {
        await send("DELETE", `${API}/${c.id}`);
        comments = comments.filter((v) => v.id !== c.id);
        closeCard();
        renderPins();
      } catch {
        toast("Could not delete. Try again.", true);
      }
    });
    placeCard(card, x, y);
  }

  // --- screenshot ---------------------------------------------------------

  let libLoading = null;
  function loadShotLib() {
    if (window.html2canvas) return Promise.resolve(window.html2canvas);
    libLoading ??= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = SHOT_LIB;
      // A slow or blocked download never holds the save up for long: after
      // ten seconds the comment goes without its picture.
      const giveUp = setTimeout(() => s.onerror(), 10000);
      s.onload = () => {
        clearTimeout(giveUp);
        resolve(window.html2canvas);
      };
      s.onerror = () => {
        clearTimeout(giveUp);
        libLoading = null;
        reject(new Error("screenshot library did not load"));
      };
      document.head.appendChild(s);
    });
    return libLoading;
  }

  /*
   * The screenshot, taken the moment the spot is picked (not on Save), so it
   * shows exactly what the reviewer was looking at, hover effects included,
   * and nothing on the page can move in between. html2canvas copies the page
   * as soon as it is called; the picture is drawn while the reviewer types.
   *
   * The red circle is placed from the picture's own layout: the clicked
   * element is tagged before the copy is made and measured inside the copy,
   * so the circle sits on that element in the picture even where html2canvas
   * draws something a little differently from the real screen.
   */
  const MARK = "data-jadm-review-spot";
  // atClick: called in the very click that picked the spot, so the page has
  // not moved since; only then may the clicked point itself stand in for an
  // element the copy did not find.
  async function capture(spot, node, atClick) {
    const W = innerWidth;
    const H = innerHeight;
    const X = scrollX;
    const Y = scrollY;
    const ready = Boolean(window.html2canvas);
    // Each picture has its own tag, so two pictures being drawn at once can
    // never mark each other's element.
    const tag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    let tagged = false;
    try {
      const html2canvas = window.html2canvas || (await loadShotLib());
      // Big screens make big pictures; 1600px across is plenty to see the problem.
      const scale = Math.min(devicePixelRatio || 1, 1.5, 1600 / W);
      let mark = null; // the spot in the copy's document coordinates
      if (node?.isConnected) {
        node.setAttribute(MARK, tag);
        tagged = true;
      }
      // html2canvas copies the page as it is called; the tag comes off the
      // real page straight after.
      const job = html2canvas(document.body, {
        x: X,
        y: Y,
        scrollX: X,
        scrollY: Y,
        width: W,
        height: H,
        windowWidth: W,
        windowHeight: H,
        scale,
        useCORS: true,
        logging: false,
        ignoreElements: (n) => n === host,
        onclone: (doc) => {
          // The copy starts its animations over; finish them at once so it
          // shows what the reviewer saw, not the first frame of an intro.
          const s = doc.createElement("style");
          s.textContent =
            "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;" +
            "animation-iteration-count:1!important;transition-duration:0s!important;transition-delay:0s!important}";
          doc.head.appendChild(s);
          const found = doc.querySelectorAll(`[${MARK}="${tag}"]`);
          const win = doc.defaultView;
          if (found.length === 1 && win) {
            const r = found[0].getBoundingClientRect();
            if (r.width && r.height) mark = { x: r.left + win.scrollX + r.width * spot.xPct, y: r.top + win.scrollY + r.height * spot.yPct };
          }
          doc.querySelectorAll(`[${MARK}]`).forEach((e) => e.removeAttribute(MARK));
        },
      });
      if (tagged) {
        node.removeAttribute(MARK);
        tagged = false;
      }
      const canvas = await Promise.race([job, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 20000))]);
      // Picture pixels per CSS pixel, from the picture itself.
      const k = canvas.width / W;
      // Where the spot is in the picture: from the copy's own layout of the
      // element; or the clicked point, when this is the click itself and the
      // page cannot have moved. Otherwise no circle at all, never a guess.
      const p = mark ? { x: mark.x - X, y: mark.y - Y } : atClick && ready ? { x: spot.clientX, y: spot.clientY } : null;
      if (p) ring(canvas.getContext("2d"), p.x * k, p.y * k, k);
      // Read back by the accuracy test: where the circle was drawn and how.
      window.__jadmReviewLastMark = p
        ? { x: p.x, y: p.y, k, fromCopy: Boolean(mark), marked: true, clientX: spot.clientX, clientY: spot.clientY }
        : { marked: false, clientX: spot.clientX, clientY: spot.clientY };
      return { url: canvas.toDataURL("image/jpeg", 0.85), marked: Boolean(p) };
    } catch {
      return null;
    } finally {
      if (tagged) node.removeAttribute(MARK);
    }
  }

  // --- wiring -------------------------------------------------------------

  root.querySelector(".bar").addEventListener("click", (e) => {
    const act = e.target.closest("button")?.dataset.act;
    if (act === "pick") picking ? stopPick() : beginComment();
    if (act === "pins") {
      pinsHidden = !pinsHidden;
      store.set(HIDE_KEY, pinsHidden ? "1" : "0");
      renderPins();
    }
    if (act === "board") open(`${BASE}/`, "_blank");
    if (act === "signin") {
      location.href = `/api/auth/__review-signin?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
    }
  });

  // ?review-focus=<id>: arrived from the board's "Show on the page" link.
  async function focusFromUrl() {
    const id = focusIdFromUrl();
    if (!id) return;
    // Once only: take it out of the address so later screens are left alone.
    // replaceState fires no hashchange, so jadm.ai's router is not disturbed.
    try {
      history.replaceState(history.state, "", urlWithoutFocus());
    } catch { /* the page forbids it; harmless */ }
    for (let i = 0; i < 20; i++) {
      const c = comments.find((v) => v.id === id);
      if (c) {
        if (pinsHidden) {
          pinsHidden = false;
          store.set(HIDE_KEY, "0");
        }
        // Scrolled to only when its element is recognised here; never to an
        // old position that may now show something else.
        const n = targetNode(c);
        if (n) n.scrollIntoView({ block: "center" });
        await new Promise((r) => setTimeout(r, 300));
        renderPins();
        const pin = layer.querySelector(`.pin[data-id="${CSS.escape(id)}"]`);
        if (pin) {
          pin.classList.add("flash");
          const { x, y } = findTarget(c) || cardSpot();
          showComment(id, x, y);
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 500)); // the app may still be drawing the screen
    }
    // The element is not on this screen now (signed out, data changed…): show
    // the comment anyway, with its screenshot, so the link still answers.
    if (comments.some((v) => v.id === id)) {
      const { x, y } = cardSpot();
      showComment(id, x, y);
      toast("That spot is not on the screen right now. The screenshot shows where it was.");
    }
  }

  const mount = async () => {
    document.body.appendChild(host);
    // Ready before the first click, so the picture is taken at the very
    // moment of the click (see capture).
    loadShotLib().catch(() => {});
    try {
      const r = await fetch(`${BASE}/api/me`, { credentials: "same-origin", cache: "no-store", headers: AUTH });
      if (r.status === 401) return toEnter();
      const who = await r.json();
      me = who.name || "";
      // Automatic jadm.ai sign-in belongs to the mirror; on jadm.ai itself
      // people sign in their own way.
      autoLogin = Boolean(who.autoLogin) && !REMOTE;
      updateSignin();
      if (REMOTE && r.ok) toast(`Comment tool is on. You are ${me}.`);
    } catch { /* the comments call below reports trouble */ }
    await refresh();
    focusFromUrl();
  };
  if (document.body) mount();
  else addEventListener("DOMContentLoaded", mount);
})();
