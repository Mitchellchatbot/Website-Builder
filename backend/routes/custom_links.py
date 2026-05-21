import base64
import csv
import io
import logging
import os
import re
import time
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from pydantic import BaseModel

from services.supabase_client import get_client
from services.pipeline import OUTPUT_DIR, cancel_custom_run, run_custom_pipeline
from services.html_chat_editor import edit_html_with_chat, rewrite_asset_urls

router = APIRouter(prefix="/custom-links", tags=["custom-links"])
logger = logging.getLogger(__name__)

CONSECUTIVE_FAILURE_THRESHOLD = 4


# ── Request models ─────────────────────────────────────────────────────────────

class CreateCustomLinkRequest(BaseModel):
    url: str
    label: str | None = None


class BatchGenerateCustomRequest(BaseModel):
    custom_link_ids: list[str]


class UpdateCustomLinkHtmlRequest(BaseModel):
    html: str


class SetCustomUrlRequest(BaseModel):
    url: str


# ── Helpers ────────────────────────────────────────────────────────────────────

def _normalize_url(url: str) -> str:
    url = url.strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    return url


def _default_label(url: str) -> str:
    try:
        host = urlparse(url).hostname or url
        return host.removeprefix("www.")
    except Exception:
        return url


def _run_batch_custom(pairs: list[tuple[str, str]], resume_from: str = "scrape") -> None:
    total = len(pairs)
    succeeded = failed = skipped = consecutive_failures = 0
    batch_halted = False

    logger.info("━━━ Custom batch started: %d link(s) ━━━", total)

    for index, (cl_id, clw_id) in enumerate(pairs, start=1):
        if batch_halted:
            try:
                db = get_client()
                db.table("custom_link_websites").update({
                    "status": "skipped",
                    "error": f"Batch halted after {CONSECUTIVE_FAILURE_THRESHOLD} consecutive failures",
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                }).eq("id", clw_id).execute()
            except Exception:
                logger.exception("Failed to mark custom_link_website %s as skipped", clw_id)
            skipped += 1
            continue

        logger.info("[%d/%d] Starting custom link %s", index, total, cl_id)
        start = time.monotonic()
        try:
            result = run_custom_pipeline(cl_id, clw_id, resume_from=resume_from)
            duration = round(time.monotonic() - start)
            if result.get("status") == "cancelled":
                logger.info("[%d/%d] ⏹ Cancelled after %ds", index, total, duration)
                # Don't count as success or failure; don't advance consecutive_failures
                continue
            logger.info("[%d/%d] ✅ Completed in %ds", index, total, duration)
            succeeded += 1
            consecutive_failures = 0
        except Exception as e:
            duration = round(time.monotonic() - start)
            logger.error("[%d/%d] ❌ Failed after %ds: %s", index, total, duration, e)
            failed += 1
            consecutive_failures += 1
            if consecutive_failures >= CONSECUTIVE_FAILURE_THRESHOLD:
                logger.error("━━━ CUSTOM BATCH HALTED: %d consecutive failures ━━━", CONSECUTIVE_FAILURE_THRESHOLD)
                batch_halted = True

    logger.info("━━━ Custom batch finished — done: %d, failed: %d, skipped: %d ━━━", succeeded, failed, skipped)


# ── Routes ─────────────────────────────────────────────────────────────────────

@router.get("")
def list_custom_links():
    db = get_client()

    links_result = db.table("custom_links").select("*").order("created_at", desc=True).execute()
    links = links_result.data or []

    if not links:
        return {"custom_links": []}

    link_ids = [l["id"] for l in links]

    # Fetch latest run per custom link
    runs_result = db.table("custom_link_websites").select(
        "id, custom_link_id, status, netlify_url, error, started_at, completed_at, generated_html_path"
    ).in_("custom_link_id", link_ids).order("started_at", desc=True).execute()

    # Keep only the most recent run per link
    latest_run: dict[str, dict] = {}
    for row in (runs_result.data or []):
        cl_id = row["custom_link_id"]
        if cl_id not in latest_run:
            latest_run[cl_id] = row

    result = []
    for l in links:
        result.append({
            "id":         l["id"],
            "url":        l["url"],
            "label":      l.get("label") or _default_label(l["url"]),
            "created_at": l.get("created_at"),
            "latest_run": latest_run.get(l["id"]),
        })

    return {"custom_links": result}


@router.get("/export")
def export_custom_links(ids: str | None = Query(None, description="Comma-separated custom_link IDs to export")):
    db = get_client()

    id_filter = [i.strip() for i in ids.split(",") if i.strip()] if ids else []

    q = db.table("custom_links").select("*").order("created_at", desc=True)
    if id_filter:
        q = q.in_("id", id_filter)
    links = q.execute().data or []

    latest_run: dict[str, dict] = {}
    if links:
        link_ids = [l["id"] for l in links]
        runs_result = db.table("custom_link_websites").select(
            "id, custom_link_id, status, netlify_url, completed_at"
        ).in_("custom_link_id", link_ids).order("started_at", desc=True).execute()
        for row in (runs_result.data or []):
            cl_id = row["custom_link_id"]
            if cl_id not in latest_run:
                latest_run[cl_id] = row

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Name", "Email", "Label", "Status", "Demo Site URL", "Completed At"])

    for l in links:
        run = latest_run.get(l["id"])
        writer.writerow([
            "",
            "",
            l.get("label") or _default_label(l["url"]),
            run["status"] if run else "not started",
            (run.get("netlify_url") or "") if run else "",
            ((run.get("completed_at") or "")[:10]) if run else "",
        ])

    filename = f"custom-links-export-{date.today().isoformat()}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("")
def create_custom_link(req: CreateCustomLinkRequest):
    url = _normalize_url(req.url)
    if not url:
        raise HTTPException(status_code=400, detail="url is required")

    label = (req.label or "").strip() or _default_label(url)

    db = get_client()
    result = db.table("custom_links").insert({"url": url, "label": label}).execute()
    row = result.data[0]
    return {
        "id":         row["id"],
        "url":        row["url"],
        "label":      row.get("label"),
        "created_at": row.get("created_at"),
    }


@router.delete("/{custom_link_id}")
def delete_custom_link(custom_link_id: str):
    db = get_client()
    result = db.table("custom_links").select("id").eq("id", custom_link_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Custom link not found")

    db.table("custom_links").delete().eq("id", custom_link_id).execute()
    return {"deleted": True}


@router.post("/{custom_link_id}/generate")
def generate_for_custom_link(custom_link_id: str, background_tasks: BackgroundTasks):
    db = get_client()
    result = db.table("custom_links").select("id, url").eq("id", custom_link_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Custom link not found")
    if not result.data[0].get("url"):
        raise HTTPException(status_code=400, detail="Custom link has no URL")

    insert_result = db.table("custom_link_websites").insert({
        "custom_link_id": custom_link_id,
        "status": "pending",
    }).execute()
    clw_id = insert_result.data[0]["id"]

    background_tasks.add_task(_run_batch_custom, [(custom_link_id, clw_id)])
    return {"custom_link_website_id": clw_id, "status": "pending"}


@router.post("/generate/batch")
def generate_batch_custom(req: BatchGenerateCustomRequest, background_tasks: BackgroundTasks):
    if not req.custom_link_ids:
        raise HTTPException(status_code=400, detail="custom_link_ids must not be empty")

    db = get_client()
    links_result = db.table("custom_links").select(
        "id, url"
    ).in_("id", req.custom_link_ids).execute()

    links_by_id = {l["id"]: l for l in (links_result.data or [])}
    errors = [lid for lid in req.custom_link_ids if lid not in links_by_id]
    if errors:
        raise HTTPException(status_code=400, detail=f"Not found: {', '.join(errors)}")

    rows = [{"custom_link_id": lid, "status": "pending"} for lid in req.custom_link_ids]
    insert_result = db.table("custom_link_websites").insert(rows).execute()

    inserted_by_link: dict[str, list[str]] = {}
    for row in insert_result.data:
        inserted_by_link.setdefault(row["custom_link_id"], []).append(row["id"])

    pairs: list[tuple[str, str]] = []
    queued = []
    for lid in req.custom_link_ids:
        clw_id = inserted_by_link[lid].pop(0)
        pairs.append((lid, clw_id))
        queued.append({"custom_link_id": lid, "custom_link_website_id": clw_id, "status": "pending"})

    background_tasks.add_task(_run_batch_custom, pairs)
    return {"queued": queued}


@router.get("/generate/batch/status")
def get_batch_status_custom(ids: str = Query(..., description="Comma-separated custom_link_website_ids")):
    id_list = [i.strip() for i in ids.split(",") if i.strip()]
    if not id_list:
        raise HTTPException(status_code=400, detail="ids param is required")

    db = get_client()
    clw_result = db.table("custom_link_websites").select(
        "id, custom_link_id, status, netlify_url, error"
    ).in_("id", id_list).execute()

    rows_by_id = {row["id"]: row for row in (clw_result.data or [])}

    cl_ids = list({row["custom_link_id"] for row in rows_by_id.values()})
    cl_result = db.table("custom_links").select("id, url, label").in_("id", cl_ids).execute()
    cl_by_id = {l["id"]: l for l in (cl_result.data or [])}

    enriched = []
    for clw_id in id_list:
        if clw_id not in rows_by_id:
            continue
        row = rows_by_id[clw_id]
        cl = cl_by_id.get(row["custom_link_id"], {})
        enriched.append({
            **row,
            "label": cl.get("label") or _default_label(cl.get("url", "")),
            "url": cl.get("url", ""),
        })

    return enriched


@router.post("/generate/{custom_link_website_id}/retry")
def retry_custom_generation(custom_link_website_id: str, background_tasks: BackgroundTasks):
    db = get_client()
    result = db.table("custom_link_websites").select("*").eq("id", custom_link_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Generation run not found")

    clw = result.data[0]
    if clw["status"] != "failed":
        raise HTTPException(status_code=400, detail="Only failed runs can be retried")

    scraped_data_path = clw.get("scraped_data_path")
    resume_from = "generate" if scraped_data_path and Path(scraped_data_path).exists() else "scrape"

    db.table("custom_link_websites").update({
        "status": "pending",
        "error": None,
        "completed_at": None,
        "netlify_url": None,
    }).eq("id", custom_link_website_id).execute()

    background_tasks.add_task(
        _run_batch_custom,
        [(clw["custom_link_id"], custom_link_website_id)],
        resume_from,
    )
    return {"status": "pending", "custom_link_website_id": custom_link_website_id}


@router.get("/generate/{custom_link_website_id}")
def get_custom_generation_status(custom_link_website_id: str):
    db = get_client()
    result = db.table("custom_link_websites").select("*").eq("id", custom_link_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Generation run not found")

    clw = result.data[0]
    cl_result = db.table("custom_links").select("id, url, label").eq("id", clw["custom_link_id"]).limit(1).execute()
    cl = cl_result.data[0] if cl_result.data else {}

    return {
        **clw,
        "custom_link": {
            "id":    cl.get("id"),
            "url":   cl.get("url"),
            "label": cl.get("label") or _default_label(cl.get("url", "")),
        },
    }


@router.post("/generate/{custom_link_website_id}/cancel")
def cancel_custom(custom_link_website_id: str):
    """Immediately stop a running custom pipeline run and mark it as cancelled."""
    db = get_client()
    result = db.table("custom_link_websites").select(
        "id, status, custom_link_id"
    ).eq("id", custom_link_website_id).limit(1).execute()

    if not result.data:
        raise HTTPException(status_code=404, detail="Generation run not found")

    clw = result.data[0]
    active = {"pending", "scraping", "generating", "deploying"}
    if clw["status"] not in active:
        raise HTTPException(
            status_code=400,
            detail=f"Run is not active (status: '{clw['status']}')",
        )

    # Terminate subprocess if in scraping stage, set cancel flag for all stages
    cancel_custom_run(custom_link_website_id)

    # Optimistically write cancelled status — pipeline _update() won't overwrite it
    db.table("custom_link_websites").update({
        "status": "cancelled",
        "error": "Cancelled by user",
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", custom_link_website_id).execute()

    return {"cancelled": True}


_MIME_MAP = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
             "gif": "image/gif", "webp": "image/webp"}


@router.get("/generate/{custom_link_website_id}/preview", response_class=HTMLResponse)
def preview_custom_html(custom_link_website_id: str):
    """Serve the generated HTML with images inlined as base64 for a fully self-contained preview."""
    db = get_client()
    result = db.table("custom_link_websites").select(
        "status, generated_html_path"
    ).eq("id", custom_link_website_id).limit(1).execute()

    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    clw = result.data[0]
    html_path_str = clw.get("generated_html_path")
    if not html_path_str or not Path(html_path_str).exists():
        raise HTTPException(status_code=404, detail="HTML not yet generated — run the pipeline first")

    html_path = Path(html_path_str)
    html = html_path.read_text(encoding="utf-8")

    # Replace relative image paths with inline base64 data URIs
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


@router.post("/generate/{custom_link_website_id}/deploy")
def deploy_custom(custom_link_website_id: str, background_tasks: BackgroundTasks):
    """Deploy a previously generated and approved custom link website to Netlify."""
    db = get_client()
    result = db.table("custom_link_websites").select("*").eq("id", custom_link_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    clw = result.data[0]
    if clw["status"] not in ("awaiting_approval", "cancelled"):
        raise HTTPException(
            status_code=400,
            detail=f"Can only deploy from 'awaiting_approval' or 'cancelled' status (current: '{clw['status']}')",
        )

    html_path = clw.get("generated_html_path")
    if not html_path or not Path(html_path).exists():
        raise HTTPException(status_code=400, detail="Generated HTML not found — regenerate first")

    db.table("custom_link_websites").update({"status": "pending"}).eq("id", custom_link_website_id).execute()

    background_tasks.add_task(
        _run_batch_custom,
        [(clw["custom_link_id"], custom_link_website_id)],
        "deploy",
    )
    return {"status": "pending", "custom_link_website_id": custom_link_website_id}


@router.get("/generate/{custom_link_website_id}/assets")
def get_custom_assets(custom_link_website_id: str):
    db = get_client()
    result = db.table("custom_link_websites").select("custom_link_id").eq("id", custom_link_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    cl_id = result.data[0]["custom_link_id"]
    images_dir = OUTPUT_DIR / f"custom_{cl_id}" / "images"

    if not images_dir.exists():
        return {"assets": []}

    assets = [
        {"filename": f.name, "size": f.stat().st_size}
        for f in sorted(images_dir.iterdir())
        if f.is_file() and f.suffix.lower().lstrip(".") in _MIME_MAP
    ]
    return {"assets": assets}


@router.get("/generate/{custom_link_website_id}/asset/{filename}")
def get_custom_asset_file(custom_link_website_id: str, filename: str):
    safe = os.path.basename(filename)
    if not safe or safe != filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    db = get_client()
    result = db.table("custom_link_websites").select("custom_link_id").eq("id", custom_link_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    cl_id = result.data[0]["custom_link_id"]
    img_path = OUTPUT_DIR / f"custom_{cl_id}" / "images" / safe

    if not img_path.exists() or not img_path.is_file():
        raise HTTPException(status_code=404, detail="Asset not found")

    return FileResponse(str(img_path))


@router.get("/generate/{custom_link_website_id}/html")
def get_custom_html(custom_link_website_id: str):
    db = get_client()
    result = db.table("custom_link_websites").select("generated_html_path").eq("id", custom_link_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    html_path_str = result.data[0].get("generated_html_path")
    if not html_path_str or not Path(html_path_str).exists():
        raise HTTPException(status_code=404, detail="HTML not yet generated")

    html_path = Path(html_path_str)
    html = html_path.read_text(encoding="utf-8")
    can_undo = html_path.with_suffix(html_path.suffix + ".bak").exists()
    return {"html": html, "can_undo": can_undo}


@router.put("/generate/{custom_link_website_id}/html")
def update_custom_html(custom_link_website_id: str, req: UpdateCustomLinkHtmlRequest):
    db = get_client()
    result = db.table("custom_link_websites").select("generated_html_path").eq("id", custom_link_website_id).limit(1).execute()
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


@router.post("/generate/{custom_link_website_id}/chat-edit")
async def chat_edit_custom_html(
    custom_link_website_id: str,
    message: str = Form(...),
    image: UploadFile | None = File(default=None),
):
    """Apply a chat-driven edit to the generated HTML. Saves a single-step undo backup."""
    db = get_client()
    result = db.table("custom_link_websites").select("generated_html_path").eq("id", custom_link_website_id).limit(1).execute()
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
        logger.exception("Chat edit failed for %s", custom_link_website_id)
        raise HTTPException(status_code=502, detail=f"Edit failed: {exc}") from exc

    html_path.with_suffix(html_path.suffix + ".bak").write_text(current_html, encoding="utf-8")
    html_path.write_text(new_html, encoding="utf-8")
    return {"saved": True, "html": new_html, "can_undo": True}


@router.post("/generate/{custom_link_website_id}/undo")
def undo_custom_html(custom_link_website_id: str):
    """Restore the previous HTML from the single-step .bak backup."""
    db = get_client()
    result = db.table("custom_link_websites").select("generated_html_path").eq("id", custom_link_website_id).limit(1).execute()
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


@router.post("/generate/{custom_link_website_id}/upload-asset")
async def upload_custom_asset(custom_link_website_id: str, file: UploadFile = File(...)):
    safe = os.path.basename(file.filename or "upload")
    ext = safe.rsplit(".", 1)[-1].lower() if "." in safe else ""
    if not safe or ext not in _MIME_MAP:
        raise HTTPException(status_code=400, detail="Unsupported or missing file type")

    db = get_client()
    result = db.table("custom_link_websites").select("custom_link_id").eq("id", custom_link_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    cl_id = result.data[0]["custom_link_id"]
    images_dir = OUTPUT_DIR / f"custom_{cl_id}" / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    contents = await file.read()
    (images_dir / safe).write_bytes(contents)
    return {"filename": safe, "size": len(contents)}


@router.patch("/generate/{custom_link_website_id}/set-url")
def set_custom_netlify_url(custom_link_website_id: str, req: SetCustomUrlRequest):
    """Manually record a Netlify URL for a run (e.g. after a cancelled run was deployed by hand)."""
    db = get_client()
    result = db.table("custom_link_websites").select("id, status").eq("id", custom_link_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    now = datetime.now(timezone.utc).isoformat()
    db.table("custom_link_websites").update({
        "status": "completed",
        "netlify_url": req.url.strip(),
        "completed_at": now,
        "error": None,
    }).eq("id", custom_link_website_id).execute()

    return {"status": "completed", "netlify_url": req.url.strip()}
