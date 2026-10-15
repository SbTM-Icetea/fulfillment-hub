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
// Data utama di Netlify Blobs (cepat, ±0,1 detik). Bila GAS_URL & GAS_KEY diisi, setiap perubahan otomatis
// DISALIN ke Google Sheets (data) dan Google Drive (lampiran) lewat Apps Script — di belakang layar, setelah jawaban
// dikirim ke aplikasi. Saat pertama kali aktif, data terbaru dari Google Sheets dipindahkan dulu ke Netlify Blobs.
const gasOn = () => !!(Netlify.env.get("GAS_URL") && Netlify.env.get("GAS_KEY"));
async function gas(op, p = {}) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 28000);
  try {
    const r = await fetch(Netlify.env.get("GAS_URL"), { method: "POST", headers: { "content-type": "text/plain;charset=utf-8" }, body: JSON.stringify({ key: Netlify.env.get("GAS_KEY"), op, ...p }), redirect: "follow", signal: ctl.signal });
    const t = await r.text(); let j;
    try { j = JSON.parse(t); } catch { throw new Error("Apps Script tidak merespons JSON (" + r.status + "): " + t.slice(0, 160)); }
    if (j && (j.error === "forbidden" || j.error === "server_error")) throw new Error("Apps Script " + j.error + (j.message ? ": " + j.message : ""));
    return j;
  } finally { clearTimeout(tm); }
}
let WAIT = null; // context.waitUntil (Netlify): pekerjaan lanjutan setelah respons
const later = (p) => { const q = Promise.resolve(p).catch((e) => console.warn("[mirror]", e && e.message || e)); if (WAIT) WAIT(q); return q; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- satu kali: data terbaru di Google Sheets → Netlify Blobs ----
let PRIMARY = null;
async function ensurePrimary(store) {
  if (PRIMARY || !gasOn()) return;
  if ((await store.get("sys/primary")) === "blobs") { PRIMARY = "blobs"; return; }
  const claim = await store.set("sys/primary-lock", String(Date.now()), { onlyIfNew: true });
  if (!claim || !claim.modified) { // perangkat lain sedang memindahkan → tunggu
    for (let i = 0; i < 50; i++) { await sleep(500); if ((await store.get("sys/primary")) === "blobs") { PRIMARY = "blobs"; return; } }
    const t = Number(await store.get("sys/primary-lock")) || 0;
    if (Date.now() - t < 90000) throw new Error("Pemindahan data sedang berjalan, coba lagi sebentar.");
    await store.set("sys/primary-lock", String(Date.now()));
  }
  const a = await gas("all");
  if (!a || !a.versions || !a.data) throw new Error("Data Google Sheets tidak bisa dibaca untuk dipindahkan");
  const mm = {};
  for (const k of Object.keys(a.data)) {
    if (!KEY_RE.test(k)) continue;
    const d = a.data[k] || {}; const v = Number(d.v || a.versions[k] || 0); if (!v) continue;
    const { blobs } = await store.list({ prefix: `d/${k}/` });
    await Promise.all(blobs.map((b) => store.delete(b.key)));
    await store.set(`d/${k}/${pad(v)}`, d.data == null ? "N" : "S" + d.data, { metadata: { at: d.at || new Date().toISOString(), by: d.by || "migrasi", n: "mig" } });
    mm[k] = v;
  }
  await store.setJSON("sys/mirror", mm);
  await store.set("sys/primary", "blobs"); PRIMARY = "blobs"; USERS = null;
  console.log("[primary] data dipindah dari Google Sheets:", Object.keys(mm).length, "kelompok");
}

// ---- salin ke Google Sheets (di belakang layar) ----
const MQ = {}, GV = {}; // antrean per key, versi terakhir di Sheets
async function mirrorMap(store) { try { return (await store.get("sys/mirror", { type: "json" })) || {}; } catch { return {}; } }
async function markMirrored(store, key, v) { for (let i = 0; i < 3; i++) { const m = await mirrorMap(store); if ((m[key] || 0) >= v) return; m[key] = v; try { await store.setJSON("sys/mirror", m); return; } catch { await sleep(200); } } }
async function mirrorKey(store, key) {
  const b = await bReadKey(store, key); if (!b.v) return;
  if (((await mirrorMap(store))[key] || 0) >= b.v) return;
  let base = GV[key]; if (base == null) { const g = await gas("get", { k: key }); base = Number(g.v || 0); }
  for (let i = 0; i < 4; i++) {
    const r = await gas("put", { k: key, base, data: b.data, by: b.by || "" });
    if (r && r.v && !r.conflict) { GV[key] = r.v; await markMirrored(store, key, b.v); return; }
    if (r && r.conflict) { base = Number(r.v || 0); continue; }
    throw new Error("salin " + key + ": " + JSON.stringify(r).slice(0, 120));
  }
}
function queueMirror(store, key) {
  if (!gasOn()) return;
  const p = (MQ[key] || Promise.resolve()).then(() => mirrorKey(store, key)).catch((e) => console.warn("[mirror]", key, e && e.message || e));
  MQ[key] = p; later(p);
}
let lastResync = 0;
function resync(store) { // salinan yang tertinggal (mis. Apps Script sempat gagal) dikirim ulang
  if (!gasOn() || Date.now() - lastResync < 60000) return; lastResync = Date.now();
  later((async () => {
    const [bv, mm] = await Promise.all([bVersions(store, "d/"), mirrorMap(store)]);
    Object.keys(bv).filter((k) => bv[k] > (mm[k] || 0)).slice(0, 6).forEach((k) => queueMirror(store, k));
    const { blobs } = await store.list({ prefix: "fq/" });
    for (const b of blobs.slice(0, 5)) { const id = b.key.slice(3); const du = await store.get(`f/${id}`); if (du) { const r = await gas("fput", { id, dataUrl: du }).catch(() => null); if (r && r.ok) await store.delete(b.key); } else await store.delete(b.key); }
  })());
}

async function versions(store, etags) { return bVersions(store, "d/", etags); }
async function readAll(store) {
  const etags = {}; const versionsMap = await versions(store, etags); const data = {};
  await Promise.all(Object.keys(versionsMap).map(async (k) => { const r = await bReadKey(store, k, versionsMap[k]); data[k] = r; if (r && r.v && r.v !== versionsMap[k]) versionsMap[k] = r.v; }));
  return { versions: versionsMap, etags, data };
}
async function readKey(store, key) { return bReadKey(store, key); }
async function writeKey(store, key, base, data, by) { // → { v, e } | { conflict, v, data }
  const cur = (await bVersions(store, `d/${key}/`))[key] || 0;
  if (Number(base || 0) !== cur) return { conflict: true, ...(await bReadKey(store, key, cur)) };
  const e = await bWriteKey(store, key, cur + 1, data, by);
  if (!e) return { conflict: true, ...(await bReadKey(store, key)) };
  queueMirror(store, key);
  return { v: cur + 1, e: typeof e === "string" ? e : undefined };
}
async function filePut(store, id, du) {
  await store.set(`f/${id}`, du);
  if (gasOn()) later((async () => { const r = await gas("fput", { id, dataUrl: du }).catch(() => null); if (!r || !r.ok) await store.set(`fq/${id}`, "1"); })());
}
async function fileGet(store, id) {
  const du = await store.get(`f/${id}`); if (du) return du;
  if (!gasOn()) return null;
  const r = await gas("fget", { id }).catch(() => null); // lampiran yang dulu hanya disimpan di Google Drive
  if (r && r.dataUrl) { later(store.set(`f/${id}`, r.dataUrl)); return r.dataUrl; }
  return null;
}
let USERS = null; // cache singkat daftar user
async function users(store, fresh) {
  if (!fresh && USERS && Date.now() - USERS.t < 60000) return USERS.list;
  const r = await readKey(store, "tapelogUsers");
  let list = null; try { const a = JSON.parse(r.data || "null"); list = Array.isArray(a) ? a : null; } catch { list = null; }
  USERS = { t: Date.now(), list }; return list;
}
const findUser = (list, username, pin) => (list || []).find((u) => u && String(u.username ?? "").toLowerCase() === String(username || "").trim().toLowerCase() && u.pin != null && String(u.pin).toLowerCase() === String(pin || "").trim().toLowerCase());
const pub = (u) => ({ id: u.id, username: u.username, fullname: u.fullname, role: u.role, division: u.division });

export default async (req, context) => {
  WAIT = context && typeof context.waitUntil === "function" ? (p) => context.waitUntil(p) : null;
  const store = storeFor(context);
  const url = new URL(req.url);
  const op = url.searchParams.get("op") || "ping";
  try {
    await ensurePrimary(store);
    if (op === "ping") {
      const list = await users(store, url.searchParams.has("warm"));
      if (url.searchParams.has("warm")) resync(store); // jadwal tiap 5 menit: kirim ulang salinan yang tertinggal
      return json({ ok: true, initialized: !!list, backend: gasOn() ? "netlify-blobs+google-sheets" : "netlify-blobs" });
    }
    if (op === "login" && req.method === "POST") {
      const { username, pin, all } = await req.json();
      // data diambil bersamaan dengan pengecekan user → login cukup 1x tunggu (hanya dikirim bila PIN benar)
      const allP = all ? readAll(store).catch(() => null) : null;
      let list = await users(store);
      let u = findUser(list, username, pin);
      if (!u) { list = await users(store, true); u = findUser(list, username, pin); } // daftar user di cache mungkin belum terbaru
      if (!list) return json({ error: "uninitialized" }, 409);
      if (!u) return json({ error: "invalid" }, 401);
      const out = { token: await makeToken(store, u), user: pub(u) };
      if (allP) { const a = await allP; if (a && JSON.stringify(a).length < 5000000) out.all = a; } // batas ukuran respons Netlify ±6 MB
      return json(out);
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

    if (op === "all") { const a = await readAll(store); return json({ ...a, now: new Date().toISOString() }); }
    if (op === "meta") { const etags = {}; const v = await versions(store, etags); resync(store); return json({ versions: v, etags, now: new Date().toISOString() }); }

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
