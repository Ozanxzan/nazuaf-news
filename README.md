# Nazuaf News OG Image Fix

Replace these two files in the repository:
- `src/index.js`
- `scripts/fetch_news.py`

This version:
- resolves Google News redirect URLs to publisher URLs
- fetches publisher pages concurrently
- extracts `og:image` / `twitter:image`
- extracts `og:description` when available
- updates existing D1 rows by title + source
- replaces old Google News URLs with resolved publisher URLs
- inserts new articles without duplicates

The image extraction relies on standard Open Graph metadata (`og:image`).
