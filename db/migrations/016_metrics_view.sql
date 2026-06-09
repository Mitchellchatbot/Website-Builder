-- Project metrics view for the centralized monitoring dashboard.
--
-- Exposes a single-row view that unions the three website-generation tables
-- (lead_websites, custom_link_websites, general_link_websites) and computes:
--   - generated counts (status = 'completed')   — total + per source
--   - failed counts    (status = 'failed')      — total + per source
--   - success rate     (completed / (completed + failed))  — total + per source
--   - time buckets     (today / this_week / this_month / this_year / all_time)
--
-- The centralized dashboard reads this via Supabase REST:
--   GET https://<project>.supabase.co/rest/v1/project_metrics
--   Authorization: Bearer <service_role_or_anon_with_rls_allow>
--
-- A view always reads from source-of-truth at query time, so the numbers
-- never go stale. No triggers, no refresh jobs, no extra table to maintain.

create or replace view project_metrics as
with all_runs as (
  -- Unify the three tables into one shape so the aggregations stay simple.
  select 'lead'    as source, status, completed_at from lead_websites
  union all
  select 'custom'  as source, status, completed_at from custom_link_websites
  union all
  select 'general' as source, status, completed_at from general_link_websites
),
buckets as (
  select
    r.source,
    r.status,
    -- Bucket flags so every aggregation below is just a SUM(CASE ...).
    (r.completed_at >= date_trunc('day',   timezone('utc', now())))    as in_today,
    (r.completed_at >= date_trunc('week',  timezone('utc', now())))    as in_week,
    (r.completed_at >= date_trunc('month', timezone('utc', now())))    as in_month,
    (r.completed_at >= date_trunc('year',  timezone('utc', now())))    as in_year
  from all_runs r
  where r.status in ('completed', 'failed')
)
select
  -- ── Generated (status = completed) ────────────────────────────────────────
  sum(case when status = 'completed'                          then 1 else 0 end) as total_all,
  sum(case when status = 'completed' and source = 'lead'      then 1 else 0 end) as total_leads,
  sum(case when status = 'completed' and source = 'custom'    then 1 else 0 end) as total_custom,
  sum(case when status = 'completed' and source = 'general'   then 1 else 0 end) as total_general,

  -- ── Failed (denominator companion to success rate) ────────────────────────
  sum(case when status = 'failed'                             then 1 else 0 end) as failed_all,
  sum(case when status = 'failed'    and source = 'lead'      then 1 else 0 end) as failed_leads,
  sum(case when status = 'failed'    and source = 'custom'    then 1 else 0 end) as failed_custom,
  sum(case when status = 'failed'    and source = 'general'   then 1 else 0 end) as failed_general,

  -- ── Success rate (completed / (completed + failed)) ───────────────────────
  -- NULL when no completed+failed runs exist for that bucket → safer than 0/1.
  case when count(*) = 0 then null
       else round(sum(case when status = 'completed' then 1 else 0 end)::numeric
                  / count(*)::numeric, 4)
  end as success_rate_all,

  case when sum(case when source = 'lead' then 1 else 0 end) = 0 then null
       else round(sum(case when status = 'completed' and source = 'lead' then 1 else 0 end)::numeric
                  / sum(case when source = 'lead' then 1 else 0 end)::numeric, 4)
  end as success_rate_leads,

  case when sum(case when source = 'custom' then 1 else 0 end) = 0 then null
       else round(sum(case when status = 'completed' and source = 'custom' then 1 else 0 end)::numeric
                  / sum(case when source = 'custom' then 1 else 0 end)::numeric, 4)
  end as success_rate_custom,

  case when sum(case when source = 'general' then 1 else 0 end) = 0 then null
       else round(sum(case when status = 'completed' and source = 'general' then 1 else 0 end)::numeric
                  / sum(case when source = 'general' then 1 else 0 end)::numeric, 4)
  end as success_rate_general,

  -- ── Today (UTC) — completed only ──────────────────────────────────────────
  sum(case when status = 'completed' and in_today                            then 1 else 0 end) as today_all,
  sum(case when status = 'completed' and in_today and source = 'lead'        then 1 else 0 end) as today_leads,
  sum(case when status = 'completed' and in_today and source = 'custom'      then 1 else 0 end) as today_custom,
  sum(case when status = 'completed' and in_today and source = 'general'     then 1 else 0 end) as today_general,

  -- ── This week (UTC, ISO week — Mon start) ─────────────────────────────────
  sum(case when status = 'completed' and in_week                             then 1 else 0 end) as this_week_all,
  sum(case when status = 'completed' and in_week  and source = 'lead'        then 1 else 0 end) as this_week_leads,
  sum(case when status = 'completed' and in_week  and source = 'custom'      then 1 else 0 end) as this_week_custom,
  sum(case when status = 'completed' and in_week  and source = 'general'     then 1 else 0 end) as this_week_general,

  -- ── This month (UTC) ──────────────────────────────────────────────────────
  sum(case when status = 'completed' and in_month                            then 1 else 0 end) as this_month_all,
  sum(case when status = 'completed' and in_month and source = 'lead'        then 1 else 0 end) as this_month_leads,
  sum(case when status = 'completed' and in_month and source = 'custom'      then 1 else 0 end) as this_month_custom,
  sum(case when status = 'completed' and in_month and source = 'general'     then 1 else 0 end) as this_month_general,

  -- ── This year (UTC) ───────────────────────────────────────────────────────
  sum(case when status = 'completed' and in_year                             then 1 else 0 end) as this_year_all,
  sum(case when status = 'completed' and in_year  and source = 'lead'        then 1 else 0 end) as this_year_leads,
  sum(case when status = 'completed' and in_year  and source = 'custom'      then 1 else 0 end) as this_year_custom,
  sum(case when status = 'completed' and in_year  and source = 'general'     then 1 else 0 end) as this_year_general
from buckets;

-- Allow the anon role read access. The centralized dashboard typically uses the
-- service_role key (which bypasses RLS), but exposing read to anon means the
-- public Supabase URL works directly without managing a service key.
-- Remove this grant if you want service-role-only access.
grant select on project_metrics to anon, authenticated;

-- Sanity check: pull the row.
-- select * from project_metrics;
