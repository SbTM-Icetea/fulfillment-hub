# Database Google Sheets (Apps Script)

1. Buat project Apps Script, tempel isi `Code.gs`, ganti `HUB_KEY` dengan nilai yang sama dengan env `GAS_KEY` di Netlify, dan `SHEET_ID` dengan id Google Sheet database.
2. Jalankan fungsi `setup` sekali (beri izin Sheets & Drive).
3. Deploy → New deployment → Web app — Execute as: **Me**, Who has access: **Anyone**.
4. Buka URL `/exec` di browser: harus tampil `"ok":true,"version":2`.
5. Isi env Netlify `GAS_URL` = URL `/exec`, lalu deploy ulang. Cek `/.netlify/functions/api?op=ping` → `"backend":"google-sheets"`.

Saat berganti versi kode: Deploy → Manage deployments → Edit → **New version** (URL tetap sama).

Catatan: Code.gs versi 4 (cek `/exec` → `"version":4`). Bila memakai "New deployment" (URL baru), perbarui env `GAS_URL` di Netlify lalu deploy ulang.

Sejak build 109: data utama disimpan di Netlify Blobs (cepat); Apps Script menerima SALINAN setiap perubahan (Sheet `_db` + tab laporan) dan lampiran (folder Drive). Salinan yang gagal dikirim ulang otomatis tiap 5 menit.
