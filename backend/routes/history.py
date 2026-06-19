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


def _delegation_doer_lead_ids(db) -> list[str]:
    res = db.table("leads").select("id").eq("source", "delegation-doer").execute()
    return [r["id"] for r in (res.data or [])]


@router.get("/history")
def list_history():
    db = get_client()
    excluded = _delegation_doer_lead_ids(db)

    # 1. All generation runs (excluding delegation-doer leads)
    q = db.table("lead_websites").select("*").order("started_at", desc=True)
    if excluded:
        q = q.not_.in_("lead_id", excluded)
    runs_result = q.limit(200).execute()
    rows = runs_result.data or []

    # lead_ids that already have at least one run record
    lead_ids_with_run = {row["lead_id"] for row in rows}

    # 2. All leads that have a manually-set demo URL but NO run record at all
    mq = db.table("leads").select(
        "id, first_name, last_name, email, company_name, demo_site_url, demo_site_generated_at, imported_at"
    ).not_.is_("demo_site_url", "null")
    if excluded:
        mq = mq.not_.in_("id", excluded)
    manual_result = mq.execute()

    # 3. Enrich run rows with lead data
    all_lead_ids = lead_ids_with_run | {l["id"] for l in (manual_result.data or [])}
    if all_lead_ids:
        leads_result = db.table("leads").select(
            "id, first_name, last_name, email, company_name, demo_site_url"
        ).in_("id", list(all_lead_ids)).execute()
        leads_by_id = {l["id"]: l for l in (leads_result.data or [])}
    else:
        leads_by_id = {}

    def _enrich(row: dict, lead: dict) -> dict:
        first = lead.get("first_name") or ""
        last  = lead.get("last_name")  or ""
        name  = f"{first} {last}".strip() or lead.get("company_name") or "—"
        return {
            **row,
            "lead_name":       name,
            "lead_first_name": first,
            "lead_last_name":  last,
            "lead_email":      lead.get("email") or "",
            "company_name":    lead.get("company_name") or "—",
            "lead_demo_url":   lead.get("demo_site_url") or None,
        }

    enriched = [_enrich(row, leads_by_id.get(row["lead_id"], {})) for row in rows]

    # 4. Synthetic entries: leads with demo URL but no run at all
    for lead in (manual_result.data or []):
        if lead["id"] in lead_ids_with_run:
            continue  # already represented by a real run row (handled via lead_demo_url)
        first = lead.get("first_name") or ""
        last  = lead.get("last_name")  or ""
        name  = f"{first} {last}".strip() or lead.get("company_name") or "—"
        ts    = lead.get("demo_site_generated_at") or lead.get("imported_at")
        enriched.append({
            "id":                f"manual_{lead['id']}",
            "lead_id":           lead["id"],
            "status":            "manual",
            "netlify_url":       None,
            "error":             None,
            "started_at":        ts,
            "completed_at":      ts,
            "generated_html_path": None,
            "scraped_data_path": None,
            "lead_name":         name,
            "lead_first_name":   first,
            "lead_last_name":    last,
            "lead_email":        lead.get("email") or "",
            "company_name":      lead.get("company_name") or "—",
            "lead_demo_url":     lead["demo_site_url"],
        })

    return {"history": enriched}
