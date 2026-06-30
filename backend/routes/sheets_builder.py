import base64
import csv
import io
import logging
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import requests as http_requests
from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel

from services.supabase_client import get_client
from services.pipeline import OUTPUT_DIR, cancel_sheets_run, run_sheets_pipeline
from services.html_chat_editor import edit_html_with_chat, rewrite_asset_urls

router = APIRouter(prefix="/sheets-builder", tags=["sheets-builder"])
logger = logging.getLogger(__name__)

CONSECUTIVE_FAILURE_THRESHOLD = 4

# ── Hardcoded sheet ────────────────────────────────────────────────────────────
SHEET_ID    = "1uUggfxS18XyVkJwO91-f5ays7od3xlzJVGiCJOQErrI"
SHEET_LABEL = "Scaled AI Clients"
SHEET_URL   = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}"


# ── Google Sheets fetcher ──────────────────────────────────────────────────────

def _fetch_sheet_rows() -> list[dict]:
    """Fetch rows via Google Sheets API v4 using service-account credentials."""
    email       = os.getenv("GOOGLE_SERVICE_ACCOUNT_EMAIL", "").strip()
    private_key = os.getenv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY", "").replace("\\n", "\n").strip()

    if not email or not private_key:
        raise HTTPException(
            status_code=500,
            detail="GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY must be set in .env",
        )

    try:
        from google.oauth2 import service_account
        import google.auth.transport.requests as g_requests

        creds = service_account.Credentials.from_service_account_info(
            {
                "type": "service_account",
                "project_id": "robust-metrics-493412-m6",
                "private_key_id": "key",
                "private_key": private_key,
                "client_email": email,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
            },
            scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"],
        )
        creds.refresh(g_requests.Request())
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Google auth failed: {exc}") from exc

    url  = f"https://sheets.googleapis.com/v4/spreadsheets/{SHEET_ID}/values/A:D"
    resp = http_requests.get(url, headers={"Authorization": f"Bearer {creds.token}"}, timeout=30)
    try:
        resp.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Sheets API error: {resp.text[:200]}") from exc

    raw = resp.json().get("values", [])
    if not raw:
        return []

    headers = [h.strip() for h in raw[0]]
    rows = []
    for row in raw[1:]:
        padded = row + [""] * max(0, len(headers) - len(row))
        rows.append(dict(zip(headers, padded)))
    return rows


# ── CSV parsing helpers ────────────────────────────────────────────────────────

def _parse_name(raw: str) -> str | None:
    if "&" in raw:
        before = raw.split("&", 1)[0].strip()
        return before or None
    return raw.strip() or None


def _score_entry(entry: dict) -> int:
    return sum(
        1 for f in ["website_url", "design_preferences", "business_description"]
        if entry.get(f) and str(entry[f]).strip()
    )


_JUNK_DESIGN_PREFS = frozenset({"no", "nope", "n/a", "none", "na", "yes", "no idea", "testt", "test", "rgrgrgr"})


def _parse_and_deduplicate(rows: list[dict]) -> list[dict]:
    raw_entries: list[dict] = []

    for i, row in enumerate(rows):
        raw_name    = (row.get("Name") or "").strip()
        website_url = (row.get("Website URL") or "").strip() or None
        design_prefs = (row.get("Design Preferences") or "").strip() or None
        business    = (row.get("Business") or "").strip() or None

        business_name = _parse_name(raw_name)

        if not any([business_name, website_url, design_prefs, business]):
            continue

        if website_url and not website_url.startswith(("http://", "https://")):
            website_url = "https://" + website_url

        if design_prefs and design_prefs.lower().strip() in _JUNK_DESIGN_PREFS:
            design_prefs = None

        if business and business.lower().strip() in ("t", "test", "grgrgr", "testt"):
            business = None

        raw_entries.append({
            "business_name": business_name,
            "website_url": website_url,
            "design_preferences": design_prefs,
            "business_description": business,
            "row_index": i,
        })

    named: dict[str, list[dict]] = {}
    unnamed: dict[str, list[dict]] = {}

    for entry in raw_entries:
        name_key = (entry["business_name"] or "").lower().strip()
        if name_key:
            named.setdefault(name_key, []).append(entry)
        else:
            url_key  = (entry.get("website_url") or "").lower().strip()
            desc_key = (entry.get("business_description") or "").lower().strip()
            # Group by shared identity; fully blank rows stay unique
            anon_key = f"{url_key}|||{desc_key}" if (url_key or desc_key) else f"__blank_{entry['row_index']}"
            unnamed.setdefault(anon_key, []).append(entry)

    result: list[dict] = []
    for _, group in named.items():
        result.append(max(group, key=_score_entry) if len(group) > 1 else group[0])
    for _, group in unnamed.items():
        result.append(max(group, key=_score_entry) if len(group) > 1 else group[0])
    result.sort(key=lambda e: e["row_index"])
    return result


# ── DB helpers ─────────────────────────────────────────────────────────────────

def _get_or_create_import(db) -> str:
    """Return the import_id for the single hardcoded sheet, creating it if needed."""
    result = db.table("sheets_imports").select("id").eq("sheets_url", SHEET_URL).limit(1).execute()
    if result.data:
        return result.data[0]["id"]
    row = db.table("sheets_imports").insert({
        "sheets_url": SHEET_URL,
        "label": SHEET_LABEL,
        "entry_count": 0,
    }).execute()
    return row.data[0]["id"]


def _entries_with_runs(db, import_id: str) -> list[dict]:
    entries_result = db.table("sheets_entries").select("*").eq("import_id", import_id).order("row_index").execute()
    entries = entries_result.data or []

    if entries:
        entry_ids = [e["id"] for e in entries]
        runs_result = db.table("sheets_entry_websites").select(
            "id, entry_id, has_website, status, netlify_url, error, started_at, completed_at, generated_html_path"
        ).in_("entry_id", entry_ids).order("started_at", desc=True).execute()
        latest_run: dict[str, dict] = {}
        for row in (runs_result.data or []):
            eid = row["entry_id"]
            if eid not in latest_run:
                latest_run[eid] = row
        for e in entries:
            e["latest_run"] = latest_run.get(e["id"])
    return entries


# ── Sync & fetch ───────────────────────────────────────────────────────────────

@router.post("/sync")
def sync_sheet():
    """Pull latest data from Google Sheets, add new businesses, update changed ones."""
    rows       = _fetch_sheet_rows()
    new_parsed = _parse_and_deduplicate(rows)

    db        = get_client()
    import_id = _get_or_create_import(db)

    existing_result = db.table("sheets_entries").select("*").eq("import_id", import_id).execute()
    existing        = existing_result.data or []

    existing_by_name: dict[str, dict] = {
        (e.get("business_name") or "").lower().strip(): e
        for e in existing
        if (e.get("business_name") or "").strip()
    }

    added = updated = 0
    for ne in new_parsed:
        name_key = (ne.get("business_name") or "").lower().strip()
        if name_key and name_key in existing_by_name:
            old = existing_by_name[name_key]
            if (
                old.get("website_url") != ne["website_url"]
                or old.get("design_preferences") != ne["design_preferences"]
                or old.get("business_description") != ne["business_description"]
            ):
                db.table("sheets_entries").update({
                    "website_url": ne["website_url"],
                    "design_preferences": ne["design_preferences"],
                    "business_description": ne["business_description"],
                }).eq("id", old["id"]).execute()
                updated += 1
        else:
            db.table("sheets_entries").insert({"import_id": import_id, **ne}).execute()
            added += 1

    total = len(db.table("sheets_entries").select("id").eq("import_id", import_id).execute().data or [])
    db.table("sheets_imports").update({"entry_count": total}).eq("id", import_id).execute()

    return {
        "added":   added,
        "updated": updated,
        "total":   total,
        "entries": _entries_with_runs(db, import_id),
    }


@router.get("/entries")
def get_entries():
    """Return all entries. Empty list if sheet has never been synced."""
    db        = get_client()
    result    = db.table("sheets_imports").select("id, entry_count").eq("sheets_url", SHEET_URL).limit(1).execute()
    if not result.data:
        return {"entries": [], "total": 0}
    import_id = result.data[0]["id"]
    entries   = _entries_with_runs(db, import_id)
    return {"entries": entries, "total": len(entries)}


# ── Generate single entry ──────────────────────────────────────────────────────

@router.post("/entries/{entry_id}/generate")
def generate_for_entry(entry_id: str, background_tasks: BackgroundTasks):
    db     = get_client()
    result = db.table("sheets_entries").select("id, website_url").eq("id", entry_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Entry not found")

    entry       = result.data[0]
    has_website = bool(entry.get("website_url"))

    insert_result = db.table("sheets_entry_websites").insert({
        "entry_id": entry_id, "has_website": has_website, "status": "pending",
    }).execute()
    ew_id = insert_result.data[0]["id"]

    background_tasks.add_task(_run_batch_sheets, [(entry_id, ew_id)])
    return {"entry_website_id": ew_id, "status": "pending"}


# ── Batch runner ───────────────────────────────────────────────────────────────

def _run_batch_sheets(pairs: list[tuple[str, str]], resume_from: str = "scrape") -> None:
    total = len(pairs)
    succeeded = failed = skipped = consecutive_failures = 0
    batch_halted = False

    logger.info("━━━ Sheets batch started: %d ━━━", total)

    for index, (entry_id, ew_id) in enumerate(pairs, start=1):
        if batch_halted:
            try:
                get_client().table("sheets_entry_websites").update({
                    "status": "skipped",
                    "error": f"Batch halted after {CONSECUTIVE_FAILURE_THRESHOLD} consecutive failures",
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                }).eq("id", ew_id).execute()
            except Exception:
                pass
            skipped += 1
            continue

        logger.info("[%d/%d] Entry %s", index, total, entry_id)
        start = time.monotonic()
        try:
            result = run_sheets_pipeline(entry_id, ew_id, resume_from=resume_from)
            duration = round(time.monotonic() - start)
            if result.get("status") == "cancelled":
                logger.info("[%d/%d] Cancelled after %ds", index, total, duration)
                continue
            logger.info("[%d/%d] Done in %ds", index, total, duration)
            succeeded += 1
            consecutive_failures = 0
        except Exception as e:
            duration = round(time.monotonic() - start)
            logger.error("[%d/%d] Failed after %ds: %s", index, total, duration, e)
            failed += 1
            consecutive_failures += 1
            if consecutive_failures >= CONSECUTIVE_FAILURE_THRESHOLD:
                logger.error("━━━ SHEETS BATCH HALTED ━━━")
                batch_halted = True

    logger.info("━━━ Sheets batch done — ok:%d fail:%d skip:%d ━━━", succeeded, failed, skipped)


# ── Batch generate ─────────────────────────────────────────────────────────────

class BatchGenerateSheetsRequest(BaseModel):
    entry_ids: list[str]


@router.post("/generate/batch")
def generate_batch(req: BatchGenerateSheetsRequest, background_tasks: BackgroundTasks):
    if not req.entry_ids:
        raise HTTPException(status_code=400, detail="entry_ids must not be empty")

    db             = get_client()
    entries_result = db.table("sheets_entries").select("id, website_url").in_("id", req.entry_ids).execute()
    entries_by_id  = {e["id"]: e for e in (entries_result.data or [])}

    errors = [eid for eid in req.entry_ids if eid not in entries_by_id]
    if errors:
        raise HTTPException(status_code=400, detail=f"Entries not found: {', '.join(errors)}")

    rows = [
        {"entry_id": eid, "has_website": bool(entries_by_id[eid].get("website_url")), "status": "pending"}
        for eid in req.entry_ids
    ]
    insert_result = db.table("sheets_entry_websites").insert(rows).execute()

    inserted_by_entry: dict[str, list[str]] = {}
    for row in insert_result.data:
        inserted_by_entry.setdefault(row["entry_id"], []).append(row["id"])

    pairs: list[tuple[str, str]] = []
    queued = []
    for eid in req.entry_ids:
        ew_id = inserted_by_entry[eid].pop(0)
        pairs.append((eid, ew_id))
        queued.append({"entry_id": eid, "entry_website_id": ew_id, "status": "pending"})

    background_tasks.add_task(_run_batch_sheets, pairs)
    return {"queued": queued}


@router.get("/generate/batch/status")
def get_batch_status(ids: str = Query(...)):
    id_list = [i.strip() for i in ids.split(",") if i.strip()]
    if not id_list:
        raise HTTPException(status_code=400, detail="ids param is required")

    db         = get_client()
    ew_result  = db.table("sheets_entry_websites").select(
        "id, entry_id, has_website, status, netlify_url, error"
    ).in_("id", id_list).execute()
    rows_by_id = {row["id"]: row for row in (ew_result.data or [])}

    entry_ids       = list({row["entry_id"] for row in rows_by_id.values()})
    entries_result  = db.table("sheets_entries").select("id, business_name, business_description").in_("id", entry_ids).execute()
    entries_by_id   = {e["id"]: e for e in (entries_result.data or [])}

    enriched = []
    for ew_id in id_list:
        if ew_id not in rows_by_id:
            continue
        row   = rows_by_id[ew_id]
        entry = entries_by_id.get(row["entry_id"], {})
        label = entry.get("business_name") or entry.get("business_description") or row["entry_id"]
        enriched.append({**row, "label": label})
    return enriched


# ── Per-run status & actions ───────────────────────────────────────────────────

@router.get("/generate/{entry_website_id}")
def get_generation_status(entry_website_id: str):
    db     = get_client()
    result = db.table("sheets_entry_websites").select("*").eq("id", entry_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    ew           = result.data[0]
    entry_result = db.table("sheets_entries").select("*").eq("id", ew["entry_id"]).limit(1).execute()
    entry        = entry_result.data[0] if entry_result.data else {}

    return {
        **ew,
        "entry": {
            "id":                   entry.get("id"),
            "business_name":        entry.get("business_name"),
            "website_url":          entry.get("website_url"),
            "business_description": entry.get("business_description"),
        },
    }


@router.post("/generate/{entry_website_id}/retry")
def retry_generation(entry_website_id: str, background_tasks: BackgroundTasks):
    db     = get_client()
    result = db.table("sheets_entry_websites").select("*").eq("id", entry_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    ew = result.data[0]
    if ew["status"] != "failed":
        raise HTTPException(status_code=400, detail="Only failed runs can be retried")

    has_website = ew.get("has_website", False)
    if ew.get("generated_html_path") and Path(ew["generated_html_path"]).exists():
        resume_from = "deploy"
    elif has_website and ew.get("scraped_data_path") and Path(ew["scraped_data_path"]).exists():
        resume_from = "generate"
    else:
        resume_from = "scrape"

    db.table("sheets_entry_websites").update({
        "status": "pending", "error": None, "completed_at": None, "netlify_url": None,
    }).eq("id", entry_website_id).execute()

    background_tasks.add_task(_run_batch_sheets, [(ew["entry_id"], entry_website_id)], resume_from)
    return {"status": "pending", "entry_website_id": entry_website_id}


@router.post("/generate/{entry_website_id}/cancel")
def cancel_generation(entry_website_id: str):
    db     = get_client()
    result = db.table("sheets_entry_websites").select("id, status, entry_id").eq("id", entry_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    ew = result.data[0]
    if ew["status"] not in {"pending", "scraping", "generating", "deploying"}:
        raise HTTPException(status_code=400, detail=f"Run is not active (status: '{ew['status']}')")

    cancel_sheets_run(entry_website_id)
    db.table("sheets_entry_websites").update({
        "status": "cancelled",
        "error": "Cancelled by user",
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", entry_website_id).execute()
    return {"cancelled": True}


def _run_regenerate_and_deploy(entry_id: str, ew_id: str) -> None:
    """Regenerate the HTML then immediately deploy — no awaiting_approval stop.
    Used when the generated file is missing (ephemeral Railway filesystem)."""
    try:
        result = run_sheets_pipeline(entry_id, ew_id, resume_from="scrape")
        if result.get("status") == "awaiting_approval":
            run_sheets_pipeline(entry_id, ew_id, resume_from="deploy")
    except Exception as exc:
        logger.error("[sheets:%s] Regenerate+redeploy failed: %s", entry_id, exc)
        try:
            get_client().table("sheets_entry_websites").update({
                "status": "failed",
                "error": str(exc),
            }).eq("id", ew_id).execute()
        except Exception:
            pass


@router.post("/generate/{entry_website_id}/deploy")
def deploy_entry(entry_website_id: str, background_tasks: BackgroundTasks):
    db     = get_client()
    result = db.table("sheets_entry_websites").select("*").eq("id", entry_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    ew = result.data[0]
    if ew["status"] not in ("awaiting_approval", "cancelled", "completed", "failed"):
        raise HTTPException(status_code=400, detail=f"Cannot deploy from status '{ew['status']}'")

    html_path = ew.get("generated_html_path")
    file_exists = bool(html_path and Path(html_path).exists())

    if not file_exists:
        # File is gone (Railway ephemeral filesystem wiped on redeploy).
        # Regenerate the HTML from scratch then auto-deploy without stopping.
        db.table("sheets_entry_websites").update({"status": "pending"}).eq("id", entry_website_id).execute()
        background_tasks.add_task(_run_regenerate_and_deploy, ew["entry_id"], entry_website_id)
        return {"status": "pending", "entry_website_id": entry_website_id}

    db.table("sheets_entry_websites").update({"status": "pending"}).eq("id", entry_website_id).execute()
    background_tasks.add_task(_run_batch_sheets, [(ew["entry_id"], entry_website_id)], "deploy")
    return {"status": "pending", "entry_website_id": entry_website_id}


# ── MIME map ───────────────────────────────────────────────────────────────────

_MIME_MAP = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
             "gif": "image/gif", "webp": "image/webp"}


@router.get("/generate/{entry_website_id}/preview", response_class=HTMLResponse)
def preview_html(entry_website_id: str):
    db     = get_client()
    result = db.table("sheets_entry_websites").select("generated_html_path").eq("id", entry_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    html_path_str = result.data[0].get("generated_html_path")
    if not html_path_str or not Path(html_path_str).exists():
        raise HTTPException(status_code=404, detail="HTML not yet generated")

    html_path = Path(html_path_str)
    html      = html_path.read_text(encoding="utf-8")

    def _inline(match: re.Match) -> str:
        src      = match.group(1)
        img_file = html_path.parent / src
        if img_file.exists():
            ext  = img_file.suffix.lower().lstrip(".")
            mime = _MIME_MAP.get(ext, "image/png")
            data = base64.standard_b64encode(img_file.read_bytes()).decode()
            return f'src="data:{mime};base64,{data}"'
        return match.group(0)

    html = re.sub(r'src="(images/[^"]+)"', _inline, html)
    return HTMLResponse(content=html)


@router.get("/generate/{entry_website_id}/html")
def get_html(entry_website_id: str):
    db     = get_client()
    result = db.table("sheets_entry_websites").select("generated_html_path").eq("id", entry_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    html_path_str = result.data[0].get("generated_html_path")
    if not html_path_str or not Path(html_path_str).exists():
        raise HTTPException(status_code=404, detail="HTML not yet generated")

    html_path = Path(html_path_str)
    html      = html_path.read_text(encoding="utf-8")
    can_undo  = html_path.with_suffix(html_path.suffix + ".bak").exists()
    return {"html": html, "can_undo": can_undo}


class UpdateEntryHtmlRequest(BaseModel):
    html: str


@router.put("/generate/{entry_website_id}/html")
def update_html(entry_website_id: str, req: UpdateEntryHtmlRequest):
    db     = get_client()
    result = db.table("sheets_entry_websites").select("generated_html_path").eq("id", entry_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    html_path_str = result.data[0].get("generated_html_path")
    if not html_path_str:
        raise HTTPException(status_code=404, detail="HTML path not set")

    html_path = Path(html_path_str)
    html_path.parent.mkdir(parents=True, exist_ok=True)
    if html_path.exists():
        html_path.with_suffix(html_path.suffix + ".bak").write_text(
            html_path.read_text(encoding="utf-8"), encoding="utf-8"
        )
    html_path.write_text(rewrite_asset_urls(req.html), encoding="utf-8")
    return {"saved": True}


@router.post("/generate/{entry_website_id}/chat-edit")
async def chat_edit_html(
    entry_website_id: str,
    message: str = Form(...),
    image: UploadFile | None = File(default=None),
):
    db     = get_client()
    result = db.table("sheets_entry_websites").select("generated_html_path").eq("id", entry_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    html_path_str = result.data[0].get("generated_html_path")
    if not html_path_str or not Path(html_path_str).exists():
        raise HTTPException(status_code=404, detail="HTML not yet generated")

    if not message.strip():
        raise HTTPException(status_code=400, detail="Message is required")

    html_path    = Path(html_path_str)
    current_html = html_path.read_text(encoding="utf-8")

    image_bytes: bytes | None = None
    image_media_type: str | None = None
    if image is not None:
        ext = (image.filename or "").rsplit(".", 1)[-1].lower() if image.filename and "." in image.filename else ""
        if ext not in _MIME_MAP:
            raise HTTPException(status_code=400, detail="Unsupported image type")
        image_bytes      = await image.read()
        image_media_type = _MIME_MAP[ext]

    try:
        new_html = edit_html_with_chat(current_html, message, image_bytes, image_media_type)
    except Exception as exc:
        logger.exception("Chat edit failed for %s", entry_website_id)
        raise HTTPException(status_code=502, detail=f"Edit failed: {exc}") from exc

    html_path.with_suffix(html_path.suffix + ".bak").write_text(current_html, encoding="utf-8")
    html_path.write_text(new_html, encoding="utf-8")
    return {"saved": True, "html": new_html, "can_undo": True}


@router.post("/generate/{entry_website_id}/undo")
def undo_html(entry_website_id: str):
    db     = get_client()
    result = db.table("sheets_entry_websites").select("generated_html_path").eq("id", entry_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    html_path_str = result.data[0].get("generated_html_path")
    if not html_path_str:
        raise HTTPException(status_code=404, detail="HTML path not set")

    html_path = Path(html_path_str)
    bak_path  = html_path.with_suffix(html_path.suffix + ".bak")
    if not bak_path.exists():
        raise HTTPException(status_code=404, detail="Nothing to undo")

    restored = bak_path.read_text(encoding="utf-8")
    html_path.write_text(restored, encoding="utf-8")
    bak_path.unlink()
    return {"restored": True, "html": restored, "can_undo": False}


@router.get("/generate/{entry_website_id}/assets")
def get_assets(entry_website_id: str):
    db     = get_client()
    result = db.table("sheets_entry_websites").select("entry_id").eq("id", entry_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    entry_id   = result.data[0]["entry_id"]
    images_dir = OUTPUT_DIR / f"sheets_{entry_id}" / "images"
    if not images_dir.exists():
        return {"assets": []}

    return {"assets": [
        {"filename": f.name, "size": f.stat().st_size}
        for f in sorted(images_dir.iterdir())
        if f.is_file() and f.suffix.lower().lstrip(".") in _MIME_MAP
    ]}


@router.get("/generate/{entry_website_id}/asset/{filename}")
def get_asset_file(entry_website_id: str, filename: str):
    safe = os.path.basename(filename)
    if not safe or safe != filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    db     = get_client()
    result = db.table("sheets_entry_websites").select("entry_id").eq("id", entry_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    entry_id = result.data[0]["entry_id"]
    img_path = OUTPUT_DIR / f"sheets_{entry_id}" / "images" / safe
    if not img_path.exists():
        raise HTTPException(status_code=404, detail="Asset not found")
    return FileResponse(str(img_path))


@router.post("/generate/{entry_website_id}/upload-asset")
async def upload_asset(entry_website_id: str, file: UploadFile = File(...)):
    safe = os.path.basename(file.filename or "upload")
    ext  = safe.rsplit(".", 1)[-1].lower() if "." in safe else ""
    if not safe or ext not in _MIME_MAP:
        raise HTTPException(status_code=400, detail="Unsupported or missing file type")

    db     = get_client()
    result = db.table("sheets_entry_websites").select("entry_id").eq("id", entry_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    entry_id   = result.data[0]["entry_id"]
    images_dir = OUTPUT_DIR / f"sheets_{entry_id}" / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    contents = await file.read()
    (images_dir / safe).write_bytes(contents)
    return {"filename": safe, "size": len(contents)}


class SetEntryUrlRequest(BaseModel):
    url: str


@router.patch("/generate/{entry_website_id}/set-url")
def set_netlify_url(entry_website_id: str, req: SetEntryUrlRequest):
    db     = get_client()
    result = db.table("sheets_entry_websites").select("id").eq("id", entry_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")

    db.table("sheets_entry_websites").update({
        "status": "completed",
        "netlify_url": req.url.strip(),
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "error": None,
    }).eq("id", entry_website_id).execute()
    return {"status": "completed", "netlify_url": req.url.strip()}
