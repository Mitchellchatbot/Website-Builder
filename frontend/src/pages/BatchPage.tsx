import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, type BatchStatusItem } from "../api/client";

const TERMINAL = new Set(["completed", "failed", "skipped"]);
const POLL_MS = 3000;

const STATUS_LABEL: Record<string, string> = {
  pending:    "Pending",
  scraping:   "Scraping",
  generating: "Generating HTML",
  deploying:  "Deploying",
  completed:  "Done",
  failed:     "Failed",
  skipped:    "Skipped",
};

const STATUS_COLORS: Record<string, { bg: string; color: string; border: string }> = {
  pending:    { bg: "rgba(144,144,168,0.12)", color: "#9090a8", border: "rgba(144,144,168,0.25)" },
  scraping:   { bg: "rgba(251,146,60,0.12)",  color: "#fb923c", border: "rgba(251,146,60,0.25)" },
  generating: { bg: "rgba(99,102,241,0.12)",  color: "#818cf8", border: "rgba(129,140,248,0.25)" },
  deploying:  { bg: "rgba(168,85,247,0.12)",  color: "#c084fc", border: "rgba(192,132,252,0.25)" },
  completed:  { bg: "rgba(74,222,128,0.12)",  color: "#4ade80", border: "rgba(74,222,128,0.25)" },
  failed:     { bg: "rgba(248,113,113,0.12)", color: "#f87171", border: "rgba(248,113,113,0.25)" },
  skipped:    { bg: "rgba(144,144,168,0.10)", color: "#6b6b88", border: "rgba(144,144,168,0.18)" },
};

const STATUS_ICON: Record<string, string> = {
  pending:    "⏳",
  scraping:   "🔍",
  generating: "✨",
  deploying:  "🚀",
  completed:  "✅",
  failed:     "❌",
  skipped:    "⏭",
};

function playNotificationTone() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.9);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.9);
  } catch {
    // browser may block AudioContext without user interaction — silently ignore
  }
}

type ToastState = { visible: boolean; message: string; type: "success" | "danger" | "neutral" };

export default function BatchPage() {
  const { ids } = useParams<{ ids: string }>();
  const navigate = useNavigate();
  const idList = ids?.split(",").filter(Boolean) ?? [];

  const [items, setItems] = useState<BatchStatusItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>({ visible: false, message: "", type: "success" });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const notifiedRef = useRef(false);

  const fetchStatus = useCallback(async () => {
    if (idList.length === 0) return;
    try {
      const data = await api.getBatchStatus(idList);
      setItems(data);
      const allDone = data.length > 0 && data.every((d) => TERMINAL.has(d.status));
      if (allDone && intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : "Failed to fetch status");
    }
  }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchStatus();
    intervalRef.current = setInterval(fetchStatus, POLL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchStatus]);

  const allDone = items.length > 0 && items.every((d) => TERMINAL.has(d.status));
  const completedCount = items.filter((d) => d.status === "completed").length;
  const failedCount    = items.filter((d) => d.status === "failed").length;
  const skippedCount   = items.filter((d) => d.status === "skipped").length;
  const inProgressCount = items.filter((d) => !TERMINAL.has(d.status)).length;

  // Fire toast + audio exactly once when batch reaches terminal state
  useEffect(() => {
    if (!allDone || notifiedRef.current) return;
    notifiedRef.current = true;
    playNotificationTone();

    let message: string;
    let type: ToastState["type"];

    if (skippedCount > 0) {
      type = "danger";
      message = `Batch halted: ${failedCount} failed, ${skippedCount} skipped before halt. ${completedCount} succeeded.`;
    } else if (failedCount > 0) {
      type = "neutral";
      message = `Batch complete: ${completedCount} succeeded, ${failedCount} failed.`;
    } else {
      type = "success";
      message = `Batch complete: ${completedCount} site${completedCount !== 1 ? "s" : ""} generated successfully.`;
    }

    setToast({ visible: true, message, type });
  }, [allDone]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRetry = async (item: BatchStatusItem) => {
    try {
      const result = await api.generateForLead(item.lead_id);
      navigate(`/result/${result.lead_website_id}`);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Retry failed");
    }
  };

  const overallPct = idList.length > 0
    ? Math.round((items.filter((d) => TERMINAL.has(d.status)).length / idList.length) * 100)
    : 0;

  return (
    <div className="page-enter" style={{ minHeight: "100vh", padding: "36px 32px" }}>
      <Toast toast={toast} onDismiss={() => setToast((t) => ({ ...t, visible: false }))} />

      {/* Header */}
      <div style={{ maxWidth: 900, margin: "0 auto 28px" }}>
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
              Batch Generation
            </h1>
            <p style={{ color: "#5a5a72", fontSize: 14, marginTop: 5, marginBottom: 0 }}>
              {allDone
                ? `Finished — ${completedCount} completed, ${failedCount} failed`
                : `Processing ${idList.length} site${idList.length > 1 ? "s" : ""}… ${completedCount} done`}
            </p>
          </div>

          {/* Status pills */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <StatPill label="Done"    value={completedCount}  color="#4ade80" />
            <StatPill label="Active"  value={inProgressCount} color="#818cf8" />
            <StatPill label="Failed"  value={failedCount}     color="#f87171" />
            {skippedCount > 0 && <StatPill label="Skipped" value={skippedCount} color="#6b6b88" />}
          </div>
        </div>

        {/* Progress bar */}
        {!allDone && idList.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "#9090a8" }}>
                <Spinner size={12} />
                Polling every 3s — safe to close and return later
              </div>
              <span style={{ fontSize: 12, color: "#5a5a72", fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600 }}>
                {overallPct}%
              </span>
            </div>
            <div
              style={{
                height: 4,
                background: "rgba(255,255,255,0.07)",
                borderRadius: 4,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${overallPct}%`,
                  background: "linear-gradient(90deg, #7c3aed, #ff6b01)",
                  borderRadius: 4,
                  transition: "width 600ms ease",
                  boxShadow: "0 0 8px rgba(124,58,237,0.5)",
                }}
              />
            </div>
          </div>
        )}
      </div>

      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        {loadError && (
          <div
            style={{
              background: "rgba(239,68,68,0.08)",
              border: "1px solid rgba(248,113,113,0.2)",
              borderRadius: 10,
              padding: "12px 16px",
              marginBottom: 20,
              color: "#f87171",
              fontSize: 13,
            }}
          >
            ⚠️ {loadError}
          </div>
        )}

        {items.length === 0 && !loadError ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "80px 0", gap: 14 }}>
            <Spinner size={32} />
            <p style={{ color: "#5a5a72", fontSize: 14 }}>Starting batch…</p>
          </div>
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
                  {["Lead", "Company", "Status", "Result"].map((h) => (
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
                  return (
                    <tr
                      key={item.id}
                      style={{
                        borderBottom: i < items.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none",
                        transition: "background 150ms",
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
                          {isInProgress
                            ? <Spinner size={9} color={colors.color} />
                            : <span style={{ fontSize: 11 }}>{STATUS_ICON[item.status]}</span>}
                          {STATUS_LABEL[item.status] ?? item.status}
                        </span>
                      </td>
                      <td style={{ padding: "13px 16px" }}>
                        {item.status === "completed" && item.netlify_url ? (
                          <a
                            href={item.netlify_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn-primary"
                            style={{
                              padding: "6px 14px",
                              fontSize: 12,
                              textDecoration: "none",
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 5,
                            }}
                          >
                            🌐 Open site
                          </a>
                        ) : item.status === "failed" ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                            <span
                              style={{
                                fontSize: 12,
                                color: "#f87171",
                                maxWidth: 180,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={item.error ?? undefined}
                            >
                              {item.error || "Unknown error"}
                            </span>
                            <button
                              onClick={() => handleRetry(item)}
                              className="btn-outline"
                              style={{ padding: "5px 12px", fontSize: 12 }}
                            >
                              ↺ Retry
                            </button>
                          </div>
                        ) : (
                          <span style={{ fontSize: 13, color: "#3a3a50" }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Done CTA */}
        {allDone && (
          <div
            style={{
              marginTop: 24,
              padding: "20px 24px",
              background: "rgba(124,58,237,0.08)",
              border: "1px solid rgba(124,58,237,0.2)",
              borderRadius: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 16,
            }}
          >
            <div>
              <p style={{ fontSize: 14, fontWeight: 600, color: "#f0f0f8", margin: 0 }}>
                🎉 Batch complete!
              </p>
              <p style={{ fontSize: 13, color: "#5a5a72", margin: "3px 0 0" }}>
                {completedCount} site{completedCount !== 1 ? "s" : ""} generated successfully.
              </p>
            </div>
            <button
              onClick={() => navigate("/leads")}
              className="btn-primary"
            >
              ← Back to Leads
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function StatPill({ label, value, color }: { label: string; value: number; color: string }) {
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

function Spinner({ size = 24, color = "#7c3aed" }: { size?: number; color?: string }) {
  const t = Math.max(2, Math.round(size / 8));
  return (
    <div
      style={{
        width: size,
        height: size,
        border: `${t}px solid rgba(255,255,255,0.08)`,
        borderTop: `${t}px solid ${color}`,
        borderRadius: "50%",
        animation: "spin 0.7s linear infinite",
        flexShrink: 0,
      }}
    />
  );
}

function Toast({ toast, onDismiss }: { toast: ToastState; onDismiss: () => void }) {
  if (!toast.visible) return null;

  const accent =
    toast.type === "success" ? "#4ade80" :
    toast.type === "danger"  ? "#f87171" :
                                "#818cf8";

  return (
    <div
      style={{
        position: "fixed",
        top: 24,
        right: 24,
        zIndex: 9999,
        maxWidth: 420,
        background: "#1a1a2e",
        border: "1px solid rgba(255,255,255,0.10)",
        borderLeft: `4px solid ${accent}`,
        borderRadius: 10,
        padding: "14px 18px",
        boxShadow: "0 8px 32px rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        animation: "heroFadeUp 0.35s cubic-bezier(0.22,1,0.36,1) both",
      }}
    >
      <span style={{ fontSize: 18, lineHeight: 1.3 }}>
        {toast.type === "success" ? "✅" : toast.type === "danger" ? "⚠️" : "ℹ️"}
      </span>
      <p style={{ flex: 1, margin: 0, fontSize: 13.5, color: "#e0e0f0", lineHeight: 1.5 }}>
        {toast.message}
      </p>
      <button
        onClick={onDismiss}
        style={{
          background: "none",
          border: "none",
          color: "#5a5a72",
          fontSize: 16,
          cursor: "pointer",
          padding: 0,
          lineHeight: 1,
          flexShrink: 0,
        }}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
