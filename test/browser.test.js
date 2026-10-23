// Where the marks land: the red circle in a saved screenshot and the pin on
// the page must sit exactly on the spot the reviewer clicked — or not be
// shown at all, never somewhere else. Runs in a real browser on a stand-in
// page shaped like jadm.ai (test/fixture/page.html).
//
// Part of npm test. Needs a browser: `npx playwright-core install chromium`
// once, or PW_CHANNEL=chrome to use an installed Google Chrome.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startSite, TEAM_PASSWORD } from "./helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = await import("playwright-core");
const launchOptions = { args: ["--auto-accept-this-tab-capture"], ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}) };
// No browser available: say so instead of failing every test.
let skip = false;
try {
  await (await chromium.launch(launchOptions)).close();
} catch {
  skip = "no browser: run `npx playwright-core install chromium`, or set PW_CHANNEL=chrome";
}

// The fixture app on its own port, standing in for jadm.ai.
function serveFixture() {
  const html = fs.readFileSync(path.join(HERE, "fixture", "page.html"));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// A review site pointed at the fixture, a browser on the fixture with the
// widget on (as a reviewer's button would), and the reviewer's token.
async function openFixture({ W = 1280, H = 800, mode = "quick" } = {}) {
  const fixture = await serveFixture();
  const base = `http://127.0.0.1:${fixture.address().port}`;
  const site = await startSite({ env: { TARGET_URL: base }, useDb: false });
  const browser = await chromium.launch(launchOptions);
  const page = await (await browser.newContext({ viewport: { width: W, height: H } })).newPage();
  await page.goto(`${site.base}/`);
  await page.fill("#n", "Tester");
  await page.fill("#p", TEAM_PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL(/__review\/setup/);
  const code = decodeURIComponent((await page.locator("#bm").getAttribute("href")).slice("javascript:".length));
  const token = JSON.parse(/__jadmReviewToken=("[^"]+")/.exec(code)[1]);
  const on = async () => {
    await page.evaluate((c) => (0, eval)(c), code);
    await page.locator('button[data-act="pick"]').waitFor();
    await page.waitForFunction(() => window.html2canvas, null, { timeout: 20000 }).catch(() => {});
  };
  await page.goto(`${base}/`);
  await page.evaluate((m) => localStorage.setItem("jadm-review-exact", m === "exact" ? "on" : "off"), mode);
  await on();
  let n = 0;
  return {
    page,
    site,
    token,
    on,
    // Pick a spot and save a comment there; returns the saved comment.
    async comment(spot, text, { wait = true } = {}) {
      await page.locator('button[data-act="pick"]').click();
      await page.locator(".hint").waitFor();
      await page.mouse.move(spot.x, spot.y, { steps: 3 });
      await page.mouse.click(spot.x, spot.y);
      await page.locator("#rv-text").fill(text);
      await page.locator("button[data-save]").click();
      n += 1;
      if (wait) await page.locator(".toast", { hasText: `#${n} saved` }).waitFor({ timeout: 30000 });
      return this.last(text);
    },
    async last(text) {
      const list = await (await fetch(`${site.base}/__review/api/comments`, { headers: { "x-review-token": token } })).json();
      return list.comments.filter((c) => !text || c.text === text).at(-1);
    },
    async shotOf(c) {
      return Buffer.from(await (await fetch(`${site.base}/__review/shots/${c.id}?k=${c.shotKey}`)).arrayBuffer());
    },
    async pins() {
      await page.waitForTimeout(1300); // one pin refresh tick
      return page.evaluate(() =>
        Object.fromEntries(
          [...document.getElementById("jadm-review").shadowRoot.querySelectorAll(".pin")].map((p) => [p.dataset.id, { x: parseFloat(p.style.left), y: parseFloat(p.style.top), count: p.dataset.count }]),
        ),
      );
    },
    async close() {
      await browser.close();
      await site.stop();
      fixture.close();
    },
  };
}

const spotIn = async (locator, fx = 0.5, fy = 0.5) => {
  const b = await locator.boundingBox();
  return { x: Math.round(b.x + b.width * fx), y: Math.round(b.y + b.height * fy) };
};

// Finds the red ring (#da1e28) in a saved picture; its centre in CSS pixels.
async function ringIn(page, jpeg, cssWidth) {
  return page.evaluate(
    async ({ src, w }) => {
      const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = src; });
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (d[i] > 170 && d[i + 1] < 70 && d[i + 2] < 80 && d[i] - d[i + 1] > 120) {
          if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
      if (maxX < 0) return null;
      const k = img.width / w;
      return { x: (minX + maxX) / 2 / k, y: (minY + maxY) / 2 / k };
    },
    { src: `data:image/jpeg;base64,${jpeg.toString("base64")}`, w: cssWidth },
  );
}

const TARGETS = [
  ["a button", (p) => p.locator("#new-invoice"), 0.5, 0.5],
  ["inside the chart", (p) => p.locator("#chart"), 0.62, 0.45],
  ["a sidebar link", (p) => p.locator("#nav-analytics"), 0.4, 0.5],
  ["the search box in the top bar", (p) => p.locator("header input"), 0.3, 0.5],
  ["big text", (p) => p.locator("#balance"), 0.8, 0.5],
  ["an icon", (p) => p.locator("#overdue svg"), 0.5, 0.5],
  ["far down, after scrolling", (p) => p.locator("#far-down"), 0.5, 0.5, true],
];

for (const [W, H, mode] of [[1920, 1000, "exact"], [1920, 1000, "quick"], [1280, 800, "quick"]]) {
  describe(`marks at ${W}x${H}, ${mode} pictures`, { skip }, () => {
    let f;
    const made = [];
    before(async () => (f = await openFixture({ W, H, mode })));
    after(() => f?.close());

    for (const [name, find, fx, fy, scroll] of TARGETS) {
      test(`the circle in the screenshot sits on ${name}`, async () => {
        await f.page.evaluate(() => scrollTo(0, 0));
        if (scroll) await f.page.evaluate(() => document.getElementById("far-down").scrollIntoView({ block: "center" }));
        const spot = await spotIn(find(f.page), fx, fy);
        const c = await f.comment(spot, `Mark on ${name}`);
        made.push({ c, find, fx, fy, scroll, name });
        const mark = await f.page.evaluate(() => window.__jadmReviewLastMark);
        assert.equal(Boolean(mark?.exact), mode === "exact", `${mode} picture taken`);
        assert.ok(mark?.marked, "the picture is marked");
        const ring = await ringIn(f.page, await f.shotOf(c), W);
        assert.ok(ring, "the picture has a red circle");
        const off = Math.hypot(ring.x - spot.x, ring.y - spot.y);
        assert.ok(off <= 3, `circle ${off.toFixed(1)}px from the spot (allowed 3); drawn at ${JSON.stringify(mark)}`);
      });
    }

    test("after a reload, every pin sits on its spot", async () => {
      await f.page.reload();
      await f.on();
      for (const m of made) {
        await f.page.evaluate(() => scrollTo(0, 0));
        if (m.scroll) await f.page.evaluate(() => document.getElementById("far-down").scrollIntoView({ block: "center" }));
        const spot = await spotIn(m.find(f.page), m.fx, m.fy);
        const pin = (await f.pins())[m.c.id];
        assert.ok(pin, `pin for ${m.name} is shown`);
        const off = Math.hypot(pin.x - spot.x, pin.y - spot.y);
        assert.ok(off <= 2, `pin for ${m.name} ${off.toFixed(1)}px from its spot (allowed 2)`);
      }
    });
  });
}

describe("never a mark in the wrong place", { skip }, () => {
  test("two comments on the same spot: both pins exactly on it, and clicking there lists both", async () => {
    const f = await openFixture();
    try {
      const spot = await spotIn(f.page.locator("#new-invoice"));
      const a = await f.comment(spot, "Same spot 1");
      const b = await f.comment({ x: spot.x + 3, y: spot.y }, "Same spot 2");
      const pins = await f.pins();
      assert.ok(Math.abs(pins[a.id].x - spot.x) <= 1 && Math.abs(pins[a.id].y - spot.y) <= 1, "first pin on its spot");
      assert.ok(Math.abs(pins[b.id].x - (spot.x + 3)) <= 1 && Math.abs(pins[b.id].y - spot.y) <= 1, "second pin on its own spot, not pushed aside");
      assert.ok(pins[a.id].count === "2" && pins[b.id].count === "2", "each says 2 comments here");
      await f.page.locator(".pin").last().click();
      await f.page.locator(".card .choice").first().waitFor();
      assert.equal(await f.page.locator(".card .choice").count(), 2, "both comments to choose from");
    } finally {
      await f.close();
    }
  });

  test("clicking empty top bar picks the bar, never content hidden under it", async () => {
    const f = await openFixture();
    try {
      // Scroll so the Open balance card lies under the see-through top bar.
      await f.page.evaluate(() => scrollTo(0, 150));
      const bar = await f.page.locator("header").boundingBox();
      const c = await f.comment({ x: Math.round(bar.x + bar.width * 0.62), y: Math.round(bar.y + bar.height / 2) }, "Empty top bar");
      assert.match(c.target.label, /^header/, `picked ${c.target.label}`);
    } finally {
      await f.close();
    }
  });

  test("a pin whose element is covered by the top bar is hidden, not drawn on the bar", async () => {
    const f = await openFixture();
    try {
      const c = await f.comment(await spotIn(f.page.locator("#balance"), 0.3, 0.5), "Balance");
      assert.ok((await f.pins())[c.id], "shown while visible");
      const b = await f.page.locator("#balance").boundingBox();
      await f.page.evaluate((dy) => scrollBy(0, dy), Math.round(b.y + b.height / 2 - 28));
      assert.equal((await f.pins())[c.id], undefined, "hidden while under the bar");
    } finally {
      await f.close();
    }
  });

  test("when the data changes, a pin never moves onto a different bubble", async () => {
    const f = await openFixture();
    try {
      const c = await f.comment(await spotIn(f.page.locator("#overdue svg")), "Overdue icon");
      assert.match(c.target.label, /Overdue, not on the ladder/, "the icon is known by its bubble");
      // Next day: a new bubble appears before it, so positions shift.
      await f.page.evaluate(() => {
        const li = document.createElement("li");
        li.innerHTML = '<a href="#/contacts"><svg viewBox="0 0 10 10"><path d="M1 9 L5 1 L9 9 Z" fill="#525252"/></svg><span>1 Customers nobody can write to</span></a>';
        document.getElementById("needs").insertBefore(li, document.getElementById("needs").children[1]);
      });
      const pin = (await f.pins())[c.id];
      if (pin) {
        const now = await spotIn(f.page.locator("#overdue svg"));
        assert.ok(Math.hypot(pin.x - now.x, pin.y - now.y) <= 2, "if shown, it is on the Overdue icon");
      }
      const other = await spotIn(f.page.locator('a[href="#/contacts"] svg'));
      assert.ok(!pin || Math.hypot(pin.x - other.x, pin.y - other.y) > 20, "never on the new bubble");
      // A changed count on the same bubble still finds it.
      await f.page.evaluate(() => { document.querySelector("#overdue span").textContent = "25 Overdue, not on the ladder"; });
      await f.page.evaluate(() => document.getElementById("needs").children[1].remove());
      const back = (await f.pins())[c.id];
      const now = await spotIn(f.page.locator("#overdue svg"));
      assert.ok(back && Math.hypot(back.x - now.x, back.y - now.y) <= 2, "with the count changed, the pin is back on the Overdue icon");
    } finally {
      await f.close();
    }
  });

  test("two quick comments in a row: each picture circles its own spot", async () => {
    const f = await openFixture({ W: 1920, H: 1000 });
    try {
      const s1 = await spotIn(f.page.locator("#chart"), 0.3, 0.5);
      const s2 = await spotIn(f.page.locator("#new-invoice"));
      // Pick the first spot and cancel at once, then comment on the second
      // while the first picture may still be being drawn.
      await f.page.locator('button[data-act="pick"]').click();
      await f.page.locator(".hint").waitFor();
      await f.page.mouse.click(s1.x, s1.y);
      await f.page.locator("[data-cancel]").click();
      const c = await f.comment(s2, "Second spot");
      const ring = await ringIn(f.page, await f.shotOf(c), 1920);
      assert.ok(ring && Math.hypot(ring.x - s2.x, ring.y - s2.y) <= 3, `circle on the second spot (got ${JSON.stringify(ring)}, want ${JSON.stringify(s2)})`);
    } finally {
      await f.close();
    }
  });

  test("exact picture while the page is still gliding: the circle is on the clicked element", async () => {
    const f = await openFixture({ W: 1280, H: 800, mode: "exact" });
    try {
      await f.page.evaluate(() => { document.documentElement.style.scrollBehavior = "smooth"; });
      await f.page.evaluate(() => scrollTo(0, 300));
      const spot = await spotIn(f.page.locator("#overdue span"), 0.5, 0.5);
      const c = await f.comment(spot, "While gliding");
      const now = await spotIn(f.page.locator("#overdue span"), 0.5, 0.5);
      const ring = await ringIn(f.page, await f.shotOf(c), 1280);
      const mark = await f.page.evaluate(() => window.__jadmReviewLastMark);
      if (mark?.marked) assert.ok(ring && Math.hypot(ring.x - now.x, ring.y - now.y) <= 3, `circle on the element as the picture shows it (ring ${JSON.stringify(ring)}, element ${JSON.stringify(now)})`);
    } finally {
      await f.close();
    }
  });

  test("an old comment made on the window-wide layer gets no pin", async () => {
    const f = await openFixture();
    try {
      const r = await fetch(`${f.site.base}/__review/api/comments`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-review-token": f.token },
        body: JSON.stringify({
          text: "Saved by an older widget on the layer",
          page: { origin: "", url: "/", key: "/#/dashboard", title: "" },
          target: { selector: "#veil", label: "div", xPct: 0.5, yPct: 0.5, pageX: 600, pageY: 400 },
        }),
      });
      const { comment } = await r.json();
      await f.page.reload();
      await f.on();
      assert.equal((await f.pins())[comment.id], undefined);
    } finally {
      await f.close();
    }
  });
});
