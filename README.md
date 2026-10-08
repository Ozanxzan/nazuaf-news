# Nazuaf News – OG Image Fix v2

Replace these two files in the GitHub repository:
- `src/index.js`
- `scripts/fetch_news.py`

This version fixes the D1 HTTP 500 caused by URL UNIQUE conflicts when converting Google News URLs to publisher URLs. It checks for URL conflicts before updating and processes D1 batches in smaller groups.

After committing, wait for the Cloudflare Worker deployment, then run **Actions → Update Nazuaf News → Run workflow** manually.
