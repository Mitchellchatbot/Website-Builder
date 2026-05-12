-- New columns on leads for fast lookup
alter table leads add column if not exists demo_site_url text;
alter table leads add column if not exists demo_site_generated_at timestamptz;

-- Full audit table for each generation run
create table if not exists lead_websites (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  netlify_url text,
  netlify_deploy_id text,
  scraped_data_path text,
  generated_html_path text,
  status text not null default 'pending',
    -- 'pending' | 'scraping' | 'generating' | 'deploying' | 'completed' | 'failed'
  error text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_lead_websites_lead_id on lead_websites(lead_id);
create index if not exists idx_lead_websites_status on lead_websites(status);
