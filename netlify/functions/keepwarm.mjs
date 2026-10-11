// Menjaga server (Netlify Function + Google Apps Script) tetap "bangun" di jam kerja,
// supaya login & simpan pertama tidak menunggu server menyala (bisa 5–7 detik).
export default async () => {
  const base = Netlify.env.get("URL") || "https://fulfillment-danindo-ambona.netlify.app";
  try { await fetch(base + "/.netlify/functions/api?op=ping&warm=1", { headers: { "cache-control": "no-cache" } }); } catch (e) {}
  return new Response("ok");
};
// setiap 5 menit, 06.00–22.59 WIB (= 23.00–15.59 UTC)
export const config = { schedule: "*/5 23,0-15 * * *" };
