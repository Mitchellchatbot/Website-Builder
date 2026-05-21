import { useState, useEffect, useRef, useCallback } from "react";
import { api, type CustomLink } from "../api/client";
import PreviewModal from "../components/PreviewModal";

const ACTIVE_STATUSES   = new Set(["pending", "scraping", "generating", "deploying"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "skipped", "cancelled"]);

function statusColor(status: string | undefined): string {
  if (!status)                        return "#3a3a52";
  if (status === "completed")         return "#4ade80";
  if (status === "failed")            return "#f87171";
  if (status === "cancelled")         return "#6b7280";
  if (status === "skipped")           return "#facc15";
  if (status === "awaiting_approval") return "#38bdf8";
  return "#fb923c"; // pending / active
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
      <span style={{ fontSize: 12.5, color, fontWeight: 500, textTransform: "capitalize" }}>
        {label}
      </span>
    </span>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function CustomLinksPage() {
  const [links, setLinks]       = useState<CustomLink[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery]       = useState("");

  const [addUrl, setAddUrl]     = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [adding, setAdding]     = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [generatingIds, setGeneratingIds] = useState<Set<string>>(new Set());
  const [deployingIds, setDeployingIds]   = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds]     = useState<Set<string>>(new Set());
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(new Set());
  const [settingUrlId,  setSettingUrlId]  = useState<string | null>(null);
  const [urlInput,      setUrlInput]      = useState("");

  // Preview modal state
  const [previewLink, setPreviewLink] = useState<{ clwId: string; label: string } | null>(null);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLinks = useCallback(async () => {
    try {
      const res = await api.getCustomLinks();
      setLinks(res.custom_links);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLinks();
    pollingRef.current = setInterval(fetchLinks, 3000);
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Slow down when nothing is active
  useEffect(() => {
    const hasActive = links.some(
      (l) => l.latest_run && ACTIVE_STATUSES.has(l.latest_run.status),
    );
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollingRef.current = setInterval(fetchLinks, hasActive ? 3000 : 10000);
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, [links, fetchLinks]);

  const visible = query.trim()
    ? links.filter((l) =>
        l.label.toLowerCase().includes(query.toLowerCase()) ||
        l.url.toLowerCase().includes(query.toLowerCase()),
      )
    : links;

  const allSelected = visible.length > 0 && visible.every((l) => selected.has(l.id));

  function toggleAll() {
    if (allSelected) {
      setSelected((s) => { const n = new Set(s); visible.forEach((l) => n.delete(l.id)); return n; });
    } else {
      setSelected((s) => { const n = new Set(s); visible.forEach((l) => n.add(l.id)); return n; });
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!addUrl.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      await api.createCustomLink(addUrl.trim(), addLabel.trim() || undefined);
      setAddUrl("");
      setAddLabel("");
      await fetchLinks();
    } catch (e: unknown) {
      setAddError(e instanceof Error ? e.message : "Failed to add");
    } finally {
      setAdding(false);
    }
  }

  async function handleGenerate(id: string) {
    setGeneratingIds((s) => new Set(s).add(id));
    try {
      await api.generateForCustomLink(id);
      await fetchLinks();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to generate");
    } finally {
      setGeneratingIds((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }

  async function handleRetry(clwId: string, linkId: string) {
    setGeneratingIds((s) => new Set(s).add(linkId));
    try {
      await api.retryCustomGeneration(clwId);
      await fetchLinks();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to retry");
    } finally {
      setGeneratingIds((s) => { const n = new Set(s); n.delete(linkId); return n; });
    }
  }

  async function handleCancel(clwId: string, linkId: string) {
    setCancellingIds((s) => new Set(s).add(linkId));
    try {
      await api.cancelCustomRun(clwId);
      await fetchLinks();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to cancel");
    } finally {
      setCancellingIds((s) => { const n = new Set(s); n.delete(linkId); return n; });
    }
  }

  async function handleSetUrl(clwId: string, linkId: string, url: string) {
    if (!url.trim()) return;
    setGeneratingIds((s) => new Set(s).add(linkId));
    setSettingUrlId(null);
    setUrlInput("");
    try {
      await api.setCustomUrl(clwId, url.trim());
      await fetchLinks();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to save URL");
    } finally {
      setGeneratingIds((s) => { const n = new Set(s); n.delete(linkId); return n; });
    }
  }

  async function handleDeploy(clwId: string, linkId: string) {
    setDeployingIds((s) => new Set(s).add(linkId));
    setPreviewLink(null); // close modal while deploying
    try {
      await api.deployCustomLink(clwId);
      await fetchLinks();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to deploy");
    } finally {
      setDeployingIds((s) => { const n = new Set(s); n.delete(linkId); return n; });
    }
  }

  async function handleDelete(id: string) {
    setDeletingIds((s) => new Set(s).add(id));
    try {
      await api.deleteCustomLink(id);
      setSelected((s) => { const n = new Set(s); n.delete(id); return n; });
      setLinks((prev) => prev.filter((l) => l.id !== id));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    } finally {
      setDeletingIds((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }

  async function handleBatchGenerate() {
    if (!selected.size) return;
    const ids = [...selected];
    ids.forEach((id) => setGeneratingIds((s) => new Set(s).add(id)));
    setSelected(new Set());
    try {
      await api.generateCustomBatch(ids);
      await fetchLinks();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Batch generate failed");
    } finally {
      ids.forEach((id) => setGeneratingIds((s) => { const n = new Set(s); n.delete(id); return n; }));
    }
  }

  const selectedCount = [...selected].filter((id) => visible.some((l) => l.id === id)).length;

  return (
    <>
      {/* Preview modal (rendered outside main flow) */}
      {previewLink && (() => {
        const link = links.find((l) => l.latest_run?.id === previewLink.clwId);
        const linkId = link?.id ?? "";
        const isDeploying = deployingIds.has(linkId);
        return (
          <PreviewModal
            label={previewLink.label}
            previewUrl={api.previewCustomHtmlUrl(previewLink.clwId)}
            assetsUrl={api.customAssetsUrl(previewLink.clwId)}
            assetBaseUrl={api.customAssetBaseUrl(previewLink.clwId)}
            htmlUrl={api.customHtmlUrl(previewLink.clwId)}
            uploadUrl={api.customUploadAssetUrl(previewLink.clwId)}
            chatEditUrl={api.customChatEditUrl(previewLink.clwId)}
            undoUrl={api.customUndoUrl(previewLink.clwId)}
            onClose={() => setPreviewLink(null)}
            onDeploy={() => handleDeploy(previewLink.clwId, linkId)}
            deploying={isDeploying}
          />
        );
      })()}

      <div style={{ minHeight: "100vh", padding: "36px 32px", fontFamily: "Inter, sans-serif" }}>
        <style>{`
          @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
          .cl-row:hover { background: rgba(255,255,255,0.025) !important; }
          .cl-btn { cursor: pointer; border: none; outline: none; font-family: Inter, sans-serif; }
          .cl-btn:hover:not(:disabled) { opacity: 0.82; }
          .cl-btn:disabled { opacity: 0.4; cursor: not-allowed; }
          .cl-input:focus { outline: none; border-color: rgba(124,58,237,0.6) !important; }
        `}</style>

        <div style={{ maxWidth: 960, margin: "0 auto" }}>

          {/* Header */}
          <div style={{ marginBottom: 28 }}>
            <h1 style={{ fontSize: 22, fontWeight: 600, color: "#FFFFFF", margin: 0 }}>
              Custom Links
            </h1>
            <p style={{ fontSize: 13, color: "#5a5a72", margin: "6px 0 0" }}>
              Generate demo websites for any URL. Review the preview before publishing.
            </p>
          </div>

          {/* Add URL form */}
          <form
            onSubmit={handleAdd}
            style={{
              border: "1px solid rgba(124,58,237,0.25)",
              borderRadius: 8,
              padding: "18px 20px",
              marginBottom: 24,
              background: "rgba(124,58,237,0.04)",
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              alignItems: "flex-end",
            }}
          >
            <div style={{ flex: "1 1 260px", display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: "#8A8A8A", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Website URL *
              </label>
              <input
                className="cl-input"
                type="text"
                placeholder="https://example.com"
                value={addUrl}
                onChange={(e) => setAddUrl(e.target.value)}
                required
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 6,
                  padding: "8px 12px",
                  color: "#FAFAFA",
                  fontSize: 13.5,
                  fontFamily: "Inter, sans-serif",
                }}
              />
            </div>
            <div style={{ flex: "1 1 200px", display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: "#8A8A8A", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Label (optional)
              </label>
              <input
                className="cl-input"
                type="text"
                placeholder="e.g. Acme Corp"
                value={addLabel}
                onChange={(e) => setAddLabel(e.target.value)}
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 6,
                  padding: "8px 12px",
                  color: "#FAFAFA",
                  fontSize: 13.5,
                  fontFamily: "Inter, sans-serif",
                }}
              />
            </div>
            <button
              className="cl-btn"
              type="submit"
              disabled={adding || !addUrl.trim()}
              style={{
                background: "linear-gradient(135deg, #7c3aed, #9333ea)",
                color: "#fff",
                borderRadius: 6,
                padding: "8px 20px",
                fontSize: 13.5,
                fontWeight: 600,
                flexShrink: 0,
                alignSelf: "flex-end",
              }}
            >
              {adding ? "Adding…" : "+ Add URL"}
            </button>
            {addError && (
              <p style={{ width: "100%", margin: 0, fontSize: 12.5, color: "#f87171" }}>{addError}</p>
            )}
          </form>

          {/* Toolbar */}
          {links.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
              <input
                className="cl-input"
                type="text"
                placeholder="Search labels or URLs…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={{
                  flex: 1,
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 6,
                  padding: "7px 12px",
                  color: "#FAFAFA",
                  fontSize: 13,
                  fontFamily: "Inter, sans-serif",
                }}
              />
              {selectedCount > 0 && (
                <button
                  className="cl-btn"
                  onClick={handleBatchGenerate}
                  style={{
                    background: "linear-gradient(135deg, #7c3aed, #9333ea)",
                    color: "#fff",
                    borderRadius: 6,
                    padding: "7px 18px",
                    fontSize: 13,
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                  }}
                >
                  Generate {selectedCount} Selected
                </button>
              )}
              <a
                href={api.exportCustomLinksUrl(selectedCount > 0 ? [...selected] : undefined)}
                download
                style={{
                  background: selectedCount > 0 ? "rgba(124,58,237,0.12)" : "rgba(255,255,255,0.05)",
                  border: `1px solid ${selectedCount > 0 ? "rgba(124,58,237,0.3)" : "rgba(255,255,255,0.12)"}`,
                  color: selectedCount > 0 ? "#a78bfa" : "#8A8A8A",
                  borderRadius: 6,
                  padding: "7px 14px",
                  fontSize: 13,
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                  fontFamily: "Inter, sans-serif",
                }}
              >
                ↓ {selectedCount > 0 ? `Export ${selectedCount} Selected` : "Export All"}
              </a>
            </div>
          )}

          {/* Error banner */}
          {error && (
            <div style={{
              background: "rgba(196,69,45,0.08)", border: "1px solid rgba(196,69,45,0.25)",
              borderRadius: 4, padding: "10px 14px", color: "#f87171", fontSize: 13, marginBottom: 16,
            }}>
              {error}
            </div>
          )}

          {/* Loading */}
          {loading ? (
            <div style={{ display: "flex", justifyContent: "center", padding: "80px 0" }}>
              <Spinner />
            </div>
          ) : visible.length === 0 ? (
            <div style={{
              border: "1px dashed rgba(255,255,255,0.08)", borderRadius: 8,
              padding: "60px 24px", textAlign: "center", color: "#5a5a72",
            }}>
              {links.length === 0
                ? "No custom links yet. Add a URL above to get started."
                : "No links match your search."}
            </div>
          ) : (
            <div style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, overflow: "hidden" }}>
              {/* Table header */}
              <div style={{
                display: "grid",
                gridTemplateColumns: "36px 1fr 160px 200px 160px",
                padding: "10px 16px",
                background: "rgba(255,255,255,0.02)",
                borderBottom: "1px solid rgba(255,255,255,0.06)",
              }}>
                <div style={{ display: "flex", alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    style={{ accentColor: "#7c3aed", cursor: "pointer" }}
                  />
                </div>
                {["Label / URL", "Status", "Demo Site", "Actions"].map((h) => (
                  <div key={h} style={{ fontSize: 10.5, fontWeight: 600, color: "#5a5a72", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    {h}
                  </div>
                ))}
              </div>

              {/* Rows */}
              {visible.map((link) => {
                const run        = link.latest_run;
                const status     = run?.status;
                const isActive    = !!status && ACTIVE_STATUSES.has(status);
                const isAwaiting  = status === "awaiting_approval";
                const isFailed    = status === "failed";
                const isCancelled = status === "cancelled";
                const isCompleted = status === "completed";
                const isBusy      = generatingIds.has(link.id) || deployingIds.has(link.id) || isActive;
                const isCancelling = cancellingIds.has(link.id);
                const isDeleting  = deletingIds.has(link.id);
                const cancelledHasHtml = isCancelled && !!run?.generated_html_path;
                const isSettingUrl = settingUrlId === link.id;

                return (
                  <div
                    key={link.id}
                    className="cl-row"
                    style={{
                      display: "grid",
                      gridTemplateColumns: "36px 1fr 160px 200px 160px",
                      padding: "14px 16px",
                      borderBottom: "1px solid rgba(255,255,255,0.05)",
                      alignItems: "center",
                      background: isAwaiting ? "rgba(56,189,248,0.03)" : "transparent",
                      transition: "background 0.15s",
                    }}
                  >
                    {/* Checkbox */}
                    <div style={{ display: "flex", alignItems: "center" }}>
                      <input
                        type="checkbox"
                        checked={selected.has(link.id)}
                        onChange={() => setSelected((s) => {
                          const n = new Set(s); n.has(link.id) ? n.delete(link.id) : n.add(link.id); return n;
                        })}
                        style={{ accentColor: "#7c3aed", cursor: "pointer" }}
                      />
                    </div>

                    {/* Label + URL */}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: "#FAFAFA", marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {link.label}
                      </div>
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontSize: 12, color: "#5a5a72", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}
                        title={link.url}
                      >
                        {link.url}
                      </a>
                    </div>

                    {/* Status */}
                    <div>
                      <StatusBadge status={status} />
                      {run?.error && (
                        <div
                          title={run.error}
                          style={{ fontSize: 11, color: "#f87171", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 150 }}
                        >
                          {run.error}
                        </div>
                      )}
                    </div>

                    {/* Demo URL */}
                    <div>
                      {isCompleted && run?.netlify_url ? (
                        <a
                          href={run.netlify_url}
                          target="_blank"
                          rel="noreferrer"
                          style={{ fontSize: 12.5, color: "#7c3aed", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}
                        >
                          {run.netlify_url.replace("https://", "")}
                        </a>
                      ) : (
                        <span style={{ fontSize: 12.5, color: "#3a3a52" }}>—</span>
                      )}
                    </div>

                    {/* Actions */}
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      {isSettingUrl ? (
                        /* ── Inline Set URL form ── */
                        <>
                          <input
                            className="cl-input"
                            autoFocus
                            type="text"
                            placeholder="https://your-site.netlify.app"
                            value={urlInput}
                            onChange={(e) => setUrlInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") run && handleSetUrl(run.id, link.id, urlInput);
                              if (e.key === "Escape") { setSettingUrlId(null); setUrlInput(""); }
                            }}
                            style={{
                              background: "rgba(255,255,255,0.06)",
                              border: "1px solid rgba(124,58,237,0.4)",
                              borderRadius: 5, padding: "4px 8px",
                              color: "#FAFAFA", fontSize: 12,
                              fontFamily: "Inter, sans-serif", width: 180,
                            }}
                          />
                          <button
                            className="cl-btn"
                            onClick={() => run && handleSetUrl(run.id, link.id, urlInput)}
                            disabled={!urlInput.trim()}
                            style={{
                              background: "rgba(124,58,237,0.2)", border: "1px solid rgba(124,58,237,0.4)",
                              color: "#a78bfa", borderRadius: 5, padding: "4px 10px", fontSize: 12, fontWeight: 600,
                            }}
                          >Save</button>
                          <button
                            className="cl-btn"
                            onClick={() => { setSettingUrlId(null); setUrlInput(""); }}
                            style={{
                              background: "transparent", border: "1px solid rgba(255,255,255,0.1)",
                              color: "#5a5a72", borderRadius: 5, padding: "4px 8px", fontSize: 12,
                            }}
                          >✕</button>
                        </>
                      ) : isActive ? (
                        /* ── Running: Stop ── */
                        <button
                          className="cl-btn"
                          disabled={isCancelling}
                          onClick={() => run && handleCancel(run.id, link.id)}
                          style={{
                            background: isCancelling ? "rgba(255,255,255,0.04)" : "rgba(248,113,113,0.12)",
                            border: `1px solid ${isCancelling ? "rgba(255,255,255,0.08)" : "rgba(248,113,113,0.35)"}`,
                            color: isCancelling ? "#5a5a72" : "#f87171",
                            borderRadius: 5, padding: "5px 10px", fontSize: 12, fontWeight: 600,
                          }}
                        >
                          {isCancelling ? "Stopping…" : "⏹ Stop"}
                        </button>
                      ) : isAwaiting || cancelledHasHtml ? (
                        /* ── Awaiting review OR cancelled-with-HTML: Preview ── */
                        <button
                          className="cl-btn"
                          onClick={() => run && setPreviewLink({ clwId: run.id, label: link.label })}
                          style={{
                            background: "rgba(56,189,248,0.1)", border: "1px solid rgba(56,189,248,0.3)",
                            color: "#38bdf8", borderRadius: 5, padding: "5px 10px", fontSize: 12, fontWeight: 600,
                          }}
                        >
                          👁 Preview
                        </button>
                      ) : isFailed ? (
                        /* ── Failed: Retry ── */
                        <button
                          className="cl-btn"
                          onClick={() => run && handleRetry(run.id, link.id)}
                          style={{
                            background: "rgba(251,146,60,0.12)", border: "1px solid rgba(251,146,60,0.3)",
                            color: "#fb923c", borderRadius: 5, padding: "5px 10px", fontSize: 12, fontWeight: 600,
                          }}
                        >
                          Retry
                        </button>
                      ) : (
                        /* ── Idle / completed: Generate / Re-run ── */
                        <button
                          className="cl-btn"
                          onClick={() => handleGenerate(link.id)}
                          style={{
                            background: "rgba(124,58,237,0.12)", border: "1px solid rgba(124,58,237,0.3)",
                            color: "#a78bfa", borderRadius: 5, padding: "5px 10px", fontSize: 12, fontWeight: 600,
                          }}
                        >
                          {isCompleted ? "Re-run" : "Generate"}
                        </button>
                      )}

                      {/* Set URL manually — for cancelled runs */}
                      {isCancelled && !isSettingUrl && !isActive && (
                        <button
                          className="cl-btn"
                          onClick={() => { setSettingUrlId(link.id); setUrlInput(""); }}
                          title="Manually record the Netlify URL you deployed to"
                          style={{
                            background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
                            color: "#5a5a72", borderRadius: 5, padding: "5px 8px", fontSize: 11.5,
                          }}
                        >
                          + URL
                        </button>
                      )}

                      {/* Delete — only for non-active runs */}
                      <button
                        className="cl-btn"
                        disabled={isDeleting || isActive || isCancelling || isSettingUrl}
                        onClick={() => handleDelete(link.id)}
                        title={isActive ? "Stop the run first" : "Delete"}
                        style={{
                          background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)",
                          color: isActive || isCancelling ? "#3a3a52" : "#f87171",
                          borderRadius: 5, padding: "5px 8px", fontSize: 12,
                        }}
                      >
                        {isDeleting ? "…" : "✕"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Count footer */}
          {!loading && links.length > 0 && (
            <p style={{ fontSize: 12, color: "#3a3a52", marginTop: 12, textAlign: "right" }}>
              {visible.length} link{visible.length !== 1 ? "s" : ""}
              {query && ` matching "${query}"`}
            </p>
          )}
        </div>
      </div>
    </>
  );
}

function Spinner() {
  return (
    <div style={{
      width: 28, height: 28,
      border: "2px solid rgba(255,255,255,0.08)",
      borderTop: "2px solid #7c3aed",
      borderRadius: "50%",
      animation: "spin 0.7s linear infinite",
    }} />
  );
}
