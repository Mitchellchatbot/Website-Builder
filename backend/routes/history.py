from fastapi import APIRouter, HTTPException

from services.supabase_client import get_client

router = APIRouter()


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
