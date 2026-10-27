NAZUAF NEWS — D1 ROWS READ OPTIMIZATION

This build introduces:
- Cloudflare Workers Cache for public API responses.
- R2 snapshot storage for article lists and category counts, so ordinary page visits avoid D1 queries.
- Index-friendly D1 queries and automatic creation of needed indexes during authenticated ingest.
- Automatic snapshot rebuild after each successful news ingest.

SETUP (IMPORTANT)
1. In Cloudflare Dashboard → R2 Object Storage, create a bucket named exactly:
   nazuaf-news-cache
2. Deploy this repository. The R2 binding is configured in wrangler.toml.
3. Keep the existing D1 binding and GitHub Actions secrets unchanged.
4. GitHub → Actions → Update Nazuaf News → Run workflow once after deployment, to generate the first R2 snapshot.
5. Test:
   https://nazuaf-news.id-faauzan.workers.dev/api/articles?limit=10

The Worker continues to use D1 as the source of truth. It creates the necessary indexes on the next authenticated ingest. The R2 view includes up to 2,000 global articles and up to 1,000 per category; this limit does not delete older rows from D1. The existing retention rule for the exact "Berita" category remains unchanged.

If R2 snapshot refresh fails, the ingest response will say D1 was saved but the R2 snapshot failed. Fix the R2 binding and rerun the workflow.

No secrets or API tokens are included in this ZIP.
