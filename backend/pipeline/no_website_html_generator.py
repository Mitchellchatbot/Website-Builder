"""
no_website_html_generator.py
-----------------------------
Generates a fully self-contained single-page HTML website from scratch
for businesses that have NO existing website.

No scraping required — all illustrations and icons are inline SVG.
Takes: business_name, design_preferences, business_description.
"""

import os
import time
from pathlib import Path

import anthropic
from dotenv import load_dotenv

load_dotenv()

MODEL = "claude-opus-4-8"
MAX_TOKENS = 64000


SYSTEM_PROMPT = """\
You are an elite web designer and frontend developer who builds complete,
premium single-page HTML websites entirely from scratch.

Your output is ALWAYS a single, raw, self-contained HTML file:
- All CSS in a <style> tag — no external CSS frameworks
- All JavaScript in a <script> tag — no jQuery, no external JS
- Google Fonts loaded via a single <link> tag (pick fonts that match the industry)
- ALL visual art, illustrations, decorative elements, and icons as inline <svg>
- NO external images, NO <img> tags, NO icon libraries (Font Awesome, etc.)
- The file must work by opening it directly in a browser with zero network requests
  (except the single Google Fonts <link>)

Quality bar:
- Must look like a $5,000+ custom-designed website
- Commit to a distinctive color palette, typography pair, and visual motif that
  genuinely fits this specific business/industry — no generic templates
- ABSOLUTELY NO EMOJIS anywhere — every icon is a clean inline <svg>
- Mobile-first: clamp() font sizes, flex-wrap grids, hamburger nav at <768px
- Conversion-first: clear primary CTAs, trust signals, social proof

Output ONLY the raw HTML. Start with <!DOCTYPE html>, end with </html>.
No markdown fences, no explanation before or after.
"""


def _build_business_info(
    business_name: str | None,
    design_preferences: str | None,
    business_description: str | None,
) -> str:
    parts = []
    if business_name:
        parts.append(f"Business Name: {business_name}")
    if business_description:
        parts.append(f"Business Type/Description: {business_description}")
    dp = (design_preferences or "").strip()
    if dp and dp.lower() not in ("no", "nope", "n/a", "none", "na", "yes", "no idea", "testt", "test"):
        parts.append(f"Design Preferences / Special Requests: {dp}")
    return "\n".join(parts) if parts else "General business"


def generate_html_from_info(
    business_name: str | None,
    design_preferences: str | None,
    business_description: str | None,
    output_folder: "Path | str",
) -> Path:
    folder = Path(output_folder)
    folder.mkdir(parents=True, exist_ok=True)
    output_path = folder / "index.html"

    business_info = _build_business_info(business_name, design_preferences, business_description)
    display_name = business_name or business_description or "Business"

    print(f"\n[no-website] Generating site for: {display_name}")

    user_prompt = f"""Build me a single-page website for:

{business_info}

Deliver it as one self-contained HTML file (all CSS and JS inline, no external \
dependencies except Google Fonts). Use these rules:

**Self-contained art**: No external images or icon libraries. Build ALL illustrations \
and icons as inline SVG — nothing that can fail to load. The hero MUST have a themed \
SVG illustration on the right side (desktop) that reflects the industry.

**Distinct theme**: Pick a color palette, Google Fonts pair, and one signature visual \
motif that genuinely fits this industry. Do NOT reuse a generic template. Commit to a \
clear mood (bold/energetic for fitness, authoritative/serif for law, warm/inviting for \
restaurants, sleek/minimal for tech, etc.). ZERO emojis — all icons are inline SVG.

**Required sections** (all 9 must be present):
1. Sticky header: logo wordmark (text or inline SVG) + nav links + primary CTA button \
   (backdrop-blur, shadow on scroll)
2. Hero: full viewport height, headline, 2-line subtext, two CTA buttons (primary + \
   secondary), inline SVG illustration on the right (desktop) / below (mobile)
3. Services/Offerings: 3-6 cards in a responsive grid, each with inline SVG icon + \
   title + 1-2 sentence description (class="cards-grid")
4. How It Works: 3-4 numbered steps showing the customer journey
5. Why Us / Trust: 3-4 differentiators with large stat numbers + supporting copy
6. Testimonials: 2-3 realistic client quotes, name, role, inline SVG star rating (5 stars)
7. FAQ accordion: 4-6 relevant Q&A, smooth JS expand/collapse (chevron SVG rotates)
8. Contact: Name, Email, Phone, Message form + contact details using these exact \
   placeholders: [PHONE], [EMAIL], [ADDRESS]
9. Footer: logo, tagline, nav links, social icon links (inline SVG for each), copyright

**Polish**:
- Scroll-reveal animations via IntersectionObserver (.fade-up, .slide-left classes)
- Hover effects on all buttons and cards (translateY(-2px) + deeper shadow)
- Smooth transitions (cubic-bezier(0.22, 1, 0.36, 1))
- Body padding-bottom: 80px + sticky bottom CTA bar
- Responsive at <768px: stacked nav (hamburger toggle), single-column grids
- CSS custom properties (--primary, --accent, --bg, --text, --radius, --shadow)

**Content**: Write realistic, professional copy tailored to this business type. \
Use [PHONE], [EMAIL], [ADDRESS], and [PRICE] as clearly-labeled placeholders.

Output ONLY the raw HTML — start with <!DOCTYPE html>, end with </html>.
No markdown, no code fences, no explanation."""

    api_key = os.getenv("CLAUDE_API_KEY")
    if not api_key:
        raise ValueError("CLAUDE_API_KEY not found in .env")

    client = anthropic.Anthropic(api_key=api_key)

    MAX_RETRIES = 2
    response = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            print(f"[no-website] Calling {MODEL}..." + (f" (attempt {attempt + 1})" if attempt else ""))
            response = client.messages.create(
                model=MODEL,
                max_tokens=MAX_TOKENS,
                system=SYSTEM_PROMPT,
                timeout=600.0,
                messages=[{"role": "user", "content": user_prompt}],
            )
            break
        except anthropic.RequestTooLargeError:
            raise
        except (anthropic.APIConnectionError, anthropic.APITimeoutError) as e:
            if attempt == MAX_RETRIES:
                raise
            wait = 2 ** attempt
            print(f"   Connection error: {e}. Retrying in {wait}s...")
            time.sleep(wait)
        except anthropic.RateLimitError:
            if attempt == MAX_RETRIES:
                raise
            print("   Rate limited. Waiting 60s...")
            time.sleep(60)

    html = "".join(
        block.text for block in response.content if hasattr(block, "text")
    ).strip()
    if html.startswith("```"):
        lines = html.splitlines()
        html = "\n".join(lines[1:-1] if lines[-1] == "```" else lines[1:]).strip()

    output_path.write_text(html, encoding="utf-8")

    input_tokens = response.usage.input_tokens
    output_tokens = response.usage.output_tokens
    cost = (input_tokens / 1_000_000 * 15) + (output_tokens / 1_000_000 * 75)
    print(f"[no-website] Saved: {output_path}")
    print(f"   Tokens: {input_tokens:,} in / {output_tokens:,} out | ${cost:.4f}")

    return output_path
