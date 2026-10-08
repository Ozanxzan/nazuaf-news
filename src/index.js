const FEEDS = [
  { name: "ANTARA", category: "Berita", url: "https://news.google.com/rss/search?q=site%3Aantaranews.com+when%3A1d&hl=id&gl=ID&ceid=ID%3Aid" },
  { name: "CNN Indonesia", category: "Berita", url: "https://news.google.com/rss/search?q=site%3Acnnindonesia.com+when%3A1d&hl=id&gl=ID&ceid=ID%3Aid" },
  { name: "CNBC Indonesia", category: "Ekonomi", url: "https://news.google.com/rss/search?q=site%3Acnbcindonesia.com+when%3A1d&hl=id&gl=ID&ceid=ID%3Aid" },
  { name: "Kompas.com", category: "Berita", url: "https://news.google.com/rss/search?q=site%3Akompas.com+when%3A1d&hl=id&gl=ID&ceid=ID%3Aid" },
  { name: "detikcom", category: "Berita", url: "https://news.google.com/rss/search?q=site%3Adetik.com+when%3A1d&hl=id&gl=ID&ceid=ID%3Aid" },
  { name: "Tempo.co", category: "Berita", url: "https://news.google.com/rss/search?q=site%3Atempo.co+when%3A1d&hl=id&gl=ID&ceid=ID%3Aid" },
  { name: "Liputan6", category: "Berita", url: "https://news.google.com/rss/search?q=site%3Aliputan6.com+when%3A1d&hl=id&gl=ID&ceid=ID%3Aid" },
  { name: "Tirto.id", category: "Berita", url: "https://news.google.com/rss/search?q=site%3Atirto.id+when%3A1d&hl=id&gl=ID&ceid=ID%3Aid" },
  { name: "Suara.com", category: "Berita", url: "https://news.google.com/rss/search?q=site%3Asuara.com+when%3A1d&hl=id&gl=ID&ceid=ID%3Aid" },
  { name: "Republika", category: "Berita", url: "https://news.google.com/rss/search?q=site%3Arepublika.co.id+when%3A1d&hl=id&gl=ID&ceid=ID%3Aid" },
  { name: "Teknologi", category: "Teknologi", url: "https://news.google.com/rss/search?q=teknologi+AI+gadget+Indonesia+when%3A1d&hl=id&gl=ID&ceid=ID%3Aid" },
  { name: "Gaming", category: "Gaming", url: "https://news.google.com/rss/search?q=gaming+game+Indonesia+when%3A1d&hl=id&gl=ID&ceid=ID%3Aid" },
  { name: "Sains", category: "Sains", url: "https://news.google.com/rss/search?q=sains+teknologi+Indonesia+when%3A1d&hl=id&gl=ID&ceid=ID%3Aid" }
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/refresh") {
      // Allow manual refresh from a browser (GET) as well as API refresh (POST).
      // The scheduled Cron trigger remains independent and still runs every 3 hours.
      if (request.method !== "GET" && request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }

      const result = await updateFeeds(env);
      return Response.json({
        ok: true,
        manual: request.method === "GET",
        ...result
      });
    }

    if (url.pathname === "/api/articles") {
      const category = url.searchParams.get("category");
      const limit = Math.min(Number(url.searchParams.get("limit") || 50), 100);
      let query = "SELECT * FROM articles";
      const params = [];
      if (category && category !== "Semua") {
        query += " WHERE category = ?";
        params.push(category);
      }
      query += " ORDER BY COALESCE(published_at, created_at) DESC LIMIT ?";
      params.push(limit);
      const { results } = await env.DB.prepare(query).bind(...params).all();
      return Response.json(results);
    }

    if (url.pathname === "/api/categories") {
      const { results } = await env.DB.prepare(
        "SELECT DISTINCT category FROM articles ORDER BY category"
      ).all();
      return Response.json(results.map(x => x.category));
    }

    return new Response(renderPage(), {
      headers: { "content-type": "text/html; charset=UTF-8" }
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(updateFeeds(env));
  }
};

async function updateFeeds(env) {
  let added = 0;
  let failed = 0;
  const errors = [];

  // Process feeds sequentially so multiple D1 writes do not contend for
  // SQLite write locks. The Cron schedule is still every 3 hours.
  for (const feed of FEEDS) {
    try {
      const response = await fetch(feed.url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; NazuafNews/1.0; +https://news.nazuaf.com)",
          "Accept": "application/rss+xml, application/xml, text/xml, */*"
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const xml = await response.text();
      if (!xml || xml.length < 100) {
        throw new Error(`Empty/invalid response (${xml.length} bytes)`);
      }

      const items = parseFeed(xml).slice(0, 50);
      let feedAdded = 0;

      for (const item of items) {
        const exists = await env.DB.prepare(
          "SELECT id FROM articles WHERE url = ? LIMIT 1"
        ).bind(item.url).first();

        if (exists) continue;

        await env.DB.prepare(`
          INSERT INTO articles
          (title, url, source, category, description, image_url, published_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          item.title,
          item.url,
          item.source || feed.name,
          feed.category,
          item.description,
          item.image_url,
          item.published_at
        ).run();

        feedAdded++;
        added++;
      }

      console.log(`Feed OK: ${feed.name}; items=${items.length}; added=${feedAdded}`);
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ feed: feed.name, error: message });
      console.error(`Feed failed: ${feed.name}`, message);
    }
  }

  return {
    ok: failed === 0,
    added,
    failed,
    feeds: FEEDS.length,
    errors,
    updated_at: new Date().toISOString()
  };
}

function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];

  for (const block of blocks) {
    const title = clean(tagValue(block, "title"));
    const source = clean(tagValue(block, "source"));
    const url =
      attrValue(block, "link", "href") ||
      clean(tagValue(block, "link")) ||
      clean(tagValue(block, "guid"));

    const rawDesc =
      tagValue(block, "description") ||
      tagValue(block, "summary") ||
      tagValue(block, "content");

    const description = clean(rawDesc).slice(0, 500);
    const published_at =
      clean(tagValue(block, "pubDate")) ||
      clean(tagValue(block, "published")) ||
      clean(tagValue(block, "updated")) ||
      null;

    const image_url =
      mediaUrl(block, "content") ||
      mediaUrl(block, "thumbnail") ||
      extractImage(rawDesc);

    if (title && url) {
      items.push({ title, url, source, description, published_at, image_url });
    }
  }

  return items;
}

function tagValue(block, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i");
  const match = block.match(re);
  return match ? match[1].trim() : "";
}

function attrValue(block, tag, attr) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<${escapedTag}\\b([^>]*)>`, "i");
  const match = block.match(re);
  if (!match) return "";
  const attrRe = new RegExp(`${attr}=["']([^"']+)["']`, "i");
  const attrMatch = match[1].match(attrRe);
  return attrMatch ? attrMatch[1].trim() : "";
}

function mediaUrl(block, name) {
  const re = new RegExp(`<media:${name}\\b[^>]*?url=["']([^"']+)["'][^>]*/?>`, "i");
  const match = block.match(re);
  return match ? match[1].trim() : "";
}

function clean(value) {
  return (value || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractImage(html) {
  const match = html?.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

function renderPage() {
return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nazuaf News — Berita Indonesia</title>
<meta name="description" content="Nazuaf News — agregator berita Indonesia yang diperbarui otomatis.">
<style>
:root{color-scheme:dark;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;background:#09090b;color:#f4f4f5}
header{position:sticky;top:0;z-index:5;background:rgba(9,9,11,.9);backdrop-filter:blur(14px);border-bottom:1px solid #27272a}
.wrap{max-width:1120px;margin:auto;padding:18px}.brand{font-size:25px;font-weight:850;letter-spacing:-.6px}
.sub{color:#a1a1aa;font-size:13px;margin-top:3px}nav{display:flex;gap:8px;overflow:auto;padding-top:16px}
button{border:1px solid #27272a;background:#18181b;color:#d4d4d8;border-radius:999px;padding:8px 14px;cursor:pointer;white-space:nowrap}
button.active{background:#f4f4f5;color:#09090b}.status{color:#71717a;font-size:13px;margin:22px 0 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:16px}
.card{border:1px solid #27272a;background:#111113;border-radius:16px;overflow:hidden;transition:.18s}
.card:hover{transform:translateY(-2px);border-color:#3f3f46}.thumb{height:175px;background:#18181b;overflow:hidden}
.thumb img{width:100%;height:100%;object-fit:cover}.body{padding:16px}.meta{font-size:12px;color:#a1a1aa;margin-bottom:8px}
.title{font-size:18px;font-weight:750;line-height:1.3;color:#fafafa;text-decoration:none}.desc{font-size:13px;color:#a1a1aa;line-height:1.5;margin-top:10px}
footer{color:#71717a;text-align:center;padding:40px 18px;font-size:12px}.empty{padding:50px;text-align:center;color:#71717a;border:1px dashed #27272a;border-radius:16px}
</style></head>
<body>
<header><div class="wrap"><div class="brand">Nazuaf News</div>
<div class="sub">Berita Indonesia · diperbarui otomatis</div><nav id="nav"></nav></div></header>
<main class="wrap"><div class="status" id="status">Memuat berita…</div><div class="grid" id="news"></div></main>
<footer>© 2026 Nazuaf · Judul, ringkasan, gambar, dan tautan berasal dari sumber berita masing-masing.</footer>
<script>
let current="Semua";
async function loadCategories(){
 const r=await fetch("/api/categories"); const cats=await r.json();
 nav.innerHTML=["Semua",...cats].map(c=>'<button class="'+(c===current?'active':'')+'" onclick="selectCat('+JSON.stringify(c)+')">'+escapeHtml(c)+'</button>').join("");
}
async function load(){
 status.textContent="Memuat berita…";
 const q=current==="Semua"?"":("?category="+encodeURIComponent(current));
 const r=await fetch("/api/articles"+q); const data=await r.json();
 status.textContent=data.length+" berita · diperbarui otomatis";
 news.innerHTML=data.length?data.map(card).join(""):'<div class="empty">Belum ada berita. Jalankan update pertama kali dari API /api/refresh.</div>';
}
function selectCat(c){current=c;loadCategories();load()}
function card(a){
 const date=a.published_at?new Date(a.published_at).toLocaleString("id-ID"):"Terbaru";
 const image=a.image_url?'<div class="thumb"><img loading="lazy" src="'+escapeAttr(a.image_url)+'" onerror="this.parentElement.style.display=\\'none\\'"></div>':'';
 return '<article class="card">'+image+'<div class="body"><div class="meta">'+escapeHtml(a.source)+' · '+escapeHtml(date)+'</div><a class="title" href="'+escapeAttr(a.url)+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(a.title)+'</a><div class="desc">'+escapeHtml(a.description||"")+'</div></div></article>';
}
function escapeHtml(s){return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
function escapeAttr(s){return escapeHtml(s)}
loadCategories();load();
</script></body></html>`;
}
