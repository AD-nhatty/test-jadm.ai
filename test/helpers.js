// Starts a real copy of the review site for a test: its own port, its own
// settings and its own comment storage, gone when the test ends.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TEAM_PASSWORD = "correct-horse-battery";

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

/*
 * env: settings for this copy. By default comments go to a fresh temporary
 * folder; with TEST_DATABASE_URL set, to that PostgreSQL instead (each copy
 * empties the table first). `vercel: true` runs it the way Vercel does —
 * VERCEL set, answered through api/index.js — instead of `node server.js`.
 */
export async function startSite({
  env = {},
  vercel = false,
  useDb = Boolean(process.env.TEST_DATABASE_URL),
  // Pass a folder (and fresh: false) to start a second copy on the same comments.
  dataDir: keepDir = null,
  fresh = true,
} = {}) {
  const port = await freePort();
  const dataDir = keepDir || fs.mkdtempSync(path.join(os.tmpdir(), "jadm-review-test-"));
  if (useDb && fresh) await emptyTable(process.env.TEST_DATABASE_URL);
  const childEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    PORT: String(port),
    TEAM_PASSWORD,
    DATA_DIR: dataDir,
    ...(useDb ? { DATABASE_URL: process.env.TEST_DATABASE_URL } : {}),
    ...env,
  };
  for (const [k, v] of Object.entries(childEnv)) if (v === undefined || v === null) delete childEnv[k];
  const args = vercel ? [path.join(ROOT, "test", "vercel-host.js"), String(port)] : [path.join(ROOT, "server.js")];
  const child = spawn(process.execPath, args, { cwd: ROOT, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      await fetch(`${base}/__review/health`);
      break;
    } catch {
      if (child.exitCode !== null || i > 100) throw new Error(`site did not start:\n${output}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return {
    base,
    dataDir,
    output: () => output,
    async stop({ keepData = Boolean(keepDir) } = {}) {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
      if (!keepData) fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function emptyTable(url) {
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("DROP TABLE IF EXISTS review_comments");
  } finally {
    await c.end();
  }
}

// Through the name page; returns the reviewer's token (the cookie's value).
export async function enter(base, name, password = TEAM_PASSWORD, headers = {}) {
  const r = await fetch(`${base}/__review/enter`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ name, password, next: "/" }).toString(),
  });
  const cookie = r.headers.get("set-cookie") || "";
  const token = /jadm_reviewer=([^;]+)/.exec(cookie)?.[1] || null;
  return { status: r.status, location: r.headers.get("location"), token };
}

// The review API as the widget on jadm.ai calls it.
export function api(base, token) {
  return async (method, p, body, extra = {}) => {
    const r = await fetch(`${base}/__review/api/comments${p}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { "x-review-token": token } : {}), ...extra },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await r.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: r.status, data, headers: r.headers };
  };
}

// A 1×1 PNG, as the widget sends a screenshot.
export const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export const sample = (over = {}) => ({
  text: "The total is cut off on small screens.",
  kind: "design",
  priority: "high",
  page: { origin: "https://jadm.ai", url: "/#/receivables", key: "/#/receivables", title: "Receivables · JADM" },
  target: { selector: "body > div > main", label: 'main · "Receivables"', xPct: 0.5, yPct: 0.5, pageX: 100, pageY: 200 },
  viewport: { w: 1440, h: 900, dpr: 1 },
  ...over,
});
