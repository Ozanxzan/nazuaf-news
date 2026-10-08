// Nazuaf News Worker

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === "/api/ingest") {
      if (request.method !== "POST") return json({ ok: false, error: "Method Not Allowed" }, 405);

      const auth = request.headers.get("Authorization") || "";
      if (!env.INGEST_TOKEN || auth !== `Bearer ${env.INGEST_TOKEN}`) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }

      const articles = Array.isArray(body?.articles) ? body.articles.slice(0, 500) : [];
      const statements = articles
        .filter((a) => a?.title && a?.url)
        .map((a) => env.DB.prepare(`
          INSERT OR IGNORE INTO articles
          (title, url, source, category, description, image_url, published_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          String(a.title).slice(0, 500),
          String(a.url).slice(0, 2000),
          String(a.source || "Unknown").slice(0, 120),
          String(a.category || "Berita").slice(0, 80),
          a.description ? String(a.description).slice(0, 500) : null,
          a.image_url ? String(a.image_url).slice(0, 2000) : null,
          a.published_at ? String(a.published_at).slice(0, 100) : null
        ));

      const results = statements.length ? await env.DB.batch(statements) : [];
      const added = results.reduce((n, r) => n + (r.meta?.changes || 0), 0);

      return json({
        ok: true,
        received: articles.length,
        added,
        updated_at: new Date().toISOString(),
      });
    }

    if (url.pathname === "/api/refresh") {
      return json({
        ok: false,
        manual: true,
        message: "Feed fetching is handled by GitHub Actions. Run the Update Nazuaf News workflow for a manual refresh.",
      }, 202);
    }

    if (url.pathname === "/api/articles") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
      const category = url.searchParams.get("category");
      const query = category
        ? env.DB.prepare(`SELECT * FROM articles WHERE category = ? ORDER BY published_at DESC, id DESC LIMIT ?`).bind(category, limit)
        : env.DB.prepare(`SELECT * FROM articles ORDER BY published_at DESC, id DESC LIMIT ?`).bind(limit);
      const { results } = await query.all();
      return json({ ok: true, articles: results });
    }

    if (url.pathname === "/api/categories") {
      const { results } = await env.DB.prepare(`SELECT category, COUNT(*) AS count FROM articles GROUP BY category ORDER BY count DESC`).all();
      return json({ ok: true, categories: results });
    }

    return new Response(`<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${env.SITE_NAME || "Nazuaf News"}</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0f14;color:#f5f7fa;margin:0;padding:40px}main{max-width:900px;margin:auto}a{color:#8ab4ff}code{background:#161c24;padding:3px 6px;border-radius:5px}</style></head>
<body><main><h1>${env.SITE_NAME || "Nazuaf News"}</h1><p>Indonesian news aggregator.</p><p>API: <a href="/api/articles">/api/articles</a> · <a href="/api/categories">/api/categories</a></p></main></body></html>`, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};
