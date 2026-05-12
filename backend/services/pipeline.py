import logging
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from services.supabase_client import get_client

logger = logging.getLogger(__name__)

# Resolves to backend/output/ regardless of where uvicorn is launched from
OUTPUT_DIR = Path(__file__).parent.parent / "output"


def _slugify(name: str) -> str:
    s = name.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")[:40]


def run_pipeline(
    lead_id: str,
    lead_website_id: str,
    resume_from: str = "scrape",  # 'scrape' | 'generate' | 'deploy'
) -> dict:
    """
    Synchronously runs the pipeline for one lead.
    resume_from controls which stages execute:
      'scrape'   → scrape → generate → deploy  (full run)
      'generate' → generate → deploy            (skip scrape, use existing data.json)
      'deploy'   → deploy only                  (skip scrape and generate)
    Updates lead_websites status at each active stage.
    Raises on failure — caller handles the except block.
    """
    db = get_client()

    result = db.table("leads").select(
        "id, first_name, last_name, company_name, company_website_url"
    ).eq("id", lead_id).limit(1).execute()

    if not result.data:
        raise ValueError(f"Lead {lead_id} not found")

    lead = result.data[0]
    website_url = lead.get("company_website_url")
    company_name = lead.get("company_name") or lead_id

    if not website_url and resume_from == "scrape":
        raise ValueError("Lead has no company_website_url")

    output_folder = OUTPUT_DIR / lead_id
    output_folder.mkdir(parents=True, exist_ok=True)

    data_path = output_folder / "data.json"
    html_path = output_folder / "index.html"
    netlify_url: str = ""

    try:
        # ── Stage 1: Scrape ────────────────────────────────────────────────────
        if resume_from == "scrape":
            logger.info("[%s] Scraping %s", lead_id, website_url)
            db.table("lead_websites").update({"status": "scraping"}).eq("id", lead_website_id).execute()

            run_scraper_script = Path(__file__).parent.parent / "run_scraper.py"
            cmd = [sys.executable, str(run_scraper_script), website_url, str(output_folder), company_name or ""]
            proc = subprocess.run(
                cmd,
                timeout=300,
                cwd=str(Path(__file__).parent.parent),
                stderr=subprocess.PIPE,
                text=True,
            )
            if proc.returncode != 0:
                stderr_text = (proc.stderr or "").strip()
                err_msg = stderr_text
                for line in stderr_text.splitlines():
                    if "[run_scraper] FAILED:" in line:
                        err_msg = line.split("[run_scraper] FAILED:", 1)[1].strip()
                        break
                raise RuntimeError(err_msg or f"Scraper exited with code {proc.returncode}")

            if not data_path.exists():
                raise RuntimeError("Scraper finished but data.json was not created")

            db.table("lead_websites").update({
                "status": "scraping",
                "scraped_data_path": str(data_path),
            }).eq("id", lead_website_id).execute()

        # ── Stage 2: Generate HTML ─────────────────────────────────────────────
        if resume_from in ("scrape", "generate"):
            logger.info("[%s] Generating HTML", lead_id)
            db.table("lead_websites").update({"status": "generating"}).eq("id", lead_website_id).execute()

            if not data_path.exists():
                raise RuntimeError(f"data.json not found at {data_path} — cannot generate HTML")

            from pipeline.html_generator import generate_html
            html_path = generate_html(data_path, output_folder)

            db.table("lead_websites").update({
                "status": "generating",
                "generated_html_path": str(html_path),
            }).eq("id", lead_website_id).execute()

        # ── Stage 3: Deploy ────────────────────────────────────────────────────
        logger.info("[%s] Deploying to Netlify", lead_id)
        db.table("lead_websites").update({"status": "deploying"}).eq("id", lead_website_id).execute()

        if not html_path.exists():
            raise RuntimeError(f"index.html not found at {html_path} — cannot deploy")

        from pipeline.netlify_deployer import deploy_site
        site_name = f"{_slugify(company_name)}-{lead_id[:8]}"
        netlify_url, netlify_deploy_id = deploy_site(output_folder, site_name)

        # ── Complete ───────────────────────────────────────────────────────────
        now = datetime.now(timezone.utc).isoformat()
        db.table("lead_websites").update({
            "status": "completed",
            "netlify_url": netlify_url,
            "netlify_deploy_id": netlify_deploy_id or None,
            "completed_at": now,
        }).eq("id", lead_website_id).execute()

        db.table("leads").update({
            "demo_site_url": netlify_url,
            "demo_site_generated_at": now,
        }).eq("id", lead_id).execute()

        logger.info("[%s] Pipeline complete: %s", lead_id, netlify_url)
        return {"status": "completed", "netlify_url": netlify_url}

    except Exception as exc:
        logger.exception("[%s] Pipeline failed: %s", lead_id, exc)
        db.table("lead_websites").update({
            "status": "failed",
            "error": str(exc),
        }).eq("id", lead_website_id).execute()
        raise
