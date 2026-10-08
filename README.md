# Nazuaf News — Indonesia

Versi ini khusus berita berbahasa Indonesia dan memakai RSS dari sejumlah portal Indonesia.

## Sumber awal
- ANTARA: terkini, tekno, ekonomi, dunia, olahraga
- CNN Indonesia: nasional, ekonomi
- CNBC Indonesia: news, market
- Liputan6: news
- Suara.com: news, bisnis
- Republika: nasional, ekonomi
- Media Indonesia
- JawaPos: nasional, ekonomi

## Setup

```bash
npx wrangler d1 create nazuaf-news
```

Masukkan `database_id` ke `wrangler.toml`, lalu:

```bash
npx wrangler d1 execute nazuaf-news --remote --file=./schema.sql
npx wrangler deploy
```

Update pertama:

```bash
curl -X POST https://ALAMAT-WORKER/api/refresh
```

Cron berjalan otomatis setiap 3 jam.

Custom domain:
`news.nazuaf.com`

Catatan: aggregator menyimpan metadata/ringkasan pendek dan tautan ke artikel asli; tidak menyalin artikel penuh.
