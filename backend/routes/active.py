from datetime import datetime, timezone, timedelta

from fastapi import APIRouter

from services.supabase_client import get_client

router = APIRouter()

RUNNING_STATUSES  = ["pending", "scraping", "generating", "deploying"]
TERMINAL_STATUSES = ["completed", "failed", "skipped"]


def _parse_iso(ts: str | None) -> datetime | None:
    if not ts:
        return None
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


@router.get("/active")
def get_active():
    db  = get_client()
    now = datetime.now(timezone.utc)
    one_hour_ago = (now - timedelta(hours=1)).isoformat()

    running_result = (
        db.table("lead_websites")
        .select("id, lead_id, status, started_at")
        .in_("status", RUNNING_STATUSES)
        .order("started_at", desc=False)
        .execute()
    )

    completed_result = (
        db.table("lead_websites")
        .select("id, lead_id, status, netlify_url, error, completed_at, started_at")
        .in_("status", TERMINAL_STATUSES)
        .gte("completed_at", one_hour_ago)
        .order("completed_at", desc=True)
        .execute()
    )

    all_lead_ids = list({
        r["lead_id"]
        for r in (running_result.data or []) + (completed_result.data or [])
    })

    leads_by_id: dict = {}
    if all_lead_ids:
        leads_result = db.table("leads").select(
            "id, first_name, last_name, company_name"
        ).in_("id", all_lead_ids).execute()
        for lead in (leads_result.data or []):
            leads_by_id[lead["id"]] = lead

    def _lead_name(lead_id: str) -> str:
        lead  = leads_by_id.get(lead_id, {})
        first = lead.get("first_name") or ""
        last  = lead.get("last_name")  or ""
        return f"{first} {last}".strip() or lead.get("company_name") or "—"

    def _company(lead_id: str) -> str:
        return leads_by_id.get(lead_id, {}).get("company_name") or "—"

    running = []
    for r in (running_result.data or []):
        started          = _parse_iso(r.get("started_at"))
        duration_seconds = int((now - started).total_seconds()) if started else 0
        running.append({
            "id":               r["id"],
            "lead_id":          r["lead_id"],
            "lead_name":        _lead_name(r["lead_id"]),
            "company_name":     _company(r["lead_id"]),
            "status":           r["status"],
            "started_at":       r.get("started_at"),
            "duration_seconds": duration_seconds,
        })

    recently_completed = []
    for r in (completed_result.data or []):
        recently_completed.append({
            "id":           r["id"],
            "lead_id":      r["lead_id"],
            "lead_name":    _lead_name(r["lead_id"]),
            "company_name": _company(r["lead_id"]),
            "status":       r["status"],
            "netlify_url":  r.get("netlify_url"),
            "error":        r.get("error"),
            "completed_at": r.get("completed_at"),
        })

    return {"running": running, "recently_completed": recently_completed}
