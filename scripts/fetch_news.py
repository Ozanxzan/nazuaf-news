#!/usr/bin/env python3
import concurrent.futures, html, json, os, re, urllib.parse, urllib.request
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from email.utils import parsedate_to_datetime

INGEST_URL = os.environ.get("NEWS_INGEST_URL")
TOKEN = os.environ.get("NEWS_INGEST_TOKEN")
FEEDS = [
    ("ANTARA", "site:antaranews.com"), ("CNN Indonesia", "site:cnnindonesia.com"),
    ("CNBC Indonesia", "site:cnbcindonesia.com"), ("Kompas.com", "site:kompas.com"),
    ("detikcom", "site:detik.com"), ("Tempo.co", "site:tempo.co"),
    ("Liputan6", "site:liputan6.com"), ("Tirto.id", "site:tirto.id"),
    ("Suara.com", "site:suara.com"), ("Republika", "site:republika.co.id"),
    ("Teknologi", "teknologi AI gadget Indonesia"), ("Gaming", "gaming game Indonesia"),
    ("Sains", "sains teknologi Indonesia"),
]
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; NazuafNewsBot/1.0; +https://news.nazuaf.com)",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

def clean_html(value):
    value = html.unescape(value or "")
    return re.sub(r"\\s+", " ", re.sub(r"<[^>]+>", " ", value)).strip()

class MetaParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta, self.json_ld, self.in_json = {}, [], False
        self.script = []
    def handle_starttag(self, tag, attrs):
        a = {str(k).lower(): (v or "") for k, v in attrs}
        if tag == "meta":
            key = (a.get("property") or a.get("name") or "").lower()
            if key and a.get("content") and key not in self.meta:
                self.meta[key] = a["content"].strip()
        if tag == "script" and "ld+json" in a.get("type", "").lower():
            self.in_json, self.script = True, []
    def handle_data(self, data):
        if self.in_json: self.script.append(data)
    def handle_endtag(self, tag):
        if tag == "script" and self.in_json:
            self.json_ld.append("".join(self.script))
            self.in_json, self.script = False, []

def find_json_image(value):
    if isinstance(value, str):
        return value if value.startswith(("https://", "http://", "/")) else None
    if isinstance(value, list):
        for v in value:
            found = find_json_image(v)
            if found: return found
    if isinstance(value, dict):
        for key in ("image", "thumbnailUrl", "contentUrl"):
            if key in value:
                found = find_json_image(value[key])
                if found: return found
        for v in value.values():
            if isinstance(v, (dict, list)):
                found = find_json_image(v)
                if found: return found
    return None

def metadata(document, base_url):
    p = MetaParser()
    try: p.feed(document)
    except Exception: pass
    image = (p.meta.get("og:image:secure_url") or p.meta.get("og:image")
             or p.meta.get("twitter:image") or p.meta.get("twitter:image:src"))
    desc = p.meta.get("og:description") or p.meta.get("twitter:description")
    if not image:
        for block in p.json_ld:
            try:
                image = find_json_image(json.loads(block))
                if image: break
            except Exception: pass
    if image:
        image = urllib.parse.urljoin(base_url, html.unescape(image).strip())
        if not image.startswith(("https://", "http://")): image = None
    return image, clean_html(desc)[:500] if desc else None

def fetch_bytes(url, timeout=12):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.geturl(), r.read()

def first_text(elem, names):
    for name in names:
        child = elem.find(name)
        if child is not None and child.text: return child.text.strip()
    return ""

def parse_date(value):
    if not value: return None
    try: return parsedate_to_datetime(value).isoformat()
    except Exception: return value

def parse_feed(data, source, category):
    root = ET.fromstring(data)
    items = root.findall(".//item") or root.findall(".//{http://www.w3.org/2005/Atom}entry")
    out = []
    for item in items[:30]:
        title = first_text(item, ["title", "{http://www.w3.org/2005/Atom}title"])
        link = first_text(item, ["link", "{http://www.w3.org/2005/Atom}link"])
        if not link:
            node = item.find("{http://www.w3.org/2005/Atom}link")
            if node is not None: link = node.attrib.get("href", "")
        published = first_text(item, ["pubDate", "published", "updated",
            "{http://www.w3.org/2005/Atom}published", "{http://www.w3.org/2005/Atom}updated"])
        if not title or not link: continue
        original_url = html.unescape(link)[:2000]
        out.append({"title": clean_html(title)[:500], "url": original_url,
            # Required by the Worker to update the matching D1 row.
            "google_url": original_url, "source": source, "category": category,
            "description": None, "image_url": None, "published_at": parse_date(published)})
    return out

def resolve_article(article):
    try:
        final_url, data = fetch_bytes(article["url"], 12)
        if not final_url.startswith(("http://", "https://")): return article
        image, desc = metadata(data[:1500000].decode("utf-8", "ignore"), final_url)
        if image: article["image_url"] = image[:2000]
        if desc: article["description"] = desc
        article["publisher_url"] = final_url[:2000]
    except Exception as e:
        article["resolve_error"] = str(e)[:200]
    return article

def main():
    if not INGEST_URL or not TOKEN:
        print("Missing NEWS_INGEST_URL or NEWS_INGEST_TOKEN"); return 2
    articles, seen, failures = [], set(), 0
    for source, query in FEEDS:
        rss = "https://news.google.com/rss/search?" + urllib.parse.urlencode({
            "q": query + " when:7d", "hl": "id", "gl": "ID", "ceid": "ID:id"})
        try:
            category = source if source in {"Teknologi", "Gaming", "Sains"} else "Berita"
            for a in parse_feed(fetch_bytes(rss, 20)[1], source, category):
                if a["url"] not in seen: seen.add(a["url"]); articles.append(a)
        except Exception as e:
            failures += 1; print(f"FAILED FEED {source}: {e}")
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        articles = list(pool.map(resolve_article, articles[:500]))
    articles.sort(key=lambda a: (a.get("published_at") or "", a.get("title") or ""), reverse=True)
    articles = articles[:500]
    images = sum(bool(a.get("image_url")) for a in articles)
    resolved = sum(bool(a.get("publisher_url")) for a in articles)
    errors = sum(bool(a.get("resolve_error")) for a in articles)
    body = json.dumps({"articles": articles}, ensure_ascii=False).encode()
    req = urllib.request.Request(INGEST_URL, data=body, method="POST", headers={
        **HEADERS, "Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=45) as r: print("INGEST:", r.read().decode())
    except Exception as e:
        print(f"INGEST FAILED: {e}"); return 1
    print(f"Fetched {len(articles)} articles; {images} image URLs; {resolved} publisher URLs; "
          f"{errors} article fetch failures; {failures}/{len(FEEDS)} feeds failed.")
    return 0 if articles or failures < len(FEEDS) else 1

if __name__ == "__main__":
    raise SystemExit(main())
