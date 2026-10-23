/*
 * Where comments live.
 *
 *   DATABASE_URL set   PostgreSQL (what the deployed copy uses, so comments
 *                      survive restarts and redeploys)
 *   otherwise          a JSON file and a folder of pictures under ./data
 *                      (for running it on your own computer)
 *
 * Both give the same five calls: list, create, update, remove, shot.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function openStore() {
  // DATABASE_URL by hand or from Render; POSTGRES_URL is what Vercel's Neon
  // database adds when it is connected to the project.
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (url) return openPostgres(url);
  // A Vercel function has no disk that lasts, so files would vanish.
  if (process.env.VERCEL) {
    throw new Error("No database is connected. In Vercel open the project → Storage → Create Database → Neon (Postgres), connect it to this project, then redeploy.");
  }
  return openFiles(process.env.DATA_DIR || path.join(HERE, "data"));
}

async function openPostgres(url) {
  const { default: pg } = await import("pg");
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  // Small and quick to let go: on Vercel every running copy has its own pool.
  const pool = new pg.Pool({
    connectionString: url,
    ssl: local ? false : { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  // A connection the database drops while idle is an "error" event on the
  // pool; unheard, it would crash the whole server. The pool has already
  // thrown that connection away and opens a fresh one on the next query.
  pool.on("error", (err) => console.error("postgres: idle connection dropped:", err.message));
  await pool.query(`
    CREATE TABLE IF NOT EXISTS review_comments (
      id text PRIMARY KEY,
      n serial,
      data jsonb NOT NULL,
      shot bytea,
      shot_type text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);

  const row = (r) => ({ ...r.data, id: r.id, n: r.n });
  return {
    kind: "postgres",
    async list() {
      const { rows } = await pool.query("SELECT id, n, data FROM review_comments ORDER BY n");
      return rows.map(row);
    },
    async create(data, shot) {
      const id = crypto.randomUUID();
      const { rows } = await pool.query(
        "INSERT INTO review_comments (id, data, shot, shot_type) VALUES ($1, $2, $3, $4) RETURNING id, n, data",
        [id, { ...data, shot: Boolean(shot) }, shot?.buf ?? null, shot?.type ?? null],
      );
      return row(rows[0]);
    },
    // Read-modify-write in one transaction, so two people replying at the
    // same moment cannot lose each other's reply.
    async update(id, change) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query("SELECT id, n, data FROM review_comments WHERE id = $1 FOR UPDATE", [id]);
        if (!rows.length) {
          await client.query("ROLLBACK");
          return null;
        }
        const next = change(row(rows[0]));
        const { id: _id, n: _n, ...data } = next;
        await client.query("UPDATE review_comments SET data = $2 WHERE id = $1", [id, data]);
        await client.query("COMMIT");
        return next;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async remove(id) {
      const { rowCount } = await pool.query("DELETE FROM review_comments WHERE id = $1", [id]);
      return rowCount > 0;
    },
    async shot(id) {
      const { rows } = await pool.query("SELECT shot, shot_type FROM review_comments WHERE id = $1 AND shot IS NOT NULL", [id]);
      return rows.length ? { buf: rows[0].shot, type: rows[0].shot_type } : null;
    },
  };
}

async function openFiles(dir) {
  const shots = path.join(dir, "shots");
  const file = path.join(dir, "comments.json");
  fs.mkdirSync(shots, { recursive: true });
  let comments = [];
  try {
    comments = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      // Never overwrite a file we could not read; keep it aside instead.
      fs.renameSync(file, `${file}.unreadable-${Date.now()}`);
    }
  }
  // Saves are chained so two never interleave, and go through a temp file so
  // a crash mid-write leaves the previous file whole. On Windows the rename
  // can fail for a moment while something else has the file open, so it is
  // retried; and one failed save never blocks the ones after it.
  let saving = Promise.resolve();
  const writeOnce = async (text) => {
    await fs.promises.writeFile(`${file}.tmp`, text, "utf8");
    for (let i = 0; ; i++) {
      try {
        await fs.promises.rename(`${file}.tmp`, file);
        return;
      } catch (err) {
        if (i >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) throw err;
        await new Promise((r) => setTimeout(r, 50 * (i + 1)));
      }
    }
  };
  const save = () => {
    const run = saving.then(() => writeOnce(JSON.stringify(comments, null, 2)));
    saving = run.catch(() => {});
    return run;
  };
  const shotPath = (id) => path.join(shots, id);

  return {
    kind: "files",
    async list() {
      return comments;
    },
    async create(data, shot) {
      const id = crypto.randomUUID();
      // The number is taken before any wait, so two comments saved at the
      // same moment never share one.
      const n = comments.reduce((max, c) => Math.max(max, c.n), 0) + 1;
      const c = { ...data, id, n, shot: Boolean(shot) };
      comments.push(c);
      try {
        if (shot) await fs.promises.writeFile(shotPath(id), Buffer.concat([Buffer.from(`${shot.type}\n`), shot.buf]));
      } catch (err) {
        comments.splice(comments.indexOf(c), 1);
        throw err;
      }
      await save();
      return c;
    },
    async update(id, change) {
      const i = comments.findIndex((c) => c.id === id);
      if (i < 0) return null;
      comments[i] = change(comments[i]);
      await save();
      return comments[i];
    },
    async remove(id) {
      const i = comments.findIndex((c) => c.id === id);
      if (i < 0) return false;
      comments.splice(i, 1);
      await fs.promises.rm(shotPath(id), { force: true });
      await save();
      return true;
    },
    async shot(id) {
      try {
        const raw = await fs.promises.readFile(shotPath(id));
        const nl = raw.indexOf(10);
        return { type: raw.subarray(0, nl).toString(), buf: raw.subarray(nl + 1) };
      } catch {
        return null;
      }
    },
  };
}
