import { useState, useEffect, useMemo } from "react";
import { api, type HistoryItem } from "../api/client";
import PreviewModal from "../components/PreviewModal";

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  completed:         "#4ade80",
  manual:            "#4ade80",
  awaiting_approval: "#38bdf8",
  failed:            "#f87171",
  cancelled:         "#6b7280",
  skipped:           "#facc15",
  pending:           "#fb923c",
  scraping:          "#fb923c",
  generating:        "#818cf8",
  deploying:         "#c084fc",
};

const STATUS_BG: Record<string, string> = {
  completed:         "rgba(74,222,128,0.1)",
  manual:            "rgba(74,222,128,0.1)",
  awaiting_approval: "rgba(56,189,248,0.1)",
  failed:            "rgba(248,113,113,0.1)",
  cancelled:         "rgba(107,114,128,0.1)",
  skipped:           "rgba(250,204,21,0.08)",
  pending:           "rgba(251,146,60,0.1)",
  scraping:          "rgba(251,146,60,0.1)",
  generating:        "rgba(129,140,248,0.1)",
  deploying:         "rgba(192,132,252,0.1)",
};

const STATUS_LABEL: Record<string, string> = {
  completed:         "Live",
  manual:            "Manually Set",
  awaiting_approval: "Ready to Deploy",
  failed:            "Failed",
  cancelled:         "Cancelled",
  skipped:           "Skipped",
  pending:           "Queued",
  scraping:          "Scraping",
  generating:        "Generating",
  deploying:         "Deploying",
};

type TimeFilter = "all" | "today" | "week" | "month" | "custom";
type StatusFilter = "all" | "completed" | "awaiting_approval" | "failed" | "active";

const TIME_OPTIONS: { value: TimeFilter; label: string }[] = [
  { value: "all",    label: "All time"     },
  { value: "today",  label: "Today"        },
  { value: "week",   label: "This week"    },
  { value: "month",  label: "This month"   },
  { value: "custom", label: "Custom range" },
];

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all",                label: "All"              },
  { value: "completed",         label: "Live"             },
  { value: "awaiting_approval", label: "Ready to Deploy"  },
  { value: "active",            label: "In Progress"      },
  { value: "failed",            label: "Failed"           },
];

const ACTIVE_STATUSES = new Set(["pending", "scraping", "generating", "deploying"]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60)  return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function LeadWebsitesPage() {
  const [items,      setItems]      = useState<HistoryItem[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);

  const [timeFilter,   setTimeFilter]   = useState<TimeFilter>("all");
  const [dateStart,    setDateStart]    = useState("");
  const [dateEnd,      setDateEnd]      = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [query,        setQuery]        = useState("");

  const [previewItem,  setPreviewItem]  = useState<HistoryItem | null>(null);
  const [deployingId,  setDeployingId]  = useState<string | null>(null);
  const [retryingId,   setRetryingId]   = useState<string | null>(null);

  useEffect(() => {
    api.getHistory()
      .then((r) => setItems(r.history))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // ── Time bounds ──────────────────────────────────────────────────────────────

  const { sinceMs, beforeMs } = useMemo(() => {
    if (timeFilter === "today") {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      return { sinceMs: start.getTime(), beforeMs: null };
    }
    if (timeFilter === "week")  return { sinceMs: Date.now() - 7  * 86_400_000, beforeMs: null };
    if (timeFilter === "month") return { sinceMs: Date.now() - 30 * 86_400_000, beforeMs: null };
    if (timeFilter === "custom") {
      return {
        sinceMs:  dateStart ? new Date(`${dateStart}T00:00:00`).getTime() : null,
        beforeMs: dateEnd   ? new Date(`${dateEnd}T23:59:59.999`).getTime() : null,
      };
    }
    return { sinceMs: null, beforeMs: null };
  }, [timeFilter, dateStart, dateEnd]);

  // ── Filtered + sorted ────────────────────────────────────────────────────────

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((item) => {
        // time filter uses completed_at (when generation finished), falling back to started_at
        if (sinceMs != null || beforeMs != null) {
          const t = new Date(item.completed_at ?? item.started_at ?? 0).getTime();
          if (sinceMs  != null && t < sinceMs)  return false;
          if (beforeMs != null && t > beforeMs) return false;
        }
        // status filter
        if (statusFilter === "completed"         && item.status !== "completed")         return false;
        if (statusFilter === "awaiting_approval" && item.status !== "awaiting_approval") return false;
        if (statusFilter === "failed"            && item.status !== "failed")            return false;
        if (statusFilter === "active"            && !ACTIVE_STATUSES.has(item.status))   return false;
        // search
        if (q && !`${item.lead_name} ${item.company_name}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => {
        // sort by when the website was generated (completed_at), fall back to started_at
        const ta = new Date(a.completed_at ?? a.started_at ?? 0).getTime();
        const tb = new Date(b.completed_at ?? b.started_at ?? 0).getTime();
        return tb - ta;
      });
  }, [items, sinceMs, beforeMs, statusFilter, query]);

  // ── Stats ────────────────────────────────────────────────────────────────────

  const stats = useMemo(() => ({
    total:     items.length,
    completed: items.filter((i) => i.status === "completed" || (i.status === "failed" && !!i.lead_demo_url)).length,
    awaiting:  items.filter((i) => i.status === "awaiting_approval").length,
    failed:    items.filter((i) => i.status === "failed" && !i.lead_demo_url).length,
    active:    items.filter((i) => ACTIVE_STATUSES.has(i.status)).length,
  }), [items]);

  // ── Export ───────────────────────────────────────────────────────────────────

  function handleExport() {
    const exportable = visible.filter((i) => i.netlify_url || i.lead_demo_url);
    if (!exportable.length) return;

    const rows = [
      ["First Name", "Last Name", "Email", "Demo Site URL", "Date"],
      ...exportable.map((i) => [
        i.lead_first_name,
        i.lead_last_name,
        i.lead_email,
        i.netlify_url ?? i.lead_demo_url ?? "",
        i.started_at ? i.started_at.slice(0, 10) : "",
      ]),
    ];

    const csv = rows
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `lead-websites-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const exportCount = visible.filter((i) => i.netlify_url || i.lead_demo_url).length;

  // ── Actions ──────────────────────────────────────────────────────────────────

  const handleDeploy = async (item: HistoryItem) => {
    setDeployingId(item.id);
    try {
      await api.deployLead(item.id);
      setItems((prev) => prev.map((i) => i.id === item.id ? { ...i, status: "pending" } : i));
      setPreviewItem(null);
    } catch (e) { alert(e instanceof Error ? e.message : "Deploy failed"); }
    finally { setDeployingId(null); }
  };

  const handleRetry = async (item: HistoryItem) => {
    setRetryingId(item.id);
    try {
      await api.retryGeneration(item.id);
      setItems((prev) => prev.map((i) => i.id === item.id ? { ...i, status: "pending" } : i));
    } catch (e) { alert(e instanceof Error ? e.message : "Retry failed"); }
    finally { setRetryingId(null); }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <>
      {previewItem && (
        <PreviewModal
          label={`${previewItem.lead_name} — ${previewItem.company_name}`}
          previewUrl={api.previewLeadHtmlUrl(previewItem.id)}
          assetsUrl={api.leadAssetsUrl(previewItem.id)}
          assetBaseUrl={api.leadAssetBaseUrl(previewItem.id)}
          htmlUrl={api.leadHtmlUrl(previewItem.id)}
          uploadUrl={api.leadUploadAssetUrl(previewItem.id)}
          chatEditUrl={api.leadChatEditUrl(previewItem.id)}
          undoUrl={api.leadUndoUrl(previewItem.id)}
          onDeploy={
            previewItem.status === "awaiting_approval" || previewItem.status === "cancelled"
              ? () => handleDeploy(previewItem)
              : undefined
          }
          deploying={deployingId === previewItem.id}
          onClose={() => setPreviewItem(null)}
        />
      )}

      <div className="page-enter" style={{ minHeight: "100vh", padding: "36px 32px", fontFamily: "Inter, sans-serif" }}>
        <style>{`
          @keyframes spin { to { transform: rotate(360deg); } }
          .lw-card { transition: border-color 150ms, background 150ms; }
          .lw-card:hover { border-color: rgba(124,58,237,0.35) !important; background: rgba(124,58,237,0.04) !important; }
          .lw-chip { cursor: pointer; transition: all 120ms; white-space: nowrap; }
          .lw-chip:hover { opacity: 0.85; }
        `}</style>

        <div style={{ maxWidth: 1060, margin: "0 auto" }}>

          {/* ── Header ── */}
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 16, marginBottom: 28 }}>
            <div>
              <h1 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 26, fontWeight: 700, color: "#f0f0f8", margin: 0, letterSpacing: "-0.5px" }}>
                Lead Websites
              </h1>
              <p style={{ color: "#5a5a72", fontSize: 14, margin: "5px 0 0" }}>
                All generated websites for leads, sorted by most recent
              </p>
            </div>

            {/* Stat pills + export */}
            {!loading && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                {[
                  { label: "Total",    value: stats.total,     color: "#7c3aed" },
                  { label: "Live",     value: stats.completed, color: "#4ade80" },
                  { label: "Awaiting", value: stats.awaiting,  color: "#38bdf8" },
                  { label: "Active",   value: stats.active,    color: "#fb923c" },
                  { label: "Failed",   value: stats.failed,    color: "#f87171" },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{
                    padding: "5px 12px", borderRadius: 8,
                    background: `${color}18`, border: `1px solid ${color}30`,
                    display: "flex", alignItems: "center", gap: 6,
                  }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color, fontFamily: "'Space Grotesk', sans-serif" }}>{value}</span>
                    <span style={{ fontSize: 10.5, color: "#5a5a72", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>{label}</span>
                  </div>
                ))}

                <button
                  onClick={handleExport}
                  disabled={exportCount === 0}
                  title={exportCount === 0 ? "No websites with URLs in current view" : `Export ${exportCount} websites as CSV`}
                  style={{
                    padding: "5px 13px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: exportCount === 0 ? "not-allowed" : "pointer",
                    background: exportCount === 0 ? "transparent" : "rgba(74,222,128,0.08)",
                    border: `1px solid ${exportCount === 0 ? "rgba(255,255,255,0.06)" : "rgba(74,222,128,0.3)"}`,
                    color: exportCount === 0 ? "#3a3a50" : "#4ade80",
                    display: "flex", alignItems: "center", gap: 5, transition: "all 150ms",
                    fontFamily: "Inter, sans-serif", whiteSpace: "nowrap",
                  }}
                  onMouseEnter={(e) => { if (exportCount > 0) e.currentTarget.style.background = "rgba(74,222,128,0.15)"; }}
                  onMouseLeave={(e) => { if (exportCount > 0) e.currentTarget.style.background = "rgba(74,222,128,0.08)"; }}
                >
                  ↓ Export CSV {exportCount > 0 && `(${exportCount})`}
                </button>
              </div>
            )}
          </div>

          {/* ── Filters ── */}
          <div style={{ marginBottom: 20, display: "flex", flexDirection: "column", gap: 8 }}>

            {/* Row 1: search + status filter */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ position: "relative", flex: "1 1 220px", maxWidth: 300 }}>
                <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "#5a5a72", pointerEvents: "none" }}>🔍</span>
                <input
                  type="search"
                  placeholder="Search lead or company…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  style={{
                    width: "100%",
                    paddingLeft: 32, paddingRight: 12, paddingTop: 7, paddingBottom: 7,
                    borderRadius: 7, border: "1px solid rgba(255,255,255,0.1)",
                    background: "rgba(255,255,255,0.04)", color: "#f0f0f8",
                    fontSize: 13, outline: "none", boxSizing: "border-box",
                  }}
                />
              </div>

              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {STATUS_OPTIONS.map((opt) => {
                  const active = statusFilter === opt.value;
                  return (
                    <button
                      key={opt.value}
                      className="lw-chip"
                      onClick={() => setStatusFilter(opt.value)}
                      style={{
                        padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: active ? 600 : 400,
                        border: active ? "1px solid rgba(124,58,237,0.6)" : "1px solid rgba(255,255,255,0.08)",
                        background: active ? "rgba(124,58,237,0.15)" : "transparent",
                        color: active ? "#c4b5fd" : "#5a5a72",
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Row 2: time filter */}
            <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: "#5a5a72", textTransform: "uppercase", letterSpacing: "0.09em", marginRight: 4 }}>
                Started
              </span>
              {TIME_OPTIONS.map((opt) => {
                const active = timeFilter === opt.value;
                return (
                  <button
                    key={opt.value}
                    className="lw-chip"
                    onClick={() => {
                      setTimeFilter(opt.value);
                      if (opt.value !== "custom") { setDateStart(""); setDateEnd(""); }
                    }}
                    style={{
                      padding: "4px 11px", borderRadius: 6, fontSize: 12, fontWeight: active ? 600 : 400,
                      border: active ? "1px solid rgba(56,189,248,0.5)" : "1px solid rgba(255,255,255,0.07)",
                      background: active ? "rgba(56,189,248,0.1)" : "transparent",
                      color: active ? "#38bdf8" : "#5a5a72",
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
              {timeFilter === "custom" && (
                <>
                  <input type="date" value={dateStart} onChange={(e) => setDateStart(e.target.value)}
                    style={dateInputStyle} />
                  <span style={{ color: "#5a5a72", fontSize: 12 }}>–</span>
                  <input type="date" value={dateEnd} onChange={(e) => setDateEnd(e.target.value)}
                    style={dateInputStyle} />
                </>
              )}

              {visible.length !== items.length && (
                <span style={{ marginLeft: 8, fontSize: 12, color: "#5a5a72" }}>
                  {visible.length} of {items.length} shown
                </span>
              )}
            </div>
          </div>

          {/* ── Content ── */}
          {loading ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "80px 0", gap: 14 }}>
              <div style={{ width: 32, height: 32, border: "3px solid rgba(255,255,255,0.08)", borderTop: "3px solid #7c3aed", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
              <p style={{ color: "#5a5a72", fontSize: 14 }}>Loading websites…</p>
            </div>
          ) : error ? (
            <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(248,113,113,0.2)", borderRadius: 10, padding: "16px 20px", color: "#f87171", fontSize: 13 }}>
              ⚠️ {error}
            </div>
          ) : items.length === 0 ? (
            <EmptyState icon="🌐" title="No websites yet" subtitle="Generate your first lead website from the Leads page." />
          ) : visible.length === 0 ? (
            <EmptyState icon="🔍" title="No matches" subtitle="Try adjusting your search or filter." />
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 }}>
              {visible.map((item) => (
                <WebsiteCard
                  key={item.id}
                  item={item}
                  onPreview={() => setPreviewItem(item)}
                  onDeploy={() => handleDeploy(item)}
                  onRetry={() => handleRetry(item)}
                  deploying={deployingId === item.id}
                  retrying={retryingId === item.id}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ── Card ──────────────────────────────────────────────────────────────────────

function WebsiteCard({
  item,
  onPreview,
  onDeploy,
  onRetry,
  deploying,
  retrying,
}: {
  item: HistoryItem;
  onPreview: () => void;
  onDeploy: () => void;
  onRetry: () => void;
  deploying: boolean;
  retrying: boolean;
}) {
  // If the run failed but the user manually set a demo URL on the lead, treat it as "manual"
  const effectiveStatus = item.status === "failed" && item.lead_demo_url ? "manual" : item.status;
  const effectiveUrl    = item.netlify_url ?? item.lead_demo_url ?? null;

  const color      = STATUS_COLOR[effectiveStatus] ?? "#9090a8";
  const bg         = STATUS_BG[effectiveStatus]    ?? "rgba(144,144,168,0.08)";
  const label      = STATUS_LABEL[effectiveStatus] ?? effectiveStatus;
  const isActive   = ACTIVE_STATUSES.has(item.status);
  const canPreview = !!item.generated_html_path;
  const canDeploy  = item.status === "awaiting_approval" || (item.status === "cancelled" && canPreview);
  const canRetry   = item.status === "failed" && !item.lead_demo_url;
  const isLive     = (item.status === "completed" || effectiveStatus === "manual") && !!effectiveUrl;

  const domain = effectiveUrl
    ? effectiveUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")
    : null;

  return (
    <div
      className="lw-card"
      style={{
        border: "1px solid rgba(255,255,255,0.07)",
        borderRadius: 10,
        background: "rgba(255,255,255,0.02)",
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {/* Top: name + status */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 14, fontWeight: 600, color: "#f0f0f8",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {item.lead_name || "—"}
          </div>
          <div style={{ fontSize: 12.5, color: "#5a5a72", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {item.company_name || "—"}
          </div>
        </div>

        <span style={{
          display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0,
          padding: "3px 9px", borderRadius: 5, fontSize: 11.5, fontWeight: 600,
          background: bg, color, border: `1px solid ${color}40`,
        }}>
          {isActive && (
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0, animation: "pulse 1.5s ease-in-out infinite" }} />
          )}
          {label}
        </span>
      </div>

      {/* URL or error */}
      {isLive && domain ? (
        <a
          href={effectiveUrl!}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "block", padding: "8px 12px", borderRadius: 7,
            background: "rgba(74,222,128,0.06)", border: "1px solid rgba(74,222,128,0.2)",
            color: "#4ade80", fontSize: 12, fontFamily: "monospace",
            textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            transition: "background 150ms",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(74,222,128,0.12)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(74,222,128,0.06)")}
        >
          ↗ {domain}
        </a>
      ) : item.status === "failed" && !item.lead_demo_url && item.error ? (
        <div style={{
          padding: "7px 10px", borderRadius: 7,
          background: "rgba(248,113,113,0.06)", border: "1px solid rgba(248,113,113,0.15)",
          color: "#f87171", fontSize: 11.5,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }} title={item.error}>
          {item.error}
        </div>
      ) : (
        <div style={{ height: 34 }} />
      )}

      {/* Time */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11.5, color: "#5a5a72" }}>
          {relativeTime(item.completed_at ?? item.started_at)}
        </span>
        <span style={{ fontSize: 11, color: "#3a3a52" }}>
          {formatDate(item.completed_at ?? item.started_at)}
        </span>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {canPreview && (
          <button
            onClick={onPreview}
            style={actionBtn("#c4b5fd", "rgba(124,58,237,0.15)", "rgba(124,58,237,0.35)")}
          >
            Preview
          </button>
        )}
        {isLive && effectiveUrl && (
          <a
            href={effectiveUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...actionBtn("#4ade80", "rgba(74,222,128,0.1)", "rgba(74,222,128,0.3)"), textDecoration: "none" }}
          >
            View Live ↗
          </a>
        )}
        {canDeploy && (
          <button
            onClick={onDeploy}
            disabled={deploying}
            style={{ ...actionBtn("#38bdf8", "rgba(56,189,248,0.1)", "rgba(56,189,248,0.3)"), opacity: deploying ? 0.5 : 1 }}
          >
            {deploying ? "Deploying…" : "Deploy"}
          </button>
        )}
        {canRetry && (
          <button
            onClick={onRetry}
            disabled={retrying}
            style={{ ...actionBtn("#fb923c", "rgba(251,146,60,0.1)", "rgba(251,146,60,0.3)"), opacity: retrying ? 0.5 : 1 }}
          >
            {retrying ? "…" : "↺ Retry"}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function actionBtn(color: string, bg: string, border: string): React.CSSProperties {
  return {
    padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer",
    background: bg, border: `1px solid ${border}`, color, transition: "opacity 120ms",
    fontFamily: "Inter, sans-serif",
  };
}

const dateInputStyle: React.CSSProperties = {
  padding: "4px 8px", borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.1)",
  background: "transparent", color: "#f0f0f8",
  fontSize: 12, colorScheme: "dark" as React.CSSProperties["colorScheme"],
  outline: "none",
};

function EmptyState({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", padding: "80px 24px", gap: 12,
      border: "1px dashed rgba(255,255,255,0.08)", borderRadius: 12,
    }}>
      <span style={{ fontSize: 36 }}>{icon}</span>
      <p style={{ fontSize: 15, fontWeight: 600, color: "#9090a8", margin: 0 }}>{title}</p>
      <p style={{ fontSize: 13, color: "#5a5a72", margin: 0, textAlign: "center", maxWidth: 360 }}>{subtitle}</p>
    </div>
  );
}
