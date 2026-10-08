# Nazuaf News image/description fix

Replace `scripts/fetch_news.py` with this version and commit it to `main`.

It:
- extracts `media:content` / `media:thumbnail` / RSS enclosures
- extracts image URLs embedded in Google News descriptions
- decodes escaped HTML before cleaning descriptions
- reports how many fetched articles contain images

After commit, GitHub Actions will fetch fresh records and ingest image URLs into D1.
