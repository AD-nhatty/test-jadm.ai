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
  const TOKEN = window.__jadmReviewToken || "";
  const AUTH = TOKEN ? { "x-review-token": TOKEN } : {};
  const BASE = `${ORIGIN}/__review`;
  const API = `${BASE}/api/comments`;
  const shotUrl = (id) => `${BASE}/shots/${encodeURIComponent(id)}${TOKEN ? `?t=${encodeURIComponent(TOKEN)}` : ""}`;

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

  async function refresh() {
    try {
      const r = await fetch(API, { cache: "no-store", credentials: "same-origin", headers: AUTH });
      if (r.status === 401) return toEnter();
      if (!r.ok) return;
      comments = (await r.json()).comments || [];
      renderPins();
    } catch { /* offline for a moment; the next tick retries */ }
  }

  // Not (or no longer) let in. On the mirror that means the name page; on
  // jadm.ai the button itself is out of date (the team password changed).
  let toldStale = false;
  function toEnter() {
    if (!REMOTE) {
      location.href = `${BASE}/enter?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
      return;
    }
    if (toldStale) return;
    toldStale = true;
    toast("Your JADM Comment button is out of date. Open the review link to get a new one.", true, 12000);
  }

  async function send(method, url, body) {
    const r = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...AUTH },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) toEnter();
    if (!r.ok && r.status !== 204) throw new Error(`HTTP ${r.status}`);
    return r.status === 204 ? null : r.json();
  }

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
      if (n.id && !/\d{3,}|:|^radix-|^headlessui-/.test(n.id)) {
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

  function describe(node) {
    const text = (node.getAttribute("aria-label") || node.innerText || node.getAttribute("placeholder") || node.getAttribute("alt") || "")
      .replace(/\s+/g, " ")
      .trim();
    const tag = node.tagName.toLowerCase();
    return text ? `${tag} · "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"` : tag;
  }

  // The element only when the selector names exactly one; otherwise the spot
  // where it was clicked, so a pin never lands on a look-alike elsewhere.
  function uniqueMatch(sel) {
    if (!sel) return null;
    try {
      const all = document.querySelectorAll(sel);
      return all.length === 1 ? all[0] : null;
    } catch {
      return null; // a selector this page cannot parse
    }
  }

  // Where a comment's spot is on the screen now, or null when its element is
  // not on screen. jadm.ai shows different things at one address (the sign-in
  // page and the dashboard are both "/"), so a pin only appears with the
  // element it was made on; it never floats over something else.
  function findTarget(c) {
    const sel = c.target.selector;
    if (sel) {
      let all = null;
      try {
        all = document.querySelectorAll(sel);
      } catch { /* a selector this page cannot parse */ }
      if (all && all.length === 0) return null;
      if (all && all.length === 1) {
        const r = all[0].getBoundingClientRect();
        return r.width || r.height ? { x: r.left + r.width * c.target.xPct, y: r.top + r.height * c.target.yPct } : null;
      }
    }
    return { x: c.target.pageX - scrollX, y: c.target.pageY - scrollY };
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
  layer.addEventListener("click", (e) => {
    const pin = e.target.closest?.(".pin");
    if (!pin) return;
    e.stopPropagation();
    const c = comments.find((v) => v.id === pin.dataset.id);
    if (c) {
      const { x, y } = findTarget(c) || cardSpot();
      showComment(c.id, x, y);
    }
  });

  function renderPins() {
    const mine = onThisPage();
    const open = mine.filter((c) => c.status === "open").length;
    countEl.textContent = String(open);
    pinsBtn.title = `${open} open on this page (${mine.length} in all). Click to ${pinsHidden ? "show" : "hide"} the pins.`;
    pinsBtn.style.opacity = pinsHidden ? "0.6" : "1";
    const shown = new Set();
    const placed = [];
    if (!pinsHidden && !picking) {
      for (const c of mine) {
        const at = findTarget(c);
        if (!at) continue;
        let { x, y } = at;
        // Two comments on the same spot sit side by side, so both can be clicked.
        while (placed.some((p) => Math.abs(p.x - x) < 24 && Math.abs(p.y - y) < 24)) x += 26;
        placed.push({ x, y });
        if (x < -20 || y < -20 || x > innerWidth + 20 || y > innerHeight + 20) continue;
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
        pin.title = `#${c.n} ${c.author}: ${c.text.slice(0, 120)}`;
        pin.setAttribute("aria-label", `Comment ${c.n} by ${c.author}`);
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
  addEventListener("hashchange", () => {
    closeCard();
    schedulePins();
  });
  // The app re-renders without telling anyone; keep the pins on their elements.
  setInterval(() => {
    schedulePins();
    updateSignin();
  }, 1000);
  // Everyone's new comments appear within a few seconds.
  setInterval(() => { if (!document.hidden) refresh(); }, 10000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

  // --- picking ------------------------------------------------------------

  function startPick() {
    closeCard();
    picking = true;
    pickBtn.classList.add("on");
    pickBtn.textContent = "Cancel";
    hintEl = el("div", "hint", "Click the spot you want to comment on · <kbd>Esc</kbd> to cancel");
    hlEl = el("div", "hl", "<span></span>");
    hlEl.style.display = "none";
    root.append(hintEl, hlEl);
    document.documentElement.style.cursor = "crosshair";
    renderPins();
  }

  function stopPick() {
    picking = false;
    hovered = null;
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
  // own Tab trap). Moving into the review card must not count as leaving, or
  // the dialog pulls focus back and the comment gets typed into the app.
  for (const type of ["focusout", "blur"]) {
    addEventListener(type, (e) => { if (e.relatedTarget === host || e.target === host) e.stopImmediatePropagation(); }, true);
  }
  for (const type of ["focusin", "focus"]) {
    addEventListener(type, (e) => { if (e.target === host) e.stopImmediatePropagation(); }, true);
  }

  document.addEventListener(
    "mousemove",
    (e) => {
      if (!picking || !fromPage(e)) return;
      const n = document.elementFromPoint(e.clientX, e.clientY);
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
      const n = document.elementFromPoint(e.clientX, e.clientY) || document.body;
      const r = n.getBoundingClientRect();
      const spot = {
        clientX: e.clientX,
        clientY: e.clientY,
        selector: selectorFor(n),
        label: describe(n),
        xPct: r.width ? (e.clientX - r.left) / r.width : 0.5,
        yPct: r.height ? (e.clientY - r.top) / r.height : 0.5,
        pageX: e.clientX + scrollX,
        pageY: e.clientY + scrollY,
      };
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
        else closeCard();
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

  function closeCard() {
    root.querySelectorAll(".card").forEach((c) => c.remove());
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
    closeCard();
    let kind = "bug";
    let priority = "medium";
    const card = el("div", "card");
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
      <div class="row"><button type="button" class="ghost" data-cancel>Cancel</button><button type="button" class="go" data-save>Save comment</button></div>`;
    body.querySelector("[data-kind]").replaceWith(chips(KINDS, kind, (k) => (kind = k), "What kind"));
    body.querySelector("[data-pri]").replaceWith(chips(PRIORITIES, priority, (p) => (priority = p), "How urgent"));
    card.querySelector("header button").addEventListener("click", closeCard);
    body.querySelector("[data-cancel]").addEventListener("click", closeCard);
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
      const screenshot = wantShot ? await capture(spot) : null;
      try {
        const { comment } = await send("POST", API, {
          kind,
          priority,
          text,
          screenshot,
          page: { origin: location.origin, url: urlWithoutFocus(), key: pageKey(), title: document.title },
          target: { selector: spot.selector, label: spot.label, xPct: spot.xPct, yPct: spot.yPct, pageX: spot.pageX, pageY: spot.pageY },
          viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio || 1 },
          tech: (window.__jadmReviewLog || []).slice(-30),
        });
        // A refresh that landed while saving may already have it.
        if (!comments.some((v) => v.id === comment.id)) comments.push(comment);
        closeCard();
        renderPins();
        toast(`Comment #${comment.n} saved — the whole team can see it${wantShot && !screenshot ? " (the screenshot could not be taken)" : ""}`);
      } catch {
        card.style.visibility = "";
        saveBtn.disabled = false;
        saveBtn.textContent = "Save comment";
        toast("Could not save. Check the connection and try again.", true);
      }
    };
    saveBtn.addEventListener("click", save);
    placeCard(card, spot.clientX, spot.clientY);
    textEl.focus();
  }

  function urlWithoutFocus() {
    const u = new URL(location.href);
    u.searchParams.delete("review-focus");
    return u.pathname + u.search + u.hash;
  }

  function showComment(id, x, y) {
    const c = comments.find((v) => v.id === id);
    if (!c) return;
    closeCard();
    const card = el("div", "card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", `Comment ${c.n}`);
    const statusTag = c.status === "open" ? "" : `<span class="tag ${c.status}">${c.status === "fixed" ? "Fixed" : "Won't fix"}${c.statusBy ? ` · ${esc(c.statusBy)}` : ""}</span>`;
    card.innerHTML = `<header><span>#${c.n} · ${esc(c.author)}</span><button type="button" aria-label="Close">×</button></header>
      <div class="body">
        <div class="meta"><span class="tag">${esc(label(KINDS, c.kind))}</span><span class="tag ${c.priority}">${esc(label(PRIORITIES, c.priority))}</span>${statusTag}<span>${esc(ago(c.createdAt))}</span></div>
        <p class="text">${esc(c.text)}</p>
        ${c.shot ? `<img class="shot" src="${esc(shotUrl(c.id))}" alt="Screenshot taken with the comment">` : ""}
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
    card.querySelector(".shot")?.addEventListener("click", () => open(shotUrl(c.id), "_blank"));
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
      s.onload = () => resolve(window.html2canvas);
      s.onerror = () => {
        libLoading = null;
        reject(new Error("screenshot library did not load"));
      };
      document.head.appendChild(s);
    });
    return libLoading;
  }

  async function capture(spot) {
    try {
      const html2canvas = await loadShotLib();
      host.style.display = "none";
      // Where the spot is now, not where it was clicked: the page may have
      // scrolled while the comment was being written.
      const at = findTarget({ target: spot }) || { x: spot.clientX, y: spot.clientY };
      // Big screens make big pictures; 1600px across is plenty to see the problem.
      const scale = Math.min(devicePixelRatio || 1, 1.5, 1600 / innerWidth);
      const canvas = await Promise.race([
        html2canvas(document.body, {
          x: scrollX,
          y: scrollY,
          width: innerWidth,
          height: innerHeight,
          windowWidth: innerWidth,
          windowHeight: innerHeight,
          scale,
          useCORS: true,
          logging: false,
          ignoreElements: (n) => n === host,
          // The copy the picture is drawn from starts its animations over;
          // finish them at once so it shows what the reviewer was looking at,
          // not the first frame of an intro.
          onclone: (doc) => {
            const s = doc.createElement("style");
            s.textContent =
              "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;" +
              "animation-iteration-count:1!important;transition-duration:0s!important;transition-delay:0s!important}";
            doc.head.appendChild(s);
          },
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 15000)),
      ]);
      const ctx = canvas.getContext("2d");
      ctx.lineWidth = 4 * scale;
      ctx.strokeStyle = "#da1e28";
      ctx.beginPath();
      ctx.arc(at.x * scale, at.y * scale, 22 * scale, 0, Math.PI * 2);
      ctx.stroke();
      return canvas.toDataURL("image/jpeg", 0.8);
    } catch {
      return null;
    } finally {
      host.style.display = "";
    }
  }

  // --- wiring -------------------------------------------------------------

  root.querySelector(".bar").addEventListener("click", (e) => {
    const act = e.target.closest("button")?.dataset.act;
    if (act === "pick") picking ? stopPick() : startPick();
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
    const id = new URLSearchParams(location.search).get("review-focus");
    if (!id) return;
    for (let i = 0; i < 20; i++) {
      const c = comments.find((v) => v.id === id);
      if (c) {
        if (pinsHidden) {
          pinsHidden = false;
          store.set(HIDE_KEY, "0");
        }
        const n = uniqueMatch(c.target.selector);
        if (n) n.scrollIntoView({ block: "center" });
        else scrollTo(0, Math.max(0, c.target.pageY - innerHeight / 2));
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
