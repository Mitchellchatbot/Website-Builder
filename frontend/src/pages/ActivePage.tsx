import { useState, useEffect, useRef, useCallback } from "react";
import { api, type ActiveRunItem, type ActiveCompletedItem, type AwaitingReviewItem } from "../api/client";
import PreviewModal from "../components/PreviewModal";

const STAGE_LABEL: Record<string, string> = {
  pending:    "Pending",
  scraping:   "Scraping",
  generating: "Generating",
  deploying:  "Deploying",
};

const STAGE_COLOR: Record<string, string> = {
  pending:    "#8A8A8A",
  scraping:   "#FF6B01",
  generating: "#3F8A5C",
  deploying:  "#8A8A8A",
};

const STATUS_COLOR: Record<string, string> = {
  completed: "#3F8A5C",
  failed:    "#C4452D",
  skipped:   "#8A8A8A",
  cancelled: "#6b7280",
};

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60)    return "just now";
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function ActivePage() {
  const [running,        setRunning]        = useState<ActiveRunItem[]>([]);
  const [completed,      setCompleted]      = useState<ActiveCompletedItem[]>([]);
  const [awaitingReview, setAwaitingReview] = useState<AwaitingReviewItem[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [error,          setError]          = useState<string | null>(null);
  const [tick,           setTick]           = useState(0);

  const [cancellingIds, setCancellingIds] = useState<Set<string>>(new Set());
  const [deployingIds,  setDeployingIds]  = useState<Set<string>>(new Set());
  const [previewLwId,   setPreviewLwId]   = useState<string | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef     = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchActive = useCallback(async () => {
    try {
      const data = await api.getActiveRuns();
      setRunning(data.running);
      setCompleted(data.recently_completed);
      setAwaitingReview(data.awaiting_review ?? []);
      setError(null);

      const wantedMs = data.running.length > 0 ? 3000 : 15000;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = setInterval(fetchActive, wantedMs);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchActive();
    intervalRef.current = setInterval(fetchActive, 3000);
    tickRef.current = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (tickRef.current)     clearInterval(tickRef.current);
    };
  }, [fetchActive]);

  async function handleCancel(lwId: string) {
    setCancellingIds((s) => new Set(s).add(lwId));
    try {
      await api.cancelLeadRun(lwId);
      await fetchActive();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to cancel");
    } finally {
      setCancellingIds((s) => { const n = new Set(s); n.delete(lwId); return n; });
    }
  }

  async function handleDeploy(lwId: string) {
    setDeployingIds((s) => new Set(s).add(lwId));
    setPreviewLwId(null);
    try {
      await api.deployLead(lwId);
      await fetchActive();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to deploy");
    } finally {
      setDeployingIds((s) => { const n = new Set(s); n.delete(lwId); return n; });
    }
  }

  const previewItem = previewLwId ? awaitingReview.find((r) => r.id === previewLwId) : null;

  // suppress unused tick warning — it forces re-render every second for live duration
  void tick;

  return (
    <>
      {/* Preview modal */}
      {previewLwId && previewItem && (
        <PreviewModal
          label={`${previewItem.lead_name} — ${previewItem.company_name}`}
          previewUrl={api.previewLeadHtmlUrl(previewLwId)}
          assetsUrl={api.leadAssetsUrl(previewLwId)}
          assetBaseUrl={api.leadAssetBaseUrl(previewLwId)}
          htmlUrl={api.leadHtmlUrl(previewLwId)}
          uploadUrl={api.leadUploadAssetUrl(previewLwId)}
          chatEditUrl={api.leadChatEditUrl(previewLwId)}
          undoUrl={api.leadUndoUrl(previewLwId)}
          onDeploy={() => handleDeploy(previewLwId)}
          deploying={deployingIds.has(previewLwId)}
          onClose={() => setPreviewLwId(null)}
        />
      )}

      <div style={{ minHeight: "100vh", padding: "36px 32px", fontFamily: "Inter, sans-serif" }}>
        <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>

          {/* Header */}
          <div style={{ marginBottom: 28 }}>
            <h1 style={{ fontSize: 22, fontWeight: 600, color: "#FFFFFF", margin: 0 }}>
              Active Runs
            </h1>
            <p style={{ fontSize: 13, color: "#8A8A8A", marginTop: 4 }}>
              {loading
                ? "Loading…"
                : `${running.length} running · ${awaitingReview.length} awaiting review · ${completed.length} completed in the last hour`}
            </p>
          </div>

          {error && (
            <div style={{
              background: "rgba(196,69,45,0.08)",
              border: "1px solid rgba(196,69,45,0.25)",
              borderRadius: 4, padding: "10px 14px",
              color: "#C4452D", fontSize: 13, marginBottom: 20,
            }}>
              {error}
            </div>
          )}

          {/* ── Running ──────────────────────────────────────────────────────── */}
          <Section title="Running" count={running.length}>
            {running.length === 0 ? (
              <EmptyRow>Nothing running right now. Start a batch from the Leads page.</EmptyRow>
            ) : (
              <Table headers={["Lead", "Company", "Stage", "Started", "Duration", ""]}>
                {running.map((item) => {
                  const isCancelling = cancellingIds.has(item.id);
                  const elapsed = item.started_at
                    ? Math.floor((Date.now() - new Date(item.started_at).getTime()) / 1000)
                    : item.duration_seconds;
                  return (
                    <tr key={item.id} style={rowStyle}>
                      <Td bold>{item.lead_name}</Td>
                      <Td muted>{item.company_name}</Td>
                      <Td>
                        <Badge color={STAGE_COLOR[item.status] ?? "#8A8A8A"}>
                          <Dot color={STAGE_COLOR[item.status] ?? "#8A8A8A"} pulse />
                          {STAGE_LABEL[item.status] ?? item.status}
                        </Badge>
                      </Td>
                      <Td muted>{relativeTime(item.started_at)}</Td>
                      <Td mono>{formatDuration(elapsed)}</Td>
                      <Td>
                        <button
                          disabled={isCancelling}
                          onClick={() => handleCancel(item.id)}
                          style={{
                            background: isCancelling ? "rgba(255,255,255,0.04)" : "rgba(248,113,113,0.12)",
                            border: `1px solid ${isCancelling ? "rgba(255,255,255,0.08)" : "rgba(248,113,113,0.35)"}`,
                            color: isCancelling ? "#5a5a72" : "#f87171",
                            borderRadius: 5, padding: "4px 10px",
                            fontSize: 11.5, fontWeight: 600,
                            cursor: isCancelling ? "not-allowed" : "pointer",
                            fontFamily: "Inter, sans-serif",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {isCancelling ? "Stopping…" : "⏹ Stop"}
                        </button>
                      </Td>
                    </tr>
                  );
                })}
              </Table>
            )}
          </Section>

          {/* ── Awaiting Review ──────────────────────────────────────────────── */}
          <Section title="Awaiting Review" count={awaitingReview.length} style={{ marginTop: 28 }}>
            {awaitingReview.length === 0 ? (
              <EmptyRow>No websites waiting for review.</EmptyRow>
            ) : (
              <Table headers={["Lead", "Company", "Generated", ""]}>
                {awaitingReview.map((item) => {
                  const isDeploying = deployingIds.has(item.id);
                  return (
                    <tr key={item.id} style={rowStyle}>
                      <Td bold>{item.lead_name}</Td>
                      <Td muted>{item.company_name}</Td>
                      <Td muted>{relativeTime(item.started_at)}</Td>
                      <Td>
                        <button
                          disabled={isDeploying}
                          onClick={() => setPreviewLwId(item.id)}
                          style={{
                            background: "rgba(56,189,248,0.1)",
                            border: "1px solid rgba(56,189,248,0.3)",
                            color: "#38bdf8",
                            borderRadius: 5, padding: "4px 10px",
                            fontSize: 11.5, fontWeight: 600,
                            cursor: "pointer",
                            fontFamily: "Inter, sans-serif",
                            whiteSpace: "nowrap",
                          }}
                        >
                          👁 Preview &amp; Deploy
                        </button>
                      </Td>
                    </tr>
                  );
                })}
              </Table>
            )}
          </Section>

          {/* ── Recently Completed ───────────────────────────────────────────── */}
          <Section title="Recently Completed" subtitle="last hour" count={completed.length} style={{ marginTop: 28 }}>
            {completed.length === 0 ? (
              <EmptyRow>Nothing completed in the last hour.</EmptyRow>
            ) : (
              <Table headers={["Lead", "Company", "Result", "Demo URL", "Error", "Completed"]}>
                {completed.map((item) => (
                  <tr key={item.id} style={rowStyle}>
                    <Td bold>{item.lead_name}</Td>
                    <Td muted>{item.company_name}</Td>
                    <Td>
                      <Badge color={STATUS_COLOR[item.status] ?? "#8A8A8A"}>
                        {item.status === "completed"
                          ? "✓ Success"
                          : item.status === "failed"
                          ? "✗ Failed"
                          : item.status === "cancelled"
                          ? "⏹ Cancelled"
                          : "⏭ Skipped"}
                      </Badge>
                    </Td>
                    <Td>
                      {item.netlify_url ? (
                        <a
                          href={item.netlify_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: "#FF6B01", fontSize: 12, fontFamily: "monospace", textDecoration: "none" }}
                        >
                          {item.netlify_url.replace("https://", "").slice(0, 28)}…
                        </a>
                      ) : <span style={{ color: "#353535" }}>—</span>}
                    </Td>
                    <Td>
                      {item.error && item.status === "failed" ? (
                        <span
                          title={item.error}
                          style={{ fontSize: 12, color: "#C4452D", maxWidth: 160, display: "inline-block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        >
                          {item.error}
                        </span>
                      ) : <span style={{ color: "#353535" }}>—</span>}
                    </Td>
                    <Td muted>{relativeTime(item.completed_at)}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>

        </div>
      </div>
    </>
  );
}

/* ── Sub-components ──────────────────────────────────────────────────────── */

function Section({
  title, subtitle, count, children, style,
}: {
  title: string; subtitle?: string; count: number;
  children: React.ReactNode; style?: React.CSSProperties;
}) {
  return (
    <div style={style}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "#FFFFFF" }}>{title}</span>
        {subtitle && <span style={{ fontSize: 12, color: "#8A8A8A" }}>({subtitle})</span>}
        <span style={{
          fontSize: 11, fontWeight: 600, color: "#8A8A8A",
          background: "rgba(138,138,138,0.12)", border: "1px solid rgba(138,138,138,0.2)",
          borderRadius: 4, padding: "1px 7px",
        }}>{count}</span>
      </div>
      <div style={{ border: "1px solid #E8E8E820", borderRadius: 4, overflow: "hidden", overflowX: "auto" }}>
        {children}
      </div>
    </div>
  );
}

function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ background: "rgba(255,255,255,0.02)" }}>
          {headers.map((h) => (
            <th key={h} style={{
              textAlign: "left", padding: "10px 14px",
              fontSize: 10.5, fontWeight: 600, color: "#8A8A8A",
              textTransform: "uppercase", letterSpacing: "0.08em",
              borderBottom: "1px solid rgba(232,232,232,0.08)",
              whiteSpace: "nowrap",
            }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

const rowStyle: React.CSSProperties = { borderBottom: "1px solid rgba(232,232,232,0.06)", transition: "background 150ms ease-out" };

function Td({ children, bold, muted, mono }: { children: React.ReactNode; bold?: boolean; muted?: boolean; mono?: boolean }) {
  return (
    <td style={{
      padding: "12px 14px", fontSize: bold ? 13.5 : 13,
      color: bold ? "#FFFFFF" : muted ? "#8A8A8A" : "#FAFAFA",
      fontWeight: bold ? 500 : 400,
      fontFamily: mono ? "monospace" : undefined,
      whiteSpace: "nowrap",
    }}>
      {children}
    </td>
  );
}

function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "3px 8px", borderRadius: 4,
      background: `${color}18`, border: `1px solid ${color}30`,
      color, fontSize: 11.5, fontWeight: 500, whiteSpace: "nowrap",
    }}>
      {children}
    </span>
  );
}

function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span style={{
      width: 6, height: 6, borderRadius: "50%",
      background: color, display: "inline-block", flexShrink: 0,
      animation: pulse ? "pulse 1.5s ease-in-out infinite" : undefined,
    }} />
  );
}

function EmptyRow({ children }: { children: string }) {
  return (
    <div style={{ padding: "28px 16px", textAlign: "center", color: "#8A8A8A", fontSize: 13 }}>
      {children}
    </div>
  );
}
