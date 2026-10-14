// Nazuaf News Worker
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders },
  });
}

function cleanDescription(value) {
  let text = String(value ?? "");
  for (let i = 0; i < 3; i++) {
    const decoded = text.replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"').replace(/&#0*39;/gi, "'")
      .replace(/&#x0*27;/gi, "'").replace(/&amp;/gi, "&");
    if (decoded === text) break;
    text = decoded;
  }
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*(?:>|$)/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
  const lower = text.toLowerCase();
  if (lower.includes("comprehensive up-to-date news coverage") ||
      lower.includes("aggregated from sources all over the world by google news")) return "";
  return text;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    if (url.pathname === "/api/ingest") {
      if (request.method !== "POST") return json({ ok: false, error: "Method Not Allowed" }, 405);
      const auth = request.headers.get("Authorization") || "";
      if (!env.INGEST_TOKEN || auth !== "Bearer " + env.INGEST_TOKEN) return json({ ok: false, error: "Unauthorized" }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

      const articles = Array.isArray(body?.articles) ? body.articles.slice(0, 500) : [];
      const valid = articles.filter(a => a?.title && a?.url);
      let updated = 0, added = 0;

      const updates = valid.map(a => {
        const title = String(a.title).slice(0, 500);
        const source = String(a.source || "Unknown").slice(0, 120);
        const oldUrl = a.google_url ? String(a.google_url).slice(0, 2000) : null;
        const desc = a.description ? cleanDescription(a.description) || null : null;
        const image = a.image_url ? String(a.image_url).slice(0, 2000) : null;
        const published = a.published_at ? String(a.published_at).slice(0, 100) : null;
        if (oldUrl) return env.DB.prepare(`
          UPDATE articles SET description=COALESCE(?,description), image_url=COALESCE(?,image_url),
          published_at=COALESCE(?,published_at) WHERE url=? OR (title=? AND source=?)
        `).bind(desc, image, published, oldUrl, title, source);
        return env.DB.prepare(`
          UPDATE articles SET description=COALESCE(?,description), image_url=COALESCE(?,image_url),
          published_at=COALESCE(?,published_at) WHERE title=? AND source=?
        `).bind(desc, image, published, title, source);
      });

      try {
        for (let i = 0; i < updates.length; i += 400) {
          const res = await env.DB.batch(updates.slice(i, i + 400));
          updated += res.reduce((n, r) => n + (r.meta?.changes || 0), 0);
        }
      } catch (e) { return json({ ok: false, error: "D1 update failed", detail: String(e?.message || e) }, 500); }

      const inserts = valid.map(a => env.DB.prepare(`
        INSERT OR IGNORE INTO articles (title,url,source,category,description,image_url,published_at)
        VALUES (?,?,?,?,?,?,?)
      `).bind(
        String(a.title).slice(0, 500), String(a.url).slice(0, 2000),
        String(a.source || "Unknown").slice(0, 120), String(a.category || "Berita").slice(0, 80),
        a.description ? cleanDescription(a.description) || null : null,
        a.image_url ? String(a.image_url).slice(0, 2000) : null,
        a.published_at ? String(a.published_at).slice(0, 100) : null
      ));

      try {
        for (let i = 0; i < inserts.length; i += 400) {
          const res = await env.DB.batch(inserts.slice(i, i + 400));
          added += res.reduce((n, r) => n + (r.meta?.changes || 0), 0);
        }
        // Retain at most 1,000 newest rows in the exact "Berita" category.
        // The existing D1 database and other categories are not recreated or deleted.
        await env.DB.prepare(`
          DELETE FROM articles
          WHERE category = 'Berita'
            AND id NOT IN (
              SELECT id FROM articles WHERE category = 'Berita'
              ORDER BY COALESCE(julianday(published_at), julianday(created_at), 0) DESC, id DESC
              LIMIT 1000
            )
        `).run();
      } catch (e) { return json({ ok: false, error: "D1 insert/retention cleanup failed", detail: String(e?.message || e) }, 500); }

      return json({ ok: true, received: articles.length, valid: valid.length, updated, added,
        with_images: valid.filter(a => a.image_url).length, updated_at: new Date().toISOString() });
    }

    if (url.pathname === "/api/refresh") {
      return json({ ok: false, manual: true, message: "Feed fetching is handled by GitHub Actions. Run the Update Nazuaf News workflow for a manual refresh." }, 202);
    }

    if (url.pathname === "/api/articles") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 24, 1), 100);
      const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
      const category = url.searchParams.get("category");
      const order = " ORDER BY COALESCE(julianday(published_at), julianday(created_at), 0) DESC, id DESC LIMIT ? OFFSET ?";
      const query = category
        ? env.DB.prepare("SELECT * FROM articles WHERE category = ?" + order).bind(category, limit, offset)
        : env.DB.prepare("SELECT * FROM articles" + order).bind(limit, offset);
      const { results } = await query.all();
      return json({ ok: true, articles: results.map(a => ({ ...a, description: cleanDescription(a.description) || null })), limit, offset });
    }

    if (url.pathname === "/api/categories") {
      const { results } = await env.DB.prepare("SELECT category, COUNT(*) AS count FROM articles GROUP BY category ORDER BY count DESC").all();
      return json({ ok: true, categories: results });
    }

    const siteName = env.SITE_NAME || "Nazuaf News";
    const country = String(request.cf?.country || "unknown").toLowerCase();
    const html = `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="theme-color" content="#0b0f14">
<meta name="description" content="Nazuaf News - agregator berita Indonesia."><title>${siteName}</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#090d12;color:#eef2f7;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
a{color:inherit;text-decoration:none}button,input{font:inherit}.container{width:min(1120px,calc(100% - 28px));margin:auto}
header{padding:34px 0 24px;border-bottom:1px solid #1b222c;position:sticky;top:0;background:rgba(9,13,18,.94);backdrop-filter:blur(14px);z-index:10}
.logo{font-size:30px;font-weight:800;letter-spacing:-1px}.tagline{color:#8f9baa;margin:5px 0 0;font-size:14px}
.search{margin-top:22px}.search input{width:100%;background:#111720;border:1px solid #27303c;color:#fff;border-radius:12px;padding:13px 15px;outline:none}
.search input:focus{border-color:#52657d}.categories{display:flex;gap:8px;overflow-x:auto;padding:18px 0 4px;scrollbar-width:none}.categories::-webkit-scrollbar{display:none}
.cat{white-space:nowrap;border:1px solid #27303c;background:#111720;color:#aeb8c5;padding:8px 13px;border-radius:999px;cursor:pointer}.cat.active{background:#eef2f7;color:#0a0e13;border-color:#eef2f7}
main{padding:24px 0 50px}.status{color:#7f8a98;font-size:13px;margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.card{background:#10161e;border:1px solid #202936;border-radius:16px;overflow:hidden;display:flex;flex-direction:column;min-width:0}
.thumb,.noimg{width:100%;aspect-ratio:16/9;object-fit:cover;background:#151c25}.noimg{background:linear-gradient(135deg,#111923,#1a2330);display:grid;place-items:center;color:#667384;font-size:13px}
.card-body{padding:16px;display:flex;flex-direction:column;flex:1}.source{font-size:12px;color:#7fa7d8;margin-bottom:8px;font-weight:650}
.title{font-size:17px;line-height:1.35;margin:0 0 10px;font-weight:750}.desc{color:#9ca7b5;font-size:13px;line-height:1.5;margin:0 0 14px}
.meta{margin-top:auto;color:#687585;font-size:12px}.read{display:inline-block;margin-top:13px;color:#d9e3ef;font-size:13px;font-weight:650}
.empty{padding:50px 20px;text-align:center;color:#7d8897;background:#10161e;border:1px solid #202936;border-radius:16px}.more-wrap{text-align:center;margin-top:24px}
.more{border:1px solid #2b3644;background:#111720;color:#eef2f7;padding:11px 18px;border-radius:10px;cursor:pointer}.more:disabled{opacity:.5;cursor:default}
footer{border-top:1px solid #1b222c;padding:24px 0 38px;color:#697585;font-size:12px}
@media(max-width:850px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:600px){header{padding-top:24px}.logo{font-size:27px}.grid{grid-template-columns:1fr}.title{font-size:18px}.container{width:min(100% - 20px,1120px)}}
</style></head><body><header><div class="container"><div class="logo"><a href="https://nazuaf.com">${siteName}</a></div>
<div class="tagline">Berita Indonesia, dikumpulkan dalam satu tempat.</div>
<div class="search"><input id="search" type="search" placeholder="Cari berita..." autocomplete="off"></div><div id="categories" class="categories"></div></div></header>
<main class="container"><div id="status" class="status">Memuat berita...</div><div id="news" class="grid"></div><div id="empty" class="empty" hidden>Tidak ada berita yang cocok.</div>
<div class="more-wrap"><button id="more" class="more">Muat lebih banyak</button></div></main>
<footer><div class="container">nazuaf news · indonesian news aggregator<div id="visitor-info">load: menghitung... · negara: ${country} · browser: mendeteksi...</div></div></footer>
<script>
(function(){function browserName(){var u=(navigator.userAgent||"").toLowerCase();if(u.indexOf("edg/")>=0)return"edge";if(u.indexOf("opr/")>=0||u.indexOf("opera")>=0)return"opera";if(u.indexOf("samsungbrowser")>=0)return"samsung internet";if(u.indexOf("firefox/")>=0||u.indexOf("fxios/")>=0)return"firefox";if(u.indexOf("crios/")>=0||u.indexOf("chrome/")>=0)return"chrome";if(u.indexOf("safari/")>=0)return"safari";return"unknown"}
function update(){var e=document.getElementById("visitor-info");if(!e)return;var ms=Math.round(performance.now());try{var n=performance.getEntriesByType("navigation");if(n&&n.length){var c=n[0].loadEventEnd||n[0].domContentLoadedEventEnd||n[0].responseEnd;if(c>0)ms=Math.round(c)}}catch(x){}e.textContent="load: "+ms+" ms · negara: ${country} · browser: "+browserName()}update();window.addEventListener("load",update);setTimeout(update,500)})();
</script>
<script>
(function(){var s={category:"",search:"",offset:0,loading:false,done:false,all:[]},size=24;
var news=document.getElementById("news"),empty=document.getElementById("empty"),status=document.getElementById("status"),more=document.getElementById("more"),cats=document.getElementById("categories"),search=document.getElementById("search");
function esc(v){return String(v==null?"":v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")}
function date(v){if(!v)return"";var d=new Date(v);return isNaN(d.getTime())?v:new Intl.DateTimeFormat("id-ID",{dateStyle:"medium",timeStyle:"short"}).format(d)}
function render(){var items=s.all.filter(function(a){return !s.search||((a.title||"")+" "+(a.description||"")+" "+(a.source||"")).toLowerCase().indexOf(s.search)>=0});
empty.hidden=items.length!==0;news.innerHTML=items.map(function(a){var im=a.image_url?'<img class="thumb" loading="lazy" referrerpolicy="no-referrer" src="'+esc(String(a.image_url).replace(/^http:/,"https:"))+'" alt="" onerror="this.remove()">':'<div class="noimg">Nazuaf News</div>';
return '<article class="card">'+im+'<div class="card-body"><div class="source">'+esc(a.source||"Berita")+'</div><h2 class="title"><a href="'+esc(a.url)+'" target="_blank" rel="noopener noreferrer">'+esc(a.title)+'</a></h2>'+(a.description?'<p class="desc">'+esc(a.description)+'</p>':'')+'<div class="meta">'+esc(date(a.published_at))+'</div><a class="read" href="'+esc(a.url)+'" target="_blank" rel="noopener noreferrer">Baca berita →</a></div></article>'}).join("");
status.textContent=items.length+" berita ditampilkan";more.disabled=s.loading||s.done;more.textContent=s.done?"Semua berita sudah dimuat":s.loading?"Memuat...":"Muat lebih banyak"}
async function load(reset){if(s.loading)return;if(reset){s.offset=0;s.done=false;s.all=[];news.innerHTML=""}if(s.done)return;s.loading=true;render();try{var p=new URLSearchParams({limit:String(size),offset:String(s.offset)});if(s.category)p.set("category",s.category);var r=await fetch("/api/articles?"+p);if(!r.ok)throw Error("HTTP "+r.status);var d=await r.json(),a=Array.isArray(d.articles)?d.articles:[];s.all=reset?a:s.all.concat(a);s.offset+=a.length;if(a.length<size)s.done=true}catch(e){status.textContent="Gagal memuat berita. Coba lagi.";console.error(e)}finally{s.loading=false;render()}}
async function loadCats(){try{var r=await fetch("/api/categories");if(!r.ok)throw Error("HTTP "+r.status);var d=await r.json(),a=Array.isArray(d.categories)?d.categories:[];cats.innerHTML='<button class="cat active" data-category="">Semua</button>'+a.map(function(x){return '<button class="cat" data-category="'+esc(x.category)+'">'+esc(x.category)+' <span>('+esc(x.count)+')</span></button>'}).join("");
cats.addEventListener("click",function(e){var b=e.target.closest(".cat");if(!b)return;s.category=b.getAttribute("data-category")||"";cats.querySelectorAll(".cat").forEach(function(x){x.classList.remove("active")});b.classList.add("active");load(true)})}catch(e){cats.innerHTML='<button class="cat active">Semua</button>';console.error(e)}}
var timer;search.addEventListener("input",function(){clearTimeout(timer);timer=setTimeout(function(){s.search=search.value.trim().toLowerCase();render()},120)});more.addEventListener("click",function(){load(false)});loadCats();load(true)})();
</script></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders } });
  },
};
