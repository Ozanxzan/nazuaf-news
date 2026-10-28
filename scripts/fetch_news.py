#!/usr/bin/env python3
"""Fetch Indonesian publisher RSS feeds and ingest articles into Nazuaf News."""
import concurrent.futures
import email.utils
import html
import json
import os
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from html.parser import HTMLParser

INGEST_URL = os.environ.get("NEWS_INGEST_URL")
TOKEN = os.environ.get("NEWS_INGEST_TOKEN")
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; NazuafNewsBot/1.2; +https://nazuaf.com)",
    "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.8",
}
CATEGORIES = ["Berita", "Bisnis", "Nasional", "Teknologi", "Sains", "Gaming", "Olahraga", "Hiburan", "Kesehatan"]
PER_CATEGORY_LIMIT = max(1, min(100, int(os.environ.get("NEWS_PER_CATEGORY_LIMIT", "20"))))

# Keep feeds grouped by the intended site category. Sources are independent: a feed
# failure is logged but does not prevent other categories from being ingested.
FEEDS = [
    # Berita umum
    ("ANTARA", "Berita", "https://www.antaranews.com/rss/terkini.xml"),
    ("ANTARA", "Berita", "https://www.antaranews.com/rss/top-news.xml"),
    ("CNN Indonesia", "Berita", "https://www.cnnindonesia.com/rss"),
    ("CNBC Indonesia", "Berita", "https://www.cnbcindonesia.com/news/rss"),
    ("Kompas.com", "Berita", "https://rss.kompas.com/api/feed/social?apikey=bc58c81819dff4b8d5c53540a2fc7ffd83e6314a"),
    ("detikcom", "Berita", "https://news.detik.com/berita/rss"),
    ("Liputan6", "Berita", "https://feed.liputan6.com/rss/news"),
    ("Suara.com", "Berita", "https://www.suara.com/rss/news"),
    ("Media Indonesia", "Berita", "https://mediaindonesia.com/feed"),
    ("Kumparan", "Berita", "https://lapi.kumparan.com/v2.0/rss/"),
    ("CNA Indonesia", "Berita", "https://www.cna.id/api/v1/rss-outbound-feed?_format=xml"),

    # Bisnis
    ("ANTARA", "Bisnis", "https://www.antaranews.com/rss/ekonomi.xml"),
    ("ANTARA", "Bisnis", "https://www.antaranews.com/rss/ekonomi-bisnis.xml"),
    ("ANTARA", "Bisnis", "https://www.antaranews.com/rss/ekonomi-finansial.xml"),
    ("CNN Indonesia", "Bisnis", "https://www.cnnindonesia.com/ekonomi/rss"),
    ("CNBC Indonesia", "Bisnis", "https://www.cnbcindonesia.com/market/rss/"),
    ("detikFinance", "Bisnis", "https://finance.detik.com/rss"),
    ("Tempo.co", "Bisnis", "https://rss.tempo.co/bisnis"),
    ("Suara.com", "Bisnis", "https://www.suara.com/rss/bisnis"),
    ("Republika", "Bisnis", "https://www.republika.co.id/rss/ekonomi/"),
    ("Kontan", "Bisnis", "https://rss.kontan.co.id/news/keuangan"),
    ("JawaPos", "Bisnis", "https://www.jawapos.com/ekonomi/rss"),
    ("CNA Indonesia", "Bisnis", "https://www.cna.id/api/v1/rss-outbound-feed?_format=xml&category=3321"),

    # Nasional
    ("ANTARA", "Nasional", "https://www.antaranews.com/rss/politik.xml"),
    ("CNN Indonesia", "Nasional", "https://www.cnnindonesia.com/nasional/rss"),
    ("Tempo.co", "Nasional", "https://rss.tempo.co/nasional"),
    ("Republika", "Nasional", "https://www.republika.co.id/rss/nasional/"),
    ("Kontan", "Nasional", "https://rss.kontan.co.id/news/nasional"),
    ("JawaPos", "Nasional", "https://www.jawapos.com/nasional/rss"),

    # Teknologi
    ("ANTARA", "Teknologi", "https://www.antaranews.com/rss/tekno.xml"),
    ("CNN Indonesia", "Teknologi", "https://www.cnnindonesia.com/teknologi/rss"),
    ("detikINET", "Teknologi", "https://inet.detik.com/rss"),

    # Sains
    ("Kompas.com Sains", "Sains", "https://sains.kompas.com/rss"),
    ("ANTARA Humaniora", "Sains", "https://www.antaranews.com/rss/humaniora.xml"),
    ("ANTARA Warta Bumi", "Sains", "https://www.antaranews.com/rss/warta-bumi.xml"),

    # Gaming
    ("Gamebrott", "Gaming", "https://gamebrott.com/feed/"),

    # Olahraga
    ("ANTARA", "Olahraga", "https://www.antaranews.com/rss/olahraga.xml"),
    ("ANTARA Sepakbola", "Olahraga", "https://www.antaranews.com/rss/sepakbola.xml"),
    ("CNA Indonesia", "Olahraga", "https://www.cna.id/api/v1/rss-outbound-feed?_format=xml&category=3246"),

    # Hiburan
    ("ANTARA", "Hiburan", "https://www.antaranews.com/rss/hiburan.xml"),
    ("CNN Indonesia", "Hiburan", "https://www.cnnindonesia.com/hiburan/rss"),

    # Kesehatan
    ("Kementerian Kesehatan", "Kesehatan", "https://kemkes.go.id/id/rss/article/rilis-berita"),
    ("Kementerian Kesehatan", "Kesehatan", "https://kemkes.go.id/id/rss/article/artikel-kesehatan"),
    ("Kementerian Kesehatan", "Kesehatan", "https://kemkes.go.id/id/rss/article/tips-kesehatan"),
]

def clean_html(value):
    value = html.unescape(value or "")
    value = re.sub(r"(?is)<(script|style)\b[^>]*>.*?</\1>", " ", value)
    value = re.sub(r"(?i)<img\b[^>]*>", " ", value)
    return re.sub(r"<[^>]+>", " ", value).strip()

def normalize_date(value):
    if not value:
        return None
    try:
        d = email.utils.parsedate_to_datetime(value)
    except Exception:
        try:
            d = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except Exception:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

def fetch_bytes(url, timeout=18):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.geturl(), response.read()

def child_text(item, names):
    for name in names:
        node = item.find(name)
        if node is not None and node.text and node.text.strip():
            return node.text.strip()
    return ""

def get_link(item):
    link = child_text(item, ["link", "{http://www.w3.org/2005/Atom}link"])
    if link:
        return link
    for node in list(item):
        if node.tag.endswith("}link") or node.tag == "link":
            href = node.attrib.get("href")
            if href and node.attrib.get("rel", "alternate") in ("alternate", ""):
                return href
    guid = child_text(item, ["guid", "{http://www.w3.org/2005/Atom}id"])
    return guid if guid.startswith(("http://", "https://")) else ""

def normalize_image(value, base):
    if not value:
        return None
    value = html.unescape(value.strip())
    if value.startswith("//"):
        value = "https:" + value
    value = urllib.parse.urljoin(base, value)
    if value.startswith("http://"):
        value = "https://" + value[7:]
    return value[:2000] if value.startswith("https://") else None

def item_image(item, base):
    for node in item.iter():
        tag = node.tag.lower()
        if tag.endswith("}thumbnail") or tag.endswith("}content") or tag.endswith("}image") or tag.endswith("enclosure"):
            candidate = node.attrib.get("url") or node.attrib.get("href")
            mime = node.attrib.get("type", "")
            if candidate and ("image" in mime.lower() or tag.endswith(("thumbnail", "}content", "}image", "enclosure"))):
                found = normalize_image(candidate, base)
                if found:
                    return found
    for name in ("description", "{http://purl.org/rss/1.0/modules/content/}encoded",
                 "content", "{http://www.w3.org/2005/Atom}content", "{http://www.w3.org/2005/Atom}summary"):
        node = item.find(name)
        if node is not None and node.text:
            match = re.search(r"<img\b[^>]*\bsrc=[\"']([^\"']+)", html.unescape(node.text), re.I)
            if match:
                return normalize_image(match.group(1), base)
    return None

class MetadataParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta = {}
    def handle_starttag(self, tag, attrs):
        if tag != "meta":
            return
        attrs = {k.lower(): (v or "") for k, v in attrs}
        key = (attrs.get("property") or attrs.get("name") or "").lower()
        if key and attrs.get("content") and key not in self.meta:
            self.meta[key] = attrs["content"].strip()

def resolve_article(article):
    try:
        final_url, data = fetch_bytes(article["url"], 10)
        parser = MetadataParser()
        parser.feed(data[:1200000].decode("utf-8", "ignore"))
        image = parser.meta.get("og:image:secure_url") or parser.meta.get("og:image") or parser.meta.get("twitter:image")
        if image and not article.get("image_url"):
            article["image_url"] = normalize_image(image, final_url)
        desc = parser.meta.get("og:description") or parser.meta.get("twitter:description")
        if desc and not article.get("description"):
            article["description"] = clean_html(desc)[:500] or None
    except Exception as exc:
        article["resolve_error"] = str(exc)[:160]
    return article

def parse_feed(data, source, category, feed_url):
    root = ET.fromstring(data)
    items = root.findall(".//item") or root.findall(".//{http://www.w3.org/2005/Atom}entry")
    result = []
    for item in items[:60]:
        title = child_text(item, ["title", "{http://www.w3.org/2005/Atom}title"])
        link = get_link(item)
        if not title or not link or not link.startswith(("http://", "https://")):
            continue
        published = child_text(item, ["pubDate", "published", "updated", "date",
            "{http://www.w3.org/2005/Atom}published", "{http://www.w3.org/2005/Atom}updated",
            "{http://purl.org/dc/elements/1.1/}date"])
        desc = child_text(item, ["description", "{http://www.w3.org/2005/Atom}summary",
            "{http://www.w3.org/2005/Atom}content", "{http://purl.org/rss/1.0/modules/content/}encoded"])
        result.append({
            "title": clean_html(title)[:500],
            "url": html.unescape(link.strip()).split("#", 1)[0][:2000],
            "source": source, "category": category,
            "description": clean_html(desc)[:500] or None,
            "image_url": item_image(item, link) or item_image(item, feed_url),
            "published_at": normalize_date(published),
        })
    return result

def main():
    if not INGEST_URL or not TOKEN:
        print("Missing NEWS_INGEST_URL or NEWS_INGEST_TOKEN")
        return 2

    grouped = {category: [] for category in CATEGORIES}
    seen_in_category = {category: set() for category in CATEGORIES}
    failures = []
    for source, category, feed_url in FEEDS:
        try:
            _, data = fetch_bytes(feed_url, 20)
            parsed = parse_feed(data, source, category, feed_url)
            added = 0
            for article in parsed:
                url = article["url"]
                if url and url not in seen_in_category[category]:
                    seen_in_category[category].add(url)
                    grouped[category].append(article)
                    added += 1
            print(f"FEED OK: {source} [{category}] -> {len(parsed)} items, {added} unique for category")
        except Exception as exc:
            failures.append((source, feed_url, str(exc)[:180]))
            print(f"FAILED FEED: {source} [{category}] {feed_url}: {exc}")

    # Prefer category-specific queues before general news so a story exposed by both
    # a specialist feed and a general feed remains in the specialist category.
    priority = [c for c in CATEGORIES if c != "Berita"] + ["Berita"]
    for category in CATEGORIES:
        grouped[category].sort(
            key=lambda a: (a.get("published_at") or "", a.get("title") or ""), reverse=True
        )

    articles, seen_globally, category_counts = [], set(), {}
    for category in priority:
        selected = []
        for article in grouped[category]:
            url = article["url"]
            if url in seen_globally:
                continue
            seen_globally.add(url)
            selected.append(article)
            if len(selected) >= PER_CATEGORY_LIMIT:
                break
        articles.extend(selected)
        category_counts[category] = len(selected)
        print(f"CATEGORY TARGET: {category} -> {len(selected)}/{PER_CATEGORY_LIMIT} articles")

    if not articles:
        print("No valid articles found; ingest skipped.")
        return 1

    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        articles = list(pool.map(resolve_article, articles))
    articles.sort(key=lambda a: (a.get("published_at") or "", a.get("title") or ""), reverse=True)
    payload = json.dumps({"articles": articles}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(INGEST_URL, data=payload, method="POST",
        headers={**HEADERS, "Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            print("INGEST:", response.read().decode("utf-8", "replace"))
    except Exception as exc:
        print(f"INGEST FAILED: {exc}")
        return 1

    under_target = {c: count for c, count in category_counts.items() if count < PER_CATEGORY_LIMIT}
    print(f"Fetched {len(articles)} unique articles across {len(CATEGORIES)} categories; feeds failed: {len(failures)}/{len(FEEDS)}.")
    if under_target:
        print("CATEGORY UNDER TARGET (not enough distinct items available in current feeds): " + ", ".join(f"{c}={n}/{PER_CATEGORY_LIMIT}" for c, n in under_target.items()))
    return 0 if len(failures) < len(FEEDS) else 1

if __name__ == "__main__":
    raise SystemExit(main())
