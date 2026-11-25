// Nazuaf News — Worker (v2: scraper isi penuh + tema portal berita)
// Arsitektur: RSS (GitHub Actions) -> POST /api/ingest -> D1 articles (metadata)
//   -> snapshot R2 nazuaf-news-cache public/news-snapshot-v1.json (home + API)
//   -> scraper (cron 3 jam + pemicu ingest + manual /api/scrape + on-demand saat
//      halaman baca dibuka) ambil isi penuh dari situs sumber -> R2
//      nazuaf-news-cache news-bodies/{id}.json -> halaman baca /baca/{id}.
// Deploy via API v4 (lihat deploy.py di folder ini). JANGAN ubah binding:
//   D1 DB (nazuaf-news), R2 NEWS_CACHE (nazuaf-news-cache),
//   secret INGEST_TOKEN, var SITE_NAME. SCRAPE_TOKEN = var plain-text baru
//   khusus pemicu scrape manual (nilai di .scrape-token, chmod 600).

const NEWS_SNAPSHOT_KEY = "public/news-snapshot-v1.json";
const BODY_PREFIX = "news-bodies/";
const GLOBAL_SNAPSHOT_LIMIT = 2000;
const CATEGORY_SNAPSHOT_LIMIT = 1000;
const SNAPSHOT_MAX_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const TARGET_PER_CATEGORY = 20;
const SITE_CATEGORIES = ["Berita", "Bisnis", "Nasional", "Teknologi", "Sains", "Gaming", "Olahraga", "Hiburan", "Kesehatan"];
const FALLBACK_FEEDS = [
  { category: "Gaming", source: "Babel Insight", url: "https://www.babelinsight.id/rss/game.xml" },
  { category: "Gaming", source: "Gamedaim", url: "https://gamedaim.com/feed/" },
  { category: "Gaming", source: "GGWP", url: "https://www.ggwp.id/feed/" },
  { category: "Olahraga", source: "Inikata.co.id", url: "https://inikata.co.id/rss/olahraga.xml" },
  { category: "Olahraga", source: "5News", url: "https://www.5news.co.id/rss/olahraga.xml" },
  { category: "Olahraga", source: "Babel Insight", url: "https://www.babelinsight.id/rss/olahraga.xml" },
  { category: "Hiburan", source: "ANTARA Lifestyle", url: "https://www.antaranews.com/rss/lifestyle.xml" },
  { category: "Hiburan", source: "Inikata.co.id", url: "https://inikata.co.id/rss/hiburan.xml" },
  { category: "Hiburan", source: "Inikata.co.id", url: "https://inikata.co.id/rss/gaya-hidup.xml" },
  { category: "Hiburan", source: "Babel Insight", url: "https://www.babelinsight.id/rss/hiburan.xml" },
  { category: "Kesehatan", source: "Inikata.co.id", url: "https://inikata.co.id/rss/kesehatan.xml" },
  { category: "Kesehatan", source: "DetikHealth", url: "https://rss.detik.com/index.php/health" }
];
const ARTICLE_COLUMNS = "id,title,url,source,category,description,image_url,published_at,created_at";

// ---- Scraper ----
const SCRAPE_BATCH_SCHEDULED = 20; // per jalan cron (8x/hari)
const SCRAPE_BATCH_INGEST = 10; // per jalan ingest (8x/hari)
const SCRAPE_WINDOW_DAYS = 3; // hanya artikel terbit <= 3 hari terakhir
const SCRAPE_RETRY_AFTER_HOURS = 24;
const SCRAPE_FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 2000000;
const MAX_BODY_BYTES = 524288;
const MAX_PARAGRAPHS = 400;
const CATEGORY_COLORS = {
  Berita: "#6b7280", Bisnis: "#047857", Nasional: "#d8232a", Teknologi: "#1d4ed8",
  Sains: "#6d28d9", Gaming: "#7c3aed", Olahraga: "#ea580c", Hiburan: "#db2777", Kesehatan: "#0d9488"
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders, ...extraHeaders }
  });
}
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};
function apiCacheHeaders(tag, maxAgeSeconds = 120) {
  return {
    "Cache-Control": "public, max-age=30, s-maxage=" + maxAgeSeconds + ", stale-while-revalidate=300, stale-if-error=86400",
    "Cache-Tag": tag
  };
}
function isRecentArticle(article, now = Date.now()) {
  const published = Date.parse(article?.published_at || "");
  return Number.isFinite(published) && published >= now - SNAPSHOT_MAX_AGE_DAYS * DAY_MS && published <= now + DAY_MS;
}
function snapshotCategories(snapshot) {
  if (snapshot?.snapshot_schema_version === 2 && Array.isArray(snapshot.categories)) return snapshot.categories;
  const byCategory = snapshot?.byCategory || {};
  return SITE_CATEGORIES.map((category) => ({
    category,
    count: Array.isArray(byCategory[category]) ? byCategory[category].filter((article) => isRecentArticle(article)).length : 0
  })).sort((a, b) => b.count - a.count);
}
function snapshotUnavailable() {
  return json(
    { ok: false, error: "News snapshot is unavailable", code: "SNAPSHOT_UNAVAILABLE" },
    503,
    { "Cache-Control": "no-store", "Retry-After": "60" }
  );
}
function decodeXml(value) {
  return String(value || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&#0*39;/gi, "'").replace(/&#x0*27;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}
function xmlTagText(block, name) {
  const re = new RegExp("<(?:[\\w.-]+:)?" + name + "\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?" + name + "\\s*>", "i");
  const match = String(block || "").match(re);
  return match ? decodeXml(match[1]).trim() : "";
}
function xmlAttribute(block, tagNames, attribute) {
  for (const tag of tagNames) {
    const re = new RegExp("<(?:[\\w.-]+:)?" + tag + "\\b[^>]*\\b" + attribute + `=["']([^"']+)["'][^>]*>`, "i");
    const match = String(block || "").match(re);
    if (match) return decodeXml(match[1]).trim();
  }
  return "";
}
function parseFallbackFeed(xml, feed) {
  const rssItems = String(xml || "").match(/<item\b[^>]*>[\s\S]*?<\/item\s*>/gi) || [];
  const atomItems = String(xml || "").match(/<entry\b[^>]*>[\s\S]*?<\/entry\s*>/gi) || [];
  const articles = [];
  for (const block of [...rssItems, ...atomItems].slice(0, 100)) {
    const title = cleanDescription(xmlTagText(block, "title")).slice(0, 500);
    let link = xmlTagText(block, "link") || xmlTagText(block, "id") || xmlAttribute(block, ["link"], "href");
    link = decodeXml(link).trim().split("#", 1)[0];
    if (!title || !/^https?:\/\//i.test(link)) continue;
    const dateValue = xmlTagText(block, "pubDate") || xmlTagText(block, "published") || xmlTagText(block, "updated") || xmlTagText(block, "date");
    const parsedDate = Date.parse(dateValue);
    if (!Number.isFinite(parsedDate)) continue;
    const descriptionRaw = xmlTagText(block, "description") || xmlTagText(block, "summary") || xmlTagText(block, "encoded") || xmlTagText(block, "content");
    let image = xmlAttribute(block, ["content", "thumbnail", "enclosure"], "url") || xmlAttribute(block, ["image"], "href");
    if (!image) {
      const imgMatch = decodeXml(descriptionRaw).match(/<img\b[^>]*\bsrc=["']([^"']+)/i);
      if (imgMatch) image = imgMatch[1];
    }
    try {
      if (image) image = new URL(image, link).href;
    } catch {
      image = "";
    }
    if (image && image.startsWith("http://")) image = "https://" + image.slice(7);
    const article = {
      title,
      url: link.slice(0, 2000),
      source: feed.source,
      category: feed.category,
      description: cleanDescription(descriptionRaw).slice(0, 500) || null,
      image_url: image && image.startsWith("https://") ? image.slice(0, 2000) : null,
      published_at: new Date(parsedDate).toISOString()
    };
    if (isRecentArticle(article)) articles.push(article);
  }
  return articles;
}
async function supplementMissingCategories(articles) {
  const counts = new Map(SITE_CATEGORIES.map((category) => [category, 0]));
  const seenUrls = new Set();
  for (const article of articles) {
    if (article?.category) counts.set(article.category, (counts.get(article.category) || 0) + 1);
    if (article?.url) seenUrls.add(String(article.url).split("#", 1)[0]);
  }
  const missing = new Set(SITE_CATEGORIES.filter((category) => (counts.get(category) || 0) < TARGET_PER_CATEGORY));
  const feeds = FALLBACK_FEEDS.filter((feed) => missing.has(feed.category));
  if (!feeds.length) return [];
  const results = await Promise.all(feeds.map(async (feed) => {
    try {
      const response = await fetch(feed.url, { headers: {
        "User-Agent": "Mozilla/5.0 (compatible; NazuafNewsBot/1.3; +https://nazuaf.com)",
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.8"
      }, signal: AbortSignal.timeout(7000) });
      if (!response.ok) throw new Error("HTTP " + response.status);
      return { feed, articles: parseFallbackFeed((await response.text()).slice(0, 1000000), feed) };
    } catch (error) {
      console.warn("Fallback RSS failed:", feed.source, feed.category, String(error?.message || error));
      return { feed, articles: [] };
    }
  }));
  const byCategory = new Map(SITE_CATEGORIES.map((category) => [category, []]));
  for (const result of results) byCategory.get(result.feed.category).push(...result.articles);
  const extra = [];
  for (const category of missing) {
    const candidates = (byCategory.get(category) || []).sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
    let count = counts.get(category) || 0;
    for (const article of candidates) {
      if (count >= TARGET_PER_CATEGORY) break;
      if (seenUrls.has(article.url)) continue;
      seenUrls.add(article.url);
      extra.push(article);
      count++;
    }
    if (count < TARGET_PER_CATEGORY) console.warn("Category remains below target after fallback RSS:", category, count + "/" + TARGET_PER_CATEGORY);
  }
  return extra;
}
async function readNewsSnapshot(env) {
  if (!env.NEWS_CACHE) return null;
  try {
    const object = await env.NEWS_CACHE.get(NEWS_SNAPSHOT_KEY);
    if (!object) return null;
    const snapshot = JSON.parse(await object.text());
    if (snapshot?.version !== 1 || !Array.isArray(snapshot.articles) || !Array.isArray(snapshot.categories) || !snapshot.byCategory || typeof snapshot.byCategory !== "object") return null;
    return snapshot;
  } catch (error) {
    console.warn("Could not read Nazuaf News R2 snapshot:", String(error?.message || error));
    return null;
  }
}
async function rebuildNewsSnapshot(env) {
  if (!env.NEWS_CACHE) return null;
  const cutoff = new Date(Date.now() - SNAPSHOT_MAX_AGE_DAYS * DAY_MS).toISOString();
  const upperBound = new Date(Date.now() + DAY_MS).toISOString();
  const categoryResult = await env.DB.prepare(
    "SELECT category, COUNT(*) AS count FROM articles WHERE published_at >= ? AND published_at <= ? GROUP BY category ORDER BY count DESC"
  ).bind(cutoff, upperBound).all();
  const categories = categoryResult.results || [];
  const latestResult = await env.DB.prepare(
    `SELECT ${ARTICLE_COLUMNS} FROM articles WHERE published_at >= ? AND published_at <= ? ORDER BY published_at DESC, id DESC LIMIT ?`
  ).bind(cutoff, upperBound, GLOBAL_SNAPSHOT_LIMIT).all();
  const byCategory = Object.create(null);
  for (const category of SITE_CATEGORIES) {
    const result = await env.DB.prepare(
      `SELECT ${ARTICLE_COLUMNS} FROM articles WHERE category = ? AND published_at >= ? AND published_at <= ? ORDER BY published_at DESC, id DESC LIMIT ?`
    ).bind(category, cutoff, upperBound, CATEGORY_SNAPSHOT_LIMIT).all();
    byCategory[category] = result.results || [];
  }
  const categoryCounts = new Map(categories.map((item) => [String(item.category || ""), Number(item.count) || 0]));
  const publicCategories = SITE_CATEGORIES.map((category) => ({ category, count: categoryCounts.get(category) || 0 })).sort((a, b) => b.count - a.count);
  const snapshot = {
    version: 1,
    snapshot_schema_version: 2,
    freshness_window_days: SNAPSHOT_MAX_AGE_DAYS,
    generated_at: new Date().toISOString(),
    articles: latestResult.results || [],
    categories: publicCategories,
    byCategory
  };
  await env.NEWS_CACHE.put(NEWS_SNAPSHOT_KEY, JSON.stringify(snapshot), {
    httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl: "no-cache" }
  });
  return snapshot;
}
async function ensureOptimizedIndexes(env) {
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_articles_title_source ON articles(title, source)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_articles_published_id ON articles(published_at DESC, id DESC)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_articles_category_published_id ON articles(category, published_at DESC, id DESC)").run();
}
async function ensureBodyColumns(env) {
  // Pertahanan: kalau migrasi kolom belum jalan di DB ini, tambahkan di sini.
  try {
    const info = await env.DB.prepare("PRAGMA table_info(articles)").all();
    const cols = new Set((info.results || []).map((r) => r.name));
    if (!cols.has("body_status")) await env.DB.prepare("ALTER TABLE articles ADD COLUMN body_status TEXT NOT NULL DEFAULT 'pending'").run();
    if (!cols.has("body_scraped_at")) await env.DB.prepare("ALTER TABLE articles ADD COLUMN body_scraped_at TEXT").run();
    if (!cols.has("body_error")) await env.DB.prepare("ALTER TABLE articles ADD COLUMN body_error TEXT").run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_articles_body_pending ON articles(body_status, published_at DESC, id DESC)").run();
  } catch (e) {
    console.warn("ensureBodyColumns:", String(e?.message || e));
  }
}
function cleanDescription(value) {
  let text = String(value ?? "");
  for (let i = 0; i < 3; i++) {
    const decoded = text.replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#0*39;/gi, "'").replace(/&#x0*27;/gi, "'").replace(/&amp;/gi, "&");
    if (decoded === text) break;
    text = decoded;
  }
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*(?:>|$)/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
  const lower = text.toLowerCase();
  if (lower.includes("comprehensive up-to-date news coverage") || lower.includes("aggregated from sources all over the world by google news")) return "";
  return text;
}
function escHtml(v) {
  return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function timeAgoId(value) {
  const t = Date.parse(value || "");
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  if (diff < 0) return "baru saja";
  const m = Math.floor(diff / 60000);
  if (m < 1) return "baru saja";
  if (m < 60) return m + " menit lalu";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " jam lalu";
  const d = Math.floor(h / 24);
  if (d < 7) return d + " hari lalu";
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium" }).format(new Date(t));
}
function fmtDateId(value) {
  const t = Date.parse(value || "");
  if (!Number.isFinite(t)) return String(value || "");
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "full", timeStyle: "short" }).format(new Date(t));
}

// ================= Ekstraksi isi artikel =================
function decodeHtmlEntities(s) {
  let t = String(s || "");
  t = t.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; } });
  t = t.replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch { return ""; } });
  return t.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&#0*39;/g, "'").replace(/&#x0*27;/gi, "'");
}
function stripTags(s) {
  return String(s || "").replace(/<[^>]*>/g, " ");
}
const JUNK_PARA_RE = /^(baca juga|simak juga|lihat juga|baca:|simak:|iklan|advertisement|download aplikasi|langganan|berlangganan|editor\s*:|penulis\s*:|reporter\s*:|sumber\s*:|foto\s*:|ilustrasi|all rights reserved|hak cipta)/i;
const JUNK_CONTAINS_RE = /(baca juga:|simak juga:|download aplikasi|all rights reserved|hak cipta dilindungi|langganan kompas|untuk membaca artikel ini|silakan login|dapatkan akses)/i;

function cleanParagraphs(rawList) {
  const out = [];
  const seen = new Set();
  for (const raw of rawList) {
    let text = decodeHtmlEntities(stripTags(raw)).replace(/\s+/g, " ").trim();
    if (!text || text.length < 40) continue;
    if (JUNK_PARA_RE.test(text) || JUNK_CONTAINS_RE.test(text)) continue;
    const linkTextLen = [...String(raw).matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)]
      .map((m) => stripTags(m[1]).trim().length).reduce((a, b) => a + b, 0);
    if (text.length > 0 && linkTextLen / text.length > 0.5) continue;
    const key = text.slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= MAX_PARAGRAPHS) break;
  }
  return out;
}

function extractFromJsonLd(html) {
  // Banyak portal Indonesia (CNN, detik, Kompas, Liputan6, dll) menyertakan
  // NewsArticle JSON-LD berisi articleBody utuh — jalur paling bersih.
  const scripts = [...String(html).matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)];
  for (const m of scripts) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const nodes = Array.isArray(data) ? data : (data && data["@graph"] ? data["@graph"] : [data]);
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const type = String(node["@type"] || "");
      const body = node.articleBody;
      if (/Article/.test(type) && typeof body === "string" && body.trim().length >= 500) {
        const parts = body.split(/\n+/).map((p) => p.trim()).filter((p) => p.length >= 40 && !JUNK_PARA_RE.test(p) && !JUNK_CONTAINS_RE.test(p));
        if (parts.length >= 3) return { paragraphs: parts.slice(0, MAX_PARAGRAPHS), author: extractAuthorFromJsonLd(node) };
      }
    }
  }
  return null;
}
function extractAuthorFromJsonLd(node) {
  const a = node.author;
  if (!a) return "";
  if (typeof a === "string") return a.slice(0, 120);
  if (typeof a === "object" && a.name) return String(a.name).slice(0, 120);
  if (Array.isArray(a) && a[0]?.name) return String(a[0].name).slice(0, 120);
  return "";
}
function extractAuthorMeta(html) {
  const m = String(html).match(/<meta[^>]+(?:name|property)=["'](?:author|article:author)["'][^>]+content=["']([^"']+)["']/i)
    || String(html).match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:author|article:author)["']/i);
  return m ? decodeHtmlEntities(m[1]).trim().slice(0, 120) : "";
}

function extractArticleBody(html, url) {
  const raw = String(html || "").slice(0, MAX_HTML_BYTES);
  let author = extractAuthorMeta(raw);
  const viaJsonLd = extractFromJsonLd(raw);
  if (viaJsonLd) {
    if (!author && viaJsonLd.author) author = viaJsonLd.author;
    const chars = viaJsonLd.paragraphs.join("\n").length;
    if (chars >= 500) return { paragraphs: viaJsonLd.paragraphs, author, chars };
  }
  // Jalur generik: batasi ke <article> bila ada, buang blok non-konten,
  // lalu ambil paragraf <p> yang lolos filter.
  let scope = raw;
  const art = raw.match(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/i);
  if (art && (art[1].match(/<p\b/gi) || []).length >= 3) scope = art[1];
  scope = scope
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|iframe|svg|form|button|nav|header|footer|aside|figure|figcaption)[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*(?:class|id)=["'][^"']*(share|related|rekomendasi|baca-juga|sidebar|comment|newsletter|ads|iklan|popup|breadcrumb|author-box|tag-list|social|video-player)[^"']*["'][^>]*>[\s\S]*?<\/\w+\s*>/gi, " ");
  let paras = cleanParagraphs([...scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)].map((m) => m[1]));
  if (paras.length < 3) {
    // Fallback: teks blok — pecah berdasarkan <br>, </div>, </li>, </h2>.
    const text = scope
      .replace(/<(br\s*\/?|\/div|\/li|\/h2|\/blockquote)>/gi, "\n")
      .replace(/<[^>]*>/g, " ");
    paras = cleanParagraphs(decodeHtmlEntities(text).split(/\n+/).map((l) => l.trim()).filter(Boolean));
  }
  const chars = paras.join("\n").length;
  if (paras.length < 3 || chars < 500) return null;
  return { paragraphs: paras, author, chars };
}

async function getBody(env, id) {
  if (!env.NEWS_CACHE) return null;
  try {
    const obj = await env.NEWS_CACHE.get(BODY_PREFIX + id + ".json");
    if (!obj) return null;
    const body = JSON.parse(await obj.text());
    if (!body || !Array.isArray(body.paragraphs) || !body.paragraphs.length) return null;
    return body;
  } catch {
    return null;
  }
}

async function scrapeOne(env, article) {
  const id = article.id;
  const started = Date.now();
  const fail = async (msg) => {
    const short = String(msg || "gagal").slice(0, 200);
    try {
      await env.DB.prepare("UPDATE articles SET body_status='failed', body_scraped_at=?, body_error=? WHERE id=?")
        .bind(new Date().toISOString(), short, id).run();
    } catch {}
    return { ok: false, id, error: short, ms: Date.now() - started };
  };
  try {
    const res = await fetch(article.url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(SCRAPE_FETCH_TIMEOUT_MS)
    });
    if (!res.ok) return fail("HTTP " + res.status);
    const ct = res.headers.get("content-type") || "";
    if (ct && !/text\/html|application\/xhtml/i.test(ct)) return fail("bukan HTML: " + ct.split(";")[0]);
    const html = (await res.text()).slice(0, MAX_HTML_BYTES);
    const extracted = extractArticleBody(html, article.url);
    if (!extracted) return fail("isi tidak ditemukan");
    const scrapedAt = new Date().toISOString();
    const body = {
      v: 1, id, url: article.url, source: article.source, title: article.title,
      category: article.category, author: extracted.author || null,
      published_at: article.published_at, scraped_at: scrapedAt,
      chars: extracted.chars, paragraphs: extracted.paragraphs
    };
    const bodyJson = JSON.stringify(body);
    if (bodyJson.length > MAX_BODY_BYTES) return fail("isi terlalu besar");
    await env.NEWS_CACHE.put(BODY_PREFIX + id + ".json", bodyJson, {
      httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl: "public, max-age=3600" }
    });
    await env.DB.prepare("UPDATE articles SET body_status='done', body_scraped_at=?, body_error=NULL WHERE id=?")
      .bind(scrapedAt, id).run();
    return { ok: true, id, chars: extracted.chars, ms: Date.now() - started };
  } catch (e) {
    return fail(String(e?.message || e));
  }
}

async function scrapePending(env, limit) {
  await ensureBodyColumns(env);
  const cutoff = new Date(Date.now() - SCRAPE_WINDOW_DAYS * DAY_MS).toISOString();
  const retryCutoff = new Date(Date.now() - SCRAPE_RETRY_AFTER_HOURS * 60 * 60 * 1000).toISOString();
  const rows = await env.DB.prepare(
    "SELECT id,title,url,source,category,published_at FROM articles WHERE body_status='pending' AND published_at>=? ORDER BY published_at DESC, id DESC LIMIT ?"
  ).bind(cutoff, limit).all();
  let list = rows.results || [];
  if (list.length < limit) {
    const retry = await env.DB.prepare(
      "SELECT id,title,url,source,category,published_at FROM articles WHERE body_status='failed' AND published_at>=? AND (body_scraped_at IS NULL OR body_scraped_at<=?) ORDER BY published_at DESC, id DESC LIMIT ?"
    ).bind(cutoff, retryCutoff, limit - list.length).all();
    list = list.concat(retry.results || []);
  }
  const results = [];
  for (const a of list) results.push(await scrapeOne(env, a));
  return {
    attempted: list.length,
    done: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    details: results
  };
}

// ================= Handler =================
function isAuthorized(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (env.INGEST_TOKEN && auth === "Bearer " + env.INGEST_TOKEN) return true;
  if (env.SCRAPE_TOKEN && auth === "Bearer " + env.SCRAPE_TOKEN) return true;
  return false;
}

const worker = {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      scrapePending(env, SCRAPE_BATCH_SCHEDULED).catch((e) =>
        console.warn("scheduled scrape:", String(e?.message || e)))
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    if (url.pathname === "/api/health") {
      const snapshot = await readNewsSnapshot(env);
      if (!snapshot) return snapshotUnavailable();
      const freshArticles = (snapshot.articles || []).filter((article) => isRecentArticle(article));
      const generatedAt = Date.parse(snapshot.generated_at || "");
      const ageSeconds = Number.isFinite(generatedAt) ? Math.max(0, Math.floor((Date.now() - generatedAt) / 1000)) : null;
      let bodyStats = null;
      try {
        const cutoff = new Date(Date.now() - SCRAPE_WINDOW_DAYS * DAY_MS).toISOString();
        const r = await env.DB.prepare(
          "SELECT body_status, COUNT(*) AS c FROM articles WHERE published_at>=? GROUP BY body_status"
        ).bind(cutoff).all();
        bodyStats = Object.fromEntries((r.results || []).map((x) => [x.body_status, x.c]));
      } catch {}
      return json({
        ok: true,
        snapshot_exists: true,
        generated_at: snapshot.generated_at || null,
        age_seconds: ageSeconds,
        stale: ageSeconds === null || ageSeconds > 6 * 60 * 60,
        freshness_window_days: SNAPSHOT_MAX_AGE_DAYS,
        articles_available: freshArticles.length,
        newest_published_at: freshArticles[0]?.published_at || null,
        categories: snapshotCategories(snapshot),
        bodies_last_3d: bodyStats
      }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/api/ingest") {
      if (request.method !== "POST") return json({ ok: false, error: "Method Not Allowed" }, 405);
      if (!isAuthorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }
      const articles = Array.isArray(body?.articles) ? body.articles.slice(0, 500) : [];
      const fresh = articles.filter((article) => isRecentArticle(article));
      const rejectedStale = articles.length - fresh.length;
      const valid = fresh.filter((a) => a?.title && a?.url);
      const fallbackArticles = await supplementMissingCategories(valid);
      valid.push(...fallbackArticles);
      let updated = 0, added = 0;
      try {
        await ensureOptimizedIndexes(env);
      } catch (e) {
        return json({ ok: false, error: "D1 index optimization failed", detail: String(e?.message || e) }, 500);
      }
      const updates = valid.map((a) => {
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
      } catch (e) {
        return json({ ok: false, error: "D1 update failed", detail: String(e?.message || e) }, 500);
      }
      const inserts = valid.map((a) => env.DB.prepare(`
        INSERT OR IGNORE INTO articles (title,url,source,category,description,image_url,published_at)
        VALUES (?,?,?,?,?,?,?)
      `).bind(
        String(a.title).slice(0, 500),
        String(a.url).slice(0, 2000),
        String(a.source || "Unknown").slice(0, 120),
        String(a.category || "Berita").slice(0, 80),
        a.description ? cleanDescription(a.description) || null : null,
        a.image_url ? String(a.image_url).slice(0, 2000) : null,
        a.published_at ? String(a.published_at).slice(0, 100) : null
      ));
      try {
        for (let i = 0; i < inserts.length; i += 400) {
          const res = await env.DB.batch(inserts.slice(i, i + 400));
          added += res.reduce((n, r) => n + (r.meta?.changes || 0), 0);
        }
        await env.DB.prepare(`
          DELETE FROM articles
          WHERE category = 'Berita'
            AND id NOT IN (
              SELECT id FROM articles WHERE category = 'Berita'
              ORDER BY published_at DESC, id DESC
              LIMIT 1000
            )
        `).run();
      } catch (e) {
        return json({ ok: false, error: "D1 insert/retention cleanup failed", detail: String(e?.message || e) }, 500);
      }
      let snapshotUpdated = false;
      if (env.NEWS_CACHE) {
        try {
          await rebuildNewsSnapshot(env);
          snapshotUpdated = true;
        } catch (e) {
          return json({ ok: false, database_saved: true, error: "D1 updated but R2 news snapshot refresh failed", detail: String(e?.message || e) }, 500);
        }
      }
      try {
        if (ctx?.cache?.purge) {
          const purgeResult = await ctx.cache.purge({ tags: ["news-articles", "news-categories"] });
          if (purgeResult?.success === false) console.warn("Cache purge returned an unsuccessful result:", purgeResult.errors || []);
        }
      } catch (e) {
        console.warn("Cache purge after ingest failed:", String(e?.message || e));
      }
      // Isi penuh artikel yang baru masuk di-scrape di latar belakang.
      try { ctx.waitUntil(scrapePending(env, SCRAPE_BATCH_INGEST).catch(() => {})); } catch {}
      return json({
        ok: true,
        received: articles.length,
        valid: valid.length,
        fallback_added: fallbackArticles.length,
        rejected_stale_or_undated: rejectedStale,
        updated,
        added,
        with_images: valid.filter((a) => a.image_url).length,
        snapshot_updated: snapshotUpdated,
        updated_at: new Date().toISOString()
      });
    }

    if (url.pathname === "/api/scrape") {
      if (request.method !== "POST") return json({ ok: false, error: "Method Not Allowed" }, 405);
      if (!isAuthorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
      let limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || SCRAPE_BATCH_SCHEDULED, 1), 50);
      let ids = null;
      try {
        const b = await request.json().catch(() => null);
        if (b) {
          if (Number(b.limit)) limit = Math.min(Math.max(Number(b.limit), 1), 50);
          if (Array.isArray(b.ids)) ids = b.ids.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, 50);
        }
      } catch {}
      if (ids && ids.length) {
        const results = [];
        for (const id of ids) {
          const row = await env.DB.prepare(
            "SELECT id,title,url,source,category,published_at FROM articles WHERE id=?"
          ).bind(id).first();
          if (!row) { results.push({ ok: false, id, error: "tidak ditemukan di D1" }); continue; }
          results.push(await scrapeOne(env, row));
        }
        return json({ ok: true, mode: "ids", attempted: results.length, done: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, details: results });
      }
      const summary = await scrapePending(env, limit);
      return json({ ok: true, mode: "pending", limit, ...summary });
    }

    if (url.pathname === "/api/refresh") {
      return json({ ok: false, manual: true, message: "Feed fetching is handled by GitHub Actions. Run the Update Nazuaf News workflow for a manual refresh." }, 202, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/api/articles") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 24, 1), 100);
      const offsetValue = Number(url.searchParams.get("offset")) || 0;
      const offset = Math.min(Math.max(offsetValue, 0), 1000000);
      const category = url.searchParams.get("category");
      const snapshot = await readNewsSnapshot(env);
      if (!snapshot) return snapshotUnavailable();
      const collection = category ? snapshot.byCategory && snapshot.byCategory[category] || [] : snapshot.articles;
      const results = collection.filter((article) => isRecentArticle(article)).slice(offset, offset + limit);
      return json({
        ok: true,
        articles: results.map((a) => ({ ...a, description: cleanDescription(a.description) || null })),
        limit,
        offset,
        snapshot_generated_at: snapshot.generated_at || null
      }, 200, apiCacheHeaders("news-articles", 120));
    }

    if (url.pathname === "/api/categories") {
      const snapshot = await readNewsSnapshot(env);
      if (!snapshot) return snapshotUnavailable();
      return json(
        { ok: true, categories: snapshotCategories(snapshot), snapshot_generated_at: snapshot.generated_at || null },
        200,
        apiCacheHeaders("news-categories", 300)
      );
    }

    const articleMatch = url.pathname.match(/^\/api\/article\/(\d+)$/);
    if (articleMatch) {
      const id = Number(articleMatch[1]);
      const row = await env.DB.prepare(
        `SELECT ${ARTICLE_COLUMNS}, body_status, body_scraped_at FROM articles WHERE id=?`
      ).bind(id).first();
      if (!row) return json({ ok: false, error: "Artikel tidak ditemukan" }, 404);
      let body = null;
      if (row.body_status === "done") body = await getBody(env, id);
      if (!body && row.body_status !== "done") {
        try { ctx.waitUntil(scrapeOne(env, row).catch(() => {})); } catch {}
      }
      return json({
        ok: true,
        id,
        has_body: !!body,
        body_status: body ? "done" : row.body_status,
        article: { id: row.id, title: row.title, url: row.url, source: row.source, category: row.category, description: row.description, image_url: row.image_url, published_at: row.published_at },
        body
      }, 200, apiCacheHeaders("news-article", 300));
    }

    const siteName = env.SITE_NAME || "Nazuaf News";

    const readMatch = url.pathname.match(/^\/(?:baca|artikel)\/(\d+)\/?$/);
    if (readMatch) {
      const id = Number(readMatch[1]);
      let row = null;
      try {
        row = await env.DB.prepare(
          `SELECT ${ARTICLE_COLUMNS}, body_status, body_scraped_at FROM articles WHERE id=?`
        ).bind(id).first();
      } catch (e) {
        return new Response(readerErrorHtml(siteName, "Database tidak bisa dibaca saat ini."), { status: 500, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders } });
      }
      if (!row) {
        return new Response(readerErrorHtml(siteName, "Artikel tidak ditemukan."), { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders } });
      }
      let body = null;
      if (row.body_status === "done") body = await getBody(env, id);
      if (!body && row.body_status !== "done") {
        try { ctx.waitUntil(scrapeOne(env, row).catch(() => {})); } catch {}
      }
      let related = [];
      try {
        const snapshot = await readNewsSnapshot(env);
        related = ((snapshot?.byCategory?.[row.category]) || []).filter((a) => a.id !== id).slice(0, 4);
      } catch {}
      return new Response(readerHtml(siteName, row, body, related), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60, s-maxage=300", ...corsHeaders }
      });
    }

    return new Response(homeHtml(siteName), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders }
    });
  }
};

export default worker;

// ================= Tema portal berita =================
const PORTAL_CSS = `
:root{color-scheme:light;--red:#d8232a;--red-dark:#b01b21;--ink:#111827;--dark:#0f172a;--muted:#6b7280;--faint:#9ca3af;--line:#e5e7eb;--bg:#f4f4f2;--card:#ffffff;--shadow:0 10px 30px rgba(17,24,39,.07)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
a{color:inherit;text-decoration:none}button,input{font:inherit}.container{width:min(1180px,calc(100% - 28px));margin:auto}
.topbar{background:var(--dark);color:#cbd5e1;font-size:12px}.topbar .container{display:flex;justify-content:space-between;gap:12px;padding:8px 0}.topbar a{color:#fff;font-weight:600}.topbar a:hover{color:#fca5a5}
.masthead{background:#fff;border-bottom:1px solid var(--line)}.masthead .container{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:20px 0 16px;flex-wrap:wrap}
.logo{font-family:"Plus Jakarta Sans",Inter,system-ui,sans-serif;font-size:34px;font-weight:800;letter-spacing:-1.5px;line-height:1}.logo .red{color:var(--red)}
.tagline{color:var(--muted);margin:6px 0 0;font-size:13px}
.search-box{flex:0 1 340px;min-width:220px}.search-box input{width:100%;background:#f9fafb;border:1px solid var(--line);border-radius:999px;padding:11px 16px;outline:none;font-size:14px}.search-box input:focus{border-color:var(--red);background:#fff}
.mainnav{background:var(--ink);position:sticky;top:0;z-index:50;box-shadow:0 4px 14px rgba(0,0,0,.18)}.mainnav .container{display:flex;overflow-x:auto;scrollbar-width:none}.mainnav .container::-webkit-scrollbar{display:none}
.navlink{white-space:nowrap;color:#e5e7eb;padding:13px 15px;font-size:13.5px;font-weight:600;cursor:pointer;border:0;background:none}.navlink:hover{color:#fff;background:rgba(255,255,255,.08)}.navlink.active{background:var(--red);color:#fff}.navlink .count{opacity:.75;font-weight:400;font-size:12px}
.ticker{background:#fff;border-bottom:1px solid var(--line);overflow:hidden}.ticker .container{display:flex;align-items:center;gap:0;padding:0}
.ticker-label{background:var(--red);color:#fff;font-weight:800;font-size:12px;letter-spacing:1px;padding:9px 12px;flex-shrink:0}
.ticker-viewport{overflow:hidden;flex:1}.ticker-track{display:inline-flex;white-space:nowrap;animation:ticker 55s linear infinite;padding:9px 0}.ticker-viewport:hover .ticker-track{animation-play-state:paused}
.ticker-item{font-size:13px;margin-right:42px;color:#374151}.ticker-item:hover{color:var(--red)}.ticker-item b{color:var(--red);margin-right:6px}
@keyframes ticker{from{transform:translateX(0)}to{transform:translateX(-50%)}}
main{padding:8px 0 50px}
.hero{display:grid;grid-template-columns:1.9fr 1fr;gap:18px;margin:22px 0 30px}
.hero-main{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:var(--shadow);display:flex;flex-direction:column}
.hero-main img{width:100%;aspect-ratio:16/9;object-fit:cover;background:#e5e7eb}
.hero-main .hero-body{padding:20px 22px 22px}.hero-main h2{font-family:"Plus Jakarta Sans",Inter,sans-serif;font-size:26px;line-height:1.3;margin:10px 0;font-weight:800}.hero-main h2 a:hover{color:var(--red)}
.hero-side{display:flex;flex-direction:column;gap:12px}
.hero-item{display:flex;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:10px;box-shadow:var(--shadow);flex:1;min-height:0}
.hero-item img{width:104px;height:78px;object-fit:cover;border-radius:10px;flex-shrink:0;background:#e5e7eb}
.hero-item h3{font-size:14.5px;line-height:1.35;margin:4px 0 6px;font-weight:700}.hero-item h3 a:hover{color:var(--red)}
.badge{display:inline-block;color:#fff;font-size:11px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;padding:4px 9px;border-radius:999px}
.src{font-size:12px;font-weight:700}.meta{color:var(--faint);font-size:12px}.excerpt{color:var(--muted);font-size:14px;line-height:1.55;margin:0}
.sec-head{display:flex;align-items:center;gap:10px;margin:6px 0 16px}.sec-bar{width:5px;height:22px;background:var(--red);border-radius:2px}.sec-head h2{font-family:"Plus Jakarta Sans",Inter,sans-serif;font-size:20px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;margin:0}
.status{color:var(--muted);font-size:13px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden;display:flex;flex-direction:column;min-width:0;box-shadow:var(--shadow);transition:transform .2s ease,box-shadow .2s ease;position:relative}
.card:hover{transform:translateY(-3px);box-shadow:0 16px 36px rgba(17,24,39,.12)}
.card .thumb-wrap{position:relative}.card .thumb,.card .noimg{width:100%;aspect-ratio:16/9;object-fit:cover;background:#e5e7eb;display:block}
.card .noimg{background:linear-gradient(135deg,#f3f4f6,#e5e7eb);display:grid;place-items:center;color:#9ca3af;font-size:13px;font-weight:700}
.card .badge{position:absolute;top:10px;left:10px;box-shadow:0 2px 8px rgba(0,0,0,.25)}
.card-body{padding:16px 16px 14px;display:flex;flex-direction:column;flex:1}
.card-top{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:8px}
.card h2,.card .title{font-family:"Plus Jakarta Sans",Inter,sans-serif;font-size:17px;line-height:1.35;margin:0 0 9px;font-weight:700}.card h2 a:hover{color:var(--red)}
.card .desc{color:var(--muted);font-size:13.5px;line-height:1.55;margin:0 0 14px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.card-foot{margin-top:auto;display:flex;justify-content:space-between;align-items:center;gap:10px;border-top:1px solid var(--line);padding-top:12px}
.btn-read{color:var(--red);font-size:13px;font-weight:800}.btn-read:hover{text-decoration:underline}
.btn-source{color:var(--faint);font-size:12.5px;font-weight:600}.btn-source:hover{color:var(--ink)}
.empty{padding:50px 20px;text-align:center;color:var(--muted);background:#fff;border:1px solid var(--line);border-radius:16px}
.more-wrap{text-align:center;margin-top:26px}
.more{border:1px solid var(--ink);background:var(--ink);color:#fff;padding:12px 26px;border-radius:999px;cursor:pointer;font-weight:700}.more:hover{background:var(--red);border-color:var(--red)}.more:disabled{opacity:.5;cursor:default}
footer{background:var(--dark);color:#94a3b8;padding:38px 0 30px;margin-top:10px}
footer .cols{display:grid;grid-template-columns:2fr 1fr 1fr;gap:26px}
footer h4{color:#fff;margin:0 0 12px;font-size:15px}footer p,footer li{font-size:13px;line-height:1.7;margin:0}footer ul{list-style:none;padding:0;margin:0}footer li{margin-bottom:7px}footer a{color:#cbd5e1}footer a:hover{color:#fff}
footer .fine{border-top:1px solid #1e293b;margin-top:28px;padding-top:18px;font-size:12px;line-height:1.7}
/* Halaman baca */
.crumbs{font-size:13px;color:var(--muted);margin:20px 0 14px}.crumbs a:hover{color:var(--red)}
.article-wrap{max-width:780px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);padding:30px 34px 34px}
.article-wrap h1{font-family:"Plus Jakarta Sans",Inter,sans-serif;font-size:32px;line-height:1.25;font-weight:800;margin:12px 0 14px}
.byline{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;color:var(--muted);font-size:13.5px;border-bottom:1px solid var(--line);padding-bottom:16px;margin-bottom:20px}
.byline .src{font-size:13.5px}
.article-hero{width:100%;border-radius:14px;margin:0 0 22px;object-fit:cover;max-height:440px}
.article-body p{font-size:18px;line-height:1.85;color:#1f2937;margin:0 0 18px}
.article-body p:first-of-type::first-letter{font-size:54px;line-height:.9;float:left;padding:4px 10px 0 0;font-weight:800;color:var(--red);font-family:"Plus Jakarta Sans",Inter,sans-serif}
.article-body h2{font-family:"Plus Jakarta Sans",Inter,sans-serif;font-size:21px;margin:26px 0 12px}
.source-box{border-left:4px solid var(--red);background:#fef2f2;border-radius:10px;padding:16px 18px;margin:26px 0 6px;font-size:14px;line-height:1.6;color:#7f1d1d}
.source-box a{font-weight:800;color:var(--red)}
.notice-box{border-left:4px solid #f59e0b;background:#fffbeb;border-radius:10px;padding:16px 18px;margin:20px 0;font-size:14.5px;line-height:1.65;color:#78350f}
.related{margin-top:34px}.related .grid{grid-template-columns:repeat(2,minmax(0,1fr))}
@media(max-width:900px){.hero{grid-template-columns:1fr}.hero-side{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}footer .cols{grid-template-columns:1fr 1fr}}
@media(max-width:600px){.logo{font-size:28px}.masthead .container{padding:16px 0 12px}.hero-main h2{font-size:22px}.grid{grid-template-columns:1fr}.hero-side{grid-template-columns:1fr}.article-wrap{padding:22px 18px}.article-wrap h1{font-size:25px}.article-body p{font-size:17px}.related .grid{grid-template-columns:1fr}footer .cols{grid-template-columns:1fr}.ticker-item{margin-right:28px}}
`;

function homeHtml(siteName) {
  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="theme-color" content="#0f172a">
<meta name="description" content="Nazuaf News - agregator berita Indonesia. Baca ringkasan dan isi penuh berita dari berbagai sumber dalam satu tempat."><title>${escHtml(siteName)} - Berita Indonesia Terkini</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=Plus+Jakarta+Sans:wght@700;800&display=swap" rel="stylesheet">
<style>${PORTAL_CSS}</style></head><body>
<div class="topbar"><div class="container"><span id="today"></span><span><a href="https://nazuaf.com">nazuaf.com</a> &nbsp;&middot;&nbsp; <a href="https://m.nazuaf.com">m.nazuaf.com</a></span></div></div>
<header class="masthead"><div class="container"><div><div class="logo"><a href="/">NAZUAF <span class="red">NEWS</span></a></div>
<div class="tagline">Berita Indonesia, dikumpulkan dalam satu tempat.</div></div>
<div class="search-box"><input id="search" type="search" placeholder="Cari berita..." autocomplete="off"></div></div></header>
<nav class="mainnav"><div class="container" id="categories"></div></nav>
<div class="ticker"><div class="container"><span class="ticker-label">TERKINI</span><div class="ticker-viewport"><div class="ticker-track" id="ticker"></div></div></div></div>
<main class="container"><div id="hero"></div>
<div class="sec-head"><span class="sec-bar"></span><h2 id="sec-title">Berita Terbaru</h2></div>
<div id="status" class="status">Memuat berita...</div><div id="news" class="grid"></div><div id="empty" class="empty" hidden>Tidak ada berita yang cocok.</div>
<div class="more-wrap"><button id="more" class="more">Muat lebih banyak</button></div></main>
<footer><div class="container"><div class="cols"><div><h4>NAZUAF NEWS</h4><p>Agregator berita Indonesia. Judul, ringkasan, dan isi berita dikumpulkan dari berbagai media nasional dan ditampilkan sebagai arsip baca.</p></div>
<div><h4>Kategori</h4><ul id="foot-cats"></ul></div>
<div><h4>Tautan</h4><ul><li><a href="https://nazuaf.com">Blog nazuaf.com</a></li><li><a href="https://m.nazuaf.com">m.nazuaf.com</a></li><li><a href="/">Beranda Berita</a></li></ul></div></div>
<div class="fine">Seluruh isi berita adalah milik media penerbit masing-masing. Nazuaf News hanya mengumpulkan dan menampilkan kembali sebagai arsip baca beserta tautan ke sumber aslinya.</div></div></footer>
<script>
(function(){var CAT_COLORS={"Berita":"#6b7280","Bisnis":"#047857","Nasional":"#d8232a","Teknologi":"#1d4ed8","Sains":"#6d28d9","Gaming":"#7c3aed","Olahraga":"#ea580c","Hiburan":"#db2777","Kesehatan":"#0d9488"};
var s={category:"",search:"",offset:0,loading:false,done:false,all:[],heroBuilt:false},size=24;
var news=document.getElementById("news"),empty=document.getElementById("empty"),status=document.getElementById("status"),more=document.getElementById("more"),cats=document.getElementById("categories"),search=document.getElementById("search"),hero=document.getElementById("hero"),ticker=document.getElementById("ticker"),secTitle=document.getElementById("sec-title");
function esc(v){return String(v==null?"":v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")}
function ago(v){if(!v)return"";var t=new Date(v).getTime(),d=Date.now()-t;if(isNaN(t)||d<0)return"baru saja";var m=Math.floor(d/60000);if(m<1)return"baru saja";if(m<60)return m+" menit lalu";var h=Math.floor(m/60);if(h<24)return h+" jam lalu";var dd=Math.floor(h/24);if(dd<7)return dd+" hari lalu";return new Intl.DateTimeFormat("id-ID",{dateStyle:"medium"}).format(new Date(t))}
function color(c){return CAT_COLORS[c]||"#6b7280"}
function thumb(a){return a.image_url?'<img class="thumb" loading="lazy" referrerpolicy="no-referrer" src="'+esc(String(a.image_url).replace(/^http:/,"https:"))+'" alt="" onerror="this.remove()">':'<div class="noimg">Nazuaf News</div>'}
function cardHtml(a){return '<article class="card"><div class="thumb-wrap">'+thumb(a)+'<span class="badge" style="background:'+color(a.category)+'">'+esc(a.category||"Berita")+'</span></div><div class="card-body"><div class="card-top"><span class="src">'+esc(a.source||"Berita")+'</span><span class="meta">'+esc(ago(a.published_at))+'</span></div><h2><a href="/baca/'+a.id+'">'+esc(a.title)+'</a></h2>'+(a.description?'<p class="desc">'+esc(a.description)+'</p>':'')+'<div class="card-foot"><a class="btn-read" href="/baca/'+a.id+'">Baca di Nazuaf &rarr;</a><a class="btn-source" href="'+esc(a.url)+'" target="_blank" rel="noopener noreferrer">Sumber &nearr;</a></div></div></article>'}
function buildHero(){if(s.heroBuilt||s.category||s.search||s.all.length<5)return;s.heroBuilt=true;var h=s.all.slice(0,5),main=h[0];
hero.innerHTML='<section class="hero"><article class="hero-main">'+(main.image_url?'<a href="/baca/'+main.id+'"><img loading="eager" referrerpolicy="no-referrer" src="'+esc(String(main.image_url).replace(/^http:/,"https:"))+'" alt="" onerror="this.remove()"></a>':'')+'<div class="hero-body"><span class="badge" style="background:'+color(main.category)+'">'+esc(main.category||"Berita")+'</span><h2><a href="/baca/'+main.id+'">'+esc(main.title)+'</a></h2>'+(main.description?'<p class="excerpt">'+esc(main.description)+'</p>':'')+'<div class="meta" style="margin-top:12px">'+esc(main.source||"Berita")+' &middot; '+esc(ago(main.published_at))+'</div></div></article><div class="hero-side">'+h.slice(1).map(function(a){return '<article class="hero-item">'+(a.image_url?'<a href="/baca/'+a.id+'"><img loading="lazy" referrerpolicy="no-referrer" src="'+esc(String(a.image_url).replace(/^http:/,"https:"))+'" alt="" onerror="this.remove()"></a>':'')+'<div><span class="src" style="color:'+color(a.category)+'">'+esc(a.source||"Berita")+'</span><h3><a href="/baca/'+a.id+'">'+esc(a.title)+'</a></h3><div class="meta">'+esc(ago(a.published_at))+'</div></div></article>'}).join("")+'</div></section>'}
function buildTicker(){if(!s.all.length)return;var items=s.all.slice(0,10).map(function(a){return '<a class="ticker-item" href="/baca/'+a.id+'"><b>&bull;</b>'+esc(a.title)+'</a>'}).join("");ticker.innerHTML=items+items}
function render(){var items=s.all.filter(function(a){return !s.search||((a.title||"")+" "+(a.description||"")+" "+(a.source||"")).toLowerCase().indexOf(s.search)>=0});
buildHero();buildTicker();
var gridItems=(s.heroBuilt&&!s.category&&!s.search)?items.slice(5):items;
empty.hidden=gridItems.length!==0;news.innerHTML=gridItems.map(cardHtml).join("");
status.textContent=items.length+" berita ditampilkan";more.disabled=s.loading||s.done;more.textContent=s.done?"Semua berita sudah dimuat":s.loading?"Memuat...":"Muat lebih banyak";
secTitle.textContent=s.category?s.category:"Berita Terbaru"}
async function load(reset){if(s.loading)return;if(reset){s.offset=0;s.done=false;s.all=[];s.heroBuilt=false;hero.innerHTML="";news.innerHTML=""}if(s.done)return;s.loading=true;render();try{var p=new URLSearchParams({limit:String(size),offset:String(s.offset)});if(s.category)p.set("category",s.category);var r=await fetch("/api/articles?"+p);if(!r.ok)throw Error("HTTP "+r.status);var d=await r.json(),a=Array.isArray(d.articles)?d.articles:[];s.all=reset?a:s.all.concat(a);s.offset+=a.length;if(a.length<size)s.done=true}catch(e){status.textContent="Gagal memuat berita. Coba lagi.";console.error(e)}finally{s.loading=false;render()}}
async function loadCats(){try{var r=await fetch("/api/categories");if(!r.ok)throw Error("HTTP "+r.status);var d=await r.json(),a=Array.isArray(d.categories)?d.categories:[];cats.innerHTML='<button class="navlink active" data-category="">Semua</button>'+a.map(function(x){return '<button class="navlink" data-category="'+esc(x.category)+'">'+esc(x.category)+' <span class="count">('+esc(x.count)+')</span></button>'}).join("");
document.getElementById("foot-cats").innerHTML=a.map(function(x){return '<li><a href="/?cat='+encodeURIComponent(x.category)+'">'+esc(x.category)+'</a></li>'}).join("");
cats.addEventListener("click",function(e){var b=e.target.closest(".navlink");if(!b)return;s.category=b.getAttribute("data-category")||"";cats.querySelectorAll(".navlink").forEach(function(x){x.classList.remove("active")});b.classList.add("active");var u=new URL(location.href);if(s.category)u.searchParams.set("cat",s.category);else u.searchParams.delete("cat");history.replaceState(null,"",u);load(true)})}catch(e){cats.innerHTML='<button class="navlink active">Semua</button>';console.error(e)}}
var timer;search.addEventListener("input",function(){clearTimeout(timer);timer=setTimeout(function(){s.search=search.value.trim().toLowerCase();render()},120)});more.addEventListener("click",function(){load(false)});
var q=new URLSearchParams(location.search);if(q.get("cat")){s.category=q.get("cat")}if(q.get("q")){s.search=q.get("q").toLowerCase();search.value=q.get("q")}
document.getElementById("today").textContent=new Intl.DateTimeFormat("id-ID",{weekday:"long",day:"numeric",month:"long",year:"numeric"}).format(new Date());
loadCats();load(true)})();
</script></body></html>`;
}

function readerHtml(siteName, row, body, related) {
  const catColor = CATEGORY_COLORS[row.category] || "#6b7280";
  const img = row.image_url
    ? '<img class="article-hero" referrerpolicy="no-referrer" src="' + escHtml(String(row.image_url).replace(/^http:/, "https:")) + '" alt="" onerror="this.remove()">'
    : "";
  const byline = '<div class="byline"><span class="src">' + escHtml(row.source || "Berita") + '</span><span>' + escHtml(fmtDateId(row.published_at)) + '</span>'
    + (body?.author ? "<span>Penulis: " + escHtml(body.author) + "</span>" : "")
    + (body ? "<span>Arsip dibaca " + escHtml(timeAgoId(body.scraped_at)) + "</span>" : "") + "</div>";
  let content;
  if (body) {
    const paras = body.paragraphs.map((p) => "<p>" + escHtml(p) + "</p>").join("");
    content = '<div class="article-body">' + paras + "</div>"
      + '<div class="source-box">Artikel ini milik <b>' + escHtml(row.source || "media penerbit") + "</b> dan ditampilkan di sini sebagai arsip baca. "
      + 'Baca versi asli di situs sumber: <a href="' + escHtml(row.url) + '" target="_blank" rel="noopener noreferrer">' + escHtml(row.url) + "</a></div>";
  } else {
    content = '<div class="notice-box"><b>Isi penuh artikel ini belum tersimpan.</b><br>'
      + "Scraper sedang mengambil isi dari situs sumber — coba buka halaman ini lagi sebentar lagi. Sementara itu, kamu bisa membaca langsung di situs sumbernya.</div>"
      + (row.description ? '<div class="article-body"><p>' + escHtml(row.description) + "</p></div>" : "")
      + '<div class="source-box">Baca artikel lengkap di situs sumber: <a href="' + escHtml(row.url) + '" target="_blank" rel="noopener noreferrer">' + escHtml(row.url) + "</a></div>";
  }
  const relatedHtml = related.length
    ? '<section class="related"><div class="sec-head"><span class="sec-bar"></span><h2>Baca Juga</h2></div><div class="grid">'
      + related.map((a) => {
          const color = CATEGORY_COLORS[a.category] || "#6b7280";
          const th = a.image_url
            ? '<img class="thumb" loading="lazy" referrerpolicy="no-referrer" src="' + escHtml(String(a.image_url).replace(/^http:/, "https:")) + '" alt="" onerror="this.remove()">'
            : '<div class="noimg">Nazuaf News</div>';
          return '<article class="card"><div class="thumb-wrap">' + th + '<span class="badge" style="background:' + color + '">' + escHtml(a.category || "Berita") + '</span></div>'
            + '<div class="card-body"><div class="card-top"><span class="src">' + escHtml(a.source || "Berita") + '</span><span class="meta">' + escHtml(timeAgoId(a.published_at)) + '</span></div>'
            + '<h2><a href="/baca/' + a.id + '">' + escHtml(a.title) + "</a></h2>"
            + '<div class="card-foot"><a class="btn-read" href="/baca/' + a.id + '">Baca di Nazuaf &rarr;</a><a class="btn-source" href="' + escHtml(a.url) + '" target="_blank" rel="noopener noreferrer">Sumber &nearr;</a></div></div></article>';
        }).join("") + "</div></section>"
    : "";
  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="theme-color" content="#0f172a">
<meta name="description" content="${escHtml(row.description || row.title)}"><title>${escHtml(row.title)} - ${escHtml(siteName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=Plus+Jakarta+Sans:wght@700;800&display=swap" rel="stylesheet">
<style>${PORTAL_CSS}</style></head><body>
<div class="topbar"><div class="container"><span>${escHtml(fmtDateId(row.published_at))}</span><span><a href="https://nazuaf.com">nazuaf.com</a> &nbsp;&middot;&nbsp; <a href="https://m.nazuaf.com">m.nazuaf.com</a></span></div></div>
<header class="masthead"><div class="container"><div><div class="logo"><a href="/">NAZUAF <span class="red">NEWS</span></a></div>
<div class="tagline">Berita Indonesia, dikumpulkan dalam satu tempat.</div></div></div></header>
<nav class="mainnav"><div class="container"><a class="navlink" href="/">Semua</a><a class="navlink" href="/?cat=Nasional">Nasional</a><a class="navlink" href="/?cat=Bisnis">Bisnis</a><a class="navlink" href="/?cat=Teknologi">Teknologi</a><a class="navlink" href="/?cat=Olahraga">Olahraga</a><a class="navlink" href="/?cat=Hiburan">Hiburan</a><a class="navlink" href="/?cat=Kesehatan">Kesehatan</a><a class="navlink" href="/?cat=Gaming">Gaming</a><a class="navlink" href="/?cat=Sains">Sains</a></div></nav>
<main class="container"><div class="crumbs"><a href="/">Beranda</a> &nbsp;/&nbsp; <a href="/?cat=${encodeURIComponent(row.category || "Berita")}">${escHtml(row.category || "Berita")}</a> &nbsp;/&nbsp; ${escHtml(row.source || "Berita")}</div>
<article class="article-wrap"><span class="badge" style="background:${catColor}">${escHtml(row.category || "Berita")}</span>
<h1>${escHtml(row.title)}</h1>${byline}${img}${content}</article>${relatedHtml}</main>
<footer><div class="container"><div class="cols"><div><h4>NAZUAF NEWS</h4><p>Agregator berita Indonesia. Judul, ringkasan, dan isi berita dikumpulkan dari berbagai media nasional dan ditampilkan sebagai arsip baca.</p></div>
<div><h4>Kategori</h4><ul><li><a href="/?cat=Nasional">Nasional</a></li><li><a href="/?cat=Bisnis">Bisnis</a></li><li><a href="/?cat=Teknologi">Teknologi</a></li><li><a href="/?cat=Olahraga">Olahraga</a></li></ul></div>
<div><h4>Tautan</h4><ul><li><a href="https://nazuaf.com">Blog nazuaf.com</a></li><li><a href="https://m.nazuaf.com">m.nazuaf.com</a></li><li><a href="/">Beranda Berita</a></li></ul></div></div>
<div class="fine">Seluruh isi berita adalah milik media penerbit masing-masing. Nazuaf News hanya mengumpulkan dan menampilkan kembali sebagai arsip baca beserta tautan ke sumber aslinya.</div></div></footer>
</body></html>`;
}

function readerErrorHtml(siteName, message) {
  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(siteName)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=Plus+Jakarta+Sans:wght@700;800&display=swap" rel="stylesheet">
<style>${PORTAL_CSS}</style></head><body>
<header class="masthead"><div class="container"><div><div class="logo"><a href="/">NAZUAF <span class="red">NEWS</span></a></div></div></div></header>
<main class="container"><div class="empty" style="margin-top:30px"><h2 style="margin:0 0 10px">Ups.</h2><p>${escHtml(message)}</p><p><a href="/" style="color:var(--red);font-weight:700">&larr; Kembali ke Beranda</a></p></div></main>
</body></html>`;
}
