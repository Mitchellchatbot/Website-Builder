"""
Chat-driven HTML editor: takes current HTML + a user instruction (optionally with a
screenshot of the issue) and returns the edited HTML, modifying only what the user asked.

Used by the Chat tab in the Preview modal for both lead websites and custom-link websites.
"""

import base64
import logging
import os
import re

import anthropic

logger = logging.getLogger(__name__)


# Matches absolute URLs that point at the backend's asset proxy, capturing the filename:
#   http://localhost:8000/custom-links/generate/<uuid>/asset/foo.webp
#   http://127.0.0.1:8000/generate/<uuid>/asset/foo.webp
# Those URLs work in the local preview iframe but are DEAD on a deployed Netlify site.
# We rewrite them to the relative `images/<filename>` path the deployer ships.
_ASSET_URL_RE = re.compile(
    r'https?://[^\s"\'<>]+/asset/([A-Za-z0-9._-]+)',
    re.IGNORECASE,
)


def rewrite_asset_urls(html: str) -> str:
    """Convert backend-proxy asset URLs into the relative `images/<file>` paths that the
    Netlify deployer ships. Safe to run on any HTML — non-matching content is untouched."""
    return _ASSET_URL_RE.sub(lambda m: f"images/{m.group(1)}", html)

MODEL = "claude-opus-4-5"
MAX_TOKENS = 64000

SYSTEM_PROMPT = """You are a precision HTML editor. The user has a working single-page website and wants to make ONE specific change.

You will receive:
1. The COMPLETE current HTML of the page.
2. The user's requested change in plain language. They may also attach a screenshot showing the issue.

ABSOLUTE RULES:
- Make ONLY the change the user explicitly requested. Do not touch anything else.
- Do not "improve", restructure, reformat, re-indent, or clean up unrelated code.
- Preserve EVERY existing image src, link href, class name, id, inline style, and attribute that is not directly the target of the user's instruction.
- Preserve the surrounding whitespace and structure of the file as much as possible.
- If the user's request is ambiguous or impossible, return the HTML completely UNCHANGED.
- Never add commentary, markdown fences, or any text outside the HTML.

ASSET PATH RULE (critical — deployment will break otherwise):
- The page is deployed to Netlify alongside an `images/` folder. Local image files live there.
- For ANY <img src=...> referencing an uploaded/local asset, use a RELATIVE path: `images/<filename>` (e.g. `images/logo.webp`).
- NEVER use `http://localhost:...`, `http://127.0.0.1:...`, or any absolute URL containing `/asset/<filename>`. Those URLs only work on the developer's local machine and will be dead on the deployed site.
- If the user pastes such a URL or refers to one, silently rewrite it to `images/<filename>` (just the basename of the file).
- External images that are genuinely hosted elsewhere (real CDN, real public URL) are fine — only rewrite local/asset proxy URLs.

OUTPUT FORMAT:
- Return ONLY the complete updated HTML document.
- The first character of your response MUST be `<` and the last MUST be `>`.
- No ```html fences. No prose. No apology. Just the HTML.
"""


def _strip_fences(text: str) -> str:
    t = text.strip()
    if t.startswith("```"):
        lines = t.splitlines()
        if lines[-1].strip() == "```":
            lines = lines[1:-1]
        else:
            lines = lines[1:]
        t = "\n".join(lines).strip()
    return t


def edit_html_with_chat(
    current_html: str,
    user_message: str,
    image_bytes: bytes | None = None,
    image_media_type: str | None = None,
) -> str:
    """
    Send the current HTML + user instruction (and optional screenshot) to Claude,
    and return the edited HTML. Caller is responsible for persisting the result.
    """
    api_key = os.getenv("CLAUDE_API_KEY")
    if not api_key:
        raise RuntimeError("CLAUDE_API_KEY not found in environment")

    user_content: list[dict] = []

    if image_bytes and image_media_type:
        user_content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": image_media_type,
                "data": base64.standard_b64encode(image_bytes).decode("utf-8"),
            },
        })

    user_content.append({
        "type": "text",
        "text": (
            f"User's requested change:\n{user_message.strip()}\n\n"
            f"--- CURRENT HTML BELOW ---\n{current_html}"
        ),
    })

    client = anthropic.Anthropic(api_key=api_key)
    logger.info("Chat-edit request: %d chars HTML, image=%s", len(current_html), bool(image_bytes))

    response = client.messages.create(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        system=SYSTEM_PROMPT,
        timeout=600.0,
        messages=[{"role": "user", "content": user_content}],
    )

    raw = "".join(block.text for block in response.content if hasattr(block, "text"))
    html = _strip_fences(raw)

    if not html.lstrip().startswith("<"):
        raise RuntimeError("Model returned non-HTML output; refusing to save.")

    return rewrite_asset_urls(html)
