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
      if (request.method !== "POST") {
        return json({ ok: false, error: "Method Not Allowed" }, 405);
      }

      const auth = request.headers.get("Authorization") || "";
      if (!env.INGEST_TOKEN || auth !== "Bearer " + env.INGEST_TOKEN) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }

      const articles = Array.isArray(body?.articles) ? body.articles.slice(0, 500) : [];

      // Update existing records by title+source first. This lets the new fetcher
      // replace old Google News redirect URLs with the resolved publisher URL and
      // fill image_url for records already in D1.
      const updateStatements = articles
        .filter((a) => a?.title && a?.url)
        .map((a) =>
          env.DB.prepare(`
            UPDATE articles
            SET url = ?,
                description = COALESCE(?, description),
                image_url = COALESCE(?, image_url),
                published_at = COALESCE(?, published_at)
            WHERE title = ? AND source = ?
          `).bind(
            String(a.url).slice(0, 2000),
            a.description ? String(a.description).slice(0, 500) : null,
            a.image_url ? String(a.image_url).slice(0, 2000) : null,
            a.published_at ? String(a.published_at).slice(0, 100) : null,
            String(a.title).slice(0, 500),
            String(a.source || "Unknown").slice(0, 120)
          )
        );

      if (updateStatements.length) {
        await env.DB.batch(updateStatements);
      }

      // Insert anything that did not already exist.
      const insertStatements = articles
        .filter((a) => a?.title && a?.url)
        .map((a) =>
          env.DB.prepare(`
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
          )
        );

      const results = insertStatements.length ? await env.DB.batch(insertStatements) : [];
      const added = results.reduce((n, r) => n + (r.meta?.changes || 0), 0);

      return json({
        ok: true,
        received: articles.length,
        added,
        updated_or_checked: articles.length,
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
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 24, 1), 100);
      const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
      const category = url.searchParams.get("category");

      const query = category
        ? env.DB.prepare(`
            SELECT * FROM articles
            WHERE category = ?
            ORDER BY published_at DESC, id DESC
            LIMIT ? OFFSET ?
          `).bind(category, limit, offset)
        : env.DB.prepare(`
            SELECT * FROM articles
            ORDER BY published_at DESC, id DESC
            LIMIT ? OFFSET ?
          `).bind(limit, offset);

      const { results } = await query.all();
      return json({ ok: true, articles: results, limit, offset });
    }

    if (url.pathname === "/api/categories") {
      const { results } = await env.DB.prepare(`
        SELECT category, COUNT(*) AS count
        FROM articles
        GROUP BY category
        ORDER BY count DESC
      `).all();

      return json({ ok: true, categories: results });
    }

    const siteName = env.SITE_NAME || "Nazuaf News";

    const html = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0b0f14">
<meta name="description" content="Nazuaf News - agregator berita Indonesia.">
<title>${siteName}</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#090d12;color:#eef2f7;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
a{color:inherit;text-decoration:none}
button,input{font:inherit}
.container{width:min(1120px,calc(100% - 28px));margin:auto}
header{padding:34px 0 24px;border-bottom:1px solid #1b222c;position:sticky;top:0;background:rgba(9,13,18,.94);backdrop-filter:blur(14px);z-index:10}
.brand{display:flex;align-items:center;justify-content:space-between;gap:16px}
.logo{font-size:30px;font-weight:800;letter-spacing:-1px}
.tagline{color:#8f9baa;margin:5px 0 0;font-size:14px}
.search{margin-top:22px;display:flex;gap:10px}
.search input{width:100%;background:#111720;border:1px solid #27303c;color:#fff;border-radius:12px;padding:13px 15px;outline:none}
.search input:focus{border-color:#52657d}
.categories{display:flex;gap:8px;overflow-x:auto;padding:18px 0 4px;scrollbar-width:none}
.categories::-webkit-scrollbar{display:none}
.cat{white-space:nowrap;border:1px solid #27303c;background:#111720;color:#aeb8c5;padding:8px 13px;border-radius:999px;cursor:pointer}
.cat.active{background:#eef2f7;color:#0a0e13;border-color:#eef2f7}
main{padding:24px 0 50px}
.status{color:#7f8a98;font-size:13px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.card{background:#10161e;border:1px solid #202936;border-radius:16px;overflow:hidden;display:flex;flex-direction:column;min-width:0;transition:transform .15s,border-color .15s}
.card:hover{transform:translateY(-2px);border-color:#344154}
.thumb{width:100%;aspect-ratio:16/9;object-fit:cover;background:#151c25}
.noimg{aspect-ratio:16/9;background:linear-gradient(135deg,#111923,#1a2330);display:grid;place-items:center;color:#667384;font-size:13px}
.card-body{padding:16px;display:flex;flex-direction:column;flex:1}
.source{font-size:12px;color:#7fa7d8;margin-bottom:8px;font-weight:650}
.title{font-size:17px;line-height:1.35;margin:0 0 10px;font-weight:750}
.desc{color:#9ca7b5;font-size:13px;line-height:1.5;margin:0 0 14px}
.meta{margin-top:auto;color:#687585;font-size:12px}
.read{display:inline-block;margin-top:13px;color:#d9e3ef;font-size:13px;font-weight:650}
.empty{padding:50px 20px;text-align:center;color:#7d8897;background:#10161e;border:1px solid #202936;border-radius:16px}
.more-wrap{text-align:center;margin-top:24px}
.more{border:1px solid #2b3644;background:#111720;color:#eef2f7;padding:11px 18px;border-radius:10px;cursor:pointer}
.more:disabled{opacity:.5;cursor:default}
footer{border-top:1px solid #1b222c;padding:24px 0 38px;color:#697585;font-size:12px}
.api{margin-top:6px}
.api a{color:#91afd0}
@media(max-width:850px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){header{padding-top:24px}.logo{font-size:27px}.grid{grid-template-columns:1fr}.title{font-size:18px}.container{width:min(100% - 20px,1120px)}}
</style>
</head>
<body>
<header>
<div class="container">
<div class="brand">
<div><div class="logo">${siteName}</div><div class="tagline">Berita Indonesia, dikumpulkan dalam satu tempat.</div></div>
</div>
<div class="search"><input id="search" type="search" placeholder="Cari berita..." autocomplete="off"></div>
<div id="categories" class="categories"></div>
</div>
</header>

<main class="container">
<div id="status" class="status">Memuat berita...</div>
<div id="news" class="grid"></div>
<div id="empty" class="empty" hidden>Tidak ada berita yang cocok.</div>
<div class="more-wrap"><button id="more" class="more">Muat lebih banyak</button></div>
</main>

<footer>
<div class="container">
<div>Nazuaf News · Indonesian news aggregator</div>
<div class="api">API: <a href="/api/articles">Articles</a> · <a href="/api/categories">Categories</a></div>
</div>
</footer>

<script>
(function(){
  var state = { category:"", search:"", offset:0, loading:false, done:false, all:[] };
  var pageSize = 24;

  var newsEl = document.getElementById("news");
  var emptyEl = document.getElementById("empty");
  var statusEl = document.getElementById("status");
  var moreEl = document.getElementById("more");
  var categoriesEl = document.getElementById("categories");
  var searchEl = document.getElementById("search");

  function escapeHtml(value){
    return String(value == null ? "" : value)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;")
      .replace(/'/g,"&#039;");
  }

  function formatDate(value){
    if(!value) return "";
    var d = new Date(value);
    if(isNaN(d.getTime())) return value;
    return new Intl.DateTimeFormat("id-ID",{dateStyle:"medium",timeStyle:"short"}).format(d);
  }

  function matchesSearch(item){
    if(!state.search) return true;
    var hay = ((item.title || "") + " " + (item.description || "") + " " + (item.source || "")).toLowerCase();
    return hay.indexOf(state.search) !== -1;
  }

  function render(){
    var filtered = state.all.filter(matchesSearch);
    emptyEl.hidden = filtered.length !== 0;

    newsEl.innerHTML = filtered.map(function(item){
      var image = item.image_url
        ? '<img class="thumb" loading="lazy" src="' + escapeHtml(item.image_url) + '" alt="" onerror="this.style.display=\\'none\\'">'
        : '<div class="noimg">Nazuaf News</div>';

      return '<article class="card">' +
        image +
        '<div class="card-body">' +
        '<div class="source">' + escapeHtml(item.source || "Berita") + '</div>' +
        '<h2 class="title">' + escapeHtml(item.title) + '</h2>' +
        (item.description ? '<p class="desc">' + escapeHtml(item.description) + '</p>' : '') +
        '<div class="meta">' + escapeHtml(formatDate(item.published_at)) + '</div>' +
        '<a class="read" href="' + escapeHtml(item.url) + '" target="_blank" rel="noopener noreferrer">Baca berita →</a>' +
        '</div></article>';
    }).join("");

    statusEl.textContent = filtered.length + " berita ditampilkan";
    moreEl.disabled = state.loading || state.done;
    moreEl.textContent = state.done ? "Semua berita sudah dimuat" : (state.loading ? "Memuat..." : "Muat lebih banyak");
  }

  async function load(reset){
    if(state.loading) return;
    if(reset){
      state.offset = 0;
      state.done = false;
      state.all = [];
      newsEl.innerHTML = "";
    }
    if(state.done) return;

    state.loading = true;
    render();

    try{
      var params = new URLSearchParams();
      params.set("limit", String(pageSize));
      params.set("offset", String(state.offset));
      if(state.category) params.set("category", state.category);

      var response = await fetch("/api/articles?" + params.toString());
      if(!response.ok) throw new Error("HTTP " + response.status);
      var data = await response.json();
      var items = Array.isArray(data.articles) ? data.articles : [];

      state.all = reset ? items : state.all.concat(items);
      state.offset += items.length;
      if(items.length < pageSize) state.done = true;
    }catch(error){
      statusEl.textContent = "Gagal memuat berita. Coba lagi.";
      console.error(error);
    }finally{
      state.loading = false;
      render();
    }
  }

  async function loadCategories(){
    try{
      var response = await fetch("/api/categories");
      var data = await response.json();
      var items = Array.isArray(data.categories) ? data.categories : [];
      var html = '<button class="cat active" data-category="">Semua</button>';
      html += items.map(function(x){
        return '<button class="cat" data-category="' + escapeHtml(x.category) + '">' +
          escapeHtml(x.category) + ' <span>(' + escapeHtml(x.count) + ')</span></button>';
      }).join("");
      categoriesEl.innerHTML = html;

      categoriesEl.addEventListener("click", function(event){
        var button = event.target.closest(".cat");
        if(!button) return;
        state.category = button.getAttribute("data-category") || "";
        categoriesEl.querySelectorAll(".cat").forEach(function(x){x.classList.remove("active");});
        button.classList.add("active");
        load(true);
      });
    }catch(error){
      categoriesEl.innerHTML = '<button class="cat active">Semua</button>';
      console.error(error);
    }
  }

  var searchTimer;
  searchEl.addEventListener("input", function(){
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function(){
      state.search = searchEl.value.trim().toLowerCase();
      render();
    },120);
  });

  moreEl.addEventListener("click", function(){ load(false); });

  loadCategories();
  load(true);
})();
</script>
</body>
</html>`;

    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders },
    });
  },
};
