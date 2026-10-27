# Nazuaf News — D1 Rows Read Optimization

This build reduces repeat D1 reads by caching public API responses at Cloudflare's edge and serving prebuilt news snapshots from R2. D1 remains the source of truth; ingest still writes articles to D1 and refreshes the R2 snapshot.

## What changed

- `/api/articles` reads from a single R2 snapshot when available, then slices the requested page/category in the Worker instead of querying D1 for every page view.
- `/api/categories` reads category names/counts from the same snapshot.
- Public API responses use edge cache headers and cache tags. The ingest endpoint purges tagged API responses after a successful snapshot refresh.
- The ingestion endpoint ensures three idempotent indexes exist on the existing D1 database: `(title, source)`, `(published_at, id)`, and `(category, published_at, id)`.
- Listing/retention queries use index-friendly `ORDER BY published_at DESC, id DESC` instead of applying `julianday()` to every row.
- The R2 snapshot stores the latest 2,000 global articles and up to 1,000 articles per category. D1 data is not deleted by this snapshot limit; only the existing retention rule for the exact `Berita` category remains.
- If the R2 snapshot is not available yet, API endpoints fall back to D1 with cache headers, so the site can still serve data during initial setup.

## Required setup before deployment

1. In the same Cloudflare account as the `nazuaf-news` Worker, open **R2 Object Storage** and create a bucket named exactly `nazuaf-news-cache`.
2. Deploy this repository. `wrangler.toml` binds that bucket to `NEWS_CACHE` and enables Workers Cache for cacheable HTTP responses.
3. Keep the existing D1 binding and GitHub secrets unchanged (`NEWS_INGEST_URL` and `NEWS_INGEST_TOKEN`). The Worker creates the required indexes automatically on the next authenticated ingest run.
4. After deployment, open **GitHub → Actions → Update Nazuaf News → Run workflow** once. This populates/refreshes the R2 snapshot from D1. Future scheduled imports refresh it automatically.
5. Check `https://nazuaf-news.id-faauzan.workers.dev/api/articles?limit=10`. The response shape stays compatible with the existing frontend.

## Notes

- Snapshot responses intentionally expose only the newest 2,000 global articles and newest 1,000 per category through the public API. The underlying D1 database is retained; the snapshot is a read-optimized view.
- If the ingest response reports `D1 updated but R2 news snapshot refresh failed`, the D1 write has already completed. Check the `NEWS_CACHE` R2 binding/bucket, then rerun the workflow to rebuild the snapshot.
- No secrets or API tokens are included in this ZIP.
