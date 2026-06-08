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
from services.pipeline import OUTPUT_DIR, cancel_general_run, run_general_pipeline
from services.html_chat_editor import edit_html_with_chat, rewrite_asset_urls

router = APIRouter(prefix="/general-sites", tags=["general-sites"])
logger = logging.getLogger(__name__)

CONSECUTIVE_FAILURE_THRESHOLD = 4


# ── Request models ─────────────────────────────────────────────────────────────

class CreateGeneralLinkRequest(BaseModel):
    url: str
    label: str | None = None


class BatchGenerateGeneralRequest(BaseModel):
    general_link_ids: list[str]


class UpdateGeneralLinkHtmlRequest(BaseModel):
    html: str


class SetGeneralUrlRequest(BaseModel):
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


def _run_batch_general(pairs: list[tuple[str, str]], resume_from: str = "scrape") -> None:
    total = len(pairs)
    succeeded = failed = skipped = consecutive_failures = 0
    batch_halted = False

    logger.info("━━━ General batch started: %d link(s) ━━━", total)

    for index, (gl_id, glw_id) in enumerate(pairs, start=1):
        if batch_halted:
            try:
                db = get_client()
                db.table("general_link_websites").update({
                    "status": "skipped",
                    "error": f"Batch halted after {CONSECUTIVE_FAILURE_THRESHOLD} consecutive failures",
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                }).eq("id", glw_id).execute()
            except Exception:
                logger.exception("Failed to mark general_link_website %s as skipped", glw_id)
            skipped += 1
            continue

        logger.info("[%d/%d] Starting general link %s", index, total, gl_id)
        start = time.monotonic()
        try:
            result = run_general_pipeline(gl_id, glw_id, resume_from=resume_from)
            duration = round(time.monotonic() - start)
            if result.get("status") == "cancelled":
                logger.info("[%d/%d] ⏹ Cancelled after %ds", index, total, duration)
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
                logger.error("━━━ GENERAL BATCH HALTED: %d consecutive failures ━━━", CONSECUTIVE_FAILURE_THRESHOLD)
                batch_halted = True

    logger.info("━━━ General batch finished — done: %d, failed: %d, skipped: %d ━━━", succeeded, failed, skipped)


# ── Routes ─────────────────────────────────────────────────────────────────────

@router.get("")
def list_general_links():
    db = get_client()

    links_result = db.table("general_links").select("*").order("created_at", desc=True).execute()
    links = links_result.data or []

    if not links:
        return {"general_links": []}

    link_ids = [l["id"] for l in links]

    runs_result = db.table("general_link_websites").select(
        "id, general_link_id, status, netlify_url, error, started_at, completed_at, generated_html_path"
    ).in_("general_link_id", link_ids).order("started_at", desc=True).execute()

    latest_run: dict[str, dict] = {}
    for row in (runs_result.data or []):
        gl_id = row["general_link_id"]
        if gl_id not in latest_run:
            latest_run[gl_id] = row

    result = []
    for l in links:
        result.append({
            "id":         l["id"],
            "url":        l["url"],
            "label":      l.get("label") or _default_label(l["url"]),
            "created_at": l.get("created_at"),
            "latest_run": latest_run.get(l["id"]),
        })

    return {"general_links": result}


@router.get("/export")
def export_general_links(ids: str | None = Query(None, description="Comma-separated general_link IDs to export")):
    db = get_client()

    id_filter = [i.strip() for i in ids.split(",") if i.strip()] if ids else []

    q = db.table("general_links").select("*").order("created_at", desc=True)
    if id_filter:
        q = q.in_("id", id_filter)
    links = q.execute().data or []

    latest_run: dict[str, dict] = {}
    if links:
        link_ids = [l["id"] for l in links]
        runs_result = db.table("general_link_websites").select(
            "id, general_link_id, status, netlify_url, completed_at"
        ).in_("general_link_id", link_ids).order("started_at", desc=True).execute()
        for row in (runs_result.data or []):
            gl_id = row["general_link_id"]
            if gl_id not in latest_run:
                latest_run[gl_id] = row

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

    filename = f"general-sites-export-{date.today().isoformat()}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("")
def create_general_link(req: CreateGeneralLinkRequest):
    url = _normalize_url(req.url)
    if not url:
        raise HTTPException(status_code=400, detail="url is required")

    label = (req.label or "").strip() or _default_label(url)

    db = get_client()
    result = db.table("general_links").insert({"url": url, "label": label}).execute()
    row = result.data[0]
    return {
        "id":         row["id"],
        "url":        row["url"],
        "label":      row.get("label"),
        "created_at": row.get("created_at"),
    }


@router.delete("/{general_link_id}")
def delete_general_link(general_link_id: str):
    db = get_client()
    result = db.table("general_links").select("id").eq("id", general_link_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="General link not found")

    db.table("general_links").delete().eq("id", general_link_id).execute()
    return {"deleted": True}


@router.post("/{general_link_id}/generate")
def generate_for_general_link(general_link_id: str, background_tasks: BackgroundTasks):
    db = get_client()
    result = db.table("general_links").select("id, url").eq("id", general_link_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="General link not found")
    if not result.data[0].get("url"):
        raise HTTPException(status_code=400, detail="General link has no URL")

    insert_result = db.table("general_link_websites").insert({
        "general_link_id": general_link_id,
        "status": "pending",
    }).execute()
    glw_id = insert_result.data[0]["id"]

    background_tasks.add_task(_run_batch_general, [(general_link_id, glw_id)])
    return {"general_link_website_id": glw_id, "status": "pending"}


@router.post("/generate/batch")
def generate_batch_general(req: BatchGenerateGeneralRequest, background_tasks: BackgroundTasks):
    if not req.general_link_ids:
        raise HTTPException(status_code=400, detail="general_link_ids must not be empty")

    db = get_client()
    links_result = db.table("general_links").select(
        "id, url"
    ).in_("id", req.general_link_ids).execute()

    links_by_id = {l["id"]: l for l in (links_result.data or [])}
    errors = [lid for lid in req.general_link_ids if lid not in links_by_id]
    if errors:
        raise HTTPException(status_code=400, detail=f"Not found: {', '.join(errors)}")

    rows = [{"general_link_id": lid, "status": "pending"} for lid in req.general_link_ids]
    insert_result = db.table("general_link_websites").insert(rows).execute()

    inserted_by_link: dict[str, list[str]] = {}
    for row in insert_result.data:
        inserted_by_link.setdefault(row["general_link_id"], []).append(row["id"])

    pairs: list[tuple[str, str]] = []
    queued = []
    for lid in req.general_link_ids:
        glw_id = inserted_by_link[lid].pop(0)
        pairs.append((lid, glw_id))
        queued.append({"general_link_id": lid, "general_link_website_id": glw_id, "status": "pending"})

    background_tasks.add_task(_run_batch_general, pairs)
    return {"queued": queued}


@router.get("/generate/batch/status")
def get_batch_status_general(ids: str = Query(..., description="Comma-separated general_link_website_ids")):
    id_list = [i.strip() for i in ids.split(",") if i.strip()]
    if not id_list:
        raise HTTPException(status_code=400, detail="ids param is required")

    db = get_client()
    glw_result = db.table("general_link_websites").select(
        "id, general_link_id, status, netlify_url, error"
    ).in_("id", id_list).execute()

    rows_by_id = {row["id"]: row for row in (glw_result.data or [])}

    gl_ids = list({row["general_link_id"] for row in rows_by_id.values()})
    gl_result = db.table("general_links").select("id, url, label").in_("id", gl_ids).execute()
    gl_by_id = {l["id"]: l for l in (gl_result.data or [])}

    enriched = []
    for glw_id in id_list:
        if glw_id not in rows_by_id:
            continue
        row = rows_by_id[glw_id]
        gl = gl_by_id.get(row["general_link_id"], {})
        enriched.append({
            **row,
            "label": gl.get("label") or _default_label(gl.get("url", "")),
            "url": gl.get("url", ""),
        })

    return enriched


@router.post("/generate/{general_link_website_id}/retry")
def retry_general_generation(general_link_website_id: str, background_tasks: BackgroundTasks):
    db = get_client()
    result = db.table("general_link_websites").select("*").eq("id", general_link_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Generation run not found")

    glw = result.data[0]
    if glw["status"] != "failed":
        raise HTTPException(status_code=400, detail="Only failed runs can be retried")

    generated_html_path = glw.get("generated_html_path")
    scraped_data_path = glw.get("scraped_data_path")
    if generated_html_path and Path(generated_html_path).exists():
        resume_from = "deploy"
    elif scraped_data_path and Path(scraped_data_path).exists():
        resume_from = "generate"
    else:
        resume_from = "scrape"

    db.table("general_link_websites").update({
        "status": "pending",
        "error": None,
        "completed_at": None,
        "netlify_url": None,
    }).eq("id", general_link_website_id).execute()

    background_tasks.add_task(
        _run_batch_general,
        [(glw["general_link_id"], general_link_website_id)],
        resume_from,
    )
    return {"status": "pending", "general_link_website_id": general_link_website_id}


@router.get("/generate/{general_link_website_id}")
def get_general_generation_status(general_link_website_id: str):
    db = get_client()
    result = db.table("general_link_websites").select("*").eq("id", general_link_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Generation run not found")

    glw = result.data[0]
    gl_result = db.table("general_links").select("id, url, label").eq("id", glw["general_link_id"]).limit(1).execute()
    gl = gl_result.data[0] if gl_result.data else {}

    return {
        **glw,
        "general_link": {
            "id":    gl.get("id"),
            "url":   gl.get("url"),
            "label": gl.get("label") or _default_label(gl.get("url", "")),
        },
    }


@router.post("/generate/{general_link_website_id}/cancel")
def cancel_general(general_link_website_id: str):
    """Immediately stop a running general pipeline run and mark it as cancelled."""
    db = get_client()
    result = db.table("general_link_websites").select(
        "id, status, general_link_id"
    ).eq("id", general_link_website_id).limit(1).execute()

    if not result.data:
        raise HTTPException(status_code=404, detail="Generation run not found")

    glw = result.data[0]
    active = {"pending", "scraping", "generating", "deploying"}
    if glw["status"] not in active:
        raise HTTPException(
            status_code=400,
            detail=f"Run is not active (status: '{glw['status']}')",
        )

    cancel_general_run(general_link_website_id)

    db.table("general_link_websites").update({
        "status": "cancelled",
        "error": "Cancelled by user",
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", general_link_website_id).execute()

    return {"cancelled": True}


_MIME_MAP = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
             "gif": "image/gif", "webp": "image/webp"}


@router.get("/generate/{general_link_website_id}/preview", response_class=HTMLResponse)
def preview_general_html(general_link_website_id: str):
    """Serve the generated HTML with images inlined as base64 for a fully self-contained preview."""
    db = get_client()
    result = db.table("general_link_websites").select(
        "status, generated_html_path"
    ).eq("id", general_link_website_id).limit(1).execute()

    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    glw = result.data[0]
    html_path_str = glw.get("generated_html_path")
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


@router.post("/generate/{general_link_website_id}/deploy")
def deploy_general(general_link_website_id: str, background_tasks: BackgroundTasks):
    db = get_client()
    result = db.table("general_link_websites").select("*").eq("id", general_link_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    glw = result.data[0]
    if glw["status"] not in ("awaiting_approval", "cancelled"):
        raise HTTPException(
            status_code=400,
            detail=f"Can only deploy from 'awaiting_approval' or 'cancelled' status (current: '{glw['status']}')",
        )

    html_path = glw.get("generated_html_path")
    if not html_path or not Path(html_path).exists():
        raise HTTPException(status_code=400, detail="Generated HTML not found — regenerate first")

    db.table("general_link_websites").update({"status": "pending"}).eq("id", general_link_website_id).execute()

    background_tasks.add_task(
        _run_batch_general,
        [(glw["general_link_id"], general_link_website_id)],
        "deploy",
    )
    return {"status": "pending", "general_link_website_id": general_link_website_id}


@router.get("/generate/{general_link_website_id}/assets")
def get_general_assets(general_link_website_id: str):
    db = get_client()
    result = db.table("general_link_websites").select("general_link_id").eq("id", general_link_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    gl_id = result.data[0]["general_link_id"]
    images_dir = OUTPUT_DIR / f"general_{gl_id}" / "images"

    if not images_dir.exists():
        return {"assets": []}

    assets = [
        {"filename": f.name, "size": f.stat().st_size}
        for f in sorted(images_dir.iterdir())
        if f.is_file() and f.suffix.lower().lstrip(".") in _MIME_MAP
    ]
    return {"assets": assets}


@router.get("/generate/{general_link_website_id}/asset/{filename}")
def get_general_asset_file(general_link_website_id: str, filename: str):
    safe = os.path.basename(filename)
    if not safe or safe != filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    db = get_client()
    result = db.table("general_link_websites").select("general_link_id").eq("id", general_link_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    gl_id = result.data[0]["general_link_id"]
    img_path = OUTPUT_DIR / f"general_{gl_id}" / "images" / safe

    if not img_path.exists() or not img_path.is_file():
        raise HTTPException(status_code=404, detail="Asset not found")

    return FileResponse(str(img_path))


@router.get("/generate/{general_link_website_id}/html")
def get_general_html(general_link_website_id: str):
    db = get_client()
    result = db.table("general_link_websites").select("generated_html_path").eq("id", general_link_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    html_path_str = result.data[0].get("generated_html_path")
    if not html_path_str or not Path(html_path_str).exists():
        raise HTTPException(status_code=404, detail="HTML not yet generated")

    html_path = Path(html_path_str)
    html = html_path.read_text(encoding="utf-8")
    can_undo = html_path.with_suffix(html_path.suffix + ".bak").exists()
    return {"html": html, "can_undo": can_undo}


@router.put("/generate/{general_link_website_id}/html")
def update_general_html(general_link_website_id: str, req: UpdateGeneralLinkHtmlRequest):
    db = get_client()
    result = db.table("general_link_websites").select("generated_html_path").eq("id", general_link_website_id).limit(1).execute()
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


@router.post("/generate/{general_link_website_id}/chat-edit")
async def chat_edit_general_html(
    general_link_website_id: str,
    message: str = Form(...),
    image: UploadFile | None = File(default=None),
):
    """Apply a chat-driven edit to the generated HTML. Saves a single-step undo backup."""
    db = get_client()
    result = db.table("general_link_websites").select("generated_html_path").eq("id", general_link_website_id).limit(1).execute()
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
        logger.exception("Chat edit failed for %s", general_link_website_id)
        raise HTTPException(status_code=502, detail=f"Edit failed: {exc}") from exc

    html_path.with_suffix(html_path.suffix + ".bak").write_text(current_html, encoding="utf-8")
    html_path.write_text(new_html, encoding="utf-8")
    return {"saved": True, "html": new_html, "can_undo": True}


@router.post("/generate/{general_link_website_id}/undo")
def undo_general_html(general_link_website_id: str):
    """Restore the previous HTML from the single-step .bak backup."""
    db = get_client()
    result = db.table("general_link_websites").select("generated_html_path").eq("id", general_link_website_id).limit(1).execute()
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


@router.post("/generate/{general_link_website_id}/upload-asset")
async def upload_general_asset(general_link_website_id: str, file: UploadFile = File(...)):
    safe = os.path.basename(file.filename or "upload")
    ext = safe.rsplit(".", 1)[-1].lower() if "." in safe else ""
    if not safe or ext not in _MIME_MAP:
        raise HTTPException(status_code=400, detail="Unsupported or missing file type")

    db = get_client()
    result = db.table("general_link_websites").select("general_link_id").eq("id", general_link_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    gl_id = result.data[0]["general_link_id"]
    images_dir = OUTPUT_DIR / f"general_{gl_id}" / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    contents = await file.read()
    (images_dir / safe).write_bytes(contents)
    return {"filename": safe, "size": len(contents)}


@router.patch("/generate/{general_link_website_id}/set-url")
def set_general_netlify_url(general_link_website_id: str, req: SetGeneralUrlRequest):
    """Manually record a Netlify URL for a run."""
    db = get_client()
    result = db.table("general_link_websites").select("id, status").eq("id", general_link_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    now = datetime.now(timezone.utc).isoformat()
    db.table("general_link_websites").update({
        "status": "completed",
        "netlify_url": req.url.strip(),
        "completed_at": now,
        "error": None,
    }).eq("id", general_link_website_id).execute()

    return {"status": "completed", "netlify_url": req.url.strip()}