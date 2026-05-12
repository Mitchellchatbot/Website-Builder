from datetime import datetime, timezone, timedelta

from fastapi import APIRouter

from services.supabase_client import get_client

router = APIRouter()


@router.get("/dashboard/stats")
def get_dashboard_stats():
    db  = get_client()
    now = datetime.now(timezone.utc)
    today_start  = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    thirty_ago   = (now - timedelta(days=30)).isoformat()

    # ── All-time totals ────────────────────────────────────────────────────────
    all_result = (
        db.table("lead_websites")
        .select("status, started_at, completed_at")
        .in_("status", ["completed", "failed"])
        .execute()
    )
    rows = all_result.data or []

    completed_total = sum(1 for r in rows if r["status"] == "completed")
    failed_total    = sum(1 for r in rows if r["status"] == "failed")
    denominator     = completed_total + failed_total
    success_rate    = round(completed_total / denominator, 4) if denominator else None

    # Average duration (completed runs only, where both timestamps present)
    durations = []
    for r in rows:
        if r["status"] != "completed":
            continue
        s = r.get("started_at")
        c = r.get("completed_at")
        if s and c:
            try:
                start = datetime.fromisoformat(s.replace("Z", "+00:00"))
                end   = datetime.fromisoformat(c.replace("Z", "+00:00"))
                durations.append((end - start).total_seconds())
            except ValueError:
                pass
    avg_duration = round(sum(durations) / len(durations)) if durations else None

    # ── Today ─────────────────────────────────────────────────────────────────
    today_result = (
        db.table("lead_websites")
        .select("status")
        .in_("status", ["completed", "failed"])
        .gte("completed_at", today_start)
        .execute()
    )
    today_rows      = today_result.data or []
    today_completed = sum(1 for r in today_rows if r["status"] == "completed")
    today_failed    = sum(1 for r in today_rows if r["status"] == "failed")

    # ── Daily counts (last 30 days) ────────────────────────────────────────────
    daily_result = (
        db.table("lead_websites")
        .select("status, completed_at")
        .in_("status", ["completed", "failed"])
        .gte("completed_at", thirty_ago)
        .execute()
    )
    daily_map: dict[str, dict] = {}
    for r in (daily_result.data or []):
        raw = r.get("completed_at") or ""
        if not raw:
            continue
        day = raw[:10]
        if day not in daily_map:
            daily_map[day] = {"date": day, "completed": 0, "failed": 0}
        if r["status"] == "completed":
            daily_map[day]["completed"] += 1
        else:
            daily_map[day]["failed"] += 1

    # Fill in zeros for days with no data (last 30 days)
    daily_counts = []
    for i in range(30, -1, -1):
        d = (now - timedelta(days=i)).strftime("%Y-%m-%d")
        daily_counts.append(daily_map.get(d, {"date": d, "completed": 0, "failed": 0}))

    # ── Top failure reasons (last 30 days) ────────────────────────────────────
    failed_result = (
        db.table("lead_websites")
        .select("id, lead_id, error")
        .eq("status", "failed")
        .gte("started_at", thirty_ago)
        .not_.is_("error", "null")
        .execute()
    )
    failed_rows = failed_result.data or []

    # Group by normalized error message
    error_map: dict[str, dict] = {}
    for r in failed_rows:
        err = (r.get("error") or "Unknown error").strip()[:120]
        if err not in error_map:
            error_map[err] = {"error": err, "count": 0, "lead_ids": []}
        error_map[err]["count"] += 1
        error_map[err]["lead_ids"].append(r["lead_id"])

    if error_map:
        # Fetch example lead names for top errors
        top_errors = sorted(error_map.values(), key=lambda x: -x["count"])[:5]
        sample_lead_ids = [e["lead_ids"][0] for e in top_errors]
        leads_result = db.table("leads").select("id, first_name, last_name, company_name").in_("id", sample_lead_ids).execute()
        leads_by_id  = {l["id"]: l for l in (leads_result.data or [])}

        top_failure_reasons = []
        for entry in top_errors:
            sample_id = entry["lead_ids"][0]
            lead      = leads_by_id.get(sample_id, {})
            first     = lead.get("first_name") or ""
            last      = lead.get("last_name")  or ""
            example   = f"{first} {last}".strip() or lead.get("company_name") or "—"
            top_failure_reasons.append({
                "error":        entry["error"][:60],
                "count":        entry["count"],
                "example_lead": example,
                "example_lead_id": sample_id,
            })
    else:
        top_failure_reasons = []

    return {
        "totals": {
            "completed":    completed_total,
            "failed":       failed_total,
            "success_rate": success_rate,
        },
        "today": {
            "completed": today_completed,
            "failed":    today_failed,
        },
        "avg_duration_seconds": avg_duration,
        "daily_counts":         daily_counts,
        "top_failure_reasons":  top_failure_reasons,
    }
