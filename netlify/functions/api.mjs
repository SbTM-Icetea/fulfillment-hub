// FULFILLMENT HUB — database bersama (Netlify Functions → Google Sheets / Netlify Blobs)
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

let SECRET = null; // disimpan di memori selama function masih "hangat" → login & sinkron lebih cepat
async function secret(store) {
  if (SECRET) return SECRET;
  const env = Netlify.env.get("HUB_SECRET");
  if (env) return (SECRET = env);
  let s = await store.get("sys/secret");
  if (!s) { await store.set("sys/secret", randomBytes(32).toString("hex"), { onlyIfNew: true }); s = await store.get("sys/secret"); }
  return (SECRET = s);
}
async function makeToken(store, user) {
  const body = b64u(JSON.stringify({ u: user.username, r: user.role, exp: Date.now() + TOKEN_DAYS * 864e5 }));
  const sig = createHmac("sha256", await secret(store)).update(body).digest("base64url");
  return body + "." + sig;
}
async function readToken(store, req) {
  const h = req.headers.get("authorization") || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : (new URL(req.url).searchParams.get("t") || "");
  const [body, sig] = t.split(".");
  if (!body || !sig) return null;
  const want = createHmac("sha256", await secret(store)).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(body, "base64url").toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}

// versi terbaru per key: { key: v } (+ etag per key di `etags`)
async function bVersions(store, prefix = "d/", etags) {
  const { blobs } = await store.list({ prefix });
  const out = {};
  for (const b of blobs) { const [, k, v] = b.key.split("/"); const n = Number(v); if (k && n > (out[k] || 0)) { out[k] = n; if (etags) etags[k] = b.etag; } }
  return out;
}
async function bReadKey(store, key, v) {
  if (v == null) v = (await bVersions(store, `d/${key}/`))[key] || 0;
  if (!v) return { v: 0, data: null };
  const r = await store.getWithMetadata(`d/${key}/${pad(v)}`);
  if (!r) return { v: 0, data: null };
  const raw = typeof r.data === "string" ? r.data : "";
  return { v, e: r.etag, data: raw.startsWith("S") ? raw.slice(1) : null, at: r.metadata && r.metadata.at, by: r.metadata && r.metadata.by };
}
async function bWriteKey(store, key, v, data, by) {
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

// ================= Penyimpanan =================
// Bila GAS_URL & GAS_KEY diisi (environment variable Netlify) → data disimpan di Google Sheets, lampiran di Google Drive
// (lewat Apps Script). Data lama di Netlify Blobs otomatis dipindahkan ke Google Sheets saat pertama kali dibaca.
const gasOn = () => !!(Netlify.env.get("GAS_URL") && Netlify.env.get("GAS_KEY"));
async function gas(op, p = {}) {
  const r = await fetch(Netlify.env.get("GAS_URL"), { method: "POST", headers: { "content-type": "text/plain;charset=utf-8" }, body: JSON.stringify({ key: Netlify.env.get("GAS_KEY"), op, ...p }), redirect: "follow" });
  const t = await r.text(); let j;
  try { j = JSON.parse(t); } catch { throw new Error("Apps Script tidak merespons JSON (" + r.status + "): " + t.slice(0, 160)); }
  if (j && (j.error === "forbidden" || j.error === "server_error")) throw new Error("Apps Script " + j.error + (j.message ? ": " + j.message : ""));
  return j;
}
async function blobHas(store, key) { return ((await bVersions(store, `d/${key}/`))[key] || 0) > 0; }
async function migrateKey(store, key) { // salin 1 key dari Netlify Blobs → Google Sheets (versi dipertahankan)
  const b = await bReadKey(store, key); if (!b.v) return null;
  return gas("import", { k: key, v: b.v, data: b.data, by: b.by || "migrasi" });
}
async function versions(store, etags) {
  if (!gasOn()) return bVersions(store, "d/", etags);
  const g = await gas("meta"); const out = { ...(g.versions || {}) }; Object.assign(etags, g.etags || {});
  const be = {}; const bv = await bVersions(store, "d/", be);
  let n = 0;
  for (const k of Object.keys(bv)) {
    if (out[k]) continue;
    if (n < 4) { const m = await migrateKey(store, k); n++; if (m && m.v) { out[k] = m.v; etags[k] = m.e; continue; } }
    out[k] = bv[k]; etags[k] = "b" + be[k]; // belum dipindah: tetap terbaca, akan dipindah saat diambil
  }
  return out;
}
async function readKey(store, key) {
  if (!gasOn()) return bReadKey(store, key);
  let g = await gas("get", { k: key });
  if (!g.v && await blobHas(store, key)) { await migrateKey(store, key); g = await gas("get", { k: key }); }
  return g;
}
async function writeKey(store, key, base, data, by) { // → { v, e } | { conflict, v, data }
  if (!gasOn()) {
    const cur = (await bVersions(store, `d/${key}/`))[key] || 0;
    if (Number(base || 0) !== cur) return { conflict: true, ...(await bReadKey(store, key, cur)) };
    const e = await bWriteKey(store, key, cur + 1, data, by);
    if (!e) return { conflict: true, ...(await bReadKey(store, key)) };
    return { v: cur + 1, e: typeof e === "string" ? e : undefined };
  }
  const g0 = await gas("get", { k: key }); // pastikan data lama sudah dipindah sebelum ditulis
  if (!g0.v && await blobHas(store, key)) await migrateKey(store, key);
  return gas("put", { k: key, base: Number(base || 0), data, by });
}
async function filePut(store, id, du) {
  if (!gasOn()) { await store.set(`f/${id}`, du, { onlyIfNew: true }); return; }
  const r = await gas("fput", { id, dataUrl: du }); if (r.error) throw new Error(r.error);
}
async function fileGet(store, id) {
  if (!gasOn()) return store.get(`f/${id}`);
  const r = await gas("fget", { id });
  if (r.dataUrl) return r.dataUrl;
  const old = await store.get(`f/${id}`); // lampiran lama di Netlify Blobs → pindahkan ke Google Drive
  if (old) { try { await gas("fput", { id, dataUrl: old }); } catch (e) {} return old; }
  return null;
}
let USERS = null; // cache singkat daftar user (hemat panggilan ke Google Sheets)
async function users(store, fresh) {
  if (!fresh && USERS && Date.now() - USERS.t < 30000) return USERS.list;
  const r = await readKey(store, "tapelogUsers");
  let list = null; try { const a = JSON.parse(r.data || "null"); list = Array.isArray(a) ? a : null; } catch { list = null; }
  USERS = { t: Date.now(), list }; return list;
}
const findUser = (list, username, pin) => (list || []).find((u) => u && String(u.username ?? "").toLowerCase() === String(username || "").trim().toLowerCase() && u.pin != null && String(u.pin).toLowerCase() === String(pin || "").trim().toLowerCase());
const pub = (u) => ({ id: u.id, username: u.username, fullname: u.fullname, role: u.role, division: u.division });

export default async (req, context) => {
  const store = storeFor(context);
  const url = new URL(req.url);
  const op = url.searchParams.get("op") || "ping";
  try {
    if (op === "ping") {
      const list = await users(store, true);
      return json({ ok: true, initialized: !!list, backend: gasOn() ? "google-sheets" : "netlify-blobs" });
    }
    if (op === "login" && req.method === "POST") {
      const { username, pin } = await req.json();
      const list = await users(store, true);
      if (!list) return json({ error: "uninitialized" }, 409);
      const u = findUser(list, username, pin);
      if (!u) return json({ error: "invalid" }, 401);
      return json({ token: await makeToken(store, u), user: pub(u) });
    }
    if (op === "bootstrap" && req.method === "POST") {
      // hanya bisa sekali: saat server belum punya data user sama sekali
      const { username, pin, users: raw } = await req.json();
      if (await users(store, true)) return json({ error: "already_initialized" }, 409);
      let list; try { list = JSON.parse(raw); } catch { return json({ error: "bad_users" }, 400); }
      const u = findUser(list, username, pin);
      if (!u || String(u.role).toUpperCase() !== "SUPER_ADMIN") return json({ error: "need_super_admin" }, 403);
      const w = await writeKey(store, "tapelogUsers", 0, raw, u.username);
      if (!w || w.conflict) return json({ error: "already_initialized" }, 409);
      USERS = null;
      return json({ token: await makeToken(store, u), user: pub(u), v: w.v });
    }

    const tok = await readToken(store, req);
    if (!tok) return json({ error: "unauthorized" }, 401);

    // ---- lampiran (foto/PDF) disimpan terpisah: f/<id>, isi berupa data URL ----
    if (op === "fput" || op === "fget") {
      const id = url.searchParams.get("id") || "";
      if (!/^f[a-z0-9]{6,40}$/.test(id)) return json({ error: "bad_id" }, 400);
      if (op === "fput" && req.method === "POST") {
        const body = await req.text();
        if (!/^data:[a-z0-9.+\/-]+;base64,/i.test(body)) return json({ error: "bad_file" }, 400);
        await filePut(store, id, body);
        return json({ ok: true });
      }
      const du = await fileGet(store, id);
      if (!du) return json({ error: "not_found" }, 404);
      if (url.searchParams.get("raw")) return new Response(du, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, max-age=31536000, immutable" } });
      const comma = du.indexOf(",");
      const type = (du.slice(5, comma).split(";")[0]) || "application/octet-stream";
      return new Response(Buffer.from(du.slice(comma + 1), "base64"), { headers: { "content-type": type, "cache-control": "private, max-age=31536000, immutable" } });
    }

    if (op === "meta") { const etags = {}; const v = await versions(store, etags); return json({ versions: v, etags, now: new Date().toISOString(), backend: gasOn() ? "google-sheets" : "netlify-blobs" }); }

    const key = url.searchParams.get("key") || "";
    if (!KEY_RE.test(key)) return json({ error: "bad_key" }, 400);
    // user yang sudah dihapus tidak boleh membaca/menulis lagi
    const list = await users(store);
    if (list && !list.some((u) => u && String(u.username).toLowerCase() === String(tok.u).toLowerCase())) return json({ error: "unauthorized" }, 401);

    if (op === "get") return json(await readKey(store, key));
    if (op === "put" && req.method === "POST") {
      const { base, data } = await req.json();
      if (data != null && typeof data !== "string") return json({ error: "bad_data" }, 400);
      const w = await writeKey(store, key, base, data, tok.u);
      if (w.conflict) return json(w, 409);
      if (w.error) return json(w, 400);
      if (key === "tapelogUsers") USERS = null;
      return json({ v: w.v, e: w.e });
    }
    return json({ error: "unknown_op" }, 400);
  } catch (e) {
    console.error("[api]", op, e);
    return json({ error: "server_error", message: String(e && e.message || e) }, 500);
  }
};
