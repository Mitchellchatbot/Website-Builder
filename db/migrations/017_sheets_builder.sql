-- Sheets Builder: import Google Sheets data and generate websites per business entry.

create table if not exists sheets_imports (
  id uuid primary key default gen_random_uuid(),
  sheets_url text not null,
  label text,
  entry_count int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_sheets_imports_created_at on sheets_imports(created_at desc);

-- Each deduplicated business row parsed from the sheet
create table if not exists sheets_entries (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references sheets_imports(id) on delete cascade,
  business_name text,
  website_url text,
  design_preferences text,
  business_description text,
  row_index int,
  created_at timestamptz not null default now()
);

create index if not exists idx_sheets_entries_import_id on sheets_entries(import_id);
create index if not exists idx_sheets_entries_created_at on sheets_entries(created_at desc);

-- Generation runs per sheets entry
create table if not exists sheets_entry_websites (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references sheets_entries(id) on delete cascade,
  has_website boolean not null default false,
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

create index if not exists idx_sheets_entry_websites_entry_id on sheets_entry_websites(entry_id);
create index if not exists idx_sheets_entry_websites_status on sheets_entry_websites(status);
create index if not exists idx_sheets_entry_websites_started_at on sheets_entry_websites(started_at desc);