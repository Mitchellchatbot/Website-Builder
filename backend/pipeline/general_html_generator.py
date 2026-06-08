"""
general_html_generator.py
-------------------------
Niche-agnostic single-page website generator.

Sibling module to html_generator.py — same scraper input (data.json + images/),
same Claude API call, same animation scaffolding, but a fully different
prompt that:
  1. Detects the business niche from the scraped data.
  2. Personalizes copy, icons, section emphasis, and color story to that niche.
  3. Always renders the required sections (Nav, Hero, About, Services, Why Us,
     Contact, Footer) and lets Claude add extra sections based on signals it
     finds in the scraped content (Menu, Portfolio, Pricing, Team, Gallery, etc.).

Importable entry point: `generate_html(data_path, output_folder)` — same
signature as pipeline/html_generator.py so services/pipeline.py can swap them
by import path.
"""

import os
import json
import time
from pathlib import Path

import anthropic
from dotenv import load_dotenv

from pipeline.html_generator import (
    ANIMATION_CSS,
    ANIMATION_JS,
    MAX_TOKENS,
    MODEL,
    load_images,
)

load_dotenv()


# ─────────────────────────────────────────────
# System prompt
# ─────────────────────────────────────────────

SYSTEM_PROMPT = """\
You are an elite web designer and conversion copywriter.
You build stunning, high-converting single-page HTML websites for any business
across any niche — restaurants, lawyers, contractors, agencies, SaaS, retail,
salons, fitness studios, consultants, real estate, e-commerce, and more.

Your output is ALWAYS a single, complete, self-contained HTML file:
- All CSS in a <style> tag — no external CSS frameworks
- Google Fonts via <link> only (pick fonts that match the detected niche)
- Image references: relative paths like images/filename.ext
- Include <meta charset>, <meta viewport>, SEO <title>, <meta description>
- Include Intersection Observer scroll animations (exact code provided in the task)

IMAGE PLACEHOLDER RULE (CRITICAL — applies everywhere):
- Every place the design calls for an image — the logo, the hero background, an
  about/story photo, a gallery, a portrait — MUST be emitted as a real <img> tag
  or a CSS background-image that references a relative path under images/.
- This is true EVEN WHEN no matching image was found in the scraped data. In that
  case, emit a sensible placeholder path (see naming convention below) plus an
  HTML comment telling the owner to swap it. The client adds the file later and it
  renders with zero code changes.
- NEVER replace an image slot with: a text-only wordmark, an inline-SVG "icon"
  standing in for a photo, a solid color, or a gradient-filled block. Gradients are
  for OVERLAYS on top of images, never as a substitute for the image itself.
- Inline <svg> is ONLY for true UI icons (nav phone icon, feature/benefit icons,
  stars, arrows). It is never a stand-in for a logo or a photographic image.

Placeholder path naming convention (use the scraped filename if one exists,
otherwise these exact fallback paths):
  - Logo            → images/logo.png
  - Hero background → images/hero-bg.jpg
  - About / story   → images/about.jpg
  - Gallery items   → images/gallery-1.jpg, images/gallery-2.jpg, ...
  - Any other photo → images/<descriptive-name>.jpg

Design philosophy:
- DETECT the business niche from the scraped data FIRST — that drives every
  subsequent decision (copy voice, font pairing, section choices, iconography,
  color palette emphasis).
- Analyze images SECOND — extract brand colors, logo aesthetic, photography style.
- Build the design system around those extracted brand colors.
- Match the design language to the niche: a law firm should feel authoritative
  and serif-heavy; a restaurant warm and image-led; a SaaS clean and modern;
  a fitness studio bold and high-energy; a contractor sturdy and trustworthy.
- Premium polish: subtle shadows, smooth gradients, micro-animations.
- Conversion-first: clear CTAs above the fold, trust signals, social proof
  where the scraped data supports it.
- Fully mobile responsive: clamp() for font sizes, flex-wrap for grids.

Quality bar:
- Must look BETTER than the company's current website.
- No default browser styles leaking through.
- Smooth scroll, sticky nav, sticky bottom CTA bar (body padding-bottom: 80px).
- Scroll animations on every section via Intersection Observer.
- **ABSOLUTELY NO EMOJIS** anywhere in the page — not in headlines, subheads,
  body copy, buttons, nav, footer, badges, trust pills, form labels, section
  titles, list bullets, or icons. Every icon MUST be an inline <svg> element.
  Emojis look amateurish on a premium business site and break the design
  language. If the scraped source data contains emojis, strip them before use.

This is NOT a behavioral-health/treatment-center site — do NOT add
HIPAA notices, insurance-verification forms, treatment-program vocabulary,
"What We Treat" sections, or similar. Use neutral, niche-appropriate language.
"""


# ─────────────────────────────────────────────
# Prompt builder
# ─────────────────────────────────────────────

def build_user_message(data: dict, image_blocks: list) -> list:
    company_name = data.get("company_name", "Company")
    contact      = data.get("contact") or {}
    key_facts    = data.get("key_facts") or {}
    phone        = contact.get("phone") or key_facts.get("phone") or ""
    email        = contact.get("email") or key_facts.get("email") or ""
    address      = contact.get("address") or key_facts.get("address") or ""

    content = [
        {
            "type": "text",
            "text": (
                f"Build a complete, stunning single-page homepage HTML for **{company_name}**.\n\n"
                f"## Company Data\n```json\n{json.dumps(data, indent=2)}\n```\n\n"
                f"## Brand Images\n"
                f"Analyze every image below. Extract brand colors, logo style, "
                f"photo mood, and company personality. Then identify the business "
                f"niche from BOTH the images and the scraped data before writing any HTML.\n"
            ),
        }
    ]

    content.extend(image_blocks)

    content.append({
        "type": "text",
        "text": f"""
## Build Instructions

### Step 1 — Niche Detection (think first, code second)
From the scraped data (services, sections, page text, meta description) AND
the images, identify:
- Business niche — one short label, e.g. "italian restaurant", "personal injury
  law firm", "boutique fitness studio", "B2B SaaS analytics", "residential
  roofing contractor".
- Tone — formal / friendly / luxury / playful / utilitarian / authoritative.
- Primary visitor goal — book a table, request a quote, schedule a consult,
  start a free trial, browse products, etc. -> this becomes your hero CTA.
- Secondary goal — call, email, view menu/portfolio, learn more, etc.

### Step 2 — Visual Analysis
From the images identify:
- Primary brand color — dominant logo color -> nav / footer / CTA backgrounds.
- Accent color — secondary logo color -> buttons, highlights, icons.
- Logo image — which file is the main logo (if none, use images/logo.png).
- Photography tone — warm / clinical / corporate / lifestyle / editorial.
- Font pairing — Google Fonts that match the niche (serif display for law/luxury,
  modern sans for SaaS/agency, warm humanist for restaurants/wellness, condensed
  bold for fitness/automotive, etc.).

### IMAGE PLACEHOLDER RULE (CRITICAL — applies to every image slot)
Every image slot — logo, hero background, about/story photo, gallery, portrait —
is ALWAYS a real <img> tag or a CSS background-image referencing a relative path
under images/, EVEN WHEN no matching image was scraped. When none exists, emit a
placeholder path plus an HTML comment to swap it, so the client drops the file in
later with zero code changes.
- NEVER substitute text, an inline-SVG icon, a solid color, or a gradient block
  for an image slot. Gradients are OVERLAYS on images, never replacements.
- Inline <svg> is only for true UI icons (phone, feature icons, stars, arrows).
Placeholder naming (use scraped filename if it exists, else these):
  Logo -> images/logo.png | Hero -> images/hero-bg.jpg | About -> images/about.jpg
  Gallery -> images/gallery-1.jpg, images/gallery-2.jpg, ... | Other -> images/<name>.jpg

###############################################################
# REQUIRED SECTIONS — non-negotiable structure
###############################################################
The page MUST contain these sections in this order, with these exact ids:
  1. <nav>                   sticky top navigation
  2. <section id="home">     hero
  3. <section id="about">    about
  4. <section id="services"> services / offerings / products
  5. <section id="why-us">   why choose us / differentiators
  6. <section id="contact">  contact
  7. <footer>                footer
Nav links MUST anchor to: #home, #about, #services, #why-us, #contact.

###############################################################
# DYNAMIC EXTRA SECTIONS — Claude's call
###############################################################
Between "Why Us" and "Contact", you MAY add 1–3 extra sections ONLY if the scraped
data clearly supports them (Menu, Portfolio/Gallery, Practice Areas, Pricing, Team,
Testimonials [reviews array has 2+ usable items], FAQ, Process/How It Works,
Case Studies). Do NOT invent content for an extra section. Skip it instead.
Required sections are required regardless.

### Step 3 — Section-by-Section Content Rules

1. Nav — Logo on the LEFT as a REAL <img>, ALWAYS (never text-only, never an SVG icon):
     <a href="#home" class="nav-logo">
       <!-- swap images/logo.png for the real logo when available -->
       <img src="images/logo.png" alt="{company_name} logo" />
       <span class="nav-logo-text">{company_name}</span>
     </a>
     .nav-logo {{ display:flex; align-items:center; gap:10px; flex-shrink:0; }}
     .nav-logo img {{ height:46px; width:auto; display:block; }}
   Use the scraped logo filename if detected; otherwise images/logo.png. The text
   wordmark is optional and NEVER replaces the <img>. Repeat the same <img> logo in
   the footer. Then 5 nav links (Home | About | Services | Why Us | Contact) +
   right-side niche CTA ("Book a Table", "Get a Quote", "Schedule a Consult",
   "Start Free Trial", "Call Now" with phone <svg> if a phone exists). Sticky,
   backdrop-blur, shadow-on-scroll.

2. Hero — Split layout: LEFT = copy + CTAs, RIGHT = lead-capture form card.
   - Background — the hero ALWAYS uses a background-image layered UNDER a brand
     gradient overlay. The gradient is the overlay, NOT a replacement.
     - Use the best scraped photo's relative path if available; otherwise still
       emit images/hero-bg.jpg with a swap comment. Never ship a gradient-only hero.
     - Keep the overlay TRANSLUCENT so the photo reads through: darkest stop ~0.84
       on the text side, falling to ~0.40 on the form side. NEVER a near-opaque
       (0.9+) flat overlay (that hides the image). Add text-shadow to hero h1/subhead.
       Reference (convert brand primary to rgb for mid/late stops):
         #home {{
           position:relative; min-height:92vh; display:flex; align-items:center;
           overflow:hidden;
           background-image:
             linear-gradient(100deg, rgba(20,8,4,0.84) 0%,
               rgba(R,G,B,0.62) 55%, rgba(R,G,B,0.40) 100%),
             url('images/hero-bg.jpg');   /* swap for real photo when available */
           background-size:cover; background-position:center; background-repeat:no-repeat;
         }}
         .hero-h1, .hero-sub {{ text-shadow:0 2px 16px rgba(0,0,0,0.28); }}
   - NO foreground product/photo cutout on the right — that slot is the form card.
   - Left column (this DOM order + animation classes):
     - Eyebrow trust pill (years in business, since YYYY, locations, awards)
       -> class="hero-animate hero-animate-1"
     - h1 tailored to niche + primary goal -> class="hero-animate hero-animate-2"
     - 1–2 sentence subhead from overall_summary/about -> class="hero-animate hero-animate-3"
     - Two CTAs (primary solid = primary goal, secondary outline) -> class="hero-animate hero-animate-4"
     - Optional row of 3 trust badges (inline-svg icon + short label).
   - Right column — Form Card -> class="hero-animate hero-animate-5"
     - Near-white card, ~20px radius, 32px padding, soft shadow.
     - Heading: short niche CTA ("Get a Free Quote", "Book Your Table", "Get Pricing").
     - Subtitle: one reassurance line ("We'll reply within 24 hours").
     - 3–5 niche-appropriate fields (pick to match the conversion):
         Restaurant -> Name, Phone, Date & Time, Party Size
         Law/Consult -> Name, Email, Phone, Case Type (select), short Message
         Contractor -> Name, Phone, Zip, Service Needed (select), Project details
         SaaS/B2B -> Work Email, Name, Company, Team Size (select), Use case
         E-commerce -> Name, Email, Product (select), Quantity, Notes
         Real estate -> Name, Email, Phone, Budget (select), Locations
         Salon/Wellness -> Name, Phone, Preferred Service (select), Preferred Date
         Agency -> Name, Work Email, Company, Project Type (select), Budget
         Fitness -> Name, Email, Phone, Goal (select)
         Fallback -> Name, Email, Phone, How can we help? (textarea)
     - Field rules: full-width single Name field unless two columns clearly read
       better; every input width:100% + box-sizing:border-box, ~12px padding,
       brand-color focus ring; <select> for fixed option sets; <textarea rows="3">
       for open questions. Side-by-side inputs: display:flex; gap:16px; each
       flex:1; min-width:0.
     - Submit: full-width pill, solid brand primary, warm CTA ("Request a Quote",
       "Book Now", "Get Pricing") — NOT generic "Submit".
     - Below button: small muted reassurance ("We respect your privacy...").
     - Card MUST fully wrap its fields (box-sizing:border-box on card + children,
       width:100% in its grid/flex column).
   - NO behavioral-health / insurance / HIPAA fields.
   - Mobile <768px: form card stacks BELOW the left column; background image stays.

3. About — 2–3 paragraph story from scraped about/summary. Weave in founding year,
   location, team size, tagline if present. Pair with a REAL <img> portrait/lifestyle
   photo (scraped filename or images/about.jpg placeholder + swap comment), styled:
     .about-img {{ width:100%; aspect-ratio:4/3; object-fit:cover;
                  border-radius:var(--radius); display:block; }}
   NEVER use a gradient block or large decorative SVG in place of the photo.

4. Services — <section id="services"> — 3–6 cards in a responsive grid.
   - Grid: class="cards-grid stagger-children". Each card: class="card fade-up" +
     inline-SVG icon (NO emoji) + title + 1–2 sentence description.
   - Pull from services/specialties/sections/offerings. If only 1–2 services exist,
     expand into 3–4 sub-offerings rather than leaving the grid sparse.

5. Why Us — <section id="why-us"> — 3–4 differentiators (cards or alternating
   blocks). Pull from trust signals: years, awards, certifications, team size,
   specialties, guarantees, USPs. Each: short headline + 1–2 sentence support.

6. (Optional extras — see Dynamic Extra Sections. Any photo in them is a real <img>
   with a relative path, per the Image Placeholder Rule.)

7. Contact — <section id="contact"> — split layout:
   - Left: real details — phone ({phone or "TBD"}), email ({email or "TBD"}),
     address ({address or "TBD"}), hours if scraped.
   - Right: simple contact form, fields appropriate to the niche (default Name,
     Email, Phone optional, Message). Submit in brand primary with warm CTA.
   - NO insurance/policy fields, NO HIPAA copy, NO compliance notices.

8. Footer — Logo <img> + tagline (left), nav repeat (center), contact + socials
   (right). Bottom strip: (c) {company_name} {{current year}}. All rights reserved.
   Optional small muted "Powered by ..." line.

### Step 4 — Design System (CSS variables)
At the top of <style>, define:
  :root {{
    --primary:  <extracted primary brand color>;
    --accent:   <extracted accent color>;
    --bg:       <near-white or warm off-white page background>;
    --surface:  <card background>;
    --text:     <primary text color>;
    --muted:    <secondary text color>;
    --border:   <subtle border color>;
    --radius:   16px;
    --shadow:   0 8px 24px rgba(0,0,0,0.06);
  }}
Apply consistently. NEVER hardcode hex values mid-stylesheet.

CENTERED SECTION HEADERS (required — prevents the tag pill sitting on the heading's
line): .section-label is display:inline-block so its underline sizes to the text,
which makes an inline-block .section-tag pill share the heading's line in a centered
header. Make every centered .section-header a centered flex column so the tag,
heading, and subtext each get their own line:
  .section-header {{ display:flex; flex-direction:column; align-items:center;
                    text-align:center; margin-bottom:56px; }}
Left-aligned headers (e.g. inside a 2-column About) are unaffected.

STICKY BOTTOM CTA (required — keeps it aligned with the page): the colored bar is
full width, but its content is wrapped in a max-width inner container matching the
nav/section width and centered:
  <div class="sticky-cta"><div class="sticky-cta-inner"> ...content... </div></div>
  .sticky-cta {{ position:fixed; left:0; right:0; bottom:0; z-index:999;
                background:var(--primary); padding:14px 24px; }}
  .sticky-cta-inner {{ max-width:1200px; margin:0 auto; width:100%; display:flex;
                      align-items:center; justify-content:space-between; gap:16px; }}
Use the SAME max-width as the nav/section container.

### Step 5 — Scroll Animations
Include this CSS verbatim inside <style>:
{ANIMATION_CSS}
Include this JS verbatim before </body>:
{ANIMATION_JS}
Apply animation classes generously: every section title gets section-label, every
card gets fade-up, card grids get stagger-children on the wrapper, hero elements
get hero-animate-N.

### Step 6 — Self-Check Before Returning
- [ ] All 7 required sections present with the exact ids; nav links match.
- [ ] Hero is a 2-column split: left copy + CTAs, right lead-capture form card.
- [ ] Logo is a real <img> in nav AND footer (placeholder path if none scraped),
      never text-only and never an inline-SVG icon.
- [ ] Hero has a background-image (real path or images/hero-bg.jpg) UNDER a
      translucent overlay (darkest <= ~0.85, ~0.40 on the form side); hero text
      has text-shadow.
- [ ] .section-header is a centered flex column (tag pill ABOVE heading, not inline).
- [ ] Sticky CTA content is wrapped in a max-width inner container.
- [ ] Every in-section photo is a real <img>/background with a relative path
      (placeholder if needed); no gradient blocks or SVG icons standing in for images.
- [ ] All placeholder image paths follow the naming convention and have a swap comment.
- [ ] Hero form has 3–5 niche-appropriate fields and a niche-appropriate submit CTA.
- [ ] ZERO emojis anywhere; every icon is an inline <svg>.
- [ ] No behavioral-health / insurance / HIPAA language anywhere.
- [ ] Brand colors driven by extracted logo colors, not generic blues/purples.
- [ ] Font pairing matches the niche.
- [ ] At least one above-the-fold CTA uses the visitor's primary goal verb.
- [ ] Every section has a section-label and at least one animated element.
- [ ] Mobile: clamp() font sizing, flex-wrap grids, hamburger/stacked nav at <768px.
- [ ] Body has padding-bottom: 80px for the sticky CTA bar.
- [ ] No chat widget, no third-party embeds — fully self-contained.

Output ONLY the raw HTML — start with <!DOCTYPE html>, end with </html>.
No markdown fences, no explanation before or after.
""",
    })

    return content


# ─────────────────────────────────────────────
# Main generator
# ─────────────────────────────────────────────

def generate_website(output_folder: "Path | str") -> Path:
    folder        = Path(output_folder)
    data_path     = folder / "data.json"
    images_folder = folder / "images"
    output_path   = folder / "index.html"

    if not data_path.exists():
        raise FileNotFoundError(f"data.json not found in: {folder}")

    data         = json.loads(data_path.read_text(encoding="utf-8"))
    company_name = data.get("company_name", folder.name)

    print(f"\n🏢 [general] Generating website for: {company_name}")
    print(f"📁 Folder: {folder}")

    images_folder.mkdir(parents=True, exist_ok=True)

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
            raise
        except (anthropic.APIConnectionError, anthropic.APITimeoutError) as e:
            if attempt == MAX_RETRIES:
                raise
            wait = 2 ** attempt
            print(f"   ⚠  Connection error (attempt {attempt + 1}/{MAX_RETRIES + 1}): {e}")
            print(f"   Retrying in {wait}s...")
            time.sleep(wait)
        except anthropic.RateLimitError:
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


# ─────────────────────────────────────────────
# Entry point (matches html_generator.generate_html signature)
# ─────────────────────────────────────────────

def generate_html(data_path: "Path | str", output_folder: "Path | str") -> Path:
    """Importable entry point: generate index.html from scraped data in output_folder."""
    return generate_website(Path(output_folder))