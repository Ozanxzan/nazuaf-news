#!/usr/bin/env python3
"""Fetch Indonesian news directly from publisher RSS feeds and ingest into Nazuaf News."""
import concurrent.futures
import html
import json
import os
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from email.utils import parsedate_to_datetime

INGEST_URL = os.environ.get("NEWS_INGEST_URL")
TOKEN = os.environ.get("NEWS_INGEST_TOKEN")
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; NazuafNewsBot/1.1; +https://nazuaf.com)",
    "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8",
}

# Direct publisher RSS feeds. No Google News RSS/search URLs are used.
# Individual feeds may change or be temporarily unavailable; failures are logged and skipped.
FEEDS = [
    ("ANTARA", "Berita", "https://www.antaranews.com/rss/terkini.xml"),
    ("ANTARA", "Berita", "https://www.antaranews.com/rss/top-news.xml"),
    ("ANTARA", "Nasional", "https://www.antaranews.com/rss/politik.xml"),
    ("ANTARA", "Bisnis", "https://www.antaranews.com/rss/ekonomi.xml"),
    ("ANTARA", "Teknologi", "https://www.antaranews.com/rss/tekno.xml"),
    ("CNN Indonesia", "Berita", "https://www.cnnindonesia.com/rss"),
    ("CNN Indonesia", "Nasional", "https://www.cnnindonesia.com/nasional/rss"),
    ("CNN Indonesia", "Bisnis", "https://www.cnnindonesia.com/ekonomi/rss"),
    ("CNBC Indonesia", "Berita", "https://www.cnbcindonesia.com/news/rss"),
    ("CNBC Indonesia", "Bisnis", "https://www.cnbcindonesia.com/market/rss/"),
    ("Kompas.com", "Berita", "https://rss.kompas.com/api/feed/social?apikey=bc58c81819dff4b8d5c53540a2fc7ffd83e6314a"),
    ("detikcom", "Berita", "https://news.detik.com/berita/rss"),
    ("detikFinance", "Bisnis", "https://finance.detik.com/rss"),
    ("Tempo.co", "Nasional", "https://rss.tempo.co/nasional"),
    ("Tempo.co", "Bisnis", "https://rss.tempo.co/bisnis"),
    ("Liputan6", "Berita", "https://feed.liputan6.com/rss/news"),
    ("Suara.com", "Berita", "https://www.suara.com/rss/news"),
    ("Suara.com", "Bisnis", "https://www.suara.com/rss/bisnis"),
    ("Republika", "Nasional", "https://www.republika.co.id/rss/nasional/"),
    ("Republika", "Bisnis", "https://www.republika.co.id/rss/ekonomi/"),
    ("Kontan", "Bisnis", "https://rss.kontan.co.id/news/keuangan"),
    ("Kontan", "Nasional", "https://rss.kontan.co.id/news/nasional"),
    ("Media Indonesia", "Berita", "https://mediaindonesia.com/feed"),
    ("JawaPos", "Nasional", "https://www.jawapos.com/nasional/rss"),
    ("JawaPos", "Bisnis", "https://www.jawapos.com/ekonomi/rss"),
    ("Kumparan", "Berita", "https://lapi.kumparan.com/v2.0/rss/"),
    ("CNA Indonesia", "Berita", "https://www.cna.id/api/v1/rss-outbound-feed?_format=xml"),
]


def clean_html(value):
    value = html.unescape(value or "")
    value = re.sub(r"(?is)<(script|style)\b[^>]*>.*?</\1>", " ", value)
    value = re.sub(r"(?i)<img\b[^>]*>", " ", value)
    value = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", value).strip()


class MetaParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta = {}
        self.json_ld = []
        self.in_json = False
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
        if self.in_json:
            self.script.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self.in_json:
            self.json_ld.append("".join(self.script))
            self.in_json, self.script = False, []


def find_json_image(value):
    if isinstance(value, str):
        return value if value.startswith(("https://", "http://", "//", "/")) else None
    if isinstance(value, list):
        for v in value:
            found = find_json_image(v)
            if found:
                return found
    if isinstance(value, dict):
        for key in ("image", "thumbnailUrl", "contentUrl", "url"):
            if key in value:
                found = find_json_image(value[key])
                if found:
                    return found
        for v in value.values():
            if isinstance(v, (dict, list)):
                found = find_json_image(v)
                if found:
                    return found
    return None


def normalize_image(value, base_url):
    if not value:
        return None
    value = html.unescape(value.strip())
    if value.startswith("//"):
        value = "https:" + value
    value = urllib.parse.urljoin(base_url, value)
    if value.startswith("http://"):
        value = "https://" + value[len("http://"):]
    return value[:2000] if value.startswith("https://") else None


def first_child_text(item, names):
    for name in names:
        node = item.find(name)
        if node is not None and node.text and node.text.strip():
            return node.text.strip()
    return ""


def get_link(item):
    link = first_child_text(item, ["link", "{http://www.w3.org/2005/Atom}link"])
    if link:
        return link
    for node in list(item):
        if node.tag.endswith("}link") or node.tag == "link":
            href = node.attrib.get("href")
            if href and node.attrib.get("rel", "alternate") in ("alternate", "" ):
                return href
    guid = first_child_text(item, ["guid", "{http://www.w3.org/2005/Atom}id"])
    return guid if guid.startswith(("http://", "https://")) else ""


def get_item_image(item, base_url):
    # Common RSS media namespaces and enclosure attributes.
    for node in item.iter():
        tag = node.tag.lower()
        if tag.endswith("}thumbnail") or tag.endswith("}content") or tag.endswith("}image") or tag.endswith("enclosure"):
            candidate = node.attrib.get("url") or node.attrib.get("href")
            mime = node.attrib.get("type", "")
            if candidate and ("image" in mime.lower() or tag.endswith("thumbnail") or tag.endswith("}content") or tag.endswith("}image") or tag.endswith("enclosure")):
                result = normalize_image(candidate, base_url)
                if result:
                    return result
    # Some feeds embed an image in the description/content HTML.
    for name in ("description", "{http://purl.org/rss/1.0/modules/content/}encoded", "content", "{http://www.w3.org/2005/Atom}content", "{http://www.w3.org/2005/Atom}summary"):
        node = item.find(name)
        if node is not None and node.text:
            match = re.search(r"<img\b[^>]*\bsrc=[\"']([^\"']+)", html.unescape(node.text), re.I)
            if match:
                result = normalize_image(match.group(1), base_url)
                if result:
                    return result
    return None


def parse_date(value):
    if not value:
        return None
    try:
        return parsedate_to_datetime(value).isoformat()
    except Exception:
        return value[:100]


def fetch_bytes(url, timeout=18):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.geturl(), response.read()


def parse_feed(data, source, category, feed_url):
    root = ET.fromstring(data)
    items = root.findall(".//item")
    if not items:
        items = root.findall(".//{http://www.w3.org/2005/Atom}entry")
    out = []
    for item in items[:60]:
        title = first_child_text(item, ["title", "{http://www.w3.org/2005/Atom}title"])
        link = get_link(item)
        if not title or not link or not link.startswith(("http://", "https://")):
            continue
        published = first_child_text(item, [
            "pubDate", "published", "updated", "date",
            "{http://www.w3.org/2005/Atom}published",
            "{http://www.w3.org/2005/Atom}updated",
            "{http://purl.org/dc/elements/1.1/}date",
        ])
        desc = first_child_text(item, [
            "description", "{http://www.w3.org/2005/Atom}summary",
            "{http://www.w3.org/2005/Atom}content",
            "{http://purl.org/rss/1.0/modules/content/}encoded",
        ])
        image = get_item_image(item, link) or get_item_image(item, feed_url)
        out.append({
            "title": clean_html(title)[:500],
            "url": html.unescape(link.strip())[:2000],
            "source": source,
            "category": category,
            "description": clean_html(desc)[:500] or None,
            "image_url": image,
            "published_at": parse_date(published),
        })
    return out


def resolve_article(article):
    # Direct RSS image first; publisher page metadata is a fallback.
    try:
        final_url, data = fetch_bytes(article["url"], 12)
        if final_url.startswith(("https://", "http://")):
            parser = MetaParser()
            try:
                parser.feed(data[:1500000].decode("utf-8", "ignore"))
            except Exception:
                pass
            image = (parser.meta.get("og:image:secure_url") or parser.meta.get("og:image")
                     or parser.meta.get("twitter:image") or parser.meta.get("twitter:image:src"))
            if not image:
                for block in parser.json_ld:
                    try:
                        image = find_json_image(json.loads(block))
                        if image:
                            break
                    except Exception:
                        continue
            image = normalize_image(image, final_url)
            if image and not article.get("image_url"):
                article["image_url"] = image
            desc = parser.meta.get("og:description") or parser.meta.get("twitter:description")
            if desc and not article.get("description"):
                cleaned = clean_html(desc)[:500]
                if cleaned:
                    article["description"] = cleaned
    except Exception as exc:
        # Do not discard a valid RSS item just because the publisher page blocks bots.
        article["resolve_error"] = str(exc)[:160]
    return article


def main():
    if not INGEST_URL or not TOKEN:
        print("Missing NEWS_INGEST_URL or NEWS_INGEST_TOKEN")
        return 2

    articles, seen_urls = [], set()
    feed_failures = []
    for source, category, feed_url in FEEDS:
        try:
            _, data = fetch_bytes(feed_url, 20)
            parsed = parse_feed(data, source, category, feed_url)
            added_from_feed = 0
            for article in parsed:
                url = article["url"].split("#", 1)[0]
                if url not in seen_urls:
                    seen_urls.add(url)
                    article["url"] = url
                    articles.append(article)
                    added_from_feed += 1
            print(f"FEED OK: {source} [{category}] -> {len(parsed)} items, {added_from_feed} unique")
        except Exception as exc:
            feed_failures.append((source, feed_url, str(exc)[:180]))
            print(f"FAILED FEED: {source} {feed_url}: {exc}")

    # Resolve publisher metadata concurrently. Cap at 500 records for the Worker endpoint.
    articles = articles[:500]
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        articles = list(pool.map(resolve_article, articles))
    articles.sort(key=lambda a: (a.get("published_at") or "", a.get("title") or ""), reverse=True)

    images = sum(bool(a.get("image_url")) for a in articles)
    resolved = sum(not a.get("resolve_error") for a in articles)
    errors = sum(bool(a.get("resolve_error")) for a in articles)
    payload = json.dumps({"articles": articles}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        INGEST_URL, data=payload, method="POST",
        headers={**HEADERS, "Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            print("INGEST:", response.read().decode("utf-8", "replace"))
    except Exception as exc:
        print(f"INGEST FAILED: {exc}")
        return 1

    print(f"Mode: direct publisher RSS; language=id; country=Indonesia; feeds={len(FEEDS)}")
    print(f"Fetched {len(articles)} unique articles; {images} image URLs; {resolved} publisher pages resolved; {errors} publisher fetch failures; {len(feed_failures)}/{len(FEEDS)} feeds failed.")
    return 0 if articles and len(feed_failures) < len(FEEDS) else 1

if __name__ == "__main__":
    raise SystemExit(main())
