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

# ── Cancellation state for custom-link pipelines ──────────────────────────────
# clw_id → True means "cancel this run ASAP"
_custom_cancel_flags: set[str] = set()
# clw_id → running scraper subprocess (so we can terminate it immediately)
_custom_active_procs: dict[str, subprocess.Popen] = {}


def cancel_custom_run(clw_id: str) -> None:
    """Signal cancellation for a custom pipeline run. Kills the scraper if active."""
    _custom_cancel_flags.add(clw_id)
    proc = _custom_active_procs.get(clw_id)
    if proc is not None:
        try:
            proc.terminate()
        except OSError:
            pass


# ── Cancellation state for lead pipelines ─────────────────────────────────────
_lead_cancel_flags: set[str] = set()
_lead_active_procs: dict[str, subprocess.Popen] = {}


def cancel_lead_run(lw_id: str) -> None:
    """Signal cancellation for a lead pipeline run. Kills the scraper if active."""
    _lead_cancel_flags.add(lw_id)
    proc = _lead_active_procs.get(lw_id)
    if proc is not None:
        try:
            proc.terminate()
        except OSError:
            pass


# ── Cancellation state for general-site pipelines ─────────────────────────────
_general_cancel_flags: set[str] = set()
_general_active_procs: dict[str, subprocess.Popen] = {}


def cancel_general_run(glw_id: str) -> None:
    """Signal cancellation for a general-site pipeline run. Kills the scraper if active."""
    _general_cancel_flags.add(glw_id)
    proc = _general_active_procs.get(glw_id)
    if proc is not None:
        try:
            proc.terminate()
        except OSError:
            pass


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
    Three-stage pipeline for leads: scrape → generate → (await approval) → deploy.

    After Stage 2 (generate), stops at 'awaiting_approval' so the user can preview
    the HTML before it goes live. Stage 3 (deploy) only runs when resume_from='deploy'.
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

    def _is_cancelled() -> bool:
        return lead_website_id in _lead_cancel_flags

    def _update(fields: dict) -> None:
        if not _is_cancelled():
            db.table("lead_websites").update(fields).eq("id", lead_website_id).execute()

    def _finish_cancel() -> dict:
        _lead_cancel_flags.discard(lead_website_id)
        logger.info("[%s] Cancelled by user", lead_id)
        return {"status": "cancelled"}

    try:
        # ── Stage 1: Scrape ────────────────────────────────────────────────────
        if resume_from == "scrape":
            if _is_cancelled():
                return _finish_cancel()

            logger.info("[%s] Scraping %s", lead_id, website_url)
            _update({"status": "scraping"})

            run_scraper_script = Path(__file__).parent.parent / "run_scraper.py"
            cmd = [sys.executable, str(run_scraper_script), website_url, str(output_folder), company_name or ""]
            proc = subprocess.Popen(
                cmd,
                cwd=str(Path(__file__).parent.parent),
                stderr=subprocess.PIPE,
                text=True,
            )
            _lead_active_procs[lead_website_id] = proc
            try:
                try:
                    _, stderr_text = proc.communicate(timeout=300)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.communicate()
                    raise RuntimeError("Scraper timed out after 300s")
            finally:
                _lead_active_procs.pop(lead_website_id, None)

            if _is_cancelled():
                return _finish_cancel()

            if proc.returncode != 0:
                stderr_text = (stderr_text or "").strip()
                err_msg = stderr_text
                for line in stderr_text.splitlines():
                    if "[run_scraper] FAILED:" in line:
                        err_msg = line.split("[run_scraper] FAILED:", 1)[1].strip()
                        break
                raise RuntimeError(err_msg or f"Scraper exited with code {proc.returncode}")

            if not data_path.exists():
                raise RuntimeError("Scraper finished but data.json was not created")

            _update({"status": "scraping", "scraped_data_path": str(data_path)})

        # ── Stage 2: Generate HTML ─────────────────────────────────────────────
        if resume_from in ("scrape", "generate"):
            if _is_cancelled():
                return _finish_cancel()

            logger.info("[%s] Generating HTML", lead_id)
            _update({"status": "generating"})

            if not data_path.exists():
                raise RuntimeError(f"data.json not found at {data_path} — cannot generate HTML")

            from pipeline.html_generator import generate_html
            html_path = generate_html(data_path, output_folder)

            if _is_cancelled():
                return _finish_cancel()

            # Stop here and wait for the user to review before deploying
            _update({"status": "awaiting_approval", "generated_html_path": str(html_path)})
            logger.info("[%s] HTML ready — awaiting approval", lead_id)
            return {"status": "awaiting_approval", "html_path": str(html_path)}

        # ── Stage 3: Deploy (resume_from == "deploy" only) ────────────────────
        if _is_cancelled():
            return _finish_cancel()

        logger.info("[%s] Deploying to Netlify", lead_id)
        _update({"status": "deploying"})

        if not html_path.exists():
            raise RuntimeError(f"index.html not found at {html_path} — cannot deploy")

        from pipeline.netlify_deployer import deploy_site
        site_name = f"{_slugify(company_name)}-{lead_id[:8]}"
        netlify_url, netlify_deploy_id = deploy_site(output_folder, site_name)

        if _is_cancelled():
            return _finish_cancel()

        # ── Complete ───────────────────────────────────────────────────────────
        now = datetime.now(timezone.utc).isoformat()
        _update({
            "status": "completed",
            "netlify_url": netlify_url,
            "netlify_deploy_id": netlify_deploy_id or None,
            "completed_at": now,
        })

        db.table("leads").update({
            "demo_site_url": netlify_url,
            "demo_site_generated_at": now,
        }).eq("id", lead_id).execute()

        logger.info("[%s] Pipeline complete: %s", lead_id, netlify_url)
        return {"status": "completed", "netlify_url": netlify_url}

    except Exception as exc:
        if _is_cancelled():
            return _finish_cancel()
        logger.exception("[%s] Pipeline failed: %s", lead_id, exc)
        _update({"status": "failed", "error": str(exc)})
        raise


def run_custom_pipeline(
    custom_link_id: str,
    custom_link_website_id: str,
    resume_from: str = "scrape",
) -> dict:
    """
    Three-stage pipeline for custom links: scrape → generate → (await approval) → deploy.

    Unlike the leads pipeline, stages 1+2 (scrape/generate) stop at 'awaiting_approval'
    so the user can preview the HTML before it goes live.  Stage 3 (deploy) is only
    reached when called explicitly with resume_from='deploy'.
    """
    db = get_client()

    result = db.table("custom_links").select(
        "id, url, label"
    ).eq("id", custom_link_id).limit(1).execute()

    if not result.data:
        raise ValueError(f"Custom link {custom_link_id} not found")

    cl = result.data[0]
    website_url = cl.get("url")
    label = cl.get("label") or website_url

    if not website_url and resume_from == "scrape":
        raise ValueError("Custom link has no URL")

    output_folder = OUTPUT_DIR / f"custom_{custom_link_id}"
    output_folder.mkdir(parents=True, exist_ok=True)

    data_path = output_folder / "data.json"
    html_path = output_folder / "index.html"
    netlify_url: str = ""

    def _is_cancelled() -> bool:
        return custom_link_website_id in _custom_cancel_flags

    def _update(fields: dict) -> None:
        # Don't overwrite "cancelled" status that the cancel endpoint already wrote
        if not _is_cancelled():
            db.table("custom_link_websites").update(fields).eq("id", custom_link_website_id).execute()

    def _finish_cancel() -> dict:
        _custom_cancel_flags.discard(custom_link_website_id)
        logger.info("[custom:%s] Cancelled by user", custom_link_id)
        return {"status": "cancelled"}

    try:
        # ── Stage 1: Scrape ────────────────────────────────────────────────────
        if resume_from == "scrape":
            if _is_cancelled():
                return _finish_cancel()

            logger.info("[custom:%s] Scraping %s", custom_link_id, website_url)
            _update({"status": "scraping"})

            run_scraper_script = Path(__file__).parent.parent / "run_scraper.py"
            cmd = [sys.executable, str(run_scraper_script), website_url, str(output_folder), label or ""]
            proc = subprocess.Popen(
                cmd,
                cwd=str(Path(__file__).parent.parent),
                stderr=subprocess.PIPE,
                text=True,
            )
            _custom_active_procs[custom_link_website_id] = proc
            try:
                try:
                    _, stderr_text = proc.communicate(timeout=300)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.communicate()
                    raise RuntimeError("Scraper timed out after 300s")
            finally:
                _custom_active_procs.pop(custom_link_website_id, None)

            # Cancelled mid-scrape (proc.terminate() was called)
            if _is_cancelled():
                return _finish_cancel()

            if proc.returncode != 0:
                stderr_text = (stderr_text or "").strip()
                err_msg = stderr_text
                for line in stderr_text.splitlines():
                    if "[run_scraper] FAILED:" in line:
                        err_msg = line.split("[run_scraper] FAILED:", 1)[1].strip()
                        break
                raise RuntimeError(err_msg or f"Scraper exited with code {proc.returncode}")

            if not data_path.exists():
                raise RuntimeError("Scraper finished but data.json was not created")

            _update({"status": "scraping", "scraped_data_path": str(data_path)})

        # ── Stage 2: Generate HTML ─────────────────────────────────────────────
        if resume_from in ("scrape", "generate"):
            if _is_cancelled():
                return _finish_cancel()

            logger.info("[custom:%s] Generating HTML", custom_link_id)
            _update({"status": "generating"})

            if not data_path.exists():
                raise RuntimeError(f"data.json not found at {data_path}")

            from pipeline.html_generator import generate_html
            html_path = generate_html(data_path, output_folder)

            if _is_cancelled():
                return _finish_cancel()

            # Stop here and wait for the user to review before deploying
            _update({"status": "awaiting_approval", "generated_html_path": str(html_path)})
            logger.info("[custom:%s] HTML ready — awaiting approval", custom_link_id)
            return {"status": "awaiting_approval", "html_path": str(html_path)}

        # ── Stage 3: Deploy (resume_from == "deploy" only) ────────────────────
        if _is_cancelled():
            return _finish_cancel()

        logger.info("[custom:%s] Deploying to Netlify", custom_link_id)
        _update({"status": "deploying"})

        if not html_path.exists():
            raise RuntimeError(f"index.html not found at {html_path}")

        from pipeline.netlify_deployer import deploy_site
        site_name = f"{_slugify(label)}-{custom_link_id[:8]}"
        netlify_url, netlify_deploy_id = deploy_site(output_folder, site_name)

        if _is_cancelled():
            return _finish_cancel()

        # ── Complete ───────────────────────────────────────────────────────────
        now = datetime.now(timezone.utc).isoformat()
        _update({
            "status": "completed",
            "netlify_url": netlify_url,
            "netlify_deploy_id": netlify_deploy_id or None,
            "completed_at": now,
        })

        logger.info("[custom:%s] Pipeline complete: %s", custom_link_id, netlify_url)
        return {"status": "completed", "netlify_url": netlify_url}

    except Exception as exc:
        # If we were cancelled, the exception may be from proc.terminate() — treat as cancelled
        if _is_cancelled():
            return _finish_cancel()
        logger.exception("[custom:%s] Pipeline failed: %s", custom_link_id, exc)
        _update({"status": "failed", "error": str(exc)})
        raise


def run_general_pipeline(
    general_link_id: str,
    general_link_website_id: str,
    resume_from: str = "scrape",
) -> dict:
    """
    Three-stage pipeline for general (non-behavioral-health) sites:
    scrape → generate (niche-agnostic) → (await approval) → deploy.

    Mirrors run_custom_pipeline but uses the general_html_generator module and
    the general_link_websites / general_links tables.
    """
    db = get_client()

    result = db.table("general_links").select(
        "id, url, label"
    ).eq("id", general_link_id).limit(1).execute()

    if not result.data:
        raise ValueError(f"General link {general_link_id} not found")

    gl = result.data[0]
    website_url = gl.get("url")
    label = gl.get("label") or website_url

    if not website_url and resume_from == "scrape":
        raise ValueError("General link has no URL")

    output_folder = OUTPUT_DIR / f"general_{general_link_id}"
    output_folder.mkdir(parents=True, exist_ok=True)

    data_path = output_folder / "data.json"
    html_path = output_folder / "index.html"
    netlify_url: str = ""

    def _is_cancelled() -> bool:
        return general_link_website_id in _general_cancel_flags

    def _update(fields: dict) -> None:
        if not _is_cancelled():
            db.table("general_link_websites").update(fields).eq("id", general_link_website_id).execute()

    def _finish_cancel() -> dict:
        _general_cancel_flags.discard(general_link_website_id)
        logger.info("[general:%s] Cancelled by user", general_link_id)
        return {"status": "cancelled"}

    try:
        # ── Stage 1: Scrape ────────────────────────────────────────────────────
        if resume_from == "scrape":
            if _is_cancelled():
                return _finish_cancel()

            logger.info("[general:%s] Scraping %s", general_link_id, website_url)
            _update({"status": "scraping"})

            run_scraper_script = Path(__file__).parent.parent / "run_scraper.py"
            cmd = [sys.executable, str(run_scraper_script), website_url, str(output_folder), label or ""]
            proc = subprocess.Popen(
                cmd,
                cwd=str(Path(__file__).parent.parent),
                stderr=subprocess.PIPE,
                text=True,
            )
            _general_active_procs[general_link_website_id] = proc
            try:
                try:
                    _, stderr_text = proc.communicate(timeout=300)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.communicate()
                    raise RuntimeError("Scraper timed out after 300s")
            finally:
                _general_active_procs.pop(general_link_website_id, None)

            if _is_cancelled():
                return _finish_cancel()

            if proc.returncode != 0:
                stderr_text = (stderr_text or "").strip()
                err_msg = stderr_text
                for line in stderr_text.splitlines():
                    if "[run_scraper] FAILED:" in line:
                        err_msg = line.split("[run_scraper] FAILED:", 1)[1].strip()
                        break
                raise RuntimeError(err_msg or f"Scraper exited with code {proc.returncode}")

            if not data_path.exists():
                raise RuntimeError("Scraper finished but data.json was not created")

            _update({"status": "scraping", "scraped_data_path": str(data_path)})

        # ── Stage 2: Generate HTML (general/niche-agnostic generator) ─────────
        if resume_from in ("scrape", "generate"):
            if _is_cancelled():
                return _finish_cancel()

            logger.info("[general:%s] Generating HTML", general_link_id)
            _update({"status": "generating"})

            if not data_path.exists():
                raise RuntimeError(f"data.json not found at {data_path}")

            from pipeline.general_html_generator import generate_html
            html_path = generate_html(data_path, output_folder)

            if _is_cancelled():
                return _finish_cancel()

            _update({"status": "awaiting_approval", "generated_html_path": str(html_path)})
            logger.info("[general:%s] HTML ready — awaiting approval", general_link_id)
            return {"status": "awaiting_approval", "html_path": str(html_path)}

        # ── Stage 3: Deploy (resume_from == "deploy" only) ────────────────────
        if _is_cancelled():
            return _finish_cancel()

        logger.info("[general:%s] Deploying to Netlify", general_link_id)
        _update({"status": "deploying"})

        if not html_path.exists():
            raise RuntimeError(f"index.html not found at {html_path}")

        from pipeline.netlify_deployer import deploy_site
        site_name = f"{_slugify(label)}-{general_link_id[:8]}"
        netlify_url, netlify_deploy_id = deploy_site(output_folder, site_name)

        if _is_cancelled():
            return _finish_cancel()

        now = datetime.now(timezone.utc).isoformat()
        _update({
            "status": "completed",
            "netlify_url": netlify_url,
            "netlify_deploy_id": netlify_deploy_id or None,
            "completed_at": now,
        })

        logger.info("[general:%s] Pipeline complete: %s", general_link_id, netlify_url)
        return {"status": "completed", "netlify_url": netlify_url}

    except Exception as exc:
        if _is_cancelled():
            return _finish_cancel()
        logger.exception("[general:%s] Pipeline failed: %s", general_link_id, exc)
        _update({"status": "failed", "error": str(exc)})
        raise
