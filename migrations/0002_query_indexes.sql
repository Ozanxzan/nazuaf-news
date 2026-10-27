-- Safe to run in the existing Nazuaf News D1 database.
CREATE INDEX IF NOT EXISTS idx_articles_title_source ON articles(title, source);
CREATE INDEX IF NOT EXISTS idx_articles_published_id ON articles(published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_articles_category_published_id ON articles(category, published_at DESC, id DESC);
