from fastapi import APIRouter, HTTPException

from services.supabase_client import get_client

router = APIRouter()

_ACTIVE_STATUSES = {"pending", "scraping", "generating", "deploying"}


@router.delete("/history/{lead_website_id}")
def delete_history_item(lead_website_id: str):
    db = get_client()
    result = db.table("lead_websites").select("id, status").eq("id", lead_website_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Record not found")

    if result.data[0]["status"] in _ACTIVE_STATUSES:
        raise HTTPException(status_code=400, detail="Cannot delete an active run")

    db.table("lead_websites").delete().eq("id", lead_website_id).execute()
    return {"deleted": True}


@router.get("/history")
def list_history():
    db = get_client()

    result = db.table("lead_websites").select("*").order("started_at", desc=True).limit(50).execute()
    rows = result.data or []

    if not rows:
        return {"history": []}

    lead_ids = list({row["lead_id"] for row in rows})
    leads_result = db.table("leads").select(
        "id, first_name, last_name, company_name"
    ).in_("id", lead_ids).execute()
    leads_by_id = {l["id"]: l for l in (leads_result.data or [])}

    enriched = []
    for row in rows:
        lead = leads_by_id.get(row["lead_id"], {})
        first = lead.get("first_name") or ""
        last = lead.get("last_name") or ""
        name = f"{first} {last}".strip() or lead.get("company_name") or "—"
        enriched.append({
            **row,
            "lead_name": name,
            "company_name": lead.get("company_name") or "—",
        })

    return {"history": enriched}
