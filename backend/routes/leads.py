import csv
import io
from datetime import date, datetime, timezone, timedelta

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from services.supabase_client import get_client

router = APIRouter()

DEMO_FILTER_VALUES = {"none", "all", "completed"}
DATE_RANGE_VALUES  = {"all", "today", "week", "month", "custom"}


def _date_bounds(date_range: str, date_start: str | None, date_end: str | None) -> tuple[str | None, str | None]:
    now = datetime.now(timezone.utc)
    if date_range == "today":
        return now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat(), None
    if date_range == "week":
        monday = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
        return monday.isoformat(), None
    if date_range == "month":
        return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat(), None
    if date_range == "custom" and date_start:
        gte = f"{date_start}T00:00:00+00:00"
        lte = f"{(datetime.fromisoformat(date_end) + timedelta(days=1)).date().isoformat()}T00:00:00+00:00" if date_end else None
        return gte, lte
    return None, None


def _build_query(db, demo_filter: str, date_range: str = "all", date_start: str | None = None, date_end: str | None = None):
    q = (
        db.table("leads")
        .select("id, first_name, last_name, email, company_name, company_website_url, demo_site_url, demo_site_generated_at")
        .not_.is_("company_website_url", "null")
        .order("first_name")
    )
    if demo_filter == "none":
        q = q.is_("demo_site_url", "null")
    elif demo_filter == "completed":
        q = q.not_.is_("demo_site_url", "null")

    if demo_filter != "none" and date_range != "all":
        gte, lte = _date_bounds(date_range, date_start, date_end)
        if gte:
            q = q.gte("demo_site_generated_at", gte)
        if lte:
            q = q.lt("demo_site_generated_at", lte)
    return q


def _export_filename(date_range: str, date_start: str | None, date_end: str | None) -> str:
    today = date.today().isoformat()
    if date_range == "today":   return f"leads-today-{today}.csv"
    if date_range == "week":    return f"leads-this-week-{today}.csv"
    if date_range == "month":   return f"leads-this-month-{today}.csv"
    if date_range == "custom" and date_start:
        return f"leads-{date_start}-to-{date_end or today}.csv"
    return f"leads-export-{today}.csv"


@router.get("/leads")
def list_leads(
    demo_filter: str        = Query("none"),
    date_range:  str        = Query("all"),
    date_start:  str | None = Query(None),
    date_end:    str | None = Query(None),
):
    if demo_filter not in DEMO_FILTER_VALUES: demo_filter = "none"
    if date_range  not in DATE_RANGE_VALUES:  date_range  = "all"

    db     = get_client()
    result = _build_query(db, demo_filter, date_range, date_start, date_end).limit(100).execute()

    leads = []
    for row in result.data:
        first = row.get("first_name") or ""
        last  = row.get("last_name")  or ""
        name  = f"{first} {last}".strip() or row.get("company_name") or "—"
        leads.append({
            "id":                  row["id"],
            "name":                name,
            "company_name":        row.get("company_name"),
            "company_website_url": row.get("company_website_url"),
            "has_demo":            row.get("demo_site_url") is not None,
            "demo_url":            row.get("demo_site_url"),
            "demo_generated_at":   row.get("demo_site_generated_at"),
        })
    return {"leads": leads}


@router.get("/leads/export")
def export_leads(
    demo_filter: str        = Query("none"),
    date_range:  str        = Query("all"),
    date_start:  str | None = Query(None),
    date_end:    str | None = Query(None),
):
    if demo_filter not in DEMO_FILTER_VALUES: demo_filter = "none"
    if date_range  not in DATE_RANGE_VALUES:  date_range  = "all"

    db     = get_client()
    result = _build_query(db, demo_filter, date_range, date_start, date_end).limit(5000).execute()

    buf    = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Lead ID", "First Name", "Last Name", "Company Email", "Company Name", "Demo Site URL", "Generated At"])

    for row in result.data:
        writer.writerow([
            row.get("id")            or "",
            row.get("first_name")    or "",
            row.get("last_name")     or "",
            row.get("email")         or "",
            row.get("company_name")  or "",
            row.get("demo_site_url") or "",
            (row.get("demo_site_generated_at") or "")[:10],
        ])

    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{_export_filename(date_range, date_start, date_end)}"'},
    )
