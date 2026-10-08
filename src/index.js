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

function page(env) {
  const siteName = String(env.SITE_NAME || "Nazuaf News")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="Berita Indonesia terbaru dari berbagai sumber dalam satu tempat.">
<title>${siteName}</title>
<style>
:root{color-scheme:dark;--bg:#080b10;--panel:#10151d;--panel2:#151b24;--border:#242c38;--text:#f4f7fb;--muted:#9aa5b4;--accent:#8ab4ff;--accent2:#6ea0ff;--shadow:0 10px 35px rgba(0,0,0,.22)}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5}
a{color:inherit;text-decoration:none}
.container{width:min(1120px,calc(100% - 32px));margin:auto}
header{padding:38px 0 24px;border-bottom:1px solid var(--border);background:linear-gradient(180deg,#0d1219 0%,var(--bg) 100%)}
.brand{display:flex;align-items:center;justify-content:space-between;gap:20px}
.logo{font-size:clamp(28px,5vw,42px);font-weight:800;letter-spacing:-1.5px;margin:0}
.tagline{margin:5px 0 0;color:var(--muted);font-size:15px}
.badge{font-size:12px;color:#b9c7da;border:1px solid var(--border);padding:7px 10px;border-radius:999px;white-space:nowrap;background:#0d1219}
.toolbar{padding:20px 0 8px;position:sticky;top:0;z-index:5;background:rgba(8,11,16,.88);backdrop-filter:blur(12px);border-bottom:1px solid rgba(36,44,56,.7)}
.search{width:100%;background:var(--panel);border:1px solid var(--border);color:var(--text);border-radius:12px;padding:13px 15px;font-size:15px;outline:none}
.search:focus{border-color:#456aa4;box-shadow:0 0 0 3px rgba(110,160,255,.1)}
.categories{display:flex;gap:8px;overflow:auto;padding:12px 0 4px;scrollbar-width:none}.categories::-webkit-scrollbar{display:none}
.cat{flex:0 0 auto;border:1px solid var(--border);background:var(--panel);color:#b9c2cf;border-radius:999px;padding:8px 13px;font-size:13px;cursor:pointer}.cat.active{background:#dce9ff;color:#08101c;border-color:#dce9ff;font-weight:700}
.status{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:20px 0 12px;color:var(--muted);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;padding:8px 0 30px}
.card{display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--border);border-radius:16px;overflow:hidden;min-width:0;transition:transform .16s ease,border-color .16s ease,background .16s ease;box-shadow:var(--shadow)}
.card:hover{transform:translateY(-2px);border-color:#344155;background:var(--panel2)}
.thumb{width:100%;aspect-ratio:16/9;background:#0d1219;object-fit:cover;display:block}.noimg{display:flex;align-items:center;justify-content:center;color:#586577;font-size:12px}
.body{padding:15px 15px 14px;display:flex;flex-direction:column;flex:1}.meta{display:flex;flex-wrap:wrap;gap:7px;align-items:center;color:var(--muted);font-size:11px;margin-bottom:8px}.source{color:#b9cfff;font-weight:700}.dot{opacity:.45}.title{font-size:17px;line-height:1.32;letter-spacing:-.2px;margin:0 0 10px;font-weight:750}.desc{font-size:13px;color:#aeb7c5;margin:0 0 14px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}.read{margin-top:auto;color:var(--accent);font-size:13px;font-weight:700}
.empty{grid-column:1/-1;padding:60px 20px;text-align:center;border:1px dashed var(--border);border-radius:16px;color:var(--muted)}
.more{display:block;margin:0 auto 42px;border:1px solid var(--border);background:var(--panel);color:var(--text);padding:11px 18px;border-radius:10px;cursor:pointer;font-weight:700}.more:disabled{opacity:.45;cursor:default}
footer{border-top:1px solid var(--border);padding:22px 0 34px;color:#737f90;font-size:12px}footer a{color:#9dbbf0}
@media(max-width:850px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){.container{width:min(100% - 22px,1120px)}header{padding:28px 0 20px}.badge{display:none}.grid{grid-template-columns:1fr;gap:12px}.title{font-size:16px}.desc{font-size:13px}.toolbar{top:0}.card{border-radius:14px}}
</style>
</head>
<body>
<header>
  <div class="container brand">
    <div><h1 class="logo">${siteName}</h1><p class="tagline">Berita Indonesia terbaru dari berbagai sumber.</p></div>
    <div class="badge">Updated automatically</div>
  </div>
</header>

<section class="toolbar">
  <div class="container">
    <input id="search" class="search" type="search" placeholder="Cari berita..." autocomplete="off">
    <div id="categories" class="categories"></div>
  </div>
</section>

<main class="container">
  <div class="status"><span id="status">Memuat berita...</span><span id="count"></span></div>
  <section id="news" class="grid" aria-live="polite"></section>
  <button id="more" class="more" type="button">Muat lebih banyak</button>
</main>

<footer><div class="container">© ${new Date().getUTCFullYear()} ${siteName} · Aggregated news links from public RSS feeds.</div></footer>

<script>
const state={articles:[],category:"Semua",search:"",offset:0,loading:false,done:false};
const $=id=>document.getElementById(id);
const esc=value=>String(value??"").replace(/[&<>\"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));
const dateText=value=>{if(!value)return "";const d=new Date(value);if(Number.isNaN(d.getTime()))return String(value);return new Intl.DateTimeFormat("id-ID",{day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit",timeZone:"Asia/Jakarta"}).format(d)};
function renderCategories(categories){
  const items=[{category:"Semua",count:null},...categories];
  $("categories").innerHTML=items.map(x=>`<button class="cat ${x.category===state.category?"active":""}" data-category="${esc(x.category)}">${esc(x.category)}${x.count!=null?` · ${x.count}`:""}</button>`).join("");
  document.querySelectorAll(".cat").forEach(b=>b.addEventListener("click",()=>{state.category=b.dataset.category;state.offset=0;state.done=false;state.articles=[];renderCategories(categories);load(true)}));
}
function filtered(){const q=state.search.trim().toLowerCase();return state.articles.filter(a=>(state.category==="Semua"||a.category===state.category)&&(!q||[a.title,a.source,a.description,a.category].filter(Boolean).join(" ").toLowerCase().includes(q)))}
function render(){
  const list=filtered();
  $("count").textContent=`${list.length} berita`;
  if(!list.length){$("news").innerHTML='<div class="empty">Tidak ada berita yang cocok dengan pencarian.</div>';return}
  $("news").innerHTML=list.map(a=>{
    const image=a.image_url?`<img class="thumb" loading="lazy" src="${esc(a.image_url)}" alt="" onerror="this.outerHTML='<div class=\"thumb noimg\">Nazuaf News</div>'>`:'<div class="thumb noimg">Nazuaf News</div>';
    return `<article class="card"><a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${image}<div class="body"><div class="meta"><span class="source">${esc(a.source)}</span>${a.category?`<span class="dot">•</span><span>${esc(a.category)}</span>`:""}${a.published_at?`<span class="dot">•</span><span>${esc(dateText(a.published_at))}</span>`:""}</div><h2 class="title">${esc(a.title)}</h2>${a.description?`<p class="desc">${esc(a.description)}</p>`:""}<span class="read">Baca berita →</span></div></a></article>`;
  }).join("");
}
async function load(reset=false){
  if(state.loading||state.done)return;state.loading=true;$('status').textContent='Memuat berita...';
  try{
    const params=new URLSearchParams({limit:"100",offset:String(state.offset)});if(state.category!=="Semua")params.set("category",state.category);
    const r=await fetch(`/api/articles?${params}`);if(!r.ok)throw new Error(`HTTP ${r.status}`);const data=await r.json();const rows=Array.isArray(data.articles)?data.articles:[];
    if(reset)state.articles=[];state.articles.push(...rows);state.offset+=rows.length;if(rows.length<100)state.done=true;render();$('status').textContent=state.done?'Berita terbaru':'Berita terbaru';$('more').style.display=state.done?'none':'block';
  }catch(e){$('status').textContent='Gagal memuat berita';$('news').innerHTML=`<div class="empty">Tidak dapat memuat berita saat ini.<br><small>${esc(e.message)}</small></div>`}
  finally{state.loading=false}
}
async function init(){
  try{const r=await fetch('/api/categories');const d=await r.json();renderCategories(Array.isArray(d.categories)?d.categories:[])}catch{renderCategories([])}
  await load(true);
}
$('search').addEventListener('input',e=>{state.search=e.target.value;render()});
$('more').addEventListener('click',()=>load(false));
init();
</script>
</body>
</html>`;
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
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

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

      return json({ ok: true, received: articles.length, added, updated_at: new Date().toISOString() });
    }

    if (url.pathname === "/api/refresh") {
      return json({ ok: false, manual: true, message: "Feed fetching is handled by GitHub Actions. Run the Update Nazuaf News workflow for a manual refresh." }, 202);
    }

    if (url.pathname === "/api/articles") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
      const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
      const category = url.searchParams.get("category");
      const query = category
        ? env.DB.prepare(`SELECT * FROM articles WHERE category = ? ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?`).bind(category, limit, offset)
        : env.DB.prepare(`SELECT * FROM articles ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?`).bind(limit, offset);
      const { results } = await query.all();
      return json({ ok: true, articles: results, limit, offset });
    }

    if (url.pathname === "/api/categories") {
      const { results } = await env.DB.prepare(`SELECT category, COUNT(*) AS count FROM articles GROUP BY category ORDER BY count DESC`).all();
      return json({ ok: true, categories: results });
    }

    return new Response(page(env), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" } });
  },
};
