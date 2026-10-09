#!/usr/bin/env python3
"""Nazuaf News collector using Google News RSS in GNews-style Indonesian locale.
No API key or third-party Python package is required.
"""
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
LANGUAGE = "id"
COUNTRY = "ID"
PERIOD = "7d"
MAX_ARTICLES = 500

# Broad GNews-style coverage: top headlines, major topics, Indonesian location,
# and keyword queries for common local and international news beats.
FEEDS = [
    ("Berita", "top", "headlines"),
    ("Berita", "location", "Indonesia"),
    ("Berita", "topic", "WORLD"),
    ("Berita", "topic", "NATION"),
    ("Bisnis", "topic", "BUSINESS"),
    ("Teknologi", "topic", "TECHNOLOGY"),
    ("Hiburan", "topic", "ENTERTAINMENT"),
    ("Olahraga", "topic", "SPORTS"),
    ("Sains", "topic", "SCIENCE"),
    ("Kesehatan", "topic", "HEALTH"),
    ("Berita", "search", "berita Indonesia"),
    ("Berita", "search", "politik Indonesia"),
    ("Berita", "search", "pemerintah Indonesia"),
    ("Berita", "search", "hukum kriminal Indonesia"),
    ("Bisnis", "search", "ekonomi Indonesia bisnis"),
    ("Bisnis", "search", "saham investasi pasar modal Indonesia"),
    ("Bisnis", "search", "UMKM startup Indonesia"),
    ("Teknologi", "search", "teknologi AI kecerdasan buatan Indonesia"),
    ("Teknologi", "search", "gadget smartphone aplikasi Indonesia"),
    ("Teknologi", "search", "internet keamanan siber Indonesia"),
    ("Gaming", "search", "gaming video game Indonesia"),
    ("Gaming", "search", "game PC PlayStation Xbox Nintendo"),
    ("Hiburan", "search", "film musik selebritas Indonesia"),
    ("Olahraga", "search", "sepak bola Indonesia"),
    ("Olahraga", "search", "badminton bulu tangkis Indonesia"),
    ("Olahraga", "search", "Formula 1 MotoGP olahraga"),
    ("Sains", "search", "sains penelitian antariksa Indonesia"),
    ("Kesehatan", "search", "kesehatan medis Indonesia"),
    ("Pendidikan", "search", "pendidikan kampus beasiswa Indonesia"),
    ("Otomotif", "search", "otomotif mobil motor Indonesia"),
    ("Gaya Hidup", "search", "gaya hidup kuliner travel Indonesia"),
    ("Internasional", "search", "berita dunia internasional"),
    ("ANTARA", "site", "antaranews.com"),
    ("CNN Indonesia", "site", "cnnindonesia.com"),
    ("CNBC Indonesia", "site", "cnbcindonesia.com"),
    ("Kompas.com", "site", "kompas.com"),
    ("detikcom", "site", "detik.com"),
    ("Tempo.co", "site", "tempo.co"),
    ("Liputan6", "site", "liputan6.com"),
    ("Tirto.id", "site", "tirto.id"),
    ("Suara.com", "site", "suara.com"),
    ("Republika", "site", "republika.co.id"),
    ("Teknologi", "site", "tekno.kompas.com OR inet.detik.com OR teknologi.bisnis.com"),
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; NazuafNewsBot/1.1; +https://nazuaf.com)",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


def clean_html(value):
    value = html.unescape(value or "")
    value = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", value).strip()


class MetaParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta, self.json_ld, self.in_json, self.script = {}, [], False, []

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
        return value if value.startswith(("https://", "http://", "/")) else None
    if isinstance(value, list):
        for item in value:
            found = find_json_image(item)
            if found:
                return found
    elif isinstance(value, dict):
        for key in ("image", "thumbnailUrl", "contentUrl"):
            if key in value:
                found = find_json_image(value[key])
                if found:
                    return found
        for item in value.values():
            if isinstance(item, (dict, list)):
                found = find_json_image(item)
                if found:
                    return found
    return None


def metadata(document, base_url):
    parser = MetaParser()
    try:
        parser.feed(document)
    except Exception:
        pass
    image = (parser.meta.get("og:image:secure_url") or parser.meta.get("og:image")
             or parser.meta.get("twitter:image") or parser.meta.get("twitter:image:src"))
    description = parser.meta.get("og:description") or parser.meta.get("twitter:description")
    if not image:
        for block in parser.json_ld:
            try:
                image = find_json_image(json.loads(block))
                if image:
                    break
            except Exception:
                continue
    if image:
        image = urllib.parse.urljoin(base_url, html.unescape(image).strip())
        if not image.startswith(("https://", "http://")):
            image = None
    if description:
        desc_lower = clean_html(description).lower()
        if any(phrase in desc_lower for phrase in (
            "comprehensive up-to-date news coverage",
            "aggregated from sources all over the world by google news",
        )):
            description = None
    return image, clean_html(description)[:500] if description else None


def fetch_bytes(url, timeout=15):
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.geturl(), response.read()


def feed_url(kind, query):
    base = "https://news.google.com/rss/"
    if kind == "top":
        path = "headlines"
        q = None
    elif kind == "topic":
        path = "headlines/section/topic/" + urllib.parse.quote(query)
        q = None
    elif kind == "location":
        path = "headlines/section/geo/" + urllib.parse.quote(query)
        q = None
    else:
        path = "search"
        q = query + (" when:" + PERIOD if PERIOD else "")
    params = {"hl": LANGUAGE, "gl": COUNTRY, "ceid": COUNTRY + ":" + LANGUAGE}
    if q:
        params["q"] = q
    return base + path + "?" + urllib.parse.urlencode(params)


def parse_feed(data, category, fallback_source):
    root = ET.fromstring(data)
    items = root.findall(".//item") or root.findall(".//{http://www.w3.org/2005/Atom}entry")
    results = []
    for item in items[:100]:
        title = ""
        for tag in ("title", "{http://www.w3.org/2005/Atom}title"):
            node = item.find(tag)
            if node is not None and node.text:
                title = node.text.strip()
                break
        link = ""
        for tag in ("link", "{http://www.w3.org/2005/Atom}link"):
            node = item.find(tag)
            if node is not None:
                link = (node.text or node.attrib.get("href", "")).strip()
                if link:
                    break
        pub = ""
        for tag in ("pubDate", "published", "updated", "{http://www.w3.org/2005/Atom}published", "{http://www.w3.org/2005/Atom}updated"):
            node = item.find(tag)
            if node is not None and node.text:
                pub = node.text.strip()
                break
        source_node = item.find("source")
        publisher = (source_node.text or "").strip() if source_node is not None else ""
        if not title or not link:
            continue
        original_url = html.unescape(link)[:2000]
        try:
            published = parsedate_to_datetime(pub).isoformat() if pub else None
        except Exception:
            published = pub or None
        results.append({
            "title": clean_html(title)[:500],
            "url": original_url,
            "google_url": original_url,
            "source": (publisher or fallback_source or "Unknown")[:120],
            "category": category[:80],
            "description": None,
            "image_url": None,
            "published_at": published,
        })
    return results


def resolve_article(article):
    try:
        final_url, data = fetch_bytes(article["url"], 12)
        if final_url.startswith(("http://", "https://")):
            image, description = metadata(data[:1500000].decode("utf-8", "ignore"), final_url)
            if image:
                article["image_url"] = image[:2000]
            if description:
                article["description"] = description
            article["publisher_url"] = final_url[:2000]
    except Exception as exc:
        article["resolve_error"] = str(exc)[:200]
    return article


def main():
    if not INGEST_URL or not TOKEN:
        print("Missing NEWS_INGEST_URL or NEWS_INGEST_TOKEN")
        return 2

    collected, seen_urls, failed_feeds = [], set(), 0
    for category, kind, query in FEEDS:
        label = query if kind in ("site", "search", "location") else ("Top headlines" if kind == "top" else query)
        try:
            url = feed_url(kind, query)
            _, data = fetch_bytes(url, 20)
            batch = parse_feed(data, category, label)
            for article in batch:
                key = article["url"]
                if key not in seen_urls:
                    seen_urls.add(key)
                    collected.append(article)
        except Exception as exc:
            failed_feeds += 1
            print(f"FAILED FEED [{kind}:{query}]: {exc}")

    # Stay within GitHub Actions runtime and the Worker payload cap.
    collected = collected[:MAX_ARTICLES]
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        collected = list(pool.map(resolve_article, collected))
    collected.sort(key=lambda a: (a.get("published_at") or "", a.get("title") or ""), reverse=True)

    image_count = sum(bool(a.get("image_url")) for a in collected)
    resolved_count = sum(bool(a.get("publisher_url")) for a in collected)
    fetch_errors = sum(bool(a.get("resolve_error")) for a in collected)
    payload = json.dumps({"articles": collected}, ensure_ascii=False).encode("utf-8")
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

    print(f"Locale: language={LANGUAGE}, country={COUNTRY}; feeds={len(FEEDS)}")
    print(f"Fetched {len(collected)} unique articles; {image_count} image URLs; {resolved_count} publisher URLs; {fetch_errors} article fetch failures; {failed_feeds}/{len(FEEDS)} feeds failed.")
    return 0 if collected or failed_feeds < len(FEEDS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
