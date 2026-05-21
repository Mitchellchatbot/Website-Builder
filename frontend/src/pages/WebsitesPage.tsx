import { useState, useEffect } from "react";
import { api, type CustomLink } from "../api/client";

const STATUS_COLOR: Record<string, string> = {
  completed:         "#4ade80",
  awaiting_approval: "#38bdf8",
  failed:            "#f87171",
  cancelled:         "#6b7280",
  skipped:           "#facc15",
  pending:           "#fb923c",
  scraping:          "#fb923c",
  generating:        "#818cf8",
  deploying:         "#c084fc",
};

const STATUS_LABEL: Record<string, string> = {
  completed:         "Live",
  awaiting_approval: "Ready to Deploy",
  failed:            "Failed",
  cancelled:         "Cancelled",
  skipped:           "Skipped",
  pending:           "Queued",
  scraping:          "Scraping",
  generating:        "Generating",
  deploying:         "Deploying",
};

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60)    return "just now";
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function WebsitesPage() {
  const [links, setLinks]   = useState<CustomLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState<string | null>(null);
  const [query, setQuery]   = useState("");

  useEffect(() => {
    api.getCustomLinks()
      .then((r) => setLinks(r.custom_links))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const filtered = query.trim()
    ? links.filter((l) =>
        l.label.toLowerCase().includes(query.toLowerCase()) ||
        l.url.toLowerCase().includes(query.toLowerCase()) ||
        (l.latest_run?.netlify_url ?? "").toLowerCase().includes(query.toLowerCase())
      )
    : links;

  const liveCount = links.filter((l) => l.latest_run?.status === "completed").length;
  const readyCount = links.filter((l) => l.latest_run?.status === "awaiting_approval").length;

  return (
    <div className="page-enter" style={{ minHeight: "100vh", padding: "36px 32px", fontFamily: "Inter, sans-serif" }}>
      {/* Header */}
      <div style={{ maxWidth: 960, margin: "0 auto 28px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
          <div>
            <h1 style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontSize: 26, fontWeight: 700, color: "#f0f0f8",
              margin: 0, letterSpacing: "-0.5px",
            }}>
              Custom Websites
            </h1>
            <p style={{ color: "#5a5a72", fontSize: 14, marginTop: 5, marginBottom: 0 }}>
              Directory of all custom link websites — original URLs and their generated demos
            </p>
          </div>

          {!loading && links.length > 0 && (
            <div style={{ display: "flex", gap: 10 }}>
              <Pill label="Total" value={links.length} color="#818cf8" />
              {liveCount > 0 && <Pill label="Live" value={liveCount} color="#4ade80" />}
              {readyCount > 0 && <Pill label="Ready" value={readyCount} color="#38bdf8" />}
            </div>
          )}
        </div>

        {/* Search */}
        {!loading && links.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <input
              type="text"
              placeholder="Search by label, URL, or demo URL…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{
                width: "100%", maxWidth: 420,
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 8, padding: "9px 14px",
                color: "#f0f0f8", fontSize: 13,
                fontFamily: "Inter, sans-serif",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>
        )}
      </div>

      <div style={{ maxWidth: 960, margin: "0 auto" }}>
        {loading ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "80px 0", gap: 14 }}>
            <Spinner size={32} />
            <p style={{ color: "#5a5a72", fontSize: 14 }}>Loading websites…</p>
          </div>
        ) : error ? (
          <ErrorBanner message={error} />
        ) : links.length === 0 ? (
          <EmptyState
            icon="🌐"
            title="No custom websites yet"
            subtitle="Go to Custom Links to add website URLs and generate demos."
          />
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px 0", color: "#5a5a72", fontSize: 13 }}>
            No results for "{query}"
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {filtered.map((link) => {
              const run = link.latest_run;
              const status = run?.status;
              const color = STATUS_COLOR[status ?? ""] ?? "#5a5a72";
              const isActive = status && !["completed", "failed", "cancelled", "skipped", "awaiting_approval"].includes(status);
              return (
                <div
                  key={link.id}
                  style={{
                    background: "rgba(255,255,255,0.025)",
                    border: "1px solid rgba(255,255,255,0.07)",
                    borderRadius: 10,
                    padding: "16px 20px",
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr auto",
                    gap: "12px 24px",
                    alignItems: "center",
                  }}
                >
                  {/* Left: label + original URL */}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#f0f0f8", marginBottom: 4 }}>
                      {link.label}
                    </div>
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        fontSize: 12, color: "#5a5a72", textDecoration: "none",
                        fontFamily: "monospace",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        display: "block", maxWidth: "100%",
                      }}
                      title={link.url}
                      onMouseEnter={(e) => (e.currentTarget.style.color = "#818cf8")}
                      onMouseLeave={(e) => (e.currentTarget.style.color = "#5a5a72")}
                    >
                      {link.url}
                    </a>
                  </div>

                  {/* Middle: demo URL */}
                  <div style={{ minWidth: 0 }}>
                    {run?.netlify_url ? (
                      <a
                        href={run.netlify_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          fontSize: 13, color: "#7c7cff", textDecoration: "none",
                          fontFamily: "monospace",
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          display: "block", maxWidth: "100%",
                        }}
                        title={run.netlify_url}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "#a78bfa")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "#7c7cff")}
                      >
                        {run.netlify_url.replace("https://", "")}
                      </a>
                    ) : (
                      <span style={{ fontSize: 13, color: "#3a3a50" }}>—</span>
                    )}
                    {run?.completed_at && (
                      <div style={{ fontSize: 11, color: "#3a3a50", marginTop: 3 }}>
                        {relativeTime(run.completed_at)}
                      </div>
                    )}
                  </div>

                  {/* Right: status badge */}
                  <div>
                    <span style={{
                      display: "inline-flex", alignItems: "center", gap: 5,
                      background: `${color}15`,
                      border: `1px solid ${color}35`,
                      borderRadius: 6,
                      padding: "4px 10px",
                      fontSize: 12,
                      color,
                      fontWeight: 500,
                      whiteSpace: "nowrap",
                    }}>
                      <span style={{
                        width: 6, height: 6, borderRadius: "50%", background: color,
                        boxShadow: isActive ? `0 0 6px ${color}` : undefined,
                        animation: isActive ? "pulse 1.5s ease-in-out infinite" : undefined,
                        flexShrink: 0,
                      }} />
                      {STATUS_LABEL[status ?? ""] ?? (status ? status : "Not started")}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>
    </div>
  );
}

function Pill({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{
      padding: "5px 12px", borderRadius: 8,
      background: `${color}15`, border: `1px solid ${color}28`,
      display: "flex", alignItems: "center", gap: 6,
    }}>
      <span style={{ fontSize: 15, fontWeight: 700, color, fontFamily: "'Space Grotesk', sans-serif" }}>{value}</span>
      <span style={{ fontSize: 10.5, color: "#5a5a72", textTransform: "uppercase" as const, letterSpacing: "0.08em", fontWeight: 600 }}>{label}</span>
    </div>
  );
}

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

function ErrorBanner({ message }: { message: string }) {
  return (
    <div style={{
      background: "rgba(239,68,68,0.08)", border: "1px solid rgba(248,113,113,0.2)",
      borderRadius: 10, padding: "16px 20px", color: "#f87171", fontSize: 13,
    }}>
      ⚠️ {message}
    </div>
  );
}

function Spinner({ size = 24 }: { size?: number }) {
  const t = Math.max(1, Math.floor(size / 8));
  return (
    <div style={{
      width: size, height: size,
      border: `${t}px solid transparent`,
      borderTop: `${t}px solid #7c3aed`,
      borderRadius: "50%",
      animation: "spin 0.7s linear infinite",
    }} />
  );
}
