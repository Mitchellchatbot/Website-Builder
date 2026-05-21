import base64
import logging
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel

from services.supabase_client import get_client
from services.pipeline import OUTPUT_DIR, cancel_lead_run, run_pipeline
from services.html_chat_editor import edit_html_with_chat, rewrite_asset_urls

router = APIRouter()
logger = logging.getLogger(__name__)

CONSECUTIVE_FAILURE_THRESHOLD = 4


class GenerateRequest(BaseModel):
    lead_id: str


class BatchGenerateRequest(BaseModel):
    lead_ids: list[str]


def _run_batch(pairs: list[tuple[str, str]], resume_from: str = "scrape") -> None:
    """
    Serial background worker — processes leads one at a time.

    Halts the batch if CONSECUTIVE_FAILURE_THRESHOLD leads fail in a row,
    marking remaining leads as 'skipped' in the DB.

    KNOWN LIMITATION: If uvicorn restarts while this is running,
    in-flight rows are stranded with their last status (e.g. 'scraping') and
    no auto-recovery occurs.
    """
    total = len(pairs)
    succeeded = 0
    failed = 0
    skipped = 0
    consecutive_failures = 0
    failed_leads: list[dict] = []
    batch_halted = False

    logger.info("━━━ Batch started: %d lead(s) ━━━", total)

    for index, (lead_id, lead_website_id) in enumerate(pairs, start=1):
        if batch_halted:
            try:
                db = get_client()
                db.table("lead_websites").update({
                    "status": "skipped",
                    "error": f"Batch halted after {CONSECUTIVE_FAILURE_THRESHOLD} consecutive failures",
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                }).eq("id", lead_website_id).execute()
            except Exception:
                logger.exception("Failed to mark lead_website %s as skipped", lead_website_id)
            skipped += 1
            continue

        logger.info("[%d/%d] Starting lead %s", index, total, lead_id)
        start = time.monotonic()

        try:
            result = run_pipeline(lead_id, lead_website_id, resume_from=resume_from)
            duration = round(time.monotonic() - start)
            if isinstance(result, dict) and result.get("status") in ("cancelled", "awaiting_approval"):
                logger.info("[%d/%d] ⏸ %s after %ds", index, total, result.get("status"), duration)
                continue
            logger.info("[%d/%d] ✅ Completed in %ds", index, total, duration)
            succeeded += 1
            consecutive_failures = 0
        except Exception as e:
            duration = round(time.monotonic() - start)
            logger.error("[%d/%d] ❌ Failed after %ds: %s", index, total, duration, e)
            failed += 1
            failed_leads.append({"lead_id": lead_id, "error": str(e)})
            consecutive_failures += 1

            if consecutive_failures >= CONSECUTIVE_FAILURE_THRESHOLD:
                logger.error(
                    "━━━ BATCH HALTED: %d consecutive failures. "
                    "Skipping remaining %d lead(s). ━━━",
                    CONSECUTIVE_FAILURE_THRESHOLD,
                    total - index,
                )
                batch_halted = True

    logger.info("━━━ Batch finished ━━━")
    logger.info("  Total:      %d", total)
    logger.info("  ✅ Done:    %d", succeeded)
    logger.info("  ❌ Failed:  %d", failed)
    logger.info("  ⏭ Skipped: %d", skipped)
    if batch_halted:
        logger.warning("  ⚠ Batch was halted due to consecutive failures")
    for fl in failed_leads:
        logger.info("    ✗ %s: %s", fl["lead_id"], fl["error"])


@router.post("/generate")
def generate(req: GenerateRequest, background_tasks: BackgroundTasks):
    db = get_client()

    result = db.table("leads").select(
        "id, company_name, company_website_url"
    ).eq("id", req.lead_id).limit(1).execute()

    if not result.data:
        raise HTTPException(status_code=404, detail="Lead not found")

    lead = result.data[0]
    if not lead.get("company_website_url"):
        raise HTTPException(status_code=400, detail="Lead has no company_website_url")

    insert_result = db.table("lead_websites").insert({
        "lead_id": req.lead_id,
        "status": "pending",
    }).execute()

    lead_website_id = insert_result.data[0]["id"]

    background_tasks.add_task(_run_batch, [(req.lead_id, lead_website_id)])

    return {"lead_website_id": lead_website_id, "status": "pending"}


@router.post("/generate/batch")
def generate_batch(req: BatchGenerateRequest, background_tasks: BackgroundTasks):
    if not req.lead_ids:
        raise HTTPException(status_code=400, detail="lead_ids must not be empty")

    db = get_client()

    leads_result = db.table("leads").select(
        "id, company_name, company_website_url"
    ).in_("id", req.lead_ids).execute()

    leads_by_id = {l["id"]: l for l in (leads_result.data or [])}

    errors = []
    for lead_id in req.lead_ids:
        if lead_id not in leads_by_id:
            errors.append(f"{lead_id}: not found")
        elif not leads_by_id[lead_id].get("company_website_url"):
            errors.append(f"{lead_id}: no company_website_url")

    if errors:
        raise HTTPException(status_code=400, detail="; ".join(errors))

    rows = [{"lead_id": lead_id, "status": "pending"} for lead_id in req.lead_ids]
    insert_result = db.table("lead_websites").insert(rows).execute()

    # Preserve requested order when pairing lead_id → lead_website_id
    inserted_by_lead = {}
    for row in insert_result.data:
        inserted_by_lead.setdefault(row["lead_id"], []).append(row["id"])

    pairs: list[tuple[str, str]] = []
    lw_ids: list[str] = []
    for lead_id in req.lead_ids:
        lw_id = inserted_by_lead[lead_id].pop(0)
        pairs.append((lead_id, lw_id))
        lw_ids.append(lw_id)

    background_tasks.add_task(_run_batch, pairs)

    queued = [
        {"lead_id": lead_id, "lead_website_id": lw_id, "status": "pending"}
        for lead_id, lw_id in pairs
    ]
    return {"queued": queued}


@router.get("/generate/batch/status")
def get_batch_status(ids: str = Query(..., description="Comma-separated lead_website_ids")):
    id_list = [i.strip() for i in ids.split(",") if i.strip()]
    if not id_list:
        raise HTTPException(status_code=400, detail="ids param is required")

    db = get_client()

    lw_result = db.table("lead_websites").select(
        "id, lead_id, status, netlify_url, error"
    ).in_("id", id_list).execute()

    rows_by_id = {row["id"]: row for row in (lw_result.data or [])}

    lead_ids = list({row["lead_id"] for row in rows_by_id.values()})
    leads_result = db.table("leads").select(
        "id, first_name, last_name, company_name"
    ).in_("id", lead_ids).execute()
    leads_by_id = {l["id"]: l for l in (leads_result.data or [])}

    enriched = []
    for lw_id in id_list:
        if lw_id not in rows_by_id:
            continue
        row = rows_by_id[lw_id]
        lead = leads_by_id.get(row["lead_id"], {})
        first = lead.get("first_name") or ""
        last = lead.get("last_name") or ""
        name = f"{first} {last}".strip() or lead.get("company_name") or "—"
        enriched.append({
            **row,
            "lead_name": name,
            "company_name": lead.get("company_name") or "—",
        })

    return enriched


@router.post("/generate/{lead_website_id}/retry")
def retry_generation(lead_website_id: str, background_tasks: BackgroundTasks):
    db = get_client()

    result = db.table("lead_websites").select("*").eq("id", lead_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Generation run not found")

    lw = result.data[0]
    if lw["status"] != "failed":
        raise HTTPException(status_code=400, detail="Only failed runs can be retried")

    # Determine where to resume: skip scrape if data.json is already on disk
    scraped_data_path = lw.get("scraped_data_path")
    if scraped_data_path and Path(scraped_data_path).exists():
        resume_from = "generate"
    else:
        resume_from = "scrape"

    db.table("lead_websites").update({
        "status": "pending",
        "error": None,
        "completed_at": None,
        "netlify_url": None,
    }).eq("id", lead_website_id).execute()

    background_tasks.add_task(_run_batch, [(lw["lead_id"], lead_website_id)], resume_from)

    return {"status": "pending", "lead_website_id": lead_website_id}


@router.get("/generate/{lead_website_id}")
def get_generation_status(lead_website_id: str):
    db = get_client()

    result = db.table("lead_websites").select("*").eq("id", lead_website_id).limit(1).execute()

    if not result.data:
        raise HTTPException(status_code=404, detail="Generation run not found")

    lw = result.data[0]

    lead_result = db.table("leads").select(
        "id, first_name, last_name, company_name, company_website_url"
    ).eq("id", lw["lead_id"]).limit(1).execute()

    lead = lead_result.data[0] if lead_result.data else {}
    first = lead.get("first_name") or ""
    last = lead.get("last_name") or ""
    name = f"{first} {last}".strip() or lead.get("company_name") or "—"

    return {
        **lw,
        "lead": {
            "id": lead.get("id"),
            "name": name,
            "company_name": lead.get("company_name"),
            "company_website_url": lead.get("company_website_url"),
        },
    }


_MIME_MAP = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
             "gif": "image/gif", "webp": "image/webp"}


class UpdateHtmlRequest(BaseModel):
    html: str


@router.post("/generate/{lead_website_id}/upload-asset")
async def upload_lead_asset(lead_website_id: str, file: UploadFile = File(...)):
    safe = os.path.basename(file.filename or "upload")
    ext = safe.rsplit(".", 1)[-1].lower() if "." in safe else ""
    if not safe or ext not in _MIME_MAP:
        raise HTTPException(status_code=400, detail=f"Unsupported or missing file type")

    db = get_client()
    result = db.table("lead_websites").select("lead_id").eq("id", lead_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    lead_id = result.data[0]["lead_id"]
    images_dir = OUTPUT_DIR / lead_id / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    contents = await file.read()
    (images_dir / safe).write_bytes(contents)
    return {"filename": safe, "size": len(contents)}


@router.post("/generate/{lead_website_id}/cancel")
def cancel_lead(lead_website_id: str):
    db = get_client()
    result = db.table("lead_websites").select(
        "id, status, lead_id"
    ).eq("id", lead_website_id).limit(1).execute()

    if not result.data:
        raise HTTPException(status_code=404, detail="Generation run not found")

    lw = result.data[0]
    active = {"pending", "scraping", "generating", "deploying"}
    if lw["status"] not in active:
        raise HTTPException(
            status_code=400,
            detail=f"Run is not active (status: '{lw['status']}')",
        )

    cancel_lead_run(lead_website_id)

    db.table("lead_websites").update({
        "status": "cancelled",
        "error": "Cancelled by user",
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", lead_website_id).execute()

    return {"cancelled": True}


@router.post("/generate/{lead_website_id}/deploy")
def deploy_lead(lead_website_id: str, background_tasks: BackgroundTasks):
    db = get_client()
    result = db.table("lead_websites").select("*").eq("id", lead_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    lw = result.data[0]
    if lw["status"] not in ("awaiting_approval", "cancelled"):
        raise HTTPException(
            status_code=400,
            detail=f"Can only deploy from 'awaiting_approval' or 'cancelled' status (current: '{lw['status']}')",
        )

    html_path = lw.get("generated_html_path")
    if not html_path or not Path(html_path).exists():
        raise HTTPException(status_code=400, detail="Generated HTML not found — regenerate first")

    db.table("lead_websites").update({"status": "pending"}).eq("id", lead_website_id).execute()

    background_tasks.add_task(_run_batch, [(lw["lead_id"], lead_website_id)], "deploy")
    return {"status": "pending", "lead_website_id": lead_website_id}


@router.get("/generate/{lead_website_id}/preview", response_class=HTMLResponse)
def preview_lead_html(lead_website_id: str):
    db = get_client()
    result = db.table("lead_websites").select(
        "status, generated_html_path"
    ).eq("id", lead_website_id).limit(1).execute()

    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    html_path_str = result.data[0].get("generated_html_path")
    if not html_path_str or not Path(html_path_str).exists():
        raise HTTPException(status_code=404, detail="HTML not yet generated — run the pipeline first")

    html_path = Path(html_path_str)
    html = html_path.read_text(encoding="utf-8")

    def _inline(match: re.Match) -> str:
        src = match.group(1)
        img_file = html_path.parent / src
        if img_file.exists():
            ext = img_file.suffix.lower().lstrip(".")
            mime = _MIME_MAP.get(ext, "image/png")
            data = base64.standard_b64encode(img_file.read_bytes()).decode()
            return f'src="data:{mime};base64,{data}"'
        return match.group(0)

    html = re.sub(r'src="(images/[^"]+)"', _inline, html)
    return HTMLResponse(content=html)


@router.get("/generate/{lead_website_id}/assets")
def get_lead_assets(lead_website_id: str):
    db = get_client()
    result = db.table("lead_websites").select("lead_id").eq("id", lead_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    lead_id = result.data[0]["lead_id"]
    images_dir = OUTPUT_DIR / lead_id / "images"

    if not images_dir.exists():
        return {"assets": []}

    assets = [
        {"filename": f.name, "size": f.stat().st_size}
        for f in sorted(images_dir.iterdir())
        if f.is_file() and f.suffix.lower().lstrip(".") in _MIME_MAP
    ]
    return {"assets": assets}


@router.get("/generate/{lead_website_id}/asset/{filename}")
def get_lead_asset_file(lead_website_id: str, filename: str):
    safe = os.path.basename(filename)
    if not safe or safe != filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    db = get_client()
    result = db.table("lead_websites").select("lead_id").eq("id", lead_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    lead_id = result.data[0]["lead_id"]
    img_path = OUTPUT_DIR / lead_id / "images" / safe

    if not img_path.exists() or not img_path.is_file():
        raise HTTPException(status_code=404, detail="Asset not found")

    return FileResponse(str(img_path))


@router.get("/generate/{lead_website_id}/html")
def get_lead_html(lead_website_id: str):
    db = get_client()
    result = db.table("lead_websites").select("generated_html_path").eq("id", lead_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    html_path_str = result.data[0].get("generated_html_path")
    if not html_path_str or not Path(html_path_str).exists():
        raise HTTPException(status_code=404, detail="HTML not yet generated")

    html_path = Path(html_path_str)
    html = html_path.read_text(encoding="utf-8")
    can_undo = html_path.with_suffix(html_path.suffix + ".bak").exists()
    return {"html": html, "can_undo": can_undo}


@router.put("/generate/{lead_website_id}/html")
def update_lead_html(lead_website_id: str, req: UpdateHtmlRequest):
    db = get_client()
    result = db.table("lead_websites").select("generated_html_path").eq("id", lead_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    html_path_str = result.data[0].get("generated_html_path")
    if not html_path_str:
        raise HTTPException(status_code=404, detail="HTML path not set — run generation first")

    html_path = Path(html_path_str)
    html_path.parent.mkdir(parents=True, exist_ok=True)
    if html_path.exists():
        html_path.with_suffix(html_path.suffix + ".bak").write_text(
            html_path.read_text(encoding="utf-8"), encoding="utf-8"
        )
    html_path.write_text(rewrite_asset_urls(req.html), encoding="utf-8")
    return {"saved": True}


@router.post("/generate/{lead_website_id}/chat-edit")
async def chat_edit_lead_html(
    lead_website_id: str,
    message: str = Form(...),
    image: UploadFile | None = File(default=None),
):
    """Apply a chat-driven edit to the generated HTML. Saves a single-step undo backup."""
    db = get_client()
    result = db.table("lead_websites").select("generated_html_path").eq("id", lead_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    html_path_str = result.data[0].get("generated_html_path")
    if not html_path_str or not Path(html_path_str).exists():
        raise HTTPException(status_code=404, detail="HTML not yet generated")

    if not message.strip():
        raise HTTPException(status_code=400, detail="Message is required")

    html_path = Path(html_path_str)
    current_html = html_path.read_text(encoding="utf-8")

    image_bytes: bytes | None = None
    image_media_type: str | None = None
    if image is not None:
        ext = (image.filename or "").rsplit(".", 1)[-1].lower() if image.filename and "." in image.filename else ""
        if ext not in _MIME_MAP:
            raise HTTPException(status_code=400, detail="Unsupported image type")
        image_bytes = await image.read()
        image_media_type = _MIME_MAP[ext]

    try:
        new_html = edit_html_with_chat(current_html, message, image_bytes, image_media_type)
    except Exception as exc:
        logger.exception("Chat edit failed for %s", lead_website_id)
        raise HTTPException(status_code=502, detail=f"Edit failed: {exc}") from exc

    html_path.with_suffix(html_path.suffix + ".bak").write_text(current_html, encoding="utf-8")
    html_path.write_text(new_html, encoding="utf-8")
    return {"saved": True, "html": new_html, "can_undo": True}


@router.post("/generate/{lead_website_id}/undo")
def undo_lead_html(lead_website_id: str):
    """Restore the previous HTML from the single-step .bak backup."""
    db = get_client()
    result = db.table("lead_websites").select("generated_html_path").eq("id", lead_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    html_path_str = result.data[0].get("generated_html_path")
    if not html_path_str:
        raise HTTPException(status_code=404, detail="HTML path not set")

    html_path = Path(html_path_str)
    bak_path = html_path.with_suffix(html_path.suffix + ".bak")
    if not bak_path.exists():
        raise HTTPException(status_code=404, detail="Nothing to undo")

    restored = bak_path.read_text(encoding="utf-8")
    html_path.write_text(restored, encoding="utf-8")
    bak_path.unlink()
    return {"restored": True, "html": restored, "can_undo": False}


class SetLeadUrlRequest(BaseModel):
    url: str


@router.patch("/generate/{lead_website_id}/set-url")
def set_lead_netlify_url(lead_website_id: str, req: SetLeadUrlRequest):
    """Manually record a Netlify URL for a run (e.g. after a cancelled run was deployed by hand)."""
    db = get_client()
    result = db.table("lead_websites").select("id, status, lead_id").eq("id", lead_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    url = req.url.strip()
    now = datetime.now(timezone.utc).isoformat()

    db.table("lead_websites").update({
        "status": "completed",
        "netlify_url": url,
        "completed_at": now,
        "error": None,
    }).eq("id", lead_website_id).execute()

    lead_id = result.data[0]["lead_id"]
    db.table("leads").update({
        "demo_site_url": url,
        "demo_site_generated_at": now,
    }).eq("id", lead_id).execute()

    return {"status": "completed", "netlify_url": url}
