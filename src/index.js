const FEEDS = [
  { name: "ANTARA", category: "Nasional", url: "https://www.antaranews.com/rss/terkini.xml" },
  { name: "ANTARA", category: "Teknologi", url: "https://www.antaranews.com/rss/tekno.xml" },
  { name: "ANTARA", category: "Ekonomi", url: "https://www.antaranews.com/rss/ekonomi.xml" },
  { name: "ANTARA", category: "Dunia", url: "https://www.antaranews.com/rss/dunia.xml" },
  { name: "ANTARA", category: "Olahraga", url: "https://www.antaranews.com/rss/olahraga-all-sport.xml" },
  { name: "CNN Indonesia", category: "Nasional", url: "https://www.cnnindonesia.com/nasional/rss" },
  { name: "CNN Indonesia", category: "Ekonomi", url: "https://www.cnnindonesia.com/ekonomi/rss" },
  { name: "CNBC Indonesia", category: "Ekonomi", url: "https://www.cnbcindonesia.com/news/rss" },
  { name: "CNBC Indonesia", category: "Market", url: "https://www.cnbcindonesia.com/market/rss/" },
  { name: "Liputan6", category: "Berita", url: "https://feed.liputan6.com/rss/news" },
  { name: "Suara.com", category: "Berita", url: "https://www.suara.com/rss/news" },
  { name: "Suara.com", category: "Bisnis", url: "https://www.suara.com/rss/bisnis" },
  { name: "Republika", category: "Nasional", url: "https://www.republika.co.id/rss/nasional/" },
  { name: "Republika", category: "Ekonomi", url: "https://www.republika.co.id/rss/ekonomi/" },
  { name: "Media Indonesia", category: "Berita", url: "https://mediaindonesia.com/feed" },
  { name: "JawaPos", category: "Nasional", url: "https://www.jawapos.com/nasional/rss" },
  { name: "JawaPos", category: "Ekonomi", url: "https://www.jawapos.com/ekonomi/rss" }
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/refresh") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      return Response.json(await updateFeeds(env));
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
  let added = 0, failed = 0;

  for (const feed of FEEDS) {
    try {
      const response = await fetch(feed.url, {
        headers: { "User-Agent": "NazuafNews/1.0 (+https://news.nazuaf.com)" }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const xml = await response.text();
      const items = parseFeed(xml).slice(0, 40);

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
          item.title, item.url, feed.name, feed.category,
          item.description, item.image_url, item.published_at
        ).run();

        added++;
      }
    } catch (e) {
      failed++;
      console.error(`Feed failed: ${feed.name} ${feed.url}`, e);
    }
  }

  return { added, failed, updated_at: new Date().toISOString() };
}

function parseFeed(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (!doc) return [];
  return [...doc.querySelectorAll("item, entry")].map(node => {
    const title = clean(text(node, "title"));
    const url = text(node, "link") ||
      node.querySelector("link")?.getAttribute("href") ||
      text(node, "guid");
    const rawDesc = text(node, "description") || text(node, "summary") || text(node, "content");
    const description = clean(rawDesc).slice(0, 500);
    const published_at = text(node, "pubDate") || text(node, "published") ||
      text(node, "updated") || null;
    const image_url =
      node.querySelector("media\\:content, content")?.getAttribute("url") ||
      node.querySelector("media\\:thumbnail, thumbnail")?.getAttribute("url") ||
      extractImage(rawDesc);
    return { title, url, description, published_at, image_url };
  }).filter(x => x.title && x.url);
}

function text(node, selector) {
  return node.querySelector(selector)?.textContent?.trim() || "";
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
