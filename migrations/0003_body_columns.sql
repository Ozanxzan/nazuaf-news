-- Scraper isi penuh (25 Nov 2026): status pengambilan isi artikel per baris.
-- Diterapkan langsung ke D1 produksi via API; file ini arsip migrasinya.
ALTER TABLE articles ADD COLUMN body_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE articles ADD COLUMN body_scraped_at TEXT;
ALTER TABLE articles ADD COLUMN body_error TEXT;
CREATE INDEX IF NOT EXISTS idx_articles_body_pending ON articles(body_status, published_at DESC, id DESC);
