#!/usr/bin/env python3
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
    "User-Agent": "Mozilla/5.0 (compatible; NazuafNewsBot/1.0; +https://news.nazuaf.com)"
}

MEDIA_NS = {
    "media": "http://search.yahoo.com/mrss/",
    "content": "http://purl.org/rss/1.0/modules/content/",
}


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


def find_image(elem, raw_description=""):
    # Common RSS media fields.
    for xpath in [
        "media:content",
        "media:thumbnail",
        "media:group/media:content",
        "media:group/media:thumbnail",
    ]:
        child = elem.find(xpath, MEDIA_NS)
        if child is not None:
            url = child.attrib.get("url") or child.attrib.get("href")
            if url:
                return html.unescape(url.strip())[:2000]

    # Standard RSS enclosure.
    enclosure = elem.find("enclosure")
    if enclosure is not None:
        url = enclosure.attrib.get("url")
        mime = (enclosure.attrib.get("type") or "").lower()
        if url and (mime.startswith("image/") or re.search(r"\.(?:jpe?g|png|webp|gif)(?:\?|$)", url, re.I)):
            return html.unescape(url.strip())[:2000]

    # Google News often puts an escaped <img src="..."> inside description.
    decoded = html.unescape(raw_description or "")
    match = re.search(r"<img[^>]+(?:src|data-src)=['\"]([^'\"]+)['\"]", decoded, re.I)
    if match:
        return html.unescape(match.group(1).strip())[:2000]

    # Fallback for a bare image URL in the description.
    match = re.search(r"https?://[^\s\"'<>]+?\.(?:jpe?g|png|webp|gif)(?:\?[^\s\"'<>]*)?", decoded, re.I)
    if match:
        return html.unescape(match.group(0).strip())[:2000]

    return None


def parse_date(value):
    if not value:
        return None
    try:
        return parsedate_to_datetime(value).isoformat()
    except Exception:
        return value


def parse_feed(data, source, category):
    root = ET.fromstring(data)
    items = root.findall(".//item")
    if not items:
        items = root.findall(".//{http://www.w3.org/2005/Atom}entry")

    output = []
    for item in items[:30]:
        title = first_text(item, ["title", "{http://www.w3.org/2005/Atom}title"])
        link = first_text(item, ["link", "{http://www.w3.org/2005/Atom}link"])

        if not link:
            atom_link = item.find("{http://www.w3.org/2005/Atom}link")
            if atom_link is not None:
                link = atom_link.attrib.get("href", "")

        description = first_text(
            item,
            ["description", "summary", "{http://www.w3.org/2005/Atom}summary"],
        )
        published = first_text(
            item,
            [
                "pubDate",
                "published",
                "updated",
                "{http://www.w3.org/2005/Atom}published",
                "{http://www.w3.org/2005/Atom}updated",
            ],
        )

        if not title or not link:
            continue

        image_url = find_image(item, description)

        output.append({
            "title": clean_html(title)[:500],
            "url": html.unescape(link)[:2000],
            "source": source,
            "category": category,
            "description": clean_html(description)[:500] or None,
            "image_url": image_url,
            "published_at": parse_date(published),
        })

    return output


def fetch(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=20) as response:
        return response.read()


def main():
    if not INGEST_URL or not TOKEN:
        print("Missing NEWS_INGEST_URL or NEWS_INGEST_TOKEN")
        return 2

    articles = []
    seen = set()
    failures = 0

    for source, query in FEEDS:
        rss_url = "https://news.google.com/rss/search?" + urllib.parse.urlencode({
            "q": query + " when:1d",
            "hl": "id",
            "gl": "ID",
            "ceid": "ID:id",
        })

        try:
            category = "Berita" if source not in {"Teknologi", "Gaming", "Sains"} else source
            parsed = parse_feed(fetch(rss_url), source, category)

            for article in parsed:
                if article["url"] not in seen:
                    seen.add(article["url"])
                    articles.append(article)
        except Exception as exc:
            failures += 1
            print(f"FAILED {source}: {exc}")

    articles = articles[:500]

    payload = json.dumps({"articles": articles}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        INGEST_URL,
        data=payload,
        method="POST",
        headers={
            **HEADERS,
            "Content-Type": "application/json",
            "Authorization": f"Bearer {TOKEN}",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            print("INGEST:", response.read().decode("utf-8"))
    except Exception as exc:
        print(f"INGEST FAILED: {exc}")
        return 1

    with_images = sum(1 for a in articles if a.get("image_url"))
    print(f"Fetched {len(articles)} unique articles; {with_images} have images; {failures}/{len(FEEDS)} feeds failed.")
    return 0 if articles or failures < len(FEEDS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
