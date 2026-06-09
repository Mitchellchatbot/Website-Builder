from datetime import datetime, timezone, timedelta

from fastapi import APIRouter

from services.supabase_client import get_client

router = APIRouter()


# Source tables that contribute to dashboard KPIs. Every entry needs:
#   table:    DB table name
#   id_col:   FK to the parent (lead_id / custom_link_id / general_link_id)
#   parent:   parent table to enrich the failure-reason "example" from
#   kind:     short label for the source
SOURCES = [
    {"table": "lead_websites",         "id_col": "lead_id",         "parent": "leads",         "kind": "lead"},
    {"table": "custom_link_websites",  "id_col": "custom_link_id",  "parent": "custom_links",  "kind": "custom"},
    {"table": "general_link_websites", "id_col": "general_link_id", "parent": "general_links", "kind": "general"},
]


def _fetch_all(db, since_iso: str | None = None) -> list[dict]:
    """Pull rows from every source table, normalized into a single shape."""
    rows: list[dict] = []
    for src in SOURCES:
        q = (
            db.table(src["table"])
            .select(f"id, {src['id_col']}, status, started_at, completed_at, error")
            .in_("status", ["completed", "failed"])
        )
        if since_iso:
            q = q.gte("completed_at", since_iso)
        result = q.execute()
        for r in (result.data or []):
            rows.append({
                "id":           r["id"],
                "parent_id":    r.get(src["id_col"]),
                "status":       r["status"],
                "started_at":   r.get("started_at"),
                "completed_at": r.get("completed_at"),
                "error":        r.get("error"),
                "kind":         src["kind"],
                "parent_table": src["parent"],
            })
    return rows


@router.get("/dashboard/stats")
def get_dashboard_stats():
    db  = get_client()
    now = datetime.now(timezone.utc)
    today_start  = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    thirty_ago   = (now - timedelta(days=30)).isoformat()

    # ── All-time totals (leads + custom + general) ────────────────────────────
    all_rows = _fetch_all(db)

    completed_total = sum(1 for r in all_rows if r["status"] == "completed")
    failed_total    = sum(1 for r in all_rows if r["status"] == "failed")
    denominator     = completed_total + failed_total
    success_rate    = round(completed_total / denominator, 4) if denominator else None

    # ── Today ─────────────────────────────────────────────────────────────────
    today_rows = [
        r for r in all_rows
        if (r.get("completed_at") or "") >= today_start
    ]
    today_completed = sum(1 for r in today_rows if r["status"] == "completed")
    today_failed    = sum(1 for r in today_rows if r["status"] == "failed")

    # ── Daily counts (last 30 days) ────────────────────────────────────────────
    daily_map: dict[str, dict] = {}
    for r in all_rows:
        raw = r.get("completed_at") or ""
        if not raw or raw < thirty_ago:
            continue
        day = raw[:10]
        if day not in daily_map:
            daily_map[day] = {"date": day, "completed": 0, "failed": 0}
        if r["status"] == "completed":
            daily_map[day]["completed"] += 1
        else:
            daily_map[day]["failed"] += 1

    daily_counts = []
    for i in range(30, -1, -1):
        d = (now - timedelta(days=i)).strftime("%Y-%m-%d")
        daily_counts.append(daily_map.get(d, {"date": d, "completed": 0, "failed": 0}))

    # ── Top failure reasons (last 30 days, all sources) ───────────────────────
    failed_recent = [
        r for r in all_rows
        if r["status"] == "failed"
        and (r.get("started_at") or "") >= thirty_ago
        and r.get("error")
    ]

    # Group by normalized error message; track one example per error from each source
    error_map: dict[str, dict] = {}
    for r in failed_recent:
        err = (r.get("error") or "Unknown error").strip()[:120]
        if err not in error_map:
            error_map[err] = {"error": err, "count": 0, "examples": []}
        error_map[err]["count"] += 1
        error_map[err]["examples"].append({
            "kind":         r["kind"],
            "parent_id":    r["parent_id"],
            "parent_table": r["parent_table"],
        })

    top_errors = sorted(error_map.values(), key=lambda x: -x["count"])[:5]

    # Batch-fetch parent rows per source to resolve example labels
    needed: dict[str, set[str]] = {}  # parent_table -> set of parent_ids
    for entry in top_errors:
        ex = entry["examples"][0]
        if ex["parent_id"]:
            needed.setdefault(ex["parent_table"], set()).add(ex["parent_id"])

    parents_by_id: dict[str, dict[str, dict]] = {}  # parent_table -> id -> row
    for parent_table, ids in needed.items():
        if not ids:
            continue
        if parent_table == "leads":
            res = db.table("leads").select("id, first_name, last_name, company_name").in_("id", list(ids)).execute()
        else:
            res = db.table(parent_table).select("id, url, label").in_("id", list(ids)).execute()
        parents_by_id[parent_table] = {row["id"]: row for row in (res.data or [])}

    def _example_label(ex: dict) -> str:
        parent = parents_by_id.get(ex["parent_table"], {}).get(ex["parent_id"] or "", {})
        if not parent:
            return "—"
        if ex["kind"] == "lead":
            first = parent.get("first_name") or ""
            last  = parent.get("last_name")  or ""
            name  = f"{first} {last}".strip()
            return name or parent.get("company_name") or "—"
        return parent.get("label") or parent.get("url") or "—"

    top_failure_reasons = []
    for entry in top_errors:
        ex = entry["examples"][0]
        top_failure_reasons.append({
            "error":           entry["error"][:60],
            "count":           entry["count"],
            "example_lead":    _example_label(ex),
            "example_lead_id": ex["parent_id"] or "",
        })

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
        "daily_counts":         daily_counts,
        "top_failure_reasons":  top_failure_reasons,
    }
