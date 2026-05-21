import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { api, type HistoryItem } from "../api/client";
import PreviewModal from "../components/PreviewModal";

const TERMINAL = new Set(["completed", "failed", "cancelled", "skipped"]);

const STATUS_LABEL: Record<string, string> = {
  pending:           "Pending",
  scraping:          "Scraping",
  generating:        "Generating",
  deploying:         "Deploying",
  completed:         "Completed",
  failed:            "Failed",
  cancelled:         "Cancelled",
  skipped:           "Skipped",
  awaiting_approval: "Awaiting Review",
};

const STATUS_COLORS: Record<string, { bg: string; color: string; border: string }> = {
  pending:           { bg: "rgba(144,144,168,0.12)", color: "#9090a8", border: "rgba(144,144,168,0.25)" },
  scraping:          { bg: "rgba(251,146,60,0.12)",  color: "#fb923c", border: "rgba(251,146,60,0.25)" },
  generating:        { bg: "rgba(99,102,241,0.12)",  color: "#818cf8", border: "rgba(129,140,248,0.25)" },
  deploying:         { bg: "rgba(168,85,247,0.12)",  color: "#c084fc", border: "rgba(192,132,252,0.25)" },
  completed:         { bg: "rgba(74,222,128,0.12)",  color: "#4ade80", border: "rgba(74,222,128,0.25)" },
  failed:            { bg: "rgba(248,113,113,0.12)", color: "#f87171", border: "rgba(248,113,113,0.25)" },
  cancelled:         { bg: "rgba(107,114,128,0.12)", color: "#9ca3af", border: "rgba(107,114,128,0.25)" },
  skipped:           { bg: "rgba(250,204,21,0.10)",  color: "#facc15", border: "rgba(250,204,21,0.25)" },
  awaiting_approval: { bg: "rgba(56,189,248,0.10)",  color: "#38bdf8", border: "rgba(56,189,248,0.25)" },
};

const STATUS_ICON: Record<string, string> = {
  pending:           "⏳",
  scraping:          "🔍",
  generating:        "✨",
  deploying:         "🚀",
  completed:         "✅",
  failed:            "❌",
  cancelled:         "⏹",
  skipped:           "⏭",
  awaiting_approval: "👁",
};

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function HistoryPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [retrying,    setRetrying]    = useState<string | null>(null);
  const [deletingId,  setDeletingId]  = useState<string | null>(null);
  const [settingUrlId, setSettingUrlId] = useState<string | null>(null);
  const [urlInput,    setUrlInput]    = useState("");
  const [previewItem, setPreviewItem] = useState<HistoryItem | null>(null);
  const [deployingId, setDeployingId] = useState<string | null>(null);

  useEffect(() => {
    api
      .getHistory()
      .then((r) => setItems(r.history))
      .catch((e) => setFetchError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleRetry = async (item: HistoryItem) => {
    setRetrying(item.id);
    try {
      const result = await api.retryGeneration(item.id);
      navigate(`/result/${result.lead_website_id}`);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Retry failed");
      setRetrying(null);
    }
  };

  const handleSetUrl = async (id: string, url: string) => {
    if (!url.trim()) return;
    setSettingUrlId(null);
    setUrlInput("");
    try {
      await api.setLeadUrl(id, url.trim());
      setItems((prev) =>
        prev.map((i) => i.id === id ? { ...i, status: "completed", netlify_url: url.trim() } : i)
      );
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Failed to save URL");
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await api.deleteHistoryItem(id);
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  };

  const handleDeployFromHistory = async (item: HistoryItem) => {
    setDeployingId(item.id);
    try {
      await api.deployLead(item.id);
      setPreviewItem(null);
      setItems((prev) => prev.map((i) => i.id === item.id ? { ...i, status: "pending" } : i));
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Deploy failed");
    } finally {
      setDeployingId(null);
    }
  };

  const completedCount = items.filter((i) => i.status === "completed").length;
  const failedCount = items.filter((i) => i.status === "failed").length;
  const inProgressCount = items.filter((i) => !TERMINAL.has(i.status)).length;

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
        onDeploy={previewItem.status === "awaiting_approval" || previewItem.status === "cancelled"
          ? () => handleDeployFromHistory(previewItem)
          : undefined}
        deploying={deployingId === previewItem.id}
        onClose={() => setPreviewItem(null)}
      />
    )}
    <div className="page-enter" style={{ minHeight: "100vh", padding: "36px 32px" }}>
      {/* Header */}
      <div style={{ maxWidth: 900, margin: "0 auto 32px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
          <div>
            <h1
              style={{
                fontFamily: "'Space Grotesk', sans-serif",
                fontSize: 26,
                fontWeight: 700,
                color: "#f0f0f8",
                margin: 0,
                letterSpacing: "-0.5px",
              }}
            >
              Generation History
            </h1>
            <p style={{ color: "#5a5a72", fontSize: 14, marginTop: 5, marginBottom: 0 }}>
              All website generations — in-progress, completed, and failed
            </p>
          </div>

          {/* Summary pills */}
          {!loading && items.length > 0 && (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <MiniStat label="Completed" value={completedCount} color="#4ade80" />
              <MiniStat label="Failed" value={failedCount} color="#f87171" />
              <MiniStat label="In Progress" value={inProgressCount} color="#818cf8" />
            </div>
          )}
        </div>
      </div>

      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        {loading ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "80px 0", gap: 14 }}>
            <Spinner size={32} />
            <p style={{ color: "#5a5a72", fontSize: 14 }}>Loading history…</p>
          </div>
        ) : fetchError ? (
          <ErrorBanner message={fetchError} />
        ) : items.length === 0 ? (
          <EmptyState
            icon="📋"
            title="No generations yet"
            subtitle="Go to Leads and select some to kick off your first website generation."
          />
        ) : (
          <div
            style={{
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 12,
              overflow: "hidden",
              background: "rgba(255,255,255,0.02)",
            }}
          >
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "rgba(255,255,255,0.03)" }}>
                  {["Lead", "Company", "Status", "URL", "Started", "Action", ""].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: "left",
                        padding: "12px 16px",
                        fontSize: 10.5,
                        fontWeight: 600,
                        color: "#5a5a72",
                        textTransform: "uppercase",
                        letterSpacing: "0.09em",
                        borderBottom: "1px solid rgba(255,255,255,0.07)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((item, i) => {
                  const colors = STATUS_COLORS[item.status] ?? STATUS_COLORS.pending;
                  const isInProgress = !TERMINAL.has(item.status);
                  const isDeleting = deletingId === item.id;
                  return (
                    <tr
                      key={item.id}
                      style={{
                        borderBottom: i < items.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none",
                        transition: "background 150ms ease",
                        opacity: isDeleting ? 0.4 : 1,
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.025)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <td style={{ padding: "13px 16px", fontSize: 14, color: "#f0f0f8", fontWeight: 500 }}>
                        {item.lead_name}
                      </td>
                      <td style={{ padding: "13px 16px", fontSize: 14, color: "#9090a8" }}>
                        {item.company_name}
                      </td>
                      <td style={{ padding: "13px 16px" }}>
                        <span
                          className="badge"
                          style={{
                            background: colors.bg,
                            color: colors.color,
                            borderColor: colors.border,
                          }}
                        >
                          {isInProgress ? <Spinner size={9} color={colors.color} /> : <span>{STATUS_ICON[item.status]}</span>}
                          {STATUS_LABEL[item.status] ?? item.status}
                        </span>
                      </td>
                      <td style={{ padding: "13px 16px" }}>
                        {item.netlify_url ? (
                          <a
                            href={item.netlify_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              fontSize: 12.5,
                              color: "#7c7cff",
                              textDecoration: "none",
                              fontFamily: "monospace",
                              transition: "color 150ms",
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.color = "#a78bfa")}
                            onMouseLeave={(e) => (e.currentTarget.style.color = "#7c7cff")}
                          >
                            {item.netlify_url.replace("https://", "").slice(0, 30)}…
                          </a>
                        ) : item.status === "failed" && item.error ? (
                          <span
                            style={{
                              fontSize: 12,
                              color: "#f87171",
                              maxWidth: 160,
                              display: "inline-block",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={item.error}
                          >
                            {item.error}
                          </span>
                        ) : (
                          <span style={{ color: "#3a3a50", fontSize: 13 }}>—</span>
                        )}
                      </td>
                      <td style={{ padding: "13px 16px", fontSize: 12.5, color: "#5a5a72", whiteSpace: "nowrap" }}>
                        {relativeTime(item.started_at)}
                      </td>
                      <td style={{ padding: "13px 16px" }}>
                        {settingUrlId === item.id ? (
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <input
                              autoFocus
                              type="text"
                              placeholder="https://your-site.netlify.app"
                              value={urlInput}
                              onChange={(e) => setUrlInput(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleSetUrl(item.id, urlInput);
                                if (e.key === "Escape") { setSettingUrlId(null); setUrlInput(""); }
                              }}
                              style={{
                                background: "rgba(255,255,255,0.06)",
                                border: "1px solid rgba(124,58,237,0.4)",
                                borderRadius: 5, padding: "4px 8px",
                                color: "#f0f0f8", fontSize: 12,
                                fontFamily: "Inter, sans-serif", width: 200,
                              }}
                            />
                            <button
                              onClick={() => handleSetUrl(item.id, urlInput)}
                              disabled={!urlInput.trim()}
                              className="btn-primary"
                              style={{ padding: "4px 10px", fontSize: 12 }}
                            >Save</button>
                            <button
                              onClick={() => { setSettingUrlId(null); setUrlInput(""); }}
                              style={{
                                background: "transparent", border: "1px solid rgba(255,255,255,0.1)",
                                color: "#5a5a72", borderRadius: 5, padding: "4px 8px",
                                fontSize: 12, cursor: "pointer", fontFamily: "Inter, sans-serif",
                              }}
                            >✕</button>
                          </div>
                        ) : item.status === "awaiting_approval" || (item.status === "cancelled" && item.generated_html_path) ? (
                          <div style={{ display: "flex", gap: 6 }}>
                            <button
                              onClick={() => setPreviewItem(item)}
                              style={{
                                background: "rgba(124,58,237,0.15)",
                                border: "1px solid rgba(124,58,237,0.35)",
                                color: "#c4b5fd",
                                borderRadius: 5, padding: "5px 12px",
                                fontSize: 12, cursor: "pointer", fontFamily: "Inter, sans-serif",
                              }}
                            >
                              👁 Preview
                            </button>
                            {item.status === "cancelled" && (
                              <button
                                onClick={() => { setSettingUrlId(item.id); setUrlInput(""); }}
                                style={{
                                  background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
                                  color: "#5a5a72", borderRadius: 5, padding: "5px 10px",
                                  fontSize: 12, cursor: "pointer", fontFamily: "Inter, sans-serif",
                                }}
                              >
                                + Set URL
                              </button>
                            )}
                          </div>
                        ) : item.status === "failed" ? (
                          <button
                            onClick={() => handleRetry(item)}
                            disabled={retrying === item.id}
                            className="btn-primary"
                            style={{ padding: "6px 14px", fontSize: 12, opacity: retrying === item.id ? 0.5 : 1 }}
                          >
                            {retrying === item.id ? "…" : "↺ Retry"}
                          </button>
                        ) : item.status === "completed" && item.netlify_url ? (
                          <a
                            href={item.netlify_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn-outline"
                            style={{ padding: "6px 14px", fontSize: 12 }}
                          >
                            View →
                          </a>
                        ) : item.status === "cancelled" ? (
                          <button
                            onClick={() => { setSettingUrlId(item.id); setUrlInput(""); }}
                            title="Manually record the Netlify URL you deployed to"
                            style={{
                              background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
                              color: "#5a5a72", borderRadius: 5, padding: "5px 10px",
                              fontSize: 12, cursor: "pointer", fontFamily: "Inter, sans-serif",
                            }}
                          >
                            + Set URL
                          </button>
                        ) : null}
                      </td>
                      <td style={{ padding: "13px 16px" }}>
                        <button
                          disabled={isDeleting || isInProgress}
                          onClick={() => handleDelete(item.id)}
                          title={isInProgress ? "Cannot delete an active run" : "Delete"}
                          style={{
                            background: "rgba(248,113,113,0.08)",
                            border: "1px solid rgba(248,113,113,0.2)",
                            color: isInProgress ? "#3a3a50" : "#f87171",
                            borderRadius: 5,
                            padding: "5px 9px",
                            fontSize: 12,
                            cursor: isInProgress || isDeleting ? "not-allowed" : "pointer",
                            fontFamily: "Inter, sans-serif",
                            opacity: isInProgress ? 0.35 : 1,
                          }}
                        >
                          {isDeleting ? "…" : "✕"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
    </>
  );
}

/* ── Sub-components ── */

function MiniStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div
      style={{
        padding: "5px 12px",
        borderRadius: 8,
        background: `${color}15`,
        border: `1px solid ${color}28`,
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <span style={{ fontSize: 15, fontWeight: 700, color, fontFamily: "'Space Grotesk', sans-serif" }}>
        {value}
      </span>
      <span style={{ fontSize: 10.5, color: "#5a5a72", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>
        {label}
      </span>
    </div>
  );
}

function EmptyState({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "80px 24px",
        gap: 12,
        border: "1px dashed rgba(255,255,255,0.08)",
        borderRadius: 12,
      }}
    >
      <span style={{ fontSize: 36 }}>{icon}</span>
      <p style={{ fontSize: 15, fontWeight: 600, color: "#9090a8", margin: 0 }}>{title}</p>
      <p style={{ fontSize: 13, color: "#5a5a72", margin: 0, textAlign: "center", maxWidth: 360 }}>
        {subtitle}
      </p>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      style={{
        background: "rgba(239,68,68,0.08)",
        border: "1px solid rgba(248,113,113,0.2)",
        borderRadius: 10,
        padding: "16px 20px",
        color: "#f87171",
        fontSize: 13,
      }}
    >
      ⚠️ {message}
    </div>
  );
}

function Spinner({ size = 24, color = "#7c3aed" }: { size?: number; color?: string }) {
  const t = Math.max(1, Math.floor(size / 8));
  return (
    <div
      style={{
        width: size,
        height: size,
        border: `${t}px solid transparent`,
        borderTop: `${t}px solid ${color}`,
        borderRadius: "50%",
        animation: "spin 0.7s linear infinite",
        flexShrink: 0,
      }}
    />
  );
}
