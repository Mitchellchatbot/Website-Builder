const BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

export type DemoFilter  = "none" | "all" | "completed";
export type DateRange   = "all" | "today" | "week" | "month" | "custom";

export interface Lead {
  id: string;
  name: string;
  company_name: string | null;
  company_website_url: string | null;
  has_demo: boolean;
  demo_url: string | null;
  demo_generated_at: string | null;
}

export interface ActiveRunItem {
  id: string;
  lead_id: string;
  lead_name: string;
  company_name: string;
  status: string;
  started_at: string | null;
  duration_seconds: number;
}

export interface ActiveCompletedItem {
  id: string;
  lead_id: string;
  lead_name: string;
  company_name: string;
  status: string;
  netlify_url: string | null;
  error: string | null;
  completed_at: string | null;
}

export interface ActiveRunsResponse {
  running: ActiveRunItem[];
  recently_completed: ActiveCompletedItem[];
}

export interface DashboardStats {
  totals: { completed: number; failed: number; success_rate: number | null };
  today:  { completed: number; failed: number };
  avg_duration_seconds: number | null;
  daily_counts: { date: string; completed: number; failed: number }[];
  top_failure_reasons: {
    error: string;
    count: number;
    example_lead: string;
    example_lead_id: string;
  }[];
}

export interface LeadsResponse {
  leads: Lead[];
}

export interface GenerateResponse {
  lead_website_id: string;
  status: string;
}

export interface GenerationStatus {
  id: string;
  lead_id: string;
  status: string;
  netlify_url: string | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  scraped_data_path: string | null;
  generated_html_path: string | null;
  lead: {
    id: string;
    name: string;
    company_name: string | null;
    company_website_url: string | null;
  };
}

export interface BatchQueuedItem {
  lead_id: string;
  lead_website_id: string;
  status: string;
}

export interface BatchGenerateResponse {
  queued: BatchQueuedItem[];
}

export interface BatchStatusItem {
  id: string;
  lead_id: string;
  status: string;
  netlify_url: string | null;
  error: string | null;
  lead_name: string;
  company_name: string;
}

export interface HistoryItem {
  id: string;
  lead_id: string;
  status: string;
  netlify_url: string | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  lead_name: string;
  company_name: string;
}

export interface HistoryResponse {
  history: HistoryItem[];
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Request failed");
  }
  return res.json();
}

export const api = {
  getLeads: (
    demoFilter: DemoFilter = "none",
    dateRange:  DateRange  = "all",
    dateStart?: string,
    dateEnd?:   string,
  ): Promise<LeadsResponse> => {
    const p = new URLSearchParams({ demo_filter: demoFilter, date_range: dateRange });
    if (dateStart) p.set("date_start", dateStart);
    if (dateEnd)   p.set("date_end",   dateEnd);
    return request(`/leads?${p}`);
  },

  exportLeadsUrl: (
    demoFilter: DemoFilter,
    dateRange:  DateRange  = "all",
    dateStart?: string,
    dateEnd?:   string,
  ): string => {
    const p = new URLSearchParams({ demo_filter: demoFilter, date_range: dateRange });
    if (dateStart) p.set("date_start", dateStart);
    if (dateEnd)   p.set("date_end",   dateEnd);
    return `${BASE}/leads/export?${p}`;
  },

  generateForLead: (leadId: string): Promise<GenerateResponse> =>
    request("/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lead_id: leadId }),
    }),

  generateBatch: (leadIds: string[]): Promise<BatchGenerateResponse> =>
    request("/generate/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lead_ids: leadIds }),
    }),

  getGenerationStatus: (id: string): Promise<GenerationStatus> =>
    request(`/generate/${id}`),

  getBatchStatus: (ids: string[]): Promise<BatchStatusItem[]> =>
    request(`/generate/batch/status?ids=${ids.join(",")}`),

  retryGeneration: (leadWebsiteId: string): Promise<GenerateResponse> =>
    request(`/generate/${leadWebsiteId}/retry`, { method: "POST" }),

  getHistory: (): Promise<HistoryResponse> =>
    request("/history"),

  getActiveRuns: (): Promise<ActiveRunsResponse> =>
    request("/active"),

  getDashboardStats: (): Promise<DashboardStats> =>
    request("/dashboard/stats"),
};
