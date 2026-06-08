const BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

export type DemoFilter  = "none" | "all" | "completed";
export type DateRange   = "all" | "today" | "week" | "month" | "custom";

export interface Lead {
  id: string;
  name: string;
  first_name: string;
  last_name: string;
  email: string;
  company_name: string | null;
  company_website_url: string | null;
  has_demo: boolean;
  demo_url: string | null;
  demo_generated_at: string | null;
  imported_at: string | null;
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

export interface AwaitingReviewItem {
  id: string;
  lead_id: string;
  lead_name: string;
  company_name: string;
  started_at: string | null;
}

export interface ActiveRunsResponse {
  running: ActiveRunItem[];
  recently_completed: ActiveCompletedItem[];
  awaiting_review: AwaitingReviewItem[];
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
  generated_html_path: string | null;
  lead_name: string;
  company_name: string;
}

export interface HistoryResponse {
  history: HistoryItem[];
}

export interface CustomLinkRun {
  id: string;
  custom_link_id: string;
  status: string;
  netlify_url: string | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  generated_html_path: string | null;
}

export interface CustomLink {
  id: string;
  url: string;
  label: string;
  created_at: string | null;
  latest_run: CustomLinkRun | null;
}

export interface CustomLinksResponse {
  custom_links: CustomLink[];
}

export interface CreateCustomLinkResponse {
  id: string;
  url: string;
  label: string | null;
  created_at: string | null;
}

export interface CustomBatchStatusItem {
  id: string;
  custom_link_id: string;
  status: string;
  netlify_url: string | null;
  error: string | null;
  label: string;
  url: string;
}

export interface GeneralLinkRun {
  id: string;
  general_link_id: string;
  status: string;
  netlify_url: string | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  generated_html_path: string | null;
}

export interface GeneralLink {
  id: string;
  url: string;
  label: string;
  created_at: string | null;
  latest_run: GeneralLinkRun | null;
}

export interface GeneralLinksResponse {
  general_links: GeneralLink[];
}

export interface CreateGeneralLinkResponse {
  id: string;
  url: string;
  label: string | null;
  created_at: string | null;
}

export interface GeneralBatchStatusItem {
  id: string;
  general_link_id: string;
  status: string;
  netlify_url: string | null;
  error: string | null;
  label: string;
  url: string;
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

  updateLead: (
    leadId: string,
    patch: { company_website_url?: string | null; demo_site_url?: string | null },
  ): Promise<{ updated: boolean }> =>
    request(`/leads/${leadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),

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

  deleteHistoryItem: (lwId: string): Promise<{ deleted: boolean }> =>
    request(`/history/${lwId}`, { method: "DELETE" }),

  getActiveRuns: (): Promise<ActiveRunsResponse> =>
    request("/active"),

  getDashboardStats: (): Promise<DashboardStats> =>
    request("/dashboard/stats"),

  getCustomLinks: (): Promise<CustomLinksResponse> =>
    request("/custom-links"),

  exportCustomLinksUrl: (ids?: string[]): string => {
    if (ids && ids.length > 0) return `${BASE}/custom-links/export?ids=${ids.join(",")}`;
    return `${BASE}/custom-links/export`;
  },

  createCustomLink: (url: string, label?: string): Promise<CreateCustomLinkResponse> =>
    request("/custom-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, label }),
    }),

  deleteCustomLink: (id: string): Promise<{ deleted: boolean }> =>
    request(`/custom-links/${id}`, { method: "DELETE" }),

  generateForCustomLink: (id: string): Promise<{ custom_link_website_id: string; status: string }> =>
    request(`/custom-links/${id}/generate`, { method: "POST" }),

  generateCustomBatch: (
    customLinkIds: string[],
  ): Promise<{ queued: { custom_link_id: string; custom_link_website_id: string; status: string }[] }> =>
    request("/custom-links/generate/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ custom_link_ids: customLinkIds }),
    }),

  getCustomBatchStatus: (ids: string[]): Promise<CustomBatchStatusItem[]> =>
    request(`/custom-links/generate/batch/status?ids=${ids.join(",")}`),

  retryCustomGeneration: (clwId: string): Promise<{ status: string; custom_link_website_id: string }> =>
    request(`/custom-links/generate/${clwId}/retry`, { method: "POST" }),

  previewCustomHtmlUrl: (clwId: string): string =>
    `${BASE}/custom-links/generate/${clwId}/preview`,

  deployCustomLink: (clwId: string): Promise<{ status: string; custom_link_website_id: string }> =>
    request(`/custom-links/generate/${clwId}/deploy`, { method: "POST" }),

  cancelCustomRun: (clwId: string): Promise<{ cancelled: boolean }> =>
    request(`/custom-links/generate/${clwId}/cancel`, { method: "POST" }),

  customAssetsUrl: (clwId: string): string =>
    `${BASE}/custom-links/generate/${clwId}/assets`,

  customUploadAssetUrl: (clwId: string): string =>
    `${BASE}/custom-links/generate/${clwId}/upload-asset`,

  customAssetBaseUrl: (clwId: string): string =>
    `${BASE}/custom-links/generate/${clwId}/asset`,

  customHtmlUrl: (clwId: string): string =>
    `${BASE}/custom-links/generate/${clwId}/html`,

  saveCustomHtml: (clwId: string, html: string): Promise<{ saved: boolean }> =>
    request(`/custom-links/generate/${clwId}/html`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html }),
    }),

  customChatEditUrl: (clwId: string): string =>
    `${BASE}/custom-links/generate/${clwId}/chat-edit`,

  customUndoUrl: (clwId: string): string =>
    `${BASE}/custom-links/generate/${clwId}/undo`,

  uploadLeadAsset: (lwId: string, file: File): Promise<{ filename: string; size: number }> => {
    const form = new FormData();
    form.append("file", file);
    return request(`/generate/${lwId}/upload-asset`, { method: "POST", body: form });
  },

  uploadCustomAsset: (clwId: string, file: File): Promise<{ filename: string; size: number }> => {
    const form = new FormData();
    form.append("file", file);
    return request(`/custom-links/generate/${clwId}/upload-asset`, { method: "POST", body: form });
  },

  cancelLeadRun: (lwId: string): Promise<{ cancelled: boolean }> =>
    request(`/generate/${lwId}/cancel`, { method: "POST" }),

  deployLead: (lwId: string): Promise<{ status: string; lead_website_id: string }> =>
    request(`/generate/${lwId}/deploy`, { method: "POST" }),

  previewLeadHtmlUrl: (lwId: string): string =>
    `${BASE}/generate/${lwId}/preview`,

  leadAssetsUrl: (lwId: string): string =>
    `${BASE}/generate/${lwId}/assets`,

  leadUploadAssetUrl: (lwId: string): string =>
    `${BASE}/generate/${lwId}/upload-asset`,

  leadAssetBaseUrl: (lwId: string): string =>
    `${BASE}/generate/${lwId}/asset`,

  leadHtmlUrl: (lwId: string): string =>
    `${BASE}/generate/${lwId}/html`,

  saveLeadHtml: (lwId: string, html: string): Promise<{ saved: boolean }> =>
    request(`/generate/${lwId}/html`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html }),
    }),

  leadChatEditUrl: (lwId: string): string =>
    `${BASE}/generate/${lwId}/chat-edit`,

  leadUndoUrl: (lwId: string): string =>
    `${BASE}/generate/${lwId}/undo`,

  setLeadUrl: (lwId: string, url: string): Promise<{ status: string; netlify_url: string }> =>
    request(`/generate/${lwId}/set-url`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }),

  setCustomUrl: (clwId: string, url: string): Promise<{ status: string; netlify_url: string }> =>
    request(`/custom-links/generate/${clwId}/set-url`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }),

  // ── General Sites (niche-agnostic generator) ───────────────────────────────

  getGeneralLinks: (): Promise<GeneralLinksResponse> =>
    request("/general-sites"),

  exportGeneralLinksUrl: (ids?: string[]): string => {
    if (ids && ids.length > 0) return `${BASE}/general-sites/export?ids=${ids.join(",")}`;
    return `${BASE}/general-sites/export`;
  },

  createGeneralLink: (url: string, label?: string): Promise<CreateGeneralLinkResponse> =>
    request("/general-sites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, label }),
    }),

  deleteGeneralLink: (id: string): Promise<{ deleted: boolean }> =>
    request(`/general-sites/${id}`, { method: "DELETE" }),

  generateForGeneralLink: (id: string): Promise<{ general_link_website_id: string; status: string }> =>
    request(`/general-sites/${id}/generate`, { method: "POST" }),

  generateGeneralBatch: (
    generalLinkIds: string[],
  ): Promise<{ queued: { general_link_id: string; general_link_website_id: string; status: string }[] }> =>
    request("/general-sites/generate/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ general_link_ids: generalLinkIds }),
    }),

  getGeneralBatchStatus: (ids: string[]): Promise<GeneralBatchStatusItem[]> =>
    request(`/general-sites/generate/batch/status?ids=${ids.join(",")}`),

  retryGeneralGeneration: (glwId: string): Promise<{ status: string; general_link_website_id: string }> =>
    request(`/general-sites/generate/${glwId}/retry`, { method: "POST" }),

  previewGeneralHtmlUrl: (glwId: string): string =>
    `${BASE}/general-sites/generate/${glwId}/preview`,

  deployGeneralLink: (glwId: string): Promise<{ status: string; general_link_website_id: string }> =>
    request(`/general-sites/generate/${glwId}/deploy`, { method: "POST" }),

  cancelGeneralRun: (glwId: string): Promise<{ cancelled: boolean }> =>
    request(`/general-sites/generate/${glwId}/cancel`, { method: "POST" }),

  generalAssetsUrl: (glwId: string): string =>
    `${BASE}/general-sites/generate/${glwId}/assets`,

  generalUploadAssetUrl: (glwId: string): string =>
    `${BASE}/general-sites/generate/${glwId}/upload-asset`,

  generalAssetBaseUrl: (glwId: string): string =>
    `${BASE}/general-sites/generate/${glwId}/asset`,

  generalHtmlUrl: (glwId: string): string =>
    `${BASE}/general-sites/generate/${glwId}/html`,

  saveGeneralHtml: (glwId: string, html: string): Promise<{ saved: boolean }> =>
    request(`/general-sites/generate/${glwId}/html`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html }),
    }),

  generalChatEditUrl: (glwId: string): string =>
    `${BASE}/general-sites/generate/${glwId}/chat-edit`,

  generalUndoUrl: (glwId: string): string =>
    `${BASE}/general-sites/generate/${glwId}/undo`,

  uploadGeneralAsset: (glwId: string, file: File): Promise<{ filename: string; size: number }> => {
    const form = new FormData();
    form.append("file", file);
    return request(`/general-sites/generate/${glwId}/upload-asset`, { method: "POST", body: form });
  },

  setGeneralUrl: (glwId: string, url: string): Promise<{ status: string; netlify_url: string }> =>
    request(`/general-sites/generate/${glwId}/set-url`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }),
};
