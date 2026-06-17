import logging

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from services.supabase_client import get_client
from services.pipeline import run_sheets_pipeline

router = APIRouter(prefix="/scratch", tags=["scratch"])
logger = logging.getLogger(__name__)

SCRATCH_URL = "scratch://builds"


def _get_or_create_import(db) -> str:
    result = db.table("sheets_imports").select("id").eq("sheets_url", SCRATCH_URL).limit(1).execute()
    if result.data:
        return result.data[0]["id"]
    row = db.table("sheets_imports").insert({
        "sheets_url": SCRATCH_URL,
        "label": "Build from Scratch",
        "entry_count": 0,
    }).execute()
    return row.data[0]["id"]


def _entries_with_runs(db, import_id: str) -> list[dict]:
    entries_result = (
        db.table("sheets_entries")
        .select("*")
        .eq("import_id", import_id)
        .order("created_at", desc=True)
        .execute()
    )
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


@router.get("")
def list_scratch_builds():
    db = get_client()
    result = db.table("sheets_imports").select("id").eq("sheets_url", SCRATCH_URL).limit(1).execute()
    if not result.data:
        return {"builds": []}
    return {"builds": _entries_with_runs(db, result.data[0]["id"])}


class CreateScratchRequest(BaseModel):
    business_name: str
    business_description: str
    design_preferences: str | None = None


@router.post("")
def create_scratch_build(req: CreateScratchRequest, background_tasks: BackgroundTasks):
    name = req.business_name.strip()
    desc = req.business_description.strip()
    if not name:
        raise HTTPException(status_code=400, detail="business_name is required")
    if not desc:
        raise HTTPException(status_code=400, detail="business_description is required")

    db = get_client()
    import_id = _get_or_create_import(db)

    count_result = db.table("sheets_entries").select("id").eq("import_id", import_id).execute()
    row_index = len(count_result.data or [])

    entry_result = db.table("sheets_entries").insert({
        "import_id": import_id,
        "business_name": name,
        "website_url": None,
        "design_preferences": req.design_preferences.strip() if req.design_preferences else None,
        "business_description": desc,
        "row_index": row_index,
    }).execute()
    entry = entry_result.data[0]
    entry_id = entry["id"]

    ew_result = db.table("sheets_entry_websites").insert({
        "entry_id": entry_id,
        "has_website": False,
        "status": "pending",
    }).execute()
    ew_id = ew_result.data[0]["id"]

    background_tasks.add_task(_run_build, entry_id, ew_id)

    entry["latest_run"] = {
        "id": ew_id, "entry_id": entry_id, "has_website": False,
        "status": "pending", "netlify_url": None, "error": None,
        "started_at": None, "completed_at": None, "generated_html_path": None,
    }
    return {"build": entry}


@router.delete("/{entry_id}")
def delete_scratch_build(entry_id: str):
    db = get_client()
    result = db.table("sheets_entries").select("id, import_id").eq("id", entry_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Build not found")

    import_id = result.data[0]["import_id"]
    imp = db.table("sheets_imports").select("sheets_url").eq("id", import_id).limit(1).execute()
    if not imp.data or imp.data[0]["sheets_url"] != SCRATCH_URL:
        raise HTTPException(status_code=403, detail="Not a scratch build")

    db.table("sheets_entry_websites").delete().eq("entry_id", entry_id).execute()
    db.table("sheets_entries").delete().eq("id", entry_id).execute()
    return {"deleted": True}


def _run_build(entry_id: str, ew_id: str) -> None:
    try:
        run_sheets_pipeline(entry_id, ew_id, resume_from="scrape")
    except Exception as e:
        logger.error("Scratch build failed for entry %s: %s", entry_id, e)
