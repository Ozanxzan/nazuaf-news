NAZUAF NEWS — GEMINI IMAGE FIX + GNEWS INDONESIA

Isi ZIP:
- src/index.js: Worker lengkap, dengan meta referrer no-referrer, referrerpolicy pada gambar, normalisasi URL gambar HTTP ke HTTPS, dan perbaikan Worker yang sudah ada di paket image-repair-v8.
- scripts/fetch_news.py: pengumpul berita bergaya GNews untuk bahasa Indonesia / negara Indonesia, dengan 43 feed dan ekstraksi metadata gambar publisher.

CARA PASANG DARI HP
1. Ekstrak ZIP.
2. Di repo Ozanxzan/nazuaf-news branch main, ganti src/index.js dengan file dari ZIP.
3. Ganti scripts/fetch_news.py dengan file dari ZIP.
4. Commit perubahan.
5. Tunggu deployment Cloudflare Worker berstatus Ready.
6. GitHub → Actions → Update Nazuaf News → Run workflow.
7. Periksa https://nazuaf-news.id-faauzan.workers.dev/api/articles?limit=10

JANGAN upload file .pyc. Tidak perlu mengubah wrangler.toml, database D1, atau secrets.

CATATAN
- no-referrer dapat membantu situs yang memblokir hotlink berdasarkan Referer, tetapi tidak menjamin semua publisher mengizinkan gambar.
- Mengubah HTTP menjadi HTTPS hanya membantu bila host gambar mendukung HTTPS.
- Log "with_images" menghitung URL gambar yang dikirim, bukan memastikan gambar berhasil dimuat browser.
- Paket ini belum dipasang otomatis di repo; upload file ke GitHub dan deploy seperti langkah di atas.
