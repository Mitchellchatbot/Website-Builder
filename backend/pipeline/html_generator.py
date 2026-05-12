import sys
import time

"""
html_generator.py
-----------------
Generates a stunning, brand-matched single-page HTML website for any company
by sending its scraped data.json + images to Claude's vision API.

Claude analyzes the actual images to extract brand colors, logo style,
company type, and visual identity — then builds a fully personalized homepage.

Usage:
    python html_generator.py                          # default test lead
    python html_generator.py "path/to/lead/folder"   # specific lead folder
    python html_generator.py --all                   # process all leads in output/
"""

import anthropic
import json
import base64
import os
import shutil
from pathlib import Path
from dotenv import load_dotenv
from PIL import Image as PILImage

load_dotenv()

# ─────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────
MODEL          = "claude-opus-4-5"   # Vision-capable, highest quality
MAX_TOKENS     = 64000               # 64k output tokens for rich, complete pages
MAX_IMAGES         = 15              # Cap at 15 images — logo+facilities is enough for brand matching
MAX_PAYLOAD_BYTES  = 8 * 1024 * 1024 # 8 MB raw cap → ~11 MB base64, well under API limit
MIN_IMAGE_SIZE     = 2_000           # Skip files < 2 KB (tracking pixels etc.)
OUTPUT_DIR     = Path(r"d:\Video Recording\output")


# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────

def encode_image(path: Path) -> str:
    return base64.standard_b64encode(path.read_bytes()).decode("utf-8")


def get_media_type(path: Path) -> str:
    header = path.read_bytes()[:12]
    if header[:8] == b'\x89PNG\r\n\x1a\n':
        return "image/png"
    if header[:6] in (b'GIF87a', b'GIF89a'):
        return "image/gif"
    if header[:4] == b'RIFF' and header[8:12] == b'WEBP':
        return "image/webp"
    if header[:2] in (b'\xff\xd8', b'\xff\xe0', b'\xff\xe1'):
        return "image/jpeg"
    return {
        ".jpg":  "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png":  "image/png",
        ".gif":  "image/gif",
        ".webp": "image/webp",
    }.get(path.suffix.lower(), "image/jpeg")


def is_valid_image_for_claude(image_path: Path) -> bool:
    path_str = str(image_path).lower()
    if path_str.endswith('.svg'):
        return False
    try:
        with PILImage.open(image_path) as img:
            img.verify()
        with PILImage.open(image_path) as img:
            width, height = img.size
            if width > 2000 or height > 2000:
                print(f"   ⚠  Skipping oversized: {image_path.name} ({width}x{height})")
                return False
        return True
    except Exception as e:
        print(f"   ⚠  Skipping invalid: {image_path.name} ({e})")
        return False


def load_images(images_folder: Path, image_meta: list) -> list:
    """
    Load all valid images from the images/ folder as Claude content blocks.
    Priority sort: logos/seals first, facility photos second, rest after.
    """
    if not images_folder.exists():
        return []

    alt_lookup = {img["filename"]: img.get("alt", "") for img in image_meta}

    raster_candidates = [
        p for p in sorted(images_folder.iterdir())
        if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp", ".gif")
        and p.stat().st_size >= MIN_IMAGE_SIZE
    ]

    raster = [p for p in raster_candidates if is_valid_image_for_claude(p)]

    if not raster:
        print("   ⚠  No valid images found.")
        return []

    LOGO_HINTS     = ["logo", "brand", "seal", "carf", "accred", "badge", "cert"]
    FACILITY_HINTS = ["facility", "photo", "people", "staff", "patient", "center", "building"]

    def sort_key(p: Path):
        hint = f"{alt_lookup.get(p.name, '')} {p.name}".lower()
        if any(h in hint for h in LOGO_HINTS):     return 0
        if any(h in hint for h in FACILITY_HINTS): return 1
        return 2

    raster.sort(key=sort_key)

    if len(raster) > MAX_IMAGES:
        print(f"   ℹ  {len(raster)} images found — capping at {MAX_IMAGES} (priority sorted)")
        raster = raster[:MAX_IMAGES]

    blocks = []
    total_bytes = 0
    for img_path in raster:
        file_bytes = img_path.stat().st_size
        if total_bytes + file_bytes > MAX_PAYLOAD_BYTES:
            print(f"   ℹ  Payload budget reached at {total_bytes // 1024} KB — skipping remaining images")
            break
        total_bytes += file_bytes
        alt  = alt_lookup.get(img_path.name, img_path.name)
        size = file_bytes // 1024
        blocks.append({"type": "text", "text": f"[{img_path.name} | {size} KB | alt: '{alt}']"})
        blocks.append({
            "type": "image",
            "source": {
                "type":       "base64",
                "media_type": get_media_type(img_path),
                "data":       encode_image(img_path),
            },
        })
        print(f"   📷 Loaded: {img_path.name} ({size} KB)")

    print(f"   ✅ {len(blocks) // 2} image(s) queued for Claude ({total_bytes // 1024} KB total)")

    return blocks


# ─────────────────────────────────────────────
# Animation blocks — plain strings (NOT f-strings)
# so CSS/JS curly braces need no escaping
# ─────────────────────────────────────────────

ANIMATION_CSS = """
```css
/* ── Scroll animation base states ── */
.fade-up {
  opacity: 0;
  transform: translateY(32px);
  transition: opacity 0.65s cubic-bezier(0.22, 1, 0.36, 1),
              transform 0.65s cubic-bezier(0.22, 1, 0.36, 1);
}
.fade-in {
  opacity: 0;
  transition: opacity 0.7s ease;
}
.slide-left {
  opacity: 0;
  transform: translateX(-40px);
  transition: opacity 0.65s cubic-bezier(0.22, 1, 0.36, 1),
              transform 0.65s cubic-bezier(0.22, 1, 0.36, 1);
}
.slide-right {
  opacity: 0;
  transform: translateX(40px);
  transition: opacity 0.65s cubic-bezier(0.22, 1, 0.36, 1),
              transform 0.65s cubic-bezier(0.22, 1, 0.36, 1);
}
.scale-in {
  opacity: 0;
  transform: scale(0.92);
  transition: opacity 0.6s cubic-bezier(0.22, 1, 0.36, 1),
              transform 0.6s cubic-bezier(0.22, 1, 0.36, 1);
}
.animated {
  opacity: 1 !important;
  transform: none !important;
}
/* Stagger delays */
.stagger-children > *:nth-child(1) { transition-delay: 0s; }
.stagger-children > *:nth-child(2) { transition-delay: 0.1s; }
.stagger-children > *:nth-child(3) { transition-delay: 0.2s; }
.stagger-children > *:nth-child(4) { transition-delay: 0.3s; }
.stagger-children > *:nth-child(5) { transition-delay: 0.4s; }
/* Counter */
.count-up { display: inline-block; }
/* Hero load animations */
@keyframes heroFadeUp {
  from { opacity: 0; transform: translateY(24px); }
  to   { opacity: 1; transform: translateY(0); }
}
.hero-animate   { animation: heroFadeUp 0.7s cubic-bezier(0.22, 1, 0.36, 1) both; }
.hero-animate-1 { animation-delay: 0.1s; }
.hero-animate-2 { animation-delay: 0.25s; }
.hero-animate-3 { animation-delay: 0.4s; }
.hero-animate-4 { animation-delay: 0.55s; }
.hero-animate-5 { animation-delay: 0.7s; }
/* Card hover — includes opacity so it doesn't override .fade-up */
.card {
  transition: transform 0.25s ease, box-shadow 0.25s ease,
              opacity 0.65s cubic-bezier(0.22, 1, 0.36, 1);
}
.card:hover {
  transform: translateY(-6px);
  box-shadow: 0 12px 32px rgba(0,0,0,0.12);
}
/* Step number pop */
@keyframes stepPop {
  0%   { transform: scale(0.5); opacity: 0; }
  70%  { transform: scale(1.1); }
  100% { transform: scale(1);   opacity: 1; }
}
.step-num.animated {
  animation: stepPop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
/* Section label underline draw */
.section-label {
  position: relative;
  display: inline-block;
}
.section-label::after {
  content: '';
  position: absolute;
  bottom: -4px; left: 0;
  height: 2px; width: 0;
  background: var(--primary);
  transition: width 0.6s ease 0.3s;
}
.section-label.animated::after { width: 100%; }
```
"""

ANIMATION_JS = """
```html
<script>
// Intersection Observer for scroll animations
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('animated');
      if (entry.target.classList.contains('stagger-children')) {
        entry.target.querySelectorAll(':scope > *').forEach((child, i) => {
          child.style.transitionDelay = `${i * 0.1}s`;
          setTimeout(() => child.classList.add('animated'), i * 100);
        });
      }
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

document.querySelectorAll(
  '.fade-up, .fade-in, .slide-left, .slide-right, .scale-in, .section-label, .step-num'
).forEach(el => observer.observe(el));

// Animated number counter
function animateCounter(el) {
  const target = parseInt(el.dataset.target, 10);
  const step   = target / (1200 / 16);
  let current  = 0;
  const timer  = setInterval(() => {
    current += step;
    if (current >= target) { current = target; clearInterval(timer); }
    el.textContent = Math.floor(current) + (el.dataset.suffix || '');
  }, 16);
}
const counterObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      animateCounter(entry.target);
      counterObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.5 });
document.querySelectorAll('.count-up').forEach(el => counterObserver.observe(el));

// Sticky nav shadow on scroll
const nav = document.querySelector('nav');
window.addEventListener('scroll', () => {
  if (nav) nav.style.boxShadow = window.scrollY > 10
    ? '0 2px 20px rgba(0,0,0,0.1)' : 'none';
}, { passive: true });
</script>
```
"""


EMILY_ASSET = Path(__file__).parent.parent / "assets" / "emily.png"

CHAT_WIDGET = """
<script>
  (function () {
    if (window.location.search.indexOf('scaledbot_preview=true') !== -1) return;
    var params = "primaryColor=%232563EB&greeting=We+are+so+glad+that+you+are+here.+Let+us+know+how+we+can+help+you+today.&widgetIcon=message-circle&borderRadius=24&autoOpen=true&effectType=none&effectInterval=5&effectIntensity=medium";
    var parentUrl = encodeURIComponent(window.location.href);
    var src = 'https://care-assist.io/widget-embed/a1b2c3d4-0001-4000-8000-000000000001?' + params + '&parentUrl=' + parentUrl;
    var iframe = document.createElement('iframe');
    iframe.id = 'scaledbot-widget';
    iframe.src = src;
    iframe.style.cssText = 'position:fixed;bottom:0;right:0;width:88px;height:88px;border:none;z-index:9999;background:transparent;overflow:hidden;';
    iframe.setAttribute('allowtransparency', 'true');
    document.body.appendChild(iframe);
    window.addEventListener('message', function (event) {
      var data = event && event.data;
      if (!data || data.type !== 'scaledbot_widget_resize') return;
      if (typeof data.width === 'number') iframe.style.width = data.width + 'px';
      if (typeof data.height === 'number') iframe.style.height = data.height + 'px';
    });
  })();
</script>
"""



# ─────────────────────────────────────────────
# System prompt
# ─────────────────────────────────────────────

SYSTEM_PROMPT = """\
You are an elite web designer and conversion copywriter.
You build stunning, high-converting single-page HTML websites for any business type.

Your output is ALWAYS a single, complete, self-contained HTML file:
- All CSS in a <style> tag — no external CSS frameworks
- Google Fonts via <link> only (Playfair Display + Inter by default)
- Image references: relative paths like images/filename.ext
- Include <meta charset>, <meta viewport>, SEO <title>, <meta description>
- Include Intersection Observer scroll animations (exact code provided in the task)

Design philosophy:
- Analyze images FIRST — extract brand colors, logo aesthetic, photography style
- Build the design system around those extracted brand colors
- Premium: subtle shadows, smooth gradients, micro-animations
- High-converting: CTAs above fold, trust signals, social proof
- Fully mobile responsive: clamp() for font sizes, flex-wrap for grids

Quality bar:
- Must look BETTER than the company's current website
- No default browser styles leaking through
- Smooth scroll, sticky nav, sticky bottom CTA bar (body padding-bottom: 80px)
- Scroll animations on every section via Intersection Observer
"""


# ─────────────────────────────────────────────
# Prompt builder
# ─────────────────────────────────────────────

def build_user_message(data: dict, image_blocks: list) -> list:
    company_name = data.get("company_name", "Company")
    phone  = (data.get("contact") or data.get("key_facts") or {}).get("phone", "")
    email  = (data.get("contact") or data.get("key_facts") or {}).get("email", "")
    areas  = ", ".join((data.get("key_facts") or {}).get("service_areas", []))
    years  = (data.get("key_facts") or {}).get("years_of_service", "")
    reviews = data.get("reviews", [])

    content = [
        {
            "type": "text",
            "text": (
                f"Build a complete, stunning single-page homepage HTML for **{company_name}**.\n\n"
                f"## Company Data\n```json\n{json.dumps(data, indent=2)}\n```\n\n"
                f"## Brand Images\n"
                f"Analyze every image below. Extract brand colors, logo style, "
                f"photo mood, and company personality before writing any HTML.\n"
            ),
        }
    ]

    content.extend(image_blocks)

    content.append({
        "type": "text",
        "text": f"""
## Build Instructions

### Step 1 — Visual Analysis (think first, code second)
From the images identify:
- **Primary brand color** — dominant logo color → nav / footer / CTA banner background
- **Accent color** — secondary logo color → buttons, italic text, icons
- **Logo image** — which file is the main logo for nav + footer
- **Accreditation seals** — any certification seal images
- **People / facility photos** — best photo for the "Why Us" section
- **Photography tone** — warm / clinical / corporate → inform copy voice

###############################################################
# NAVIGATION BAR — STRICT, NON-NEGOTIABLE
###############################################################
The header navigation MUST contain exactly these 5 links, in this exact order:

  Programs | What We Treat | Why Us | About | Contact

HARD REQUIREMENTS — no exceptions:
- Do NOT add any other nav items. Forbidden examples: "Services", "How It Works",
  "Reviews", "Resources", "Blog", "Treatment", "Recovery", "Insurance", "Team", "Careers"
- Do NOT remove any of the 5 items above
- Do NOT reorder them
- Do NOT rename them — use the EXACT text including capitalization:
  "What We Treat" not "What we treat" / "What We Heal" / "Conditions"

Each nav link anchors to its corresponding section on the same page:
  Programs       → href="#programs"
  What We Treat  → href="#what-we-treat"
  Why Us         → href="#why-us"
  About          → href="#about"
  Contact        → href="#contact"

The right side of the nav (after the 5 links) MUST contain exactly these 2 CTA buttons:
  1. "Verify Insurance" — ghost/outline pill (transparent background, brand-color border + text)
  2. Phone button — solid brand-color pill with phone icon SVG, displaying the phone number

These rules OVERRIDE any visual references from the source company website.
Even if the original site had different nav items, this generated site uses ONLY the 5 above.
###############################################################

### Step 2 — 10-Section Layout (in order)

1. **Sticky Nav** — Logo + exactly 5 nav links (see NAVIGATION BAR rules above) + TWO right-side CTAs:
   - Links in order: Programs | What We Treat | Why Us | About | Contact
   - "Verify Insurance" ghost/outline pill button (border in brand primary, transparent background)
   - Phone number pill button in solid brand primary color with phone icon SVG
   - Both buttons sit side by side at the far right of the nav

2. **Hero** — Split: left = headline + CTAs, right = form card
   - Playfair Display headline: empowering phrase + italic accent line
   - 2-3 sentence sub from `overall_summary`
   - Primary CTA = call button with {phone}
   - Secondary CTA = ghost button
   - 3 trust badges (years, response time, confidentiality, CARF, etc.)
   - Right: Warm, welcoming form card (NEVER cold or clinical in tone)
     - Heading: "Get Help Today" (empathetic, never territorial)
     - Subtitle: soft confidentiality line e.g. "Take the first step. All inquiries are completely confidential."
     - Fields (REQUIRED, in this order):
       1. First Name + Last Name side by side (two equal columns)
       2. Phone Number (full width)
       3. Email Address (full width)
       4. Insurance Provider (full width text input, placeholder: "Aetna, BCBS, Cigna...")
       5. Policy Number (full width text input, placeholder: "ID# 123456789")
     - Button: full-width pill, brand primary color, warm text e.g. "Request Confidential Callback" or "Check My Coverage"
     - Below button: small lock icon SVG + "Your info is encrypted and HIPAA-compliant. Verification will not affect your premium or credit."
     - Card style: white background, 20px border radius, generous padding (32px), soft shadow, feels inviting
     - Card sizing (CRITICAL): the card container must fully wrap all fields with no clipping
       - `box-sizing: border-box` on the card and every child element
       - `width: 100%` on the card within its grid column — never a fixed pixel width that undercuts the fields
       - All form inputs must have `width: 100%` and `box-sizing: border-box` so they never overflow the card
       - The side-by-side First Name / Last Name row must use `display: flex; gap: 16px` with each input `flex: 1; min-width: 0`
       - No `overflow: hidden` on the card unless border-radius requires it — and if used, ensure padding absorbs field width
   - Hero animations: location pill=hero-animate-1, h1=hero-animate-2, sub=hero-animate-3, CTAs=hero-animate-4, form card=hero-animate-5

3. **Stats / Trust Bar** — dark strip, 3-4 key stats
   - Years stat: `<span class="count-up" data-target="{years}" data-suffix="+"></span>`

4. **Services / Programs** — `<section id="programs">` — 3-4 cards
   - Grid wrapper: `class="cards-grid stagger-children"`
   - Each card: `class="card fade-up"` + icon + title + description
   - Below the card grid: admissions help bar (centered, pale background strip)
     - Small text: "Don't see what you are looking for? Our admissions team can help."
     - Two pill buttons side by side: "Explore All Programs" (solid brand primary) + phone number (outline/ghost)
     - Both buttons: `class="fade-up"`

4b. **What We Treat** — `<section id="what-we-treat">` — conditions/addictions treated
   - 4-6 cards in a grid: `class="cards-grid stagger-children"`
   - Each card: `class="card fade-up"` + icon SVG + condition name + 1-2 sentence description
   - Source conditions from `specialties`, `services`, or `sections` in data.json
   - Common examples: Alcohol Addiction, Opioid Dependence, Dual Diagnosis, Anxiety & Depression, Prescription Drug Abuse, Trauma & PTSD

5. **About / Our Journey** — `<section id="about">` — 3 steps derived from company admission process
   - Section label: "YOUR JOURNEY" or "HOW IT WORKS" (plain uppercase, class="section-label")
   - Steps: `class="step-card fade-up"` + `class="step-num"` on number circles
   - This section serves the "About" nav anchor

5b. **Inline Action CTA** — centered block between About and Why Us
   - Single large pill button, brand primary color, phone icon SVG on the left
   - Text: "Start Step One Now" or similar action-oriented phrase
   - Subtle supporting line above it in muted text: e.g. "Ready when you are."
   - `class="fade-up"` on both the label and the button

6. **Why Us** — `<section id="why-us">` — two-column
   - Left image: `class="why-image slide-left"`
   - Right text: `class="why-content slide-right"` + 4-item checklist

7. **Reviews / Testimonials** — only if `reviews` array is non-empty
   - 2-4 quote cards: `class="card fade-up"` in `class="cards-grid stagger-children"`
   - Each card: quote text + author + star rating + source badge
   - Available reviews: {json.dumps(reviews[:4], ensure_ascii=False)}

8. **Accreditations** — seal image grid
   - Wrapper: `class="seal-grid stagger-children"`
   - Each seal: `class="seal-card scale-in"`

9. **CTA Banner + Footer** — `<section id="contact">` wraps the entire footer area
   - Dark brand-primary banner, full width, centered layout
   - Status pill at top: small pill with a pulsing green dot + "HELP IS AVAILABLE RIGHT NOW" in all caps, small text
   - Headline (Playfair Display, white, large): empowering phrase with italic accent word/phrase in accent color
     e.g. "You don't have to wait <em>another day.</em>"
   - Subtitle (white, muted opacity): 2 sentences — confidential, judgment-free, 24/7 availability
   - Two pill buttons centered side by side:
     - Primary: solid accent/teal color, phone icon SVG, "Call {phone}"
     - Ghost: outline white border, white text, "Verify Insurance Online"
   - All elements: `class="fade-up"` staggered
   - Footer grid: logo + tagline + seals | nav links | contact (phone, email, areas)
     - Nav links column lists exactly these 5 links: Programs, What We Treat, Why Us, About, Contact
   - Footer columns: `class="fade-up"` staggered

### Step 3 — Design System
- Primary color: from logo → nav, footer, CTA banner, primary buttons
- Accent: lighter secondary brand color → italic text, icons, card accents
- Pale tint: near-white version of primary → alternating section backgrounds
- Fonts: Playfair Display (headlines), Inter 300/400/500/600 (body)
- Section padding: 100px desktop / 60px mobile
- Cards: white, 16px radius, subtle shadow, 1px light border
- Buttons: pill (50px radius), 14px 28px padding
- CSS variables (REQUIRED): define `:root {{ --primary: #HEX; --accent: #HEX; --primary-tint: #HEX; }}` at the top of the style block — the chat widget reads `--primary` at runtime to match brand color
- Sticky bottom bar: 72px, brand primary, white text, phone + CTA
- Sticky bar anti-overlap (CRITICAL): the sticky bar is `position: fixed; bottom: 0; z-index: 999`
  - `body` MUST have `padding-bottom: 80px` — this is NON-NEGOTIABLE, add it directly to the body selector
  - The Stats/Trust Bar section MUST have `padding-top: 60px` AND `padding-bottom: 80px` — it often appears at the bottom of the initial viewport and the sticky bar covers it if padding is missing
  - Every full-width dark section (stats strip, CTA banner) must have `padding-bottom: 80px` minimum so the sticky bar never overlaps any text or number
  - The chat widget iframe is at `z-index: 9999` and `bottom: 0` — do NOT change this value; the widget renders above the sticky bar via z-index
- Nav logo spacing: if both a logo image AND company name text appear in the nav brand link, wrap them in `display: flex; align-items: center; gap: 8px` — never leave default inline spacing that creates a large unintended gap between the image and the text

### Step 4 — Content
- All copy from actual data.json — no generic filler
- Headline: "[Empowering phrase],\\n[italic outcome in accent]."
- Phone **{phone}** in: nav (phone button), hero CTA, services admissions bar, inline action CTA, sticky bar, CTA banner, footer
- Email **{email}** in footer
- Service areas **{areas}** in footer + hero location pill
- Company name in: <title>, <meta description>, nav logo alt, footer
- No em dashes anywhere in copy or content — use commas, colons, or plain periods instead
- No emojis anywhere in the page — use SVG icons or Unicode symbols (checkmarks, arrows) if needed

### Step 5 — Scroll Animations (REQUIRED)

Embed this EXACT CSS in your <style> block:
{ANIMATION_CSS}

Embed this EXACT JS before </body>:
{ANIMATION_JS}

Embed this EXACT chat widget before </body> (after the animation script):
{CHAT_WIDGET}

The chat widget uses `var(--primary)` and `var(--accent)` — these must match the CSS variables you define in your design system so the widget is brand-matched automatically.

Section label underline animation (REQUIRED on every section):
Every section has a small ALL-CAPS text label above the h2 (e.g. "WHY CHOOSE US", "OUR PROGRAMS", "YOUR JOURNEY", "ACCREDITATIONS", "HOW IT WORKS", "WHAT CLIENTS SAY").
CRITICAL — these labels must be PLAIN UPPERCASE TEXT ONLY. Do NOT add any background color, pill shape, badge, chip, border-radius, or padding box. No styling on the element itself — just the raw text. Apply ONLY `class="section-label"` for the underline animation.
The Intersection Observer will draw a left-to-right underline in var(--primary) when each label scrolls into view.

Animation class guide:
| Element                        | Class                            |
|--------------------------------|----------------------------------|
| Section h2 headlines           | fade-up                          |
| Section labels (plain text)    | section-label (EVERY section)    |
| Hero elements                  | hero-animate + hero-animate-1/4  |
| Card grid wrapper              | stagger-children                 |
| Each card                      | fade-up                          |
| Why Us image                   | slide-left                       |
| Why Us text block              | slide-right                      |
| About / How It Works steps     | fade-up (delay 0/0.1/0.2s)      |
| Step number circles            | step-num                         |
| Seal grid wrapper              | stagger-children                 |
| Each seal                      | scale-in                         |
| CTA banner headline            | fade-up                          |
| Stats numbers                  | count-up + data-target + suffix  |
| Footer columns                 | fade-up (stagger)                |
| Hero form card (.hero-right)   | hero-animate hero-animate-5      |

### Final Checklist
- [ ] Playfair Display hero headline + italic accent color
- [ ] Phone {phone} in nav / hero / sticky bar / CTA banner / footer
- [ ] Sticky bottom bar + body padding-bottom: 80px
- [ ] All images referenced with relative paths (images/filename.ext)
- [ ] Intersection Observer JS before </body>
- [ ] .stagger-children on all card/seal grids
- [ ] .slide-left / .slide-right on Why Us columns
- [ ] .count-up on stat numbers with data-target
- [ ] Mobile responsive: clamp() font sizes, flex-wrap grids
- [ ] No external CSS frameworks
- [ ] Hero form card (.hero-right / .verify-card) uses rise animation on page load
- [ ] Hero form card heading is warm and welcoming ("Get Help Today"), never clinical or territorial
- [ ] Hero form has all 5 required fields: First Name + Last Name (side by side), Phone, Email, Insurance Provider, Policy Number
- [ ] Hero form card background fully contains all fields — no clipping, box-sizing: border-box on card and all inputs
- [ ] body selector has padding-bottom: 80px (directly on body, not a wrapper)
- [ ] Stats/Trust Bar section has padding-top: 60px AND padding-bottom: 80px so sticky bar never overlaps it
- [ ] Nav logo image and company name text are flex-aligned with gap: 8px, no large gap between them
- [ ] No em dashes anywhere in the page copy
- [ ] No emojis anywhere in the page
- [ ] Nav has EXACTLY 5 links in order: Programs | What We Treat | Why Us | About | Contact — no more, no fewer, no renames
- [ ] Nav links point to: #programs, #what-we-treat, #why-us, #about, #contact
- [ ] Corresponding sections use those exact id attributes: id="programs", id="what-we-treat", id="why-us", id="about", id="contact"
- [ ] Nav has two right-side CTAs: "Verify Insurance" outline + phone solid pill
- [ ] Services section has admissions help bar below cards with two pill buttons
- [ ] Inline action CTA pill ("Start Step One Now") placed between How It Works and Why Us
- [ ] CTA banner has status pill, italic headline, subtitle, and two buttons (call + verify insurance ghost)

- [ ] Every section label ("WHY CHOOSE US", "OUR PROGRAMS", "YOUR JOURNEY", "ACCREDITATIONS" etc.) has class="section-label" — PLAIN UPPERCASE TEXT, no background, no pill, no border-radius, no padding box
- [ ] Chat widget iframe embedded before </body> — copy the EXACT script from Step 5 verbatim, bottom:0 right:0, do NOT modify bottom value
- [ ] images/emily.png is pre-copied to output images/ folder — widget references it via window.location.origin + '/images/emily.png'
- [ ] Chat widget uses var(--primary) and var(--accent) matching the page design system

Output ONLY the raw HTML — start with <!DOCTYPE html> end with </html>.
No markdown fences, no explanation before or after.
""",
    })

    return content


# ─────────────────────────────────────────────
# Main generator
# ─────────────────────────────────────────────

def generate_website(lead_folder: str | Path) -> Path:
    lead_path     = Path(lead_folder)
    data_path     = lead_path / "data.json"
    images_folder = lead_path / "images"
    output_path   = lead_path / "index.html"

    if not data_path.exists():
        raise FileNotFoundError(f"data.json not found in: {lead_path}")

    data         = json.loads(data_path.read_text(encoding="utf-8"))
    company_name = data.get("company_name", lead_path.name)

    print(f"\n🏢 Generating website for: {company_name}")
    print(f"📁 Lead folder: {lead_path}")

    images_folder.mkdir(parents=True, exist_ok=True)
    if EMILY_ASSET.exists():
        shutil.copy2(EMILY_ASSET, images_folder / "emily.png")

    print("🖼  Loading images...")
    image_blocks = load_images(images_folder, data.get("images", []))

    user_content = build_user_message(data, image_blocks)

    api_key = os.getenv("CLAUDE_API_KEY")
    if not api_key:
        raise ValueError("CLAUDE_API_KEY not found in .env file")

    client = anthropic.Anthropic(api_key=api_key)

    MAX_RETRIES = 2
    response = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            print(f"🤖 Sending to Claude ({MODEL})..." + (f" (attempt {attempt + 1})" if attempt else ""))
            response = client.messages.create(
                model=MODEL,
                max_tokens=MAX_TOKENS,
                system=SYSTEM_PROMPT,
                timeout=600.0,
                messages=[{"role": "user", "content": user_content}],
            )
            break
        except anthropic.RequestTooLargeError:
            raise  # 413 is not retryable — payload needs to be reduced
        except (anthropic.APIConnectionError, anthropic.APITimeoutError) as e:
            if attempt == MAX_RETRIES:
                raise
            wait = 2 ** attempt
            print(f"   ⚠  Connection error (attempt {attempt + 1}/{MAX_RETRIES + 1}): {e}")
            print(f"   Retrying in {wait}s...")
            time.sleep(wait)
        except anthropic.RateLimitError as e:
            if attempt == MAX_RETRIES:
                raise
            print(f"   ⚠  Rate limited, waiting 60s...")
            time.sleep(60)

    print("✅ Generation complete")

    input_tokens  = response.usage.input_tokens
    output_tokens = response.usage.output_tokens

    html = "".join(
        block.text for block in response.content if hasattr(block, "text")
    ).strip()
    if html.startswith("```"):
        lines = html.splitlines()
        html  = "\n".join(lines[1:-1] if lines[-1] == "```" else lines[1:]).strip()

    output_path.write_text(html, encoding="utf-8")

    cost = (input_tokens / 1_000_000 * 15) + (output_tokens / 1_000_000 * 75)
    print(f"\n✅ Website saved: {output_path}")
    print(f"📊 Tokens — input: {input_tokens:,} | output: {output_tokens:,}")
    print(f"💰 Estimated cost: ${cost:.4f}")

    return output_path


def process_all_leads():
    """Process every subfolder in the output/ directory."""
    if not OUTPUT_DIR.exists():
        print(f"Output directory not found: {OUTPUT_DIR}")
        return

    leads = [d for d in OUTPUT_DIR.iterdir() if d.is_dir()]
    print(f"📋 Found {len(leads)} lead(s) to process\n")

    for i, lead in enumerate(leads, 1):
        print(f"[{i}/{len(leads)}] Processing: {lead.name}")
        try:
            generate_website(lead)
        except Exception as e:
            print(f"   ❌ Failed: {e}")
        print()


# ─────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────

def generate_html(data_path: "Path | str", output_folder: "Path | str") -> Path:
    """Importable entry point: generate index.html from scraped data in output_folder."""
    return generate_website(Path(output_folder))


if __name__ == "__main__":
    if len(sys.argv) == 1:
        generate_website(r"d:\Video Recording\output\Cobbout Patient Detox")
    elif sys.argv[1] == "--all":
        process_all_leads()
    else:
        generate_website(sys.argv[1])
