# Nazuaf News – GitHub Actions ingestion fix

This version moves RSS fetching out of the Cloudflare Worker and into GitHub Actions.

## 1. Worker secret

```bash
npx wrangler secret put INGEST_TOKEN
```

Enter a strong random token.

## 2. Deploy Worker

```bash
npx wrangler deploy
```

## 3. GitHub Actions secrets

Repository → Settings → Secrets and variables → Actions → New repository secret:

- `NEWS_INGEST_URL` = `https://nazuaf-news.id-faauzan.workers.dev/api/ingest`
- `NEWS_INGEST_TOKEN` = the same token used for `INGEST_TOKEN`

Use `https://news.nazuaf.com/api/ingest` instead if the custom domain is active.

## 4. Manual test

GitHub → Actions → Update Nazuaf News → Run workflow.

The workflow also runs automatically every 3 hours.
