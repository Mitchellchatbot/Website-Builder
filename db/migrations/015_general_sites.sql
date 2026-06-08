-- General (niche-agnostic) website generator tables.
-- Mirrors custom_links / custom_link_websites schema.

create table if not exists general_links (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  label text,
  created_at timestamptz not null default now()
);

create index if not exists idx_general_links_created_at on general_links(created_at desc);

create table if not exists general_link_websites (
  id uuid primary key default gen_random_uuid(),
  general_link_id uuid not null references general_links(id) on delete cascade,
  netlify_url text,
  netlify_deploy_id text,
  scraped_data_path text,
  generated_html_path text,
  status text not null default 'pending',
    -- 'pending' | 'scraping' | 'generating' | 'awaiting_approval' |
    -- 'deploying' | 'completed' | 'failed' | 'cancelled' | 'skipped'
  error text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_general_link_websites_link_id on general_link_websites(general_link_id);
create index if not exists idx_general_link_websites_status on general_link_websites(status);
create index if not exists idx_general_link_websites_started_at on general_link_websites(started_at desc);
