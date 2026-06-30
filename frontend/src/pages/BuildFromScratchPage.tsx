import { useState, useEffect, useCallback } from "react";
import { api, type SheetsEntry, type SheetsEntryRun } from "../api/client";

const ACTIVE_STATUSES = new Set(["pending", "generating", "deploying"]);

const STATUS_MAP: Record<string, { label: string; color: string; bg: string; border: string; pulse?: boolean }> = {
  pending:           { label: "Pending",         color: "#9090a8", bg: "rgba(144,144,168,0.1)",  border: "rgba(144,144,168,0.25)", pulse: true  },
  generating:        { label: "Generating",       color: "#fb923c", bg: "rgba(251,146,60,0.1)",  border: "rgba(251,146,60,0.3)",  pulse: true  },
  awaiting_approval: { label: "Ready to Deploy",  color: "#60a5fa", bg: "rgba(96,165,250,0.1)",  border: "rgba(96,165,250,0.3)"               },
  deploying:         { label: "Deploying",        color: "#a78bfa", bg: "rgba(167,139,250,0.1)", border: "rgba(167,139,250,0.3)", pulse: true  },
  completed:         { label: "Live",             color: "#4ade80", bg: "rgba(74,222,128,0.1)",  border: "rgba(74,222,128,0.3)"               },
  failed:            { label: "Failed",           color: "#f87171", bg: "rgba(248,113,113,0.1)", border: "rgba(248,113,113,0.3)"              },
  cancelled:         { label: "Cancelled",        color: "#5a5a72", bg: "rgba(90,90,114,0.1)",   border: "rgba(90,90,114,0.3)"                },
};

export default function BuildFromScratchPage() {
  const [builds, setBuilds]         = useState<SheetsEntry[]>([]);
  const [loading, setLoading]       = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [name,        setName]        = useState("");
  const [description, setDescription] = useState("");
  const [designPrefs, setDesignPrefs] = useState("");
  const [creating,    setCreating]    = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const fetchBuilds = useCallback(async () => {
    try {
      const r = await api.getScratchBuilds();
      setBuilds(r.builds);
      setFetchError(null);
    } catch (e: unknown) {
      setFetchError(e instanceof Error ? e.message : "Failed to load builds");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchBuilds(); }, [fetchBuilds]);

  useEffect(() => {
    const hasActive = builds.some((b) => b.latest_run && ACTIVE_STATUSES.has(b.latest_run.status));
    const ms = hasActive ? 3000 : 10000;
    const t = setInterval(fetchBuilds, ms);
    return () => clearInterval(t);
  }, [builds, fetchBuilds]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !description.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const { build } = await api.createScratchBuild(
        name.trim(),
        description.trim(),
        designPrefs.trim() || undefined,
      );
      setBuilds((prev) => [build, ...prev]);
      setName("");
      setDescription("");
      setDesignPrefs("");
    } catch (e: unknown) {
      setCreateError(e instanceof Error ? e.message : "Failed to create build");
    } finally {
      setCreating(false);
    }
  };

  const updateBuildRun = (entryId: string, patch: Partial<SheetsEntryRun>) =>
    setBuilds((prev) =>
      prev.map((b) =>
        b.id === entryId && b.latest_run
          ? { ...b, latest_run: { ...b.latest_run, ...patch } }
          : b,
      ),
    );

  const handleDeploy = async (build: SheetsEntry) => {
    if (!build.latest_run) return;
    updateBuildRun(build.id, { status: "deploying" });
    try {
      await api.deploySheetsEntry(build.latest_run.id);
      fetchBuilds();
    } catch { fetchBuilds(); }
  };

  const handleRetry = async (build: SheetsEntry) => {
    if (!build.latest_run) return;
    updateBuildRun(build.id, { status: "pending", error: null });
    try {
      await api.retrySheetsGeneration(build.latest_run.id);
      fetchBuilds();
    } catch { fetchBuilds(); }
  };

  const handleCancel = async (build: SheetsEntry) => {
    if (!build.latest_run) return;
    try {
      await api.cancelSheetsRun(build.latest_run.id);
      fetchBuilds();
    } catch { fetchBuilds(); }
  };

  const handleRedeploy = async (build: SheetsEntry) => {
    if (!build.latest_run) return;
    updateBuildRun(build.id, { status: "deploying" });
    try {
      await api.deploySheetsEntry(build.latest_run.id);
      fetchBuilds();
    } catch { fetchBuilds(); }
  };

  const handleDelete = async (build: SheetsEntry) => {
    if (!confirm(`Delete "${build.business_name ?? "this build"}"?`)) return;
    setBuilds((prev) => prev.filter((b) => b.id !== build.id));
    try {
      await api.deleteScratchBuild(build.id);
    } catch {
      fetchBuilds(); // restore if it failed
    }
  };

  return (
    <div className="page-enter" style={{ minHeight: "100vh", padding: "36px 32px" }}>
      <div style={{ maxWidth: 820, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ marginBottom: 28 }}>
          <h1 style={{
            fontFamily: "'Space Grotesk', sans-serif", fontSize: 26, fontWeight: 700,
            color: "#f0f0f8", margin: 0, letterSpacing: "-0.5px",
          }}>
            Build from Scratch
          </h1>
          <p style={{ color: "#5a5a72", fontSize: 14, marginTop: 5, marginBottom: 0 }}>
            Generate a full website from just a business name and description — no existing website needed.
          </p>
        </div>

        {/* Form card */}
        <div style={{
          background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 12, padding: "24px 28px", marginBottom: 32,
        }}>
          <h2 style={{
            fontSize: 13, fontWeight: 600, color: "#9090a8", textTransform: "uppercase",
            letterSpacing: "0.1em", margin: "0 0 18px",
          }}>
            New Build
          </h2>

          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              <label style={{ flex: "1 1 220px" }}>
                <FieldLabel text="Business Name" required />
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Sunrise Wellness Center"
                  required
                  style={{ ...inputStyle, width: "100%" }}
                />
              </label>
              <label style={{ flex: "1 1 220px" }}>
                <FieldLabel text="Design Preferences" optional />
                <input
                  type="text"
                  value={designPrefs}
                  onChange={(e) => setDesignPrefs(e.target.value)}
                  placeholder="e.g. Modern, clean, blue & white"
                  style={{ ...inputStyle, width: "100%" }}
                />
              </label>
            </div>

            <label>
              <FieldLabel text="Business Description" required />
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the business — services offered, target customers, key selling points, location, tone, etc."
                required
                rows={3}
                style={{ ...inputStyle, width: "100%", resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }}
              />
            </label>

            {createError && (
              <span style={{ fontSize: 12, color: "#f87171" }}>⚠ {createError}</span>
            )}

            <div>
              <button
                type="submit"
                disabled={!name.trim() || !description.trim() || creating}
                className="btn-primary"
                style={(!name.trim() || !description.trim() || creating) ? { opacity: 0.45, cursor: "not-allowed" } : {}}
              >
                {creating ? <><Spinner size={12} /> Generating…</> : <>✦ Generate Website</>}
              </button>
            </div>
          </form>
        </div>

        {/* Builds list */}
        {loading ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "60px 0" }}>
            <Spinner size={28} />
            <p style={{ color: "#5a5a72", fontSize: 14, margin: 0 }}>Loading builds…</p>
          </div>
        ) : fetchError ? (
          <div style={{
            background: "rgba(239,68,68,0.08)", border: "1px solid rgba(248,113,113,0.2)",
            borderRadius: 10, padding: 20, color: "#f87171", fontSize: 14,
          }}>
            ⚠️ {fetchError}
          </div>
        ) : builds.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <p style={{ fontSize: 12, color: "#5a5a72", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>
              {builds.length} Build{builds.length !== 1 ? "s" : ""}
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {builds.map((build) => (
                <BuildCard
                  key={build.id}
                  build={build}
                  onDeploy={handleDeploy}
                  onRetry={handleRetry}
                  onCancel={handleCancel}
                  onDelete={handleDelete}
                  onRedeploy={handleRedeploy}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function BuildCard({
  build, onDeploy, onRetry, onCancel, onDelete, onRedeploy,
}: {
  build: SheetsEntry;
  onDeploy:   (b: SheetsEntry) => void;
  onRetry:    (b: SheetsEntry) => void;
  onCancel:   (b: SheetsEntry) => void;
  onDelete:   (b: SheetsEntry) => void;
  onRedeploy: (b: SheetsEntry) => void;
}) {
  const run    = build.latest_run;
  const status = run?.status ?? "pending";
  const cfg    = STATUS_MAP[status] ?? STATUS_MAP.pending;
  const isActive = ACTIVE_STATUSES.has(status);

  const liveUrl = run?.netlify_url
    ? (/^https?:\/\//i.test(run.netlify_url) ? run.netlify_url : `https://${run.netlify_url}`)
    : null;

  return (
    <div style={{
      background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)",
      borderRadius: 10, padding: "16px 20px",
      transition: "border-color 150ms",
    }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.12)")}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.07)")}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>

        {/* Left: name + description + prefs */}
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: "#f0f0f8", fontFamily: "'Space Grotesk', sans-serif" }}>
              {build.business_name ?? "—"}
            </span>
            {build.design_preferences && (
              <span style={{
                fontSize: 10.5, fontWeight: 500, color: "#7c7cff",
                background: "rgba(124,124,255,0.1)", border: "1px solid rgba(124,124,255,0.2)",
                borderRadius: 4, padding: "1px 7px",
              }}>
                {build.design_preferences}
              </span>
            )}
          </div>
          {build.business_description && (
            <p style={{
              margin: 0, fontSize: 12.5, color: "#6a6a82", lineHeight: 1.5,
              display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}>
              {build.business_description}
            </p>
          )}
          {build.created_at && (
            <p style={{ margin: "5px 0 0", fontSize: 11, color: "#3a3a50" }}>
              {new Date(build.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}
            </p>
          )}
        </div>

        {/* Right: status + actions */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {/* Status badge */}
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            padding: "3px 10px", borderRadius: 6, fontSize: 11.5, fontWeight: 600,
            color: cfg.color, background: cfg.bg, border: `1px solid ${cfg.border}`,
            boxShadow: cfg.pulse ? `0 0 8px ${cfg.border}` : "none",
          }}>
            {isActive && <Spinner size={9} color={cfg.color} />}
            {cfg.label}
          </span>

          {/* Action buttons */}
          {run && status === "awaiting_approval" && (
            <>
              <a
                href={api.previewSheetsHtmlUrl(run.id)}
                target="_blank" rel="noopener noreferrer"
                style={actionLinkStyle("#60a5fa", "rgba(96,165,250,0.12)", "rgba(96,165,250,0.3)")}
              >
                Preview →
              </a>
              <button
                onClick={() => onDeploy(build)}
                style={actionBtnStyle("#a78bfa", "rgba(167,139,250,0.12)", "rgba(167,139,250,0.3)")}
              >
                Deploy ↑
              </button>
            </>
          )}

          {status === "completed" && liveUrl && (
            <>
              <a
                href={liveUrl}
                target="_blank" rel="noopener noreferrer"
                style={actionLinkStyle("#4ade80", "rgba(74,222,128,0.12)", "rgba(74,222,128,0.3)")}
              >
                View Live ↗
              </a>
              <button
                onClick={() => onRedeploy(build)}
                title="Push the existing HTML to Netlify again"
                style={actionBtnStyle("#a78bfa", "rgba(167,139,250,0.12)", "rgba(167,139,250,0.3)")}
              >
                ↑ Redeploy
              </button>
            </>
          )}

          {(status === "failed" || status === "cancelled") && run && (
            <button
              onClick={() => onRetry(build)}
              style={actionBtnStyle("#fb923c", "rgba(251,146,60,0.1)", "rgba(251,146,60,0.3)")}
            >
              ↺ Retry
            </button>
          )}

          {isActive && run && (
            <button
              onClick={() => onCancel(build)}
              style={actionBtnStyle("#f87171", "rgba(248,113,113,0.1)", "rgba(248,113,113,0.3)")}
            >
              ■ Stop
            </button>
          )}

          {/* Error tooltip */}
          {status === "failed" && run?.error && (
            <span title={run.error} style={{ fontSize: 11, color: "#f87171", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "help" }}>
              {run.error}
            </span>
          )}

          {/* Delete */}
          <button
            onClick={() => onDelete(build)}
            title="Delete build"
            style={{
              background: "none", border: "1px solid transparent", borderRadius: 5,
              color: "#3a3a50", cursor: "pointer", padding: "3px 6px", fontSize: 13,
              transition: "all 150ms",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "#f87171"; e.currentTarget.style.borderColor = "rgba(248,113,113,0.3)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "#3a3a50"; e.currentTarget.style.borderColor = "transparent"; }}
          >
            🗑
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Sub-components ── */

function FieldLabel({ text, required, optional }: { text: string; required?: boolean; optional?: boolean }) {
  return (
    <span style={{ display: "block", fontSize: 10.5, color: "#5a5a72", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 5 }}>
      {text}
      {required && <span style={{ color: "#f87171", marginLeft: 3 }}>*</span>}
      {optional && <span style={{ color: "#3a3a50", fontWeight: 400, textTransform: "none", letterSpacing: 0, marginLeft: 4 }}>(optional)</span>}
    </span>
  );
}

function EmptyState() {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      padding: "60px 24px", gap: 10,
      border: "1px dashed rgba(255,255,255,0.07)", borderRadius: 12,
    }}>
      <span style={{ fontSize: 32 }}>✦</span>
      <p style={{ fontSize: 15, fontWeight: 600, color: "#9090a8", margin: 0 }}>No builds yet</p>
      <p style={{ fontSize: 13, color: "#5a5a72", margin: 0, textAlign: "center", maxWidth: 300 }}>
        Fill in the form above to generate your first website from scratch.
      </p>
    </div>
  );
}

function Spinner({ size = 20, color = "#7c3aed" }: { size?: number; color?: string }) {
  const t = Math.max(2, Math.round(size / 9));
  return (
    <div style={{
      width: size, height: size, flexShrink: 0,
      border: `${t}px solid rgba(255,255,255,0.08)`,
      borderTop: `${t}px solid ${color}`,
      borderRadius: "50%",
      animation: "spin 0.7s linear infinite",
    }} />
  );
}

/* ── Style helpers ── */

const inputStyle: React.CSSProperties = {
  display: "block",
  padding: "7px 10px",
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.1)",
  background: "rgba(255,255,255,0.04)",
  color: "#f0f0f8",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};

function actionBtnStyle(color: string, bg: string, border: string): React.CSSProperties {
  return {
    padding: "3px 11px", borderRadius: 5, fontSize: 12, fontWeight: 600,
    background: bg, border: `1px solid ${border}`, color, cursor: "pointer",
    transition: "background 150ms",
  };
}

function actionLinkStyle(color: string, bg: string, border: string): React.CSSProperties {
  return {
    display: "inline-flex", alignItems: "center",
    padding: "3px 11px", borderRadius: 5, fontSize: 12, fontWeight: 600,
    background: bg, border: `1px solid ${border}`, color,
    textDecoration: "none", transition: "background 150ms",
  };
}
