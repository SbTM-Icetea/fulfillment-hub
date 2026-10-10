/**
 * FULFILLMENT HUB — Database Google Sheets + Lampiran Google Drive
 * Dipanggil oleh Netlify Function (netlify/functions/api.mjs). Jangan bagikan HUB_KEY.
 *
 * Penyimpanan:
 *  - Sheet "_db"   : 1 baris per kelompok data (key, versi, etag, waktu, oleh, jumlah potongan, isi JSON dipotong per 45.000 karakter)
 *  - Sheet lain    : tampilan yang mudah dibaca (Surat Jalan, Incoming, Invoice, Customer, Stok, Mutasi Stok, User, Riwayat Aktivitas)
 *                    dibuat ulang otomatis setiap ada perubahan — hanya untuk dibaca / laporan, edit tetap lewat aplikasi.
 *  - Folder Drive "FULFILLMENT HUB - Lampiran": foto / PDF lampiran (nama file = id lampiran)
 */
const HUB_KEY = 'ISI_DENGAN_GAS_KEY'; // sama dengan environment variable GAS_KEY di Netlify
const SHEET_ID = '1oHsoq3INpoorbzN5I5DYC5svLb0kkqGVykQwmfFJD_I';
const CHUNK = 45000;
const FIXED = 6; // kolom: key, version, etag, updatedAt, by, parts

function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function doGet() { // cek kesehatan: buka URL web app di browser
  const o = { ok: true, app: 'fulfillment-hub', version: 2 };
  try { o.account = Session.getEffectiveUser().getEmail(); } catch (e) {}
  try { const s = ss_(); o.sheet = s.getUrl(); o.tabs = s.getSheets().map(x => x.getName()); o.keys = rows_().length; } catch (e) { o.ok = false; o.error = String(e); }
  try { o.folder = folder_().getUrl(); } catch (e) { o.ok = false; o.folderError = String(e); }
  return out(o);
}
function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (x) { return out({ error: 'bad_json' }); }
  if (!req || req.key !== HUB_KEY) return out({ error: 'forbidden' });
  try { return out(handle(req)); } catch (err) { return out({ error: 'server_error', message: String(err && err.stack || err) }); }
}

function handle(req) {
  switch (req.op) {
    case 'ping': return { ok: true, keys: rows_().length };
    case 'meta': return meta_();
    case 'get': return getKey_(req.k);
    case 'put': return put_(req.k, Number(req.base || 0), req.data, req.by || '', null);
    case 'import': return put_(req.k, null, req.data, req.by || 'migrasi', Number(req.v || 1)); // salin dari database lama, versi dipertahankan
    case 'fput': return fput_(req.id, req.dataUrl);
    case 'fget': return fget_(req.id);
    case 'fhas': return { has: !!findFile_(req.id) };
    default: return { error: 'unknown_op' };
  }
}

// ---------- tabel _db ----------
function ensureSize_(sh, rows, cols) {
  const mr = sh.getMaxRows(), mc = sh.getMaxColumns();
  if (rows > mr) sh.insertRowsAfter(mr, rows - mr);
  if (cols > mc) sh.insertColumnsAfter(mc, cols - mc);
}
// Sheet database: pakai SHEET_ID; bila akun yang menjalankan script tidak punya akses, otomatis dibuat Sheet baru di Drive akun tersebut
let SS_ = null;
function ss_() {
  if (SS_) return SS_;
  const p = PropertiesService.getScriptProperties();
  const saved = p.getProperty('SHEET_ID');
  for (const id of [saved, SHEET_ID]) { if (!id) continue; try { SS_ = SpreadsheetApp.openById(id); if (id !== saved) p.setProperty('SHEET_ID', id); return SS_; } catch (e) {} }
  SS_ = SpreadsheetApp.create('FULFILLMENT HUB - Database'); p.setProperty('SHEET_ID', SS_.getId()); return SS_;
}
function db_() {
  const s = ss_(); let sh = s.getSheetByName('_db');
  if (!sh) { sh = s.insertSheet('_db'); sh.getRange(1, 1, 1, FIXED + 1).setValues([['key', 'version', 'etag', 'updatedAt', 'by', 'parts', 'data →']]); sh.setFrozenRows(1); }
  return sh;
}
function rows_() { const sh = db_(); const n = sh.getLastRow(); return n < 2 ? [] : sh.getRange(2, 1, n - 1, FIXED).getValues(); }
function find_(k) { const r = rows_(); for (let i = 0; i < r.length; i++) if (r[i][0] === k) return { row: i + 2, r: r[i] }; return null; }
function meta_() {
  const c = CacheService.getScriptCache(); const hit = c.get('meta'); if (hit) return JSON.parse(hit);
  const versions = {}, etags = {};
  rows_().forEach(r => { if (r[0]) { versions[r[0]] = Number(r[1]) || 0; etags[r[0]] = String(r[2]); } });
  const m = { versions, etags };
  try { c.put('meta', JSON.stringify(m), 60); } catch (e) {}
  return m;
}
function getKey_(k) {
  const f = find_(k); if (!f) return { v: 0, data: null };
  const parts = Number(f.r[5]);
  let data = null;
  if (parts === 0) data = '';
  else if (parts > 0) data = db_().getRange(f.row, FIXED + 1, 1, parts).getValues()[0].map(x => String(x).slice(1)).join(''); // tiap potongan diawali "~" supaya tidak dibaca sebagai rumus/angka
  return { v: Number(f.r[1]) || 0, e: String(f.r[2]), data, at: f.r[3] ? new Date(f.r[3]).toISOString() : null, by: f.r[4] };
}
function put_(k, base, data, by, importV) {
  if (!/^tapelog[A-Za-z0-9_]{1,80}$/.test(String(k))) return { error: 'bad_key' };
  if (data != null && typeof data !== 'string') return { error: 'bad_data' };
  const lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    const sh = db_(); const f = find_(k); const cur = f ? Number(f.r[1]) || 0 : 0;
    let v;
    if (importV != null) { if (f) return { v: cur, e: String(f.r[2]), skipped: true }; v = importV; }
    else { if (base !== cur) return Object.assign({ conflict: true }, getKey_(k)); v = cur + 1; }
    const chunks = [];
    if (data != null) for (let i = 0; i < data.length; i += CHUNK) chunks.push('~' + data.slice(i, i + CHUNK));
    const parts = data == null ? -1 : chunks.length;
    const etag = Utilities.getUuid();
    const row = f ? f.row : sh.getLastRow() + 1;
    ensureSize_(sh, row, FIXED + Math.max(chunks.length, f ? Number(f.r[5]) || 0 : 0) + 1);
    const oldParts = f ? Math.max(0, Number(f.r[5]) || 0) : 0;
    sh.getRange(row, 1, 1, FIXED).setValues([[k, v, etag, new Date(), by, parts]]);
    if (chunks.length) { const rg = sh.getRange(row, FIXED + 1, 1, chunks.length); rg.setNumberFormat('@'); rg.setValues([chunks]); }
    if (oldParts > chunks.length) sh.getRange(row, FIXED + 1 + chunks.length, 1, oldParts - chunks.length).clearContent();
    SpreadsheetApp.flush();
    CacheService.getScriptCache().remove('meta');
    try { readable_(k, data); } catch (e) { console.warn('readable ' + k + ': ' + e); }
    return { v, e: etag };
  } finally { lock.releaseLock(); }
}

// ---------- lampiran di Google Drive ----------
function folder_() {
  const p = PropertiesService.getScriptProperties(); const id = p.getProperty('FILES_FOLDER');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  let parent; try { parent = DriveApp.getFileById(ss_().getId()).getParents(); } catch (e) { parent = { hasNext: () => false }; }
  const f = (parent.hasNext() ? parent.next() : DriveApp.getRootFolder()).createFolder('FULFILLMENT HUB - Lampiran');
  p.setProperty('FILES_FOLDER', f.getId()); return f;
}
function findFile_(id) { if (!/^f[a-z0-9]{6,40}$/.test(String(id))) return null; const it = folder_().getFilesByName(id); return it.hasNext() ? it.next() : null; }
function fput_(id, dataUrl) {
  if (!/^f[a-z0-9]{6,40}$/.test(String(id))) return { error: 'bad_id' };
  const m = /^data:([^;,]+)?(;[^,]*)?;base64,(.*)$/.exec(String(dataUrl || ''));
  if (!m) return { error: 'bad_file' };
  if (findFile_(id)) return { ok: true, exists: true };
  const blob = Utilities.newBlob(Utilities.base64Decode(m[3]), m[1] || 'application/octet-stream', id);
  folder_().createFile(blob);
  return { ok: true };
}
function fget_(id) {
  const f = findFile_(id); if (!f) return { error: 'not_found' };
  const b = f.getBlob();
  return { dataUrl: 'data:' + (b.getContentType() || 'application/octet-stream') + ';base64,' + Utilities.base64Encode(b.getBytes()) };
}

// ---------- tab yang mudah dibaca ----------
const VIEWS = {
  tapelogShippingDocs: { name: 'Surat Jalan', cols: [['No. SJ', 'sjNumber'], ['Tanggal', 'sjDate'], ['Customer', 'customerName'], ['Tujuan', 'destination'], ['Status', 'status'], ['No. PO', 'poNumber'], ['No. SO', 'soNumber'], ['Item', r => (r.items || []).map(i => (i.itemCode || '') + ' ' + (i.qtyRoll || 0) + ' roll').join(', ')], ['Total Roll', r => (r.items || []).reduce((a, i) => a + (Number(i.qtyRoll) || 0), 0)], ['Biaya Kirim', 'shippingCost'], ['Ket. Biaya', 'costNote'], ['Tgl Kirim', r => r.proof && r.proof.sentDate], ['Penerima', r => r.proof && r.proof.receiverName], ['Dicetak', 'printedAt'], ['Delivered', 'deliveredAt']] },
  tapelogIncoming: { name: 'Incoming', cols: [['No. SJ', 'sj'], ['Tgl Kirim', 'date'], ['Customer', 'customer'], ['Status', 'status'], ['Item', r => (r.items || []).map(i => (i.sku || '') + ' ' + (i.qtyRoll || 0) + ' roll').join(', ')], ['Total Roll', r => (r.items || []).reduce((a, i) => a + (Number(i.qtyRoll) || 0), 0)], ['Tgl Terima', 'receiveDate'], ['Diterima Roll', r => r.receipt && r.receipt.totalReceived], ['Kondisi', r => r.receipt && r.receipt.condition], ['Catatan', r => r.receipt && r.receipt.notes]] },
  tapelogMasterCustomers: { name: 'Customer' },
  tapelogFinInvoices: { name: 'Invoice' },
  tapelogStockMoves: { name: 'Mutasi Stok', cols: [['Tanggal', 'date'], ['Kode SKU', 'sku'], ['Jenis', 'type'], ['Qty', 'qty'], ['Sebelum', 'before'], ['Sesudah', 'after'], ['Referensi', 'ref'], ['Keterangan', 'desc'], ['Dicatat', 'at']] },
  tapelogAuditTrail: { name: 'Riwayat Aktivitas', cols: [['Waktu', 'timestamp'], ['User', 'user'], ['Nama', 'userName'], ['Aksi', 'action'], ['Referensi', 'reference'], ['Detail', 'details']] },
  tapelogUsers: { name: 'User', cols: [['Username', 'username'], ['Nama', 'fullname'], ['Role', 'role'], ['Divisi', 'division']] }, // PIN tidak ditampilkan
  tapelogOpname: { name: 'Stock Opname' },
  tapelogProductEdits: { name: 'Stok', map: true, cols: [['Kode SKU', '_key'], ['Stok (roll)', 'stock'], ['Jenis', 'jenis'], ['Nama Barang', 'nama'], ['Ukuran', 'spek'], ['Ratio', 'ratio']] }
};
function cell_(v) {
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return '(' + v.length + ' item)';
  if (typeof v === 'object') return '';
  const s = String(v);
  if (/^(data:|hubfile:)/.test(s)) return '(lampiran)';
  return /^[=+\-@]/.test(s) ? "'" + s : s.slice(0, 5000);
}
function readable_(k, data) {
  const def = VIEWS[k]; if (!def) return;
  let val; try { val = JSON.parse(data || 'null'); } catch (e) { return; }
  let list = [];
  if (def.map && val && typeof val === 'object') list = Object.keys(val).map(key => Object.assign({ _key: key }, val[key]));
  else if (Array.isArray(val)) list = val.filter(x => x && typeof x === 'object');
  let cols = def.cols;
  if (!cols) { // otomatis: semua kolom teks/angka
    const seen = {}; list.forEach(o => Object.keys(o).forEach(c => { if (o[c] == null || typeof o[c] !== 'object' || Array.isArray(o[c])) seen[c] = 1; }));
    cols = Object.keys(seen).filter(c => !/pin|dataUrl/i.test(c)).map(c => [c, c]);
  }
  if (k === 'tapelogAuditTrail' || k === 'tapelogStockMoves') list = list.slice().reverse(); // terbaru di atas
  const values = [cols.map(c => c[0])].concat(list.map(o => cols.map(c => cell_(typeof c[1] === 'function' ? c[1](o) : o[c[1]]))));
  const s = ss_(); let sh = s.getSheetByName(def.name); if (!sh) sh = s.insertSheet(def.name);
  sh.clearContents();
  if (values[0].length) {
    ensureSize_(sh, values.length, values[0].length);
    sh.getRange(1, 1, values.length, values[0].length).setValues(values);
    sh.getRange(1, 1, 1, values[0].length).setFontWeight('bold').setBackground('#e2e8f0');
    sh.setFrozenRows(1);
  }
}

/** Jalankan sekali dari editor Apps Script (Run → setup) untuk memberi izin Sheets & Drive. */
function setup() { db_(); folder_(); Logger.log('OK — Sheet: ' + ss_().getUrl() + ' · Folder lampiran: ' + folder_().getUrl()); }
