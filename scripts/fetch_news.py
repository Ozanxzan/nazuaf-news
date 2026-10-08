#!/usr/bin/env python3
import concurrent.futures
import html
import json
import os
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime

INGEST_URL = os.environ.get("NEWS_INGEST_URL")
TOKEN = os.environ.get("NEWS_INGEST_TOKEN")

FEEDS = [
    ("ANTARA", "site:antaranews.com"),
    ("CNN Indonesia", "site:cnnindonesia.com"),
    ("CNBC Indonesia", "site:cnbcindonesia.com"),
    ("Kompas.com", "site:kompas.com"),
    ("detikcom", "site:detik.com"),
    ("Tempo.co", "site:tempo.co"),
    ("Liputan6", "site:liputan6.com"),
    ("Tirto.id", "site:tirto.id"),
    ("Suara.com", "site:suara.com"),
    ("Republika", "site:republika.co.id"),
    ("Teknologi", "teknologi AI gadget Indonesia"),
    ("Gaming", "gaming game Indonesia"),
    ("Sains", "sains teknologi Indonesia"),
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; NazuafNewsBot/1.0; +https://news.nazuaf.com)",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

IMAGE_PATTERNS = [
    re.compile(r'<meta[^>]+property=["\']og:image(?::secure_url)?["\'][^>]+content=["\']([^"\']+)["\']', re.I),
    re.compile(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image(?::secure_url)?["\']', re.I),
    re.compile(r'<meta[^>]+name=["\']twitter:image(?::src)?["\'][^>]+content=["\']([^"\']+)["\']', re.I),
    re.compile(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']twitter:image(?::src)?["\']', re.I),
]
DESCRIPTION_PATTERNS = [
    re.compile(r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']*)["\']', re.I),
    re.compile(r'<meta[^>]+content=["\']([^"\']*)["\'][^>]+property=["\']og:description["\']', re.I),
]

def clean_html(value):
    value = html.unescape(value or "")
    value = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", value).strip()

def first_text(elem, names):
    for name in names:
        child = elem.find(name)
        if child is not None and child.text:
            return child.text.strip()
    return ""

def parse_date(value):
    if not value:
        return None
    try:
        return parsedate_to_datetime(value).isoformat()
    except Exception:
        return value

def fetch_bytes(url, timeout=12):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.geturl(), response.read(), response.headers.get("Content-Type", "")

def resolve_article(article):
    # Keep article["url"] unchanged: it is the original Google News RSS URL
    # stored in D1 and is the stable key used to find/update the existing row.
    try:
        final_url, data, content_type = fetch_bytes(article["url"], timeout=12)
        if not final_url.startswith(("http://", "https://")):
            return article

        sample = data[:1000000].decode("utf-8", errors="ignore")
        image = None
        description = None

        for pattern in IMAGE_PATTERNS:
            match = pattern.search(sample)
            if match:
                image = html.unescape(match.group(1)).strip()
                break

        for pattern in DESCRIPTION_PATTERNS:
            match = pattern.search(sample)
            if match:
                description = clean_html(match.group(1))[:500]
                break

        if image:
            article["image_url"] = urllib.parse.urljoin(final_url, image)[:2000]
        if description:
            article["description"] = description

        # Keep the resolved publisher URL separately for future use/debugging.
        article["publisher_url"] = final_url[:2000]
        return article
    except Exception as exc:
        article["resolve_error"] = str(exc)[:200]
        return article

def parse_feed(data, source, category):
    root = ET.fromstring(data)
    items = root.findall(".//item") or root.findall(".//{http://www.w3.org/2005/Atom}entry")
    output = []
    for item in items[:30]:
        title = first_text(item, ["title", "{http://www.w3.org/2005/Atom}title"])
        link = first_text(item, ["link", "{http://www.w3.org/2005/Atom}link"])
        if not link:
            atom_link = item.find("{http://www.w3.org/2005/Atom}link")
            if atom_link is not None:
                link = atom_link.attrib.get("href", "")
        published = first_text(item, ["pubDate","published","updated",
            "{http://www.w3.org/2005/Atom}published","{http://www.w3.org/2005/Atom}updated"])
        if not title or not link:
            continue
        output.append({
            "title": clean_html(title)[:500],
            "url": html.unescape(link)[:2000],
            "source": source,
            "category": category,
            "description": None,
            "image_url": None,
            "published_at": parse_date(published),
        })
    return output

def main():
    if not INGEST_URL or not TOKEN:
        print("Missing NEWS_INGEST_URL or NEWS_INGEST_TOKEN")
        return 2

    articles, seen, failures = [], set(), 0
    for source, query in FEEDS:
        rss_url = "https://news.google.com/rss/search?" + urllib.parse.urlencode({
            "q": query + " when:1d", "hl": "id", "gl": "ID", "ceid": "ID:id",
        })
        try:
            category = "Berita" if source not in {"Teknologi","Gaming","Sains"} else source
            for article in parse_feed(fetch_bytes(rss_url, timeout=20)[1], source, category):
                if article["url"] not in seen:
                    seen.add(article["url"])
                    articles.append(article)
        except Exception as exc:
            failures += 1
            print(f"FAILED FEED {source}: {exc}")

    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        resolved = list(pool.map(resolve_article, articles[:500]))

    resolved.sort(key=lambda a: (a.get("published_at") or "", a.get("title") or ""), reverse=True)
    articles = resolved[:500]
    with_images = sum(1 for a in articles if a.get("image_url"))
    with_publisher_urls = sum(1 for a in articles if a.get("publisher_url"))

    payload = json.dumps({"articles": articles}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        INGEST_URL, data=payload, method="POST",
        headers={**HEADERS, "Content-Type":"application/json", "Authorization":f"Bearer {TOKEN}"}
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            print("INGEST:", response.read().decode("utf-8"))
    except Exception as exc:
        print(f"INGEST FAILED: {exc}")
        return 1

    print(f"Fetched {len(articles)} unique articles; {with_images} have images; "
          f"{with_publisher_urls} publisher URLs resolved; {failures}/{len(FEEDS)} feeds failed.")
    return 0 if articles or failures < len(FEEDS) else 1

if __name__ == "__main__":
    raise SystemExit(main())
