import { useState, useEffect, useRef, useCallback } from "react";
import { api, type SheetsEntry } from "../api/client";
import PreviewModal from "../components/PreviewModal";

const ACTIVE_STATUSES = new Set(["pending", "scraping", "generating", "deploying"]);

type WebsiteFilter = "all" | "has_website" | "no_website";
type StatusFilter = "all" | "not_started" | "active" | "awaiting_approval" | "completed" | "failed";

function statusColor(status: string | undefined): string {
  if (!status)                        return "#3a3a52";
  if (status === "completed")         return "#4ade80";
  if (status === "failed")            return "#f87171";
  if (status === "cancelled")         return "#6b7280";
  if (status === "skipped")           return "#facc15";
  if (status === "awaiting_approval") return "#38bdf8";
  return "#fb923c";
}

function statusLabel(status: string | undefined): string {
  if (!status)                        return "not started";
  if (status === "awaiting_approval") return "Ready to Deploy";
  return status.replace(/_/g, " ");
}

function StatusBadge({ status }: { status: string | undefined }) {
  const color    = statusColor(status);
  const label    = statusLabel(status);
  const isActive = !!status && ACTIVE_STATUSES.has(status);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{
        width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0,
        boxShadow: isActive ? `0 0 6px ${color}` : undefined,
        animation: isActive ? "pulse 1.5s ease-in-out infinite" : undefined,
      }} />
      <span style={{ fontSize: 12, color, fontWeight: 500, textTransform: "capitalize" }}>
        {label}
      </span>
    </span>
  );
}

function WebsiteBadge({ hasWebsite }: { hasWebsite: boolean }) {
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: 4,
      fontSize: 11,
      fontWeight: 600,
      background: hasWebsite ? "rgba(56,189,248,0.12)" : "rgba(251,146,60,0.12)",
      color: hasWebsite ? "#38bdf8" : "#fb923c",
      border: `1px solid ${hasWebsite ? "rgba(56,189,248,0.25)" : "rgba(251,146,60,0.25)"}`,
    }}>
      {hasWebsite ? "Has Website" : "No Website"}
    </span>
  );
}

function truncate(s: string | null | undefined, len: number): string {
  if (!s) return "—";
  return s.length > len ? s.slice(0, len) + "…" : s;
}

const btn = (color: string, bg: string, border = "transparent"): React.CSSProperties => ({
  padding: "6px 12px",
  borderRadius: 6,
  border: `1px solid ${border}`,
  background: bg,
  color,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "Inter, sans-serif",
  transition: "opacity 0.15s",
});

export default function SheetsBuilderPage() {
  const [entries, setEntries]             = useState<SheetsEntry[]>([]);
  const [loading, setLoading]             = useState(true);

  const [syncing, setSyncing]             = useState(false);
  const [syncMsg, setSyncMsg]             = useState<string | null>(null);

  const [selected, setSelected]           = useState<Set<string>>(new Set());
  const [query, setQuery]                 = useState("");
  const [websiteFilter, setWebsiteFilter] = useState<WebsiteFilter>("all");
  const [statusFilter, setStatusFilter]   = useState<StatusFilter>("all");

  const [generatingIds, setGeneratingIds] = useState<Set<string>>(new Set());
  const [deployingIds, setDeployingIds]   = useState<Set<string>>(new Set());

  const [previewEntry, setPreviewEntry]   = useState<{ ewId: string; label: string } | null>(null);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Fetch entries ──────────────────────────────────────────────────────────

  const fetchEntries = useCallback(async () => {
    try {
      const res = await api.getSheetsEntries();
      setEntries(res.entries);
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  // ── Polling ────────────────────────────────────────────────────────────────

  useEffect(() => {
    const hasActive = entries.some(
      (e) => e.latest_run && ACTIVE_STATUSES.has(e.latest_run.status),
    );
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollingRef.current = setInterval(fetchEntries, hasActive ? 3000 : 10000);
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, [entries, fetchEntries]);

  // ── Sync handler ───────────────────────────────────────────────────────────

  async function handleSync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await api.syncSheet();
      setEntries(res.entries);
      setSyncMsg(`Sync complete — ${res.added} added, ${res.updated} updated`);
      setTimeout(() => setSyncMsg(null), 4000);
    } catch (err: unknown) {
      setSyncMsg(err instanceof Error ? err.message : "Sync failed");
      setTimeout(() => setSyncMsg(null), 5000);
    } finally {
      setSyncing(false);
    }
  }

  // ── Generate handlers ──────────────────────────────────────────────────────

  async function handleGenerate(entry: SheetsEntry) {
    setGeneratingIds((s) => new Set(s).add(entry.id));
    try {
      await api.generateForSheetsEntry(entry.id);
      await fetchEntries();
    } catch (err: unknown) {
      console.error("Generate failed:", err);
    } finally {
      setGeneratingIds((s) => { const n = new Set(s); n.delete(entry.id); return n; });
    }
  }

  async function handleBatchGenerate() {
    if (!selected.size) return;
    const ids = [...selected];
    setSelected(new Set());
    try {
      await api.generateSheetsBatch(ids);
      await fetchEntries();
    } catch (err: unknown) {
      console.error("Batch generate failed:", err);
    }
  }

  async function handleGenerateAll() {
    const eligibleIds = visible
      .filter((e) => !e.latest_run || ["failed", "cancelled"].includes(e.latest_run.status))
      .map((e) => e.id);
    if (!eligibleIds.length) return;
    try {
      await api.generateSheetsBatch(eligibleIds);
      await fetchEntries();
    } catch (err: unknown) {
      console.error("Generate all failed:", err);
    }
  }

  async function handleDeploy(ewId: string) {
    setDeployingIds((s) => new Set(s).add(ewId));
    try {
      await api.deploySheetsEntry(ewId);
      await fetchEntries();
    } catch (err: unknown) {
      console.error("Deploy failed:", err);
    } finally {
      setDeployingIds((s) => { const n = new Set(s); n.delete(ewId); return n; });
    }
  }

  async function handleRetry(ewId: string) {
    try {
      await api.retrySheetsGeneration(ewId);
      await fetchEntries();
    } catch (err: unknown) {
      console.error("Retry failed:", err);
    }
  }

  async function handleCancel(ewId: string) {
    try {
      await api.cancelSheetsRun(ewId);
      await fetchEntries();
    } catch (err: unknown) {
      console.error("Cancel failed:", err);
    }
  }

  // ── Filtering ──────────────────────────────────────────────────────────────

  const visible = entries.filter((e) => {
    if (websiteFilter === "has_website" && !e.website_url) return false;
    if (websiteFilter === "no_website"  && e.website_url)  return false;

    const runStatus = e.latest_run?.status;
    if (statusFilter === "not_started"       && runStatus)                                 return false;
    if (statusFilter === "active"            && (!runStatus || !ACTIVE_STATUSES.has(runStatus))) return false;
    if (statusFilter === "awaiting_approval" && runStatus !== "awaiting_approval")          return false;
    if (statusFilter === "completed"         && runStatus !== "completed")                  return false;
    if (statusFilter === "failed"            && runStatus !== "failed")                     return false;

    if (query.trim()) {
      const q          = query.toLowerCase();
      const searchable = [e.business_name, e.website_url, e.business_description, e.design_preferences]
        .filter(Boolean).join(" ").toLowerCase();
      if (!searchable.includes(q)) return false;
    }

    return true;
  });

  const allSelected = visible.length > 0 && visible.every((e) => selected.has(e.id));

  function toggleSelectAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(visible.map((e) => e.id)));
  }

  function toggleSelect(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  const selectedCount = [...selected].filter((id) => visible.some((e) => e.id === id)).length;

  // ── Stats ──────────────────────────────────────────────────────────────────

  const stats = {
    total:      entries.length,
    hasWebsite: entries.filter((e) => e.website_url).length,
    noWebsite:  entries.filter((e) => !e.website_url).length,
    completed:  entries.filter((e) => e.latest_run?.status === "completed").length,
    pending:    entries.filter((e) => !e.latest_run).length,
    active:     entries.filter((e) => e.latest_run && ACTIVE_STATUSES.has(e.latest_run.status)).length,
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      {previewEntry && (() => {
        const ewId        = previewEntry.ewId;
        const isDeploying = deployingIds.has(ewId);
        return (
          <PreviewModal
            label={previewEntry.label}
            previewUrl={api.previewSheetsHtmlUrl(ewId)}
            assetsUrl={api.sheetsAssetsUrl(ewId)}
            assetBaseUrl={api.sheetsAssetBaseUrl(ewId)}
            htmlUrl={api.sheetsHtmlUrl(ewId)}
            uploadUrl={api.sheetsUploadAssetUrl(ewId)}
            chatEditUrl={api.sheetsChatEditUrl(ewId)}
            undoUrl={api.sheetsUndoUrl(ewId)}
            onClose={() => setPreviewEntry(null)}
            onDeploy={() => handleDeploy(ewId)}
            deploying={isDeploying}
          />
        );
      })()}

      <div style={{ minHeight: "100vh", padding: "36px 32px", fontFamily: "Inter, sans-serif" }}>
        <style>{`
          @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
          .sb-row:hover { background: rgba(255,255,255,0.025) !important; }
          .sb-btn { cursor: pointer; border: none; outline: none; font-family: Inter, sans-serif; }
          .sb-btn:hover:not(:disabled) { opacity: 0.82; }
          .sb-btn:disabled { opacity: 0.4; cursor: not-allowed; }
          .sb-input:focus { outline: none; border-color: rgba(124,58,237,0.6) !important; }
        `}</style>

        <div style={{ maxWidth: 1100, margin: "0 auto" }}>

          {/* Header */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 24 }}>
            <div style={{ flex: 1 }}>
              <h1 style={{ fontSize: 22, fontWeight: 600, color: "#FFFFFF", margin: 0 }}>
                Sheets Builder
              </h1>
              <p style={{ fontSize: 13, color: "#5a5a72", margin: "4px 0 0" }}>
                {entries.length > 0
                  ? `${stats.total} businesses · ${stats.hasWebsite} with website · ${stats.noWebsite} without`
                  : "Click Sync Sheet to load businesses from Google Sheets"}
              </p>
              {syncMsg && (
                <p style={{
                  fontSize: 12,
                  margin: "4px 0 0",
                  color: syncMsg.toLowerCase().includes("fail") ? "#f87171" : "#4ade80",
                }}>
                  {syncMsg}
                </p>
              )}
            </div>
            <button
              className="sb-btn"
              disabled={syncing}
              onClick={handleSync}
              style={{
                ...btn("#38bdf8", "rgba(56,189,248,0.08)", "rgba(56,189,248,0.2)"),
                padding: "9px 20px",
                fontSize: 13,
                flexShrink: 0,
              }}
            >
              {syncing ? "Syncing…" : "Sync Sheet"}
            </button>
          </div>

          {/* Loading */}
          {loading ? (
            <div style={{ color: "#5a5a72", textAlign: "center", padding: "60px 0" }}>
              Loading…
            </div>
          ) : entries.length === 0 ? (
            <div style={{
              border: "1px dashed rgba(255,255,255,0.08)",
              borderRadius: 8,
              padding: "60px 32px",
              textAlign: "center",
            }}>
              <div style={{ fontSize: 36, marginBottom: 14, opacity: 0.3 }}>📊</div>
              <div style={{ color: "#5a5a72", fontSize: 14, marginBottom: 16 }}>
                No businesses loaded yet.
              </div>
              <button
                className="sb-btn"
                disabled={syncing}
                onClick={handleSync}
                style={{
                  ...btn("#38bdf8", "rgba(56,189,248,0.08)", "rgba(56,189,248,0.2)"),
                  padding: "10px 24px",
                  fontSize: 13,
                }}
              >
                {syncing ? "Syncing…" : "Sync Sheet Now"}
              </button>
            </div>
          ) : (
            <>
              {/* Stats strip */}
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
                {[
                  { label: "Total",     value: stats.total,      color: "#a0a0b8" },
                  { label: "Has URL",   value: stats.hasWebsite, color: "#38bdf8" },
                  { label: "No URL",    value: stats.noWebsite,  color: "#fb923c" },
                  { label: "Done",      value: stats.completed,  color: "#4ade80" },
                  { label: "Not built", value: stats.pending,    color: "#5a5a72" },
                  { label: "Running",   value: stats.active,     color: "#fb923c" },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid rgba(255,255,255,0.07)",
                    borderRadius: 6,
                    padding: "8px 14px",
                    minWidth: 80,
                    textAlign: "center",
                  }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color }}>{value}</div>
                    <div style={{ fontSize: 11, color: "#5a5a72", marginTop: 1 }}>{label}</div>
                  </div>
                ))}
              </div>

              {/* Toolbar */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16, alignItems: "center" }}>
                <input
                  className="sb-input"
                  type="text"
                  placeholder="Search businesses…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  style={{
                    flex: "1 1 200px",
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 6,
                    padding: "7px 12px",
                    color: "#FAFAFA",
                    fontSize: 13,
                    fontFamily: "Inter, sans-serif",
                  }}
                />
                <select
                  value={websiteFilter}
                  onChange={(e) => setWebsiteFilter(e.target.value as WebsiteFilter)}
                  style={{
                    background: "rgba(255,255,255,0.06)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 6,
                    padding: "7px 10px",
                    color: "#FAFAFA",
                    fontSize: 12.5,
                    fontFamily: "Inter, sans-serif",
                    cursor: "pointer",
                  }}
                >
                  <option value="all">All Types</option>
                  <option value="has_website">Has Website</option>
                  <option value="no_website">No Website</option>
                </select>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                  style={{
                    background: "rgba(255,255,255,0.06)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 6,
                    padding: "7px 10px",
                    color: "#FAFAFA",
                    fontSize: 12.5,
                    fontFamily: "Inter, sans-serif",
                    cursor: "pointer",
                  }}
                >
                  <option value="all">All Statuses</option>
                  <option value="not_started">Not Started</option>
                  <option value="active">Active</option>
                  <option value="awaiting_approval">Ready to Deploy</option>
                  <option value="completed">Completed</option>
                  <option value="failed">Failed</option>
                </select>
                <div style={{ flex: 1 }} />
                {selectedCount > 0 && (
                  <button
                    className="sb-btn"
                    onClick={handleBatchGenerate}
                    style={btn("#fff", "linear-gradient(135deg,#7c3aed,#6d28d9)")}
                  >
                    Generate {selectedCount} selected
                  </button>
                )}
                <button
                  className="sb-btn"
                  onClick={handleGenerateAll}
                  style={btn("#fff", "rgba(124,58,237,0.15)", "rgba(124,58,237,0.35)")}
                >
                  Generate All Unbuilt
                </button>
              </div>

              {/* Table */}
              {visible.length === 0 ? (
                <div style={{ color: "#5a5a72", textAlign: "center", padding: "40px 0" }}>
                  No entries match your filters.
                </div>
              ) : (
                <div style={{ border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, overflow: "hidden" }}>
                  {/* Header row */}
                  <div style={{
                    display: "grid",
                    gridTemplateColumns: "36px 1fr 120px 160px 140px 100px 180px",
                    padding: "10px 14px",
                    background: "rgba(255,255,255,0.03)",
                    borderBottom: "1px solid rgba(255,255,255,0.07)",
                    fontSize: 11,
                    fontWeight: 600,
                    color: "#5a5a72",
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    gap: 8,
                  }}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      style={{ cursor: "pointer", accentColor: "#7c3aed" }}
                    />
                    <span>Business</span>
                    <span>Type</span>
                    <span>Design Prefs</span>
                    <span>Description</span>
                    <span>Status</span>
                    <span>Actions</span>
                  </div>

                  {/* Data rows */}
                  {visible.map((entry) => {
                    const run           = entry.latest_run;
                    const hasUrl        = !!entry.website_url;
                    const isActive      = !!run && ACTIVE_STATUSES.has(run.status);
                    const canGen        = !run || ["failed", "cancelled"].includes(run.status);
                    const canDeploy     = run?.status === "awaiting_approval";
                    const canPreview    = !!run?.generated_html_path;
                    const canRetry      = run?.status === "failed";
                    const isGenerating  = generatingIds.has(entry.id);
                    const isDeploying   = deployingIds.has(run?.id ?? "");
                    const label         = entry.business_name || entry.business_description || "(unnamed)";

                    return (
                      <div
                        key={entry.id}
                        className="sb-row"
                        style={{
                          display: "grid",
                          gridTemplateColumns: "36px 1fr 120px 160px 140px 100px 180px",
                          padding: "11px 14px",
                          borderBottom: "1px solid rgba(255,255,255,0.05)",
                          alignItems: "center",
                          gap: 8,
                          background: selected.has(entry.id) ? "rgba(124,58,237,0.06)" : "transparent",
                          transition: "background 0.1s",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(entry.id)}
                          onChange={() => toggleSelect(entry.id)}
                          style={{ cursor: "pointer", accentColor: "#7c3aed" }}
                        />

                        {/* Business */}
                        <div style={{ minWidth: 0 }}>
                          <div style={{
                            color: entry.business_name ? "#f0f0f8" : "#5a5a72",
                            fontWeight: entry.business_name ? 500 : 400,
                            fontSize: 13,
                            fontStyle: entry.business_name ? "normal" : "italic",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}>
                            {label}
                          </div>
                          {entry.website_url && (
                            <a
                              href={entry.website_url}
                              target="_blank"
                              rel="noreferrer"
                              style={{ color: "#5a5a72", fontSize: 11, textDecoration: "none" }}
                              onClick={(ev) => ev.stopPropagation()}
                            >
                              {entry.website_url.replace(/^https?:\/\//, "").slice(0, 30)}
                            </a>
                          )}
                        </div>

                        <WebsiteBadge hasWebsite={hasUrl} />

                        <div style={{ color: "#8A8A8A", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {truncate(entry.design_preferences, 28)}
                        </div>

                        <div style={{ color: "#8A8A8A", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {truncate(entry.business_description, 30)}
                        </div>

                        <StatusBadge status={run?.status} />

                        {/* Actions */}
                        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                          {canGen && !isGenerating && (
                            <button
                              className="sb-btn"
                              onClick={() => handleGenerate(entry)}
                              style={btn("#fff", "rgba(124,58,237,0.2)", "rgba(124,58,237,0.35)")}
                            >
                              Build
                            </button>
                          )}
                          {isGenerating && (
                            <span style={{ fontSize: 11, color: "#fb923c" }}>Starting…</span>
                          )}
                          {isActive && !isGenerating && (
                            <button
                              className="sb-btn"
                              onClick={() => handleCancel(run!.id)}
                              style={btn("#f87171", "rgba(248,113,113,0.08)", "rgba(248,113,113,0.2)")}
                            >
                              Stop
                            </button>
                          )}
                          {canPreview && (
                            <button
                              className="sb-btn"
                              onClick={() => setPreviewEntry({ ewId: run!.id, label })}
                              style={btn("#38bdf8", "rgba(56,189,248,0.08)", "rgba(56,189,248,0.2)")}
                            >
                              View
                            </button>
                          )}
                          {canDeploy && (
                            <button
                              className="sb-btn"
                              disabled={isDeploying}
                              onClick={() => handleDeploy(run!.id)}
                              style={btn("#4ade80", "rgba(74,222,128,0.08)", "rgba(74,222,128,0.2)")}
                            >
                              {isDeploying ? "…" : "Deploy"}
                            </button>
                          )}
                          {run?.status === "completed" && run.netlify_url && (
                            <a
                              href={run.netlify_url}
                              target="_blank"
                              rel="noreferrer"
                              style={{
                                ...btn("#4ade80", "rgba(74,222,128,0.08)", "rgba(74,222,128,0.2)"),
                                textDecoration: "none",
                                display: "inline-block",
                              }}
                            >
                              Live
                            </a>
                          )}
                          {canRetry && (
                            <button
                              className="sb-btn"
                              onClick={() => handleRetry(run!.id)}
                              style={btn("#fb923c", "rgba(251,146,60,0.08)", "rgba(251,146,60,0.2)")}
                            >
                              Retry
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div style={{ color: "#3a3a52", fontSize: 12, marginTop: 12, textAlign: "right" }}>
                {visible.length} of {entries.length} entries shown
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
