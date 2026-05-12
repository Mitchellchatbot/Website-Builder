import csv
import json
import os
import re
import time
import requests
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin, urlparse

from dotenv import load_dotenv
from groq import Groq
from bs4 import BeautifulSoup
from PIL import Image as PILImage
from playwright.sync_api import sync_playwright

load_dotenv()

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
GROQ_MODEL = "openai/gpt-oss-120b"
OUTPUT_DIR = Path("output")

groq_client = Groq(api_key=GROQ_API_KEY)


class ScrapeFailedError(Exception):
    pass


# ─────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────

def resize_if_needed(image_path: Path, max_dimension: int = 2000) -> None:
    """Resize image in place if either dimension exceeds max_dimension. Deletes corrupt files."""
    path_str = str(image_path).lower()
    if path_str.endswith('.svg'):
        return
    try:
        with PILImage.open(image_path) as img:
            img.verify()
        with PILImage.open(image_path) as img:
            width, height = img.size
            if width <= max_dimension and height <= max_dimension:
                return
            if width >= height:
                new_w = max_dimension
                new_h = int(height * (max_dimension / width))
            else:
                new_h = max_dimension
                new_w = int(width * (max_dimension / height))
            resized = img.resize((new_w, new_h), PILImage.LANCZOS)
            resized.save(image_path, optimize=True, quality=85)
    except Exception as e:
        print(f"    ⚠  Removing unprocessable image {image_path.name}: {e}")
        try:
            image_path.unlink()
        except OSError:
            pass


def ensure_protocol(url: str) -> str:
    if not url:
        return url
    url = url.strip().strip('"\'')
    if url.startswith(("http://", "https://")):
        return url
    return f"https://{url}"


def sanitize_folder_name(name: str) -> str:
    """Remove characters that are invalid in folder names."""
    return re.sub(r'[<>:"/\\|?*]', "_", name).strip()


def extract_text(html: str) -> str:
    """Strip HTML tags and return clean plain text."""
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style", "noscript", "head"]):
        tag.decompose()
    return soup.get_text(separator=" ", strip=True)


def find_contact_url(html: str, base_url: str) -> str | None:
    """
    Search the page links for a contact page URL.
    Falls back to common /contact paths.
    """
    soup = BeautifulSoup(html, "lxml")
    contact_keywords = ["contact", "contact-us", "get-in-touch", "reach-us", "reach-out"]

    for a in soup.find_all("a", href=True):
        href = a["href"].lower()
        text = a.get_text(strip=True).lower()
        if any(kw in href or kw in text for kw in contact_keywords):
            full = urljoin(base_url, a["href"])
            # Make sure we stay on the same domain
            if urlparse(full).netloc == urlparse(base_url).netloc:
                return full

    # Try common fallback paths
    for path in ["/contact", "/contact-us", "/get-in-touch"]:
        return urljoin(base_url, path)

    return None


def download_images(html: str, base_url: str, images_dir: Path) -> list[dict]:
    """Download all <img> assets from the homepage."""
    soup = BeautifulSoup(html, "lxml")
    img_tags = soup.find_all("img")

    downloaded = []
    seen_urls: set[str] = set()

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0 Safari/537.36"
        )
    }

    for img in img_tags:
        src = (
            img.get("src")
            or img.get("data-src")
            or img.get("data-lazy-src")
            or img.get("data-original")
        )
        if not src or src.startswith("data:"):
            continue

        img_url = urljoin(base_url, src)
        if img_url in seen_urls:
            continue
        seen_urls.add(img_url)

        try:
            response = requests.get(img_url, timeout=10, headers=headers)
            if response.status_code == 200:
                ext = os.path.splitext(urlparse(img_url).path)[1].lower()
                if ext not in {".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"}:
                    ext = ".jpg"

                # Use the count of already-downloaded images so numbering
                # is always sequential (001, 002, 003 ...) with no gaps.
                filename = f"image_{len(downloaded) + 1:03d}{ext}"
                filepath = images_dir / filename

                with open(filepath, "wb") as f:
                    f.write(response.content)

                resize_if_needed(filepath)

                if filepath.exists():
                    downloaded.append({
                        "filename": filename,
                        "url": img_url,
                        "alt": img.get("alt", "").strip(),
                    })
        except Exception as e:
            print(f"    ⚠  Could not download {img_url}: {e}")

    return downloaded


def extract_contact_links(html: str) -> dict:
    """
    Directly pull contact info from HTML links — reliable and instant.
    Catches mailto:, tel:, and known social media domains.
    Returns a dict of whatever was found (only non-empty values included).
    """
    soup = BeautifulSoup(html, "lxml")

    SOCIAL_DOMAINS = {
        "github":     "github.com",
        "linkedin":   "linkedin.com",
        "twitter":    "twitter.com",
        "instagram":  "instagram.com",
        "facebook":   "facebook.com",
        "youtube":    "youtube.com",
        "whatsapp":   "wa.me",
        "behance":    "behance.net",
        "dribbble":   "dribbble.com",
        "medium":     "medium.com",
        "devto":      "dev.to",
    }

    found: dict = {}

    for a in soup.find_all("a", href=True):
        href = a["href"].strip()

        if href.startswith("mailto:"):
            email = href.replace("mailto:", "").split("?")[0].strip()
            if email and "email" not in found:
                found["email"] = email

        elif href.startswith("tel:"):
            phone = href.replace("tel:", "").strip()
            if phone and "phone" not in found:
                found["phone"] = phone

        else:
            for key, domain in SOCIAL_DOMAINS.items():
                if domain in href and key not in found:
                    found[key] = href
                    break

    return found

# ─────────────────────────────────────────────
# SECTION EXTRACTION
# ─────────────────────────────────────────────

# Maps a friendly section name → HTML class/id keywords that identify it
SECTION_MAP = {
    "hero":          ["hero", "banner", "jumbotron", "intro", "splash", "masthead", "slider", "carousel", "home-top", "above-fold"],
    "about":         ["about", "who-we-are", "our-story", "mission", "vision", "history", "overview", "company-info"],
    "services":      ["service", "offering", "what-we-do", "solution", "program", "treatment", "product", "care", "specialty"],
    "features":      ["feature", "benefit", "why-us", "why-choose", "advantage", "highlight", "difference", "strength"],
    "reviews":       ["review", "testimonial", "rating", "feedback", "client-say", "what-our", "success-stor", "case-stud", "star", "google-review", "trustpilot", "ti-widget", "ti-goog", "ti-review"],
    "team":          ["team", "staff", "people", "doctor", "therapist", "founder", "expert", "counselor", "provider", "clinician"],
    "faq":           ["faq", "question", "accordion", "frequently", "asked"],
    "insurance":     ["insurance", "coverage", "verify", "in-network", "accepted", "payment", "financing", "billing"],
    "accreditations":["accreditation", "certification", "license", "carf", "joint-commission", "samhsa", "award", "recognition", "seal"],
    "gallery":       ["gallery", "photo", "image", "facility", "virtual-tour", "tour", "campus"],
    "stats":         ["stat", "number", "count", "metric", "achievement", "result", "outcome"],
    "process":       ["process", "how-it-work", "step", "journey", "admission", "intake", "referral", "get-started"],
    "blog":          ["blog", "article", "news", "resource", "insight", "post", "latest"],
    "cta":           ["cta", "call-to-action", "get-started", "action", "contact-cta", "ready", "start-today"],
    "footer":        ["footer"],
}


def extract_jsonld_reviews(html: str) -> list[dict]:
    """
    Extract individual reviews from JSON-LD schema.org markup.
    Many sites embed Review / LocalBusiness structured data — this is far more
    reliable than class-name matching.
    """
    soup = BeautifulSoup(html, "lxml")
    reviews: list[dict] = []

    def _parse_review(item: dict) -> dict | None:
        author = item.get("author", {})
        if isinstance(author, dict):
            author = author.get("name", "")
        rating = item.get("reviewRating", {})
        if isinstance(rating, dict):
            rating = rating.get("ratingValue", "")
        text = item.get("reviewBody", item.get("description", "")).strip()
        if not text:
            return None
        return {
            "author":  str(author).strip(),
            "rating":  str(rating).strip(),
            "text":    text,
            "source":  "schema.org",
        }

    for script in soup.find_all("script", type="application/ld+json"):
        try:
            raw = json.loads(script.string or "")
            items = raw if isinstance(raw, list) else [raw]
            for item in items:
                if item.get("@type") == "Review":
                    r = _parse_review(item)
                    if r:
                        reviews.append(r)
                for nested in item.get("review", []) if isinstance(item.get("review"), list) else ([item["review"]] if isinstance(item.get("review"), dict) else []):
                    r = _parse_review(nested)
                    if r:
                        reviews.append(r)
        except Exception:
            pass

    return reviews


def extract_trustindex_reviews(html: str) -> list[dict]:
    """
    Parse Trustindex review widgets (class ti-review-item).
    Trustindex embeds Google/other reviews inline in the DOM — very common on
    WordPress/Elementor sites. BeautifulSoup can read them directly.
    """
    soup = BeautifulSoup(html, "lxml")
    reviews: list[dict] = []

    for item in soup.find_all(class_=lambda c: c and "ti-review-item" in c):
        # Author name
        name_el = item.find(class_=lambda c: c and "ti-name" in c)
        author = name_el.get_text(strip=True) if name_el else ""

        # Star count — each <img class="ti-star"> = 1 star
        stars_span = item.find(class_=lambda c: c and "ti-stars" in c)
        star_count = len(stars_span.find_all("img")) if stars_span else 0

        # Review text — prefer .ti-review-content, fall back to .ti-review-text-container
        text_el = (
            item.find(class_=lambda c: c and "ti-review-content" in c)
            or item.find(class_=lambda c: c and "ti-review-text-container" in c)
        )
        text = text_el.get_text(separator=" ", strip=True) if text_el else ""
        # Strip "Read more" / "Hide" UI text the widget appends
        text = re.sub(r"\s*(Read more|Hide)\s*$", "", text, flags=re.IGNORECASE).strip()

        # Date — prefer the tooltip (exact timestamp) over relative "1 year ago"
        date_el = item.find(class_=lambda c: c and "ti-date" in c)
        tooltip_el = date_el.find(class_="ti-tooltip") if date_el else None
        date = (
            tooltip_el.get_text(strip=True)
            if tooltip_el
            else (date_el.get_text(strip=True) if date_el else "")
        )

        # Source platform from class "source-Google", "source-Facebook", etc.
        item_classes = " ".join(item.get("class", []))
        source_match = re.search(r"source-(\w+)", item_classes)
        source = source_match.group(1) if source_match else "Google"

        if text and len(text) > 5:
            reviews.append({
                "author": author,
                "rating": str(star_count) if star_count else "",
                "text":   text,
                "source": source,
                "date":   date,
            })

    return reviews


# Maps heading text keywords → section names
# Used to find sections on page-builder sites (Elementor, Divi, WPBakery)
# where CSS class names are all generic numeric IDs.
_HEADING_SECTION_HINTS: dict[str, list[str]] = {
    "about":          ["about us", "who we are", "our story", "our mission", "history", "overview"],
    "services":       ["our services", "our programs", "what we offer", "what we treat", "treatment program", "our care"],
    "reviews":        ["review", "testimonial", "what our", "what do our", "patients say", "clients say",
                       "success stor", "outpatients say", "say about", "our graduates", "hear from"],
    "team":           ["our team", "meet our", "our staff", "our doctors", "our therapist", "our provider", "clinician"],
    "faq":            ["frequently asked", "faq", "common question", "have questions"],
    "insurance":      ["insurance", "accepted insurance", "verify benefit", "we accept", "coverage"],
    "accreditations": ["accredit", "certif", "licensed", "recognized", "our award", "joint commission", "carf"],
    "process":        ["how it works", "how we work", "admission", "get started", "referral process", "our process", "steps to"],
    "stats":          ["by the numbers", "our results", "outcomes", "our impact", "proven results", "statistics"],
    "gallery":        ["our facility", "photo gallery", "virtual tour", "our campus", "our center"],
    "features":       ["why choose", "why us", "what sets", "our difference", "our advantage", "what makes us"],
}


def _find_container_text(heading_el, min_len: int = 80, max_walk: int = 5) -> str:
    """
    Walk up from a heading element to find an ancestor container with
    enough text to represent a full section.
    """
    el = heading_el
    for _ in range(max_walk):
        parent = el.parent
        if parent is None or parent.name in ("body", "html", "[document]"):
            break
        el = parent
        text = el.get_text(separator=" ", strip=True)
        if len(text) >= min_len:
            return text[:3000]
    return ""


def extract_sections_by_headings(soup: BeautifulSoup) -> dict[str, str]:
    """
    Discover page sections by reading h2/h3/h4 heading text.
    Works on Elementor, Divi, WPBakery, and any page builder that uses
    generic numeric class names — because it looks at CONTENT not CSS.
    """
    sections: dict[str, str] = {}

    for heading in soup.find_all(["h2", "h3", "h4"]):
        heading_text = heading.get_text(strip=True).lower()
        if not heading_text:
            continue

        for section_name, hints in _HEADING_SECTION_HINTS.items():
            if section_name in sections:
                continue
            if any(hint in heading_text for hint in hints):
                text = _find_container_text(heading)
                if text:
                    sections[section_name] = text
                break

    return sections


def extract_sections(html: str) -> dict[str, str]:
    """
    Parse the page HTML and extract text per named section.
    Returns a dict like: {"hero": "text...", "reviews": "text...", ...}
    """
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style", "noscript", "head"]):
        tag.decompose()

    sections: dict[str, str] = {}

    # Always capture <header>
    header_tag = soup.find("header")
    if header_tag:
        text = header_tag.get_text(separator=" ", strip=True)
        if len(text) > 30:
            sections["header"] = text[:3000]

    # Walk all block elements and classify by class/id
    for element in soup.find_all(["section", "div", "article", "aside", "main"], recursive=True):
        classes = " ".join(element.get("class", []))
        elem_id = element.get("id", "")
        search_str = f"{classes} {elem_id}".lower()

        for section_name, keywords in SECTION_MAP.items():
            if section_name in sections:          # already captured, skip
                continue
            if any(kw in search_str for kw in keywords):
                text = element.get_text(separator=" ", strip=True)
                if len(text) > 80:               # skip tiny/empty elements
                    sections[section_name] = text[:3000]
                break

    # Deep review pass — three strategies beyond class-name matching
    if "reviews" not in sections:
        review_texts = []

        # 1. blockquote elements (common for testimonials)
        for el in soup.find_all("blockquote"):
            t = el.get_text(separator=" ", strip=True)
            if len(t) > 30:
                review_texts.append(t)

        # 2. itemprop attributes (microdata schema.org)
        for el in soup.find_all(attrs={"itemprop": True}):
            prop = el.get("itemprop", "").lower()
            if any(kw in prop for kw in ["review", "testimonial", "ratingvalue", "reviewbody"]):
                t = el.get_text(separator=" ", strip=True)
                if len(t) > 30:
                    review_texts.append(t)

        # 3. class/id keyword scan (original approach, expanded keywords)
        for el in soup.find_all(True):
            classes = " ".join(el.get("class", []))
            eid = el.get("id", "")
            s = f"{classes} {eid}".lower()
            if any(kw in s for kw in [
                "review", "testimonial", "rating", "star", "quote", "feedback",
                "client-say", "what-our", "patient-say", "success-stor", "google-review",
                "trustpilot", "wp-review",
            ]):
                t = el.get_text(separator=" ", strip=True)
                if len(t) > 40:
                    review_texts.append(t)

        if review_texts:
            seen: set[str] = set()
            deduped: list[str] = []
            for t in review_texts:
                key = t[:80]
                if key not in seen:
                    seen.add(key)
                    deduped.append(t)
            sections["reviews"] = " | ".join(deduped)[:3000]

    # Heading-based gap-filler — catches Elementor/Divi/WPBakery pages where
    # every container has a generic class like "elementor-element-7aebd79".
    # Only fills sections still missing after the class/id passes above.
    heading_sections = extract_sections_by_headings(soup)
    for name, text in heading_sections.items():
        if name not in sections:
            sections[name] = text

    # Fallback: if nothing was found, return the full page text
    if not sections:
        full = soup.get_text(separator=" ", strip=True)
        sections["full_page"] = full[:6000]

    return sections


# ─────────────────────────────────────────────
# GROQ ANALYSIS
# ─────────────────────────────────────────────

def analyze_with_groq(
    company_name: str,
    sections: dict[str, str],
    full_text: str,
    pre_extracted_contact: dict,
    contact_text: str = "",
) -> dict:
    """
    Send section-labeled text to Groq.
    Returns a fully dynamic JSON profile tailored to this specific website.
    """
    sections_block = ""
    for name, text in sections.items():
        sections_block += f"\n\n=== {name.upper().replace('_', ' ')} ===\n{text[:1500]}"

    if contact_text:
        sections_block += f"\n\n=== CONTACT PAGE ===\n{contact_text[:1500]}"

    # Serialize the pre-extracted links as context for Groq
    pre_extracted_str = json.dumps(pre_extracted_contact, indent=2) if pre_extracted_contact else "{}"

    prompt = f"""You are a senior business analyst profiling the website of "{company_name}".

Produce a DYNAMIC, TAILORED JSON profile. Do NOT use a fixed template.

Return ONLY valid JSON with these exact top-level keys:

{{
  "overall_summary": "Comprehensive 150-250 word summary of what they do, services, value props, audience, brand tone.",

  "sections": {{
    "<snake_case_section_name>": "1-3 sentence summary of that section"
    // Include ALL sections found: hero, about, services, reviews, team, faq, insurance, accreditations, gallery, stats, process, cta, footer, etc.
    // Add a "reviews" key if ANY customer reviews, testimonials, star ratings, or quotes were found — quote them verbatim if possible.
  }},

  "key_facts": {{
    "<snake_case_key>": "<value or list — only include what is clearly on the site>"
    // Include: phone, email, address, years_of_service, founded, service_areas, accreditations (list),
    // num_reviews, avg_rating, insurance_accepted (list), team_size, response_time, certifications (list)
    // Add any other specific facts found: bed count, success rate, languages, specialties, etc.
  }},

  "reviews": [
    // Array of individual review objects found on the site. Include ALL available.
    // Each object: {{ "author": "", "rating": "", "text": "", "source": "" }}
    // Leave as empty array [] if no reviews found.
  ],

  "contact": {{
    // Include ONLY fields that actually exist. Examples:
    // "email", "phone", "location", "address",
    // "github", "linkedin", "twitter", "instagram",
    // "whatsapp", "facebook", "behance", "dribbble"
    "<channel>": "<value>"
  }}
}}

Rules:
- Return ONLY valid JSON. No markdown, no extra text.
- All object keys must be snake_case.
- Omit any field that is not found — do NOT include null values in "contact".
- IMPORTANT: The following contact links were extracted directly from the HTML. Trust these and include them in "contact":
{pre_extracted_str}

Website content:
{sections_block}
"""

    response = groq_client.chat.completions.create(
        model=GROQ_MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.1,
        max_tokens=3500,
        response_format={"type": "json_object"},
    )

    try:
        result = json.loads(response.choices[0].message.content)
        # Ensure reviews key always exists
        if "reviews" not in result:
            result["reviews"] = []
        return result
    except json.JSONDecodeError:
        return {
            "overall_summary": None,
            "sections": {},
            "key_facts": {},
            "reviews": [],
            "contact": pre_extracted_contact,
        }


# ─────────────────────────────────────────────
# CORE SCRAPER
# ─────────────────────────────────────────────

def scrape_company(company_name: str, url: str, browser, output_dir: Path | None = None) -> dict:
    """Scrape one company homepage and return structured data."""

    folder_name = sanitize_folder_name(company_name)
    company_dir = output_dir if output_dir is not None else (OUTPUT_DIR / folder_name)
    images_dir = company_dir / "images"
    company_dir.mkdir(parents=True, exist_ok=True)
    images_dir.mkdir(exist_ok=True)

    print(f"\n{'─'*55}")
    print(f"🔍  Scraping: {company_name}")
    print(f"    URL: {url}")

    data = {
        "company_name": company_name,
        "url": url,
        "scraped_at": datetime.now().isoformat(),
        "overall_summary": None,
        "sections": {},
        "key_facts": {},
        "reviews": [],
        "contact": {},
        "images": [],
        "error": None,
    }

    context = browser.new_context(
        viewport={"width": 1920, "height": 1080},
        user_agent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0 Safari/537.36"
        ),
    )
    page = context.new_page()

    try:
        url = ensure_protocol(url)

        # ── 1. Load homepage ──────────────────────────────────
        # domcontentloaded fires as soon as the DOM is ready — much faster than
        # networkidle (which waits for every tracker/CDN request to settle).
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
        except Exception:
            # Second try: bare load event, still skip networkidle
            page.goto(url, wait_until="load", timeout=60000)

        # Attempt networkidle but don't fail if the site never settles
        try:
            page.wait_for_load_state("networkidle", timeout=8000)
        except Exception:
            pass

        page.wait_for_timeout(2000)

        # Scroll to bottom and back — triggers lazy-loaded images and review widgets
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        page.wait_for_timeout(1500)
        page.evaluate("window.scrollTo(0, 0)")
        page.wait_for_timeout(500)

        homepage_html = page.content()
        homepage_text = extract_text(homepage_html)

        # ── 2. Screenshot (full page) ─────────────────────────
        print("  📸  Taking full-page screenshot...")
        page.screenshot(
            path=str(company_dir / "screenshot.png"),
            full_page=True,
        )
        print("  ✅  Screenshot saved.")

        # ── 3. Download images ────────────────────────────────
        print("  🖼   Downloading images...")
        data["images"] = download_images(homepage_html, url, images_dir)
        print(f"  ✅  {len(data['images'])} image(s) downloaded.")

        # ── 4. Extract HTML sections + contact links ──────────
        print("  🗂   Identifying page sections...")
        sections = extract_sections(homepage_html)
        print(f"  ✅  Found sections: {list(sections.keys())}")

        # Extract structured reviews via every available method
        jsonld_reviews     = extract_jsonld_reviews(homepage_html)
        trustindex_reviews = extract_trustindex_reviews(homepage_html)

        # Merge: JSON-LD first, then Trustindex (deduplicate by text prefix)
        seen_review_texts: set[str] = {r["text"][:60] for r in jsonld_reviews}
        for r in trustindex_reviews:
            if r["text"][:60] not in seen_review_texts:
                jsonld_reviews.append(r)
                seen_review_texts.add(r["text"][:60])

        if jsonld_reviews:
            print(f"  ⭐  Found {len(jsonld_reviews)} structured review(s) "
                  f"(JSON-LD: {len(jsonld_reviews) - len(trustindex_reviews)}, "
                  f"Trustindex: {len(trustindex_reviews)})")

        print("  🔗  Extracting contact links from HTML...")
        pre_contact = extract_contact_links(homepage_html)
        print(f"  ✅  Pre-extracted: {list(pre_contact.keys()) or 'none'}")

        # ── 5. Check contact page for extra info ──────────────
        contact_text = ""
        contact_url = find_contact_url(homepage_html, url)
        if contact_url:
            try:
                print(f"  🔎  Checking contact page: {contact_url}")
                page.goto(contact_url, wait_until="domcontentloaded", timeout=20000)
                try:
                    page.wait_for_load_state("networkidle", timeout=5000)
                except Exception:
                    pass
                page.wait_for_timeout(1000)
                contact_html = page.content()
                contact_text = extract_text(contact_html)
                # Also extract links from the contact page itself
                extra = extract_contact_links(contact_html)
                for k, v in extra.items():
                    if k not in pre_contact:
                        pre_contact[k] = v
                print("  ✅  Contact page fetched.")
            except Exception as e:
                print(f"  ⚠   Could not load contact page: {e}")

        # ── 6. Analyze with Groq ──────────────────────────────
        print(f"  🤖  Analyzing {len(sections)} section(s) with Groq...")
        groq_result = analyze_with_groq(
            company_name, sections, homepage_text, pre_contact, contact_text
        )

        data["overall_summary"] = groq_result.get("overall_summary")
        data["sections"]        = groq_result.get("sections", {})
        data["key_facts"]       = groq_result.get("key_facts", {})
        data["contact"]         = groq_result.get("contact", pre_contact)

        # Merge reviews: prefer JSON-LD (structured), fall back to Groq-extracted
        groq_reviews = groq_result.get("reviews", [])
        if jsonld_reviews:
            # Deduplicate by review text
            seen_texts: set[str] = {r["text"][:60] for r in jsonld_reviews}
            for r in groq_reviews:
                if r.get("text", "")[:60] not in seen_texts:
                    jsonld_reviews.append(r)
            data["reviews"] = jsonld_reviews
        else:
            data["reviews"] = groq_reviews

        print(f"  ✅  Analysis complete.")
        print(f"      📄 Sections:  {list(data['sections'].keys())}")
        print(f"      🔑 Key facts: {list(data['key_facts'].keys())}")
        print(f"      ⭐ Reviews:   {len(data['reviews'])} found")
        print(f"      📬 Contact:   {list(data['contact'].keys())}")

    except Exception as e:
        print(f"  ❌  Error scraping {company_name}: {e}")
        data["error"] = str(e)

    finally:
        context.close()

    # ── 6. Save JSON ──────────────────────────────────────────
    json_path = company_dir / "data.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"  💾  Data saved → {json_path}")

    return data


# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────

def main():
    csv_file = "leads.csv"

    if not os.path.exists(csv_file):
        print(f"❌  '{csv_file}' not found.")
        print("    Please create it with two columns: company_name, url")
        return

    # Read leads
    with open(csv_file, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        leads = [row for row in reader]

    if not leads:
        print("❌  No leads found in the CSV file.")
        return

    print(f"📋  Loaded {len(leads)} lead(s) from '{csv_file}'")
    OUTPUT_DIR.mkdir(exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        for i, lead in enumerate(leads, start=1):
            company_name = lead.get("company_name", "").strip()
            url = lead.get("url", "").strip()

            if not company_name or not url:
                print(f"⚠   Skipping row {i}: missing company_name or url → {lead}")
                continue

            if not url.startswith("http"):
                url = "https://" + url

            print(f"\n[{i}/{len(leads)}]", end="")
            scrape_company(company_name, url, browser)

            # Polite delay between companies
            if i < len(leads):
                print("\n  ⏳  Waiting 3 seconds before next company...")
                time.sleep(3)

        browser.close()

    print(f"\n{'═'*55}")
    print("✅  All leads scraped! Results are in the 'output/' folder.")
    print(f"{'═'*55}\n")


def scrape_site(website_url: str, output_folder: "Path | str", company_name: str | None = None) -> Path:
    """Importable entry point: scrape website into output_folder. Returns path to data.json."""
    output_folder = Path(output_folder)
    output_folder.mkdir(parents=True, exist_ok=True)
    _company_name = company_name or output_folder.name
    website_url = ensure_protocol(website_url)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            data = scrape_company(_company_name, website_url, browser, output_dir=output_folder)
        finally:
            browser.close()
    if data.get("error"):
        raise ScrapeFailedError(data["error"])
    data_path = output_folder / "data.json"
    if not data_path.exists():
        raise ScrapeFailedError("Scraper completed but data.json was not created")
    return data_path


if __name__ == "__main__":
    main()
