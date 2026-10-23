// The review site's promises, each checked against a real running copy.
// Run: npm test   (add TEST_DATABASE_URL=postgresql://… to run them on PostgreSQL)
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startSite, enter, api, sample, TINY_PNG, TEAM_PASSWORD } from "./helpers.js";

const JADM = "https://jadm.ai";

describe("the door: name and team password", () => {
  let site;
  before(async () => (site = await startSite()));
  after(() => site.stop());

  test("a stranger is sent to the name page, and the API refuses them", async () => {
    const page = await fetch(`${site.base}/`, { redirect: "manual", headers: { accept: "text/html" } });
    assert.equal(page.status, 302);
    assert.match(page.headers.get("location"), /^\/__review\/enter\?next=/);
    const data = await fetch(`${site.base}/__review/api/comments`);
    assert.equal(data.status, 401);
  });

  test("the right password lets a reviewer in, with their name", async () => {
    const { status, token } = await enter(site.base, "Sara Ali");
    assert.equal(status, 303);
    const me = await (await fetch(`${site.base}/__review/api/me`, { headers: { "x-review-token": token } })).json();
    assert.equal(me.name, "Sara Ali");
  });

  test("a wrong password is refused", async () => {
    const { status, token } = await enter(site.base, "Sara", "nope", { "x-forwarded-for": "10.0.0.1" });
    assert.equal(status, 401);
    assert.equal(token, null);
  });

  test("an empty name is refused", async () => {
    const { status } = await enter(site.base, "   ");
    assert.equal(status, 400);
  });

  test("five wrong passwords from one address make it wait; others are not affected", async () => {
    const ip = { "x-forwarded-for": "10.9.9.9" };
    for (let i = 0; i < 5; i++) assert.equal((await enter(site.base, "X", "wrong", ip)).status, 401);
    assert.equal((await enter(site.base, "X", TEAM_PASSWORD, ip)).status, 429);
    assert.equal((await enter(site.base, "X", TEAM_PASSWORD, { "x-forwarded-for": "10.1.1.1" })).status, 303);
  });

  test("after entering, the reviewer only ever goes somewhere on this site", async () => {
    const go = async (next) => {
      const r = await fetch(`${site.base}/__review/enter`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "10.2.2.2" },
        body: new URLSearchParams({ name: "Sara", password: TEAM_PASSWORD, next }).toString(),
      });
      return r.headers.get("location");
    };
    assert.equal(await go("/__review/"), "/__review/");
    assert.equal(await go("/#/invoices"), "/#/invoices");
    for (const evil of ["//evil.example", "/\\evil.example", "/\t/evil.example", "https://evil.example", "javascript:alert(1)", "/__review/enter"]) {
      assert.equal(await go(evil), "/", `next=${JSON.stringify(evil)}`);
    }
  });

  test("a huge sign-in post is cut off instead of filling memory", async () => {
    const r = await fetch(`${site.base}/__review/enter`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=" + "a".repeat(200_000),
    }).catch(() => null);
    assert.ok(r === null || r.status === 413);
  });
});

describe("the personal JADM Comment button", () => {
  let site;
  let token;
  before(async () => {
    site = await startSite();
    ({ token } = await enter(site.base, "Nati"));
  });
  after(() => site.stop());

  test("without the mirror, the site's home is the button page", async () => {
    const r = await fetch(`${site.base}/`, { redirect: "manual", headers: { accept: "text/html", cookie: `jadm_reviewer=${token}` } });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/__review/setup");
    const other = await fetch(`${site.base}/api/invoices`, { headers: { cookie: `jadm_reviewer=${token}` } });
    assert.equal(other.status, 404, "nothing is passed on to jadm.ai");
  });

  test("the button carries this reviewer's token and only works on jadm.ai", async () => {
    const html = await (await fetch(`${site.base}/__review/setup`, { headers: { cookie: `jadm_reviewer=${token}` } })).text();
    const href = /href="(javascript:[^"]+)"/.exec(html)?.[1];
    assert.ok(href, "the page has a bookmark button");
    const code = decodeURIComponent(href.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).slice("javascript:".length));
    assert.ok(code.includes(JSON.stringify(token)), "it carries the token");
    assert.ok(code.includes('location.hostname!=="jadm.ai"'), "it checks it is on jadm.ai");
    assert.ok(code.includes(`${site.base}/__review/widget.js`), "it loads the widget from this site");
    assert.ok(html.includes("Nati"), "the page names its owner");
  });

  test("the widget itself loads without any login", async () => {
    const r = await fetch(`${site.base}/__review/widget.js`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /javascript/);
  });

  test("a changed or made-up token is refused", async () => {
    const call = api(site.base, token.slice(0, -2) + "xx");
    assert.equal((await call("GET", "")).status, 401);
    const madeUp = Buffer.from("Omar").toString("base64url") + ".abc";
    assert.equal((await api(site.base, madeUp)("GET", "")).status, 401);
  });

  test("only jadm.ai may call the review API from a browser", async () => {
    const preflight = (origin) =>
      fetch(`${site.base}/__review/api/comments`, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-review-token" },
      });
    const ok = await preflight(JADM);
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get("access-control-allow-origin"), JADM);
    assert.match(ok.headers.get("access-control-allow-headers"), /x-review-token/);
    const evil = await preflight("https://evil.example");
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
    const real = await api(site.base, token)("GET", "", undefined, { origin: JADM });
    assert.equal(real.headers.get("access-control-allow-origin"), JADM);
  });
});

describe("comments", () => {
  let site;
  let sara;
  let omar;
  before(async () => {
    site = await startSite();
    sara = api(site.base, (await enter(site.base, "Sara")).token);
    omar = api(site.base, (await enter(site.base, "Omar")).token);
  });
  after(() => site.stop());

  test("a comment is saved with its details and the writer's own name", async () => {
    const { status, data } = await sara("POST", "", sample({ author: "Somebody Else", screenshot: TINY_PNG }));
    assert.equal(status, 201);
    const c = data.comment;
    assert.equal(c.author, "Sara", "the name comes from the token, not the request");
    assert.equal(c.status, "open");
    assert.equal(c.kind, "design");
    assert.equal(c.priority, "high");
    assert.equal(c.page.origin, JADM);
    assert.equal(c.page.key, "/#/receivables");
    assert.equal(c.shot, true);
    assert.equal(typeof c.n, "number");
  });

  test("everyone sees everyone's comments", async () => {
    const { data } = await omar("GET", "");
    assert.ok(data.comments.some((c) => c.author === "Sara"));
  });

  test("the screenshot loads with the token in its address, and not without", async () => {
    const { data } = await sara("GET", "");
    const c = data.comments.find((x) => x.shot);
    const token = (await enter(site.base, "Sara")).token;
    const withT = await fetch(`${site.base}/__review/shots/${c.id}?t=${encodeURIComponent(token)}`);
    assert.equal(withT.status, 200);
    assert.equal(withT.headers.get("content-type"), "image/png");
    assert.equal((await withT.arrayBuffer()).byteLength > 0, true);
    const without = await fetch(`${site.base}/__review/shots/${c.id}`);
    assert.equal(without.status, 401);
  });

  test("a comment without text is refused; unknown kinds and priorities fall back", async () => {
    assert.equal((await sara("POST", "", sample({ text: "   " }))).status, 400);
    const { data } = await sara("POST", "", sample({ kind: "rant", priority: "urgent!!" }));
    assert.equal(data.comment.kind, "bug");
    assert.equal(data.comment.priority, "medium");
  });

  test("a broken request is answered, not crashed on", async () => {
    assert.equal((await sara("POST", "", "{not json")).status, 400);
    assert.equal((await sara("POST", "", sample({ screenshot: "data:text/html;base64,PHNjcmlwdD4=" }))).data.comment.shot, false);
    assert.equal((await sara("GET", "")).status, 200, "still answering");
  });

  test("replies and status changes carry who did them", async () => {
    const { data } = await sara("POST", "", sample({ text: "Reply test" }));
    const id = data.comment.id;
    const r1 = await omar("PATCH", `/${id}`, { reply: { text: "Seen it too", author: "Fake" } });
    assert.equal(r1.data.comment.replies.at(-1).author, "Omar");
    const r2 = await omar("PATCH", `/${id}`, { status: "fixed" });
    assert.equal(r2.data.comment.status, "fixed");
    assert.equal(r2.data.comment.statusBy, "Omar");
    const r3 = await sara("PATCH", `/${id}`, { status: "open" });
    assert.equal(r3.data.comment.status, "open");
    assert.equal((await sara("PATCH", `/${id}`, { reply: { text: "  " } })).status, 400);
    assert.equal((await sara("PATCH", "/00000000-0000-4000-8000-000000000000", { status: "fixed" })).status, 404);
  });

  test("only the writer can delete a comment, and its screenshot goes with it", async () => {
    const { data } = await sara("POST", "", sample({ text: "Delete me", screenshot: TINY_PNG }));
    const id = data.comment.id;
    assert.equal((await omar("DELETE", `/${id}`)).status, 403);
    assert.equal((await sara("DELETE", `/${id}`)).status, 204);
    const token = (await enter(site.base, "Sara")).token;
    assert.equal((await fetch(`${site.base}/__review/shots/${id}?t=${encodeURIComponent(token)}`)).status, 404);
    assert.equal((await sara("GET", "")).data.comments.some((c) => c.id === id), false);
  });

  test("comments written at the same moment all get their own number", async () => {
    const made = await Promise.all(Array.from({ length: 12 }, (_, i) => sara("POST", "", sample({ text: `Burst ${i}`, screenshot: TINY_PNG }))));
    const ns = made.map((r) => r.data.comment.n);
    assert.equal(new Set(ns).size, ns.length);
  });

  test("text that looks like code is stored as plain text", async () => {
    const evil = '<img src=x onerror="alert(1)">';
    const { data } = await sara("POST", "", sample({ text: evil, target: { label: evil, selector: evil } }));
    assert.equal(data.comment.text, evil, "kept exactly; the pages show it escaped");
  });
});

describe("the feedback board", () => {
  let site;
  before(async () => (site = await startSite()));
  after(() => site.stop());

  test("needs the name page first, then shows", async () => {
    const no = await fetch(`${site.base}/__review/`, { redirect: "manual", headers: { accept: "text/html" } });
    assert.equal(no.status, 302);
    const { token } = await enter(site.base, "Nati");
    const yes = await fetch(`${site.base}/__review/`, { headers: { cookie: `jadm_reviewer=${token}` } });
    assert.equal(yes.status, 200);
    assert.match(await yes.text(), /JADM Feedback/);
  });
});

describe("on Vercel and Render", () => {
  test("without a team password the site only says what to set", async () => {
    const site = await startSite({ env: { TEAM_PASSWORD: "", RENDER: "true" }, useDb: false });
    try {
      const r = await fetch(`${site.base}/`, { headers: { accept: "text/html" } });
      assert.equal(r.status, 503);
      assert.match(await r.text(), /TEAM_PASSWORD is not set/);
      assert.equal((await fetch(`${site.base}/__review/api/comments`)).status, 503);
    } finally {
      await site.stop();
    }
  });

  test("on Vercel without a database the site says how to connect one", async () => {
    const site = await startSite({ vercel: true, useDb: false });
    try {
      const r = await fetch(`${site.base}/`, { headers: { accept: "text/html" } });
      assert.equal(r.status, 503);
      assert.match(await r.text(), /No database is connected/);
    } finally {
      await site.stop();
    }
  });

  test("the same team password gives the same keys on every copy, so buttons keep working", async () => {
    const a = await startSite({ useDb: false });
    const b = await startSite({ useDb: false });
    try {
      const { token } = await enter(a.base, "Lina");
      const me = await fetch(`${b.base}/__review/api/me`, { headers: { "x-review-token": token } });
      assert.equal(me.status, 200);
      assert.equal((await me.json()).name, "Lina");
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  test("changing the team password retires every old button", async () => {
    const a = await startSite({ useDb: false });
    const b = await startSite({ useDb: false, env: { TEAM_PASSWORD: "a-new-team-password" } });
    try {
      const { token } = await enter(a.base, "Lina");
      assert.equal((await fetch(`${b.base}/__review/api/me`, { headers: { "x-review-token": token } })).status, 401);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  test("run as the Vercel function, with a database, it works end to end", { skip: !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run" }, async () => {
    const site = await startSite({ vercel: true });
    try {
      const sara = api(site.base, (await enter(site.base, "Sara")).token);
      const made = await sara("POST", "", sample({ screenshot: TINY_PNG }), { origin: JADM });
      assert.equal(made.status, 201);
      assert.equal(made.headers.get("access-control-allow-origin"), JADM);
      assert.equal((await sara("GET", "")).data.comments.length, 1);
    } finally {
      await site.stop();
    }
  });

  test("comments, replies and screenshots are still there after a restart", async () => {
    const first = await startSite();
    const sara = api(first.base, (await enter(first.base, "Sara")).token);
    const { data } = await sara("POST", "", sample({ text: "Survives restarts", screenshot: TINY_PNG }));
    await sara("PATCH", `/${data.comment.id}`, { reply: { text: "and its reply" } });
    await first.stop({ keepData: true });

    const second = await startSite({ dataDir: first.dataDir, fresh: false });
    try {
      const token = (await enter(second.base, "Omar")).token;
      const again = (await api(second.base, token)("GET", "")).data.comments.find((c) => c.id === data.comment.id);
      assert.ok(again, "the comment is still there");
      assert.equal(again.replies[0].text, "and its reply");
      const shot = await fetch(`${second.base}/__review/shots/${again.id}?t=${encodeURIComponent(token)}`);
      assert.equal(shot.status, 200);
    } finally {
      await second.stop({ keepData: false });
    }
  });
});
