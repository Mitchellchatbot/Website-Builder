import logging
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from pydantic import BaseModel

from services.supabase_client import get_client
from services.pipeline import run_pipeline

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
            run_pipeline(lead_id, lead_website_id, resume_from=resume_from)
            duration = round(time.monotonic() - start)
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
