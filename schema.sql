CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Query-performance indexes. The Worker also creates these idempotently on ingest
-- so they are added to an already-existing D1 database after the next workflow run.
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category);
CREATE INDEX IF NOT EXISTS idx_articles_title_source ON articles(title, source);
CREATE INDEX IF NOT EXISTS idx_articles_published_id ON articles(published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_articles_category_published_id ON articles(category, published_at DESC, id DESC);
