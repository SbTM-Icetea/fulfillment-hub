// FULFILLMENT HUB — database bersama (Netlify Functions + Netlify Blobs)
// Endpoint: /.netlify/functions/api?op=ping|login|bootstrap|meta|get|put
// Setiap key localStorage "tapelog*" disimpan sebagai blob berversi: d/<key>/<versi 8 digit>.
// Penulisan memakai onlyIfNew sehingga dua perangkat tidak bisa menimpa versi yang sama.
import { getStore } from "@netlify/blobs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_DAYS = 14;
const KEY_RE = /^tapelog[A-Za-z0-9_]{1,80}$/;
const pad = (n) => String(n).padStart(8, "0");
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const b64u = (s) => Buffer.from(s).toString("base64url");

function storeFor(context) {
  const ctx = (context && context.deploy && context.deploy.context) || "production";
  return getStore({ name: ctx === "production" ? "fulfillment-hub" : "fulfillment-hub-" + ctx, consistency: "strong" });
}

async function secret(store) {
  const env = Netlify.env.get("HUB_SECRET");
  if (env) return env;
  let s = await store.get("sys/secret");
  if (!s) { await store.set("sys/secret", randomBytes(32).toString("hex"), { onlyIfNew: true }); s = await store.get("sys/secret"); }
  return s;
}
async function makeToken(store, user) {
  const body = b64u(JSON.stringify({ u: user.username, r: user.role, exp: Date.now() + TOKEN_DAYS * 864e5 }));
  const sig = createHmac("sha256", await secret(store)).update(body).digest("base64url");
  return body + "." + sig;
}
async function readToken(store, req) {
  const h = req.headers.get("authorization") || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  const [body, sig] = t.split(".");
  if (!body || !sig) return null;
  const want = createHmac("sha256", await secret(store)).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(body, "base64url").toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}

// versi terbaru per key: { key: v } (+ etag per key di `etags`)
async function versions(store, prefix = "d/", etags) {
  const { blobs } = await store.list({ prefix });
  const out = {};
  for (const b of blobs) { const [, k, v] = b.key.split("/"); const n = Number(v); if (k && n > (out[k] || 0)) { out[k] = n; if (etags) etags[k] = b.etag; } }
  return out;
}
async function readKey(store, key, v) {
  if (v == null) v = (await versions(store, `d/${key}/`))[key] || 0;
  if (!v) return { v: 0, data: null };
  const r = await store.getWithMetadata(`d/${key}/${pad(v)}`);
  if (!r) return { v: 0, data: null };
  const raw = typeof r.data === "string" ? r.data : "";
  return { v, e: r.etag, data: raw.startsWith("S") ? raw.slice(1) : null, at: r.metadata && r.metadata.at, by: r.metadata && r.metadata.by };
}
async function writeKey(store, key, v, data, by) {
  const n = randomBytes(8).toString("hex");
  const bk = `d/${key}/${pad(v)}`;
  const { modified, etag } = await store.set(bk, data == null ? "N" : "S" + data, { onlyIfNew: true, metadata: { at: new Date().toISOString(), by, n } });
  if (!modified) return false;
  // verifikasi: pastikan versi ini memang tulisan kita (bukan tulisan perangkat lain di saat yang sama)
  const chk = await store.getMetadata(bk);
  if (!chk || !chk.metadata || chk.metadata.n !== n) return false;
  if (modified) { // simpan 1 versi sebelumnya sebagai cadangan, hapus yang lebih lama
    const { blobs } = await store.list({ prefix: `d/${key}/` });
    await Promise.all(blobs.filter((b) => Number(b.key.split("/")[2]) < v - 1).map((b) => store.delete(b.key)));
  }
  return chk.etag || etag || true;
}
async function users(store) {
  const r = await readKey(store, "tapelogUsers");
  try { const a = JSON.parse(r.data || "null"); return Array.isArray(a) ? a : null; } catch { return null; }
}
const findUser = (list, username, pin) => (list || []).find((u) => u && String(u.username ?? "").toLowerCase() === String(username || "").trim().toLowerCase() && u.pin != null && String(u.pin).toLowerCase() === String(pin || "").trim().toLowerCase());
const pub = (u) => ({ id: u.id, username: u.username, fullname: u.fullname, role: u.role, division: u.division });

export default async (req, context) => {
  const store = storeFor(context);
  const url = new URL(req.url);
  const op = url.searchParams.get("op") || "ping";
  try {
    if (op === "ping") {
      const { blobs } = await store.list({ prefix: "d/tapelogUsers/" });
      return json({ ok: true, initialized: blobs.length > 0 });
    }
    if (op === "login" && req.method === "POST") {
      const { username, pin } = await req.json();
      const list = await users(store);
      if (!list) return json({ error: "uninitialized" }, 409);
      const u = findUser(list, username, pin);
      if (!u) return json({ error: "invalid" }, 401);
      return json({ token: await makeToken(store, u), user: pub(u) });
    }
    if (op === "bootstrap" && req.method === "POST") {
      // hanya bisa sekali: saat server belum punya data user sama sekali
      const { username, pin, users: raw } = await req.json();
      if (await users(store)) return json({ error: "already_initialized" }, 409);
      let list; try { list = JSON.parse(raw); } catch { return json({ error: "bad_users" }, 400); }
      const u = findUser(list, username, pin);
      if (!u || String(u.role).toUpperCase() !== "SUPER_ADMIN") return json({ error: "need_super_admin" }, 403);
      if (!(await writeKey(store, "tapelogUsers", 1, raw, u.username))) return json({ error: "already_initialized" }, 409);
      return json({ token: await makeToken(store, u), user: pub(u), v: 1 });
    }

    const tok = await readToken(store, req);
    if (!tok) return json({ error: "unauthorized" }, 401);

    if (op === "meta") { const etags = {}; const v = await versions(store, "d/", etags); return json({ versions: v, etags, now: new Date().toISOString() }); }

    const key = url.searchParams.get("key") || "";
    if (!KEY_RE.test(key)) return json({ error: "bad_key" }, 400);
    // user yang sudah dihapus tidak boleh membaca/menulis lagi
    const list = await users(store);
    if (list && !list.some((u) => u && String(u.username).toLowerCase() === String(tok.u).toLowerCase())) return json({ error: "unauthorized" }, 401);

    if (op === "get") return json(await readKey(store, key));
    if (op === "put" && req.method === "POST") {
      const { base, data } = await req.json();
      if (data != null && typeof data !== "string") return json({ error: "bad_data" }, 400);
      const cur = (await versions(store, `d/${key}/`))[key] || 0;
      if (Number(base || 0) !== cur) return json({ conflict: true, ...(await readKey(store, key, cur)) }, 409);
      const e = await writeKey(store, key, cur + 1, data, tok.u);
      if (!e) return json({ conflict: true, ...(await readKey(store, key)) }, 409);
      return json({ v: cur + 1, e: typeof e === "string" ? e : undefined });
    }
    return json({ error: "unknown_op" }, 400);
  } catch (e) {
    console.error("[api]", op, e);
    return json({ error: "server_error", message: String(e && e.message || e) }, 500);
  }
};
