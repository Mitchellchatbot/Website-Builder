import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Lead, type DemoFilter, type DateRange } from "../api/client";

export default function LeadsPage() {
  const navigate = useNavigate();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [demoFilter,  setDemoFilter]  = useState<DemoFilter>("none");
  const [dateRange,   setDateRange]   = useState<DateRange>("all");
  const [dateStart,   setDateStart]   = useState("");
  const [dateEnd,     setDateEnd]     = useState("");
  const [loading,     setLoading]     = useState(true);
  const [fetchError,  setFetchError]  = useState<string | null>(null);
  const [selected,    setSelected]    = useState<Set<string>>(new Set());
  const [submitting,  setSubmitting]  = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [exporting,   setExporting]   = useState(false);

  const fetchLeads = useCallback(() => {
    setLoading(true);
    setFetchError(null);
    api
      .getLeads(demoFilter, dateRange, dateStart || undefined, dateEnd || undefined)
      .then((r) => {
        setLeads(r.leads);
        setSelected(new Set());
      })
      .catch((e) => setFetchError(e.message))
      .finally(() => setLoading(false));
  }, [demoFilter, dateRange, dateStart, dateEnd]);

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  const allSelected = leads.length > 0 && selected.size === leads.length;

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(leads.map((l) => l.id)));
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleGenerateSelected = async () => {
    if (selected.size === 0 || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { queued } = await api.generateBatch([...selected]);
      const ids = queued.map((q) => q.lead_website_id).join(",");
      navigate(`/batch/${ids}`);
    } catch (e: unknown) {
      setSubmitError(e instanceof Error ? e.message : "Failed to queue generation");
      setSubmitting(false);
    }
  };

  return (
    <div className="page-enter" style={{ minHeight: "100vh", padding: "36px 32px" }}>
      {/* Page header */}
      <div style={{ marginBottom: 32, maxWidth: 880, margin: "0 auto 32px" }}>
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
              Leads
            </h1>
            <p style={{ color: "#5a5a72", fontSize: 14, marginTop: 5, marginBottom: 0 }}>
              Select leads to generate AI-powered demo websites in bulk
            </p>
          </div>

          {/* Stats row */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <StatPill label="Total" value={leads.length} color="#7c3aed" />
            <StatPill label="Selected" value={selected.size} color="#ff6b01" />
            <StatPill
              label="With Demo"
              value={leads.filter((l) => l.has_demo).length}
              color="#4ade80"
            />
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 880, margin: "0 auto" }}>
        {/* Error banner */}
        {submitError && (
          <div
            style={{
              background: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(248,113,113,0.3)",
              borderRadius: 10,
              padding: "12px 16px",
              marginBottom: 20,
              color: "#f87171",
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span>⚠️</span> {submitError}
          </div>
        )}

        {/* Controls row */}
        <div style={{ marginBottom: 16 }}>
          {/* Row 1: generate button + demo filter + export */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 10 }}>
            <button
              onClick={handleGenerateSelected}
              disabled={selected.size === 0 || submitting}
              className="btn-primary"
              style={selected.size === 0 ? { opacity: 0.4, cursor: "not-allowed" } : {}}
            >
              {submitting ? (
                <><Spinner size={12} />Queuing…</>
              ) : selected.size > 0 ? (
                <>⚡ Generate {selected.size} site{selected.size > 1 ? "s" : ""}</>
              ) : (
                <>⚡ Generate selected</>
              )}
            </button>

            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <FilterChips value={demoFilter} onChange={(v) => { setDemoFilter(v); setDateRange("all"); }} />
              <ExportButton
                demoFilter={demoFilter}
                dateRange={dateRange}
                dateStart={dateStart}
                dateEnd={dateEnd}
                disabled={leads.length === 0}
                exporting={exporting}
                setExporting={setExporting}
              />
            </div>
          </div>

          {/* Row 2: date filters (grayed out when demo filter = "none") */}
          <div
            title={demoFilter === "none" ? "Date filters apply when filtering by demo creation date." : undefined}
            style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", opacity: demoFilter === "none" ? 0.35 : 1, transition: "opacity 150ms ease-out", pointerEvents: demoFilter === "none" ? "none" : undefined }}
          >
            <DateRangeChips value={dateRange} onChange={setDateRange} />
            {dateRange === "custom" && (
              <>
                <input
                  type="date"
                  value={dateStart}
                  onChange={(e) => setDateStart(e.target.value)}
                  style={dateInputStyle}
                />
                <span style={{ color: "#8A8A8A", fontSize: 12 }}>–</span>
                <input
                  type="date"
                  value={dateEnd}
                  onChange={(e) => setDateEnd(e.target.value)}
                  style={dateInputStyle}
                />
              </>
            )}
          </div>
        </div>

        {/* Table */}
        {loading ? (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              padding: "80px 0",
              flexDirection: "column",
              gap: 14,
            }}
          >
            <Spinner size={32} />
            <p style={{ color: "#5a5a72", fontSize: 14 }}>Loading leads…</p>
          </div>
        ) : fetchError ? (
          <div
            style={{
              background: "rgba(239,68,68,0.08)",
              border: "1px solid rgba(248,113,113,0.2)",
              borderRadius: 10,
              padding: "20px",
              color: "#f87171",
              fontSize: 14,
            }}
          >
            ⚠️ {fetchError}
          </div>
        ) : leads.length === 0 ? (
          <EmptyState
            icon="🎯"
            title="No leads found"
            subtitle={
              demoFilter === "none"
                ? 'No unprocessed leads. Switch to "All leads" to see everything.'
                : demoFilter === "completed"
                ? "No leads with a completed demo yet."
                : "No leads exist yet."
            }
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
                  <th
                    style={{
                      padding: "12px 16px",
                      width: 44,
                      borderBottom: "1px solid rgba(255,255,255,0.07)",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      style={{ accentColor: "#7c3aed", width: 14, height: 14, cursor: "pointer" }}
                    />
                  </th>
                  {["Name", "Company", "Website", "Status"].map((h) => (
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
                {leads.map((lead, i) => {
                  const isSelected = selected.has(lead.id);
                  return (
                    <LeadRow
                      key={lead.id}
                      lead={lead}
                      isSelected={isSelected}
                      isLast={i === leads.length - 1}
                      onToggle={() => toggleOne(lead.id)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function LeadRow({
  lead,
  isSelected,
  isLast,
  onToggle,
}: {
  lead: Lead;
  isSelected: boolean;
  isLast: boolean;
  onToggle: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  const rowBg = isSelected
    ? "rgba(124,58,237,0.12)"
    : hovered
    ? "rgba(255,255,255,0.03)"
    : "transparent";

  return (
    <tr
      onClick={onToggle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        borderBottom: isLast ? "none" : "1px solid rgba(255,255,255,0.05)",
        background: rowBg,
        cursor: "pointer",
        transition: "background 150ms ease",
      }}
    >
      <td style={{ padding: "13px 16px" }} onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggle}
          style={{ accentColor: "#7c3aed", width: 14, height: 14, cursor: "pointer" }}
        />
      </td>
      <td
        style={{
          padding: "13px 16px",
          fontSize: 14,
          color: "#f0f0f8",
          fontWeight: 500,
        }}
      >
        {lead.name || <span style={{ color: "#5a5a72" }}>—</span>}
      </td>
      <td
        style={{
          padding: "13px 16px",
          fontSize: 14,
          color: "#9090a8",
        }}
      >
        {lead.company_name || <span style={{ color: "#5a5a72" }}>—</span>}
      </td>
      <td
        style={{
          padding: "13px 16px",
          fontSize: 12.5,
          color: "#9090a8",
          maxWidth: 220,
        }}
      >
        {lead.company_website_url ? (
          <a
            href={lead.company_website_url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{
              color: "#7c7cff",
              textDecoration: "none",
              fontFamily: "monospace",
              fontSize: 12,
              transition: "color 150ms",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#a78bfa")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "#7c7cff")}
          >
            {lead.company_website_url.replace(/^https?:\/\//, "").slice(0, 40)}
          </a>
        ) : (
          <span style={{ color: "#3a3a50" }}>—</span>
        )}
      </td>
      <td style={{ padding: "13px 16px" }}>
        {lead.has_demo ? (
          <span
            className="badge"
            style={{
              background: "rgba(74,222,128,0.12)",
              color: "#4ade80",
              borderColor: "rgba(74,222,128,0.25)",
            }}
          >
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#4ade80", display: "inline-block" }} />
            Demo ready
          </span>
        ) : (
          <span style={{ fontSize: 12, color: "#3a3a50" }}>No demo</span>
        )}
      </td>
    </tr>
  );
}

/* ── Sub-components ── */

const dateInputStyle: React.CSSProperties = {
  padding: "4px 8px",
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.1)",
  background: "transparent",
  color: "#f0f0f8",
  fontSize: 12,
  colorScheme: "dark" as React.CSSProperties["colorScheme"],
};

const FILTER_OPTIONS: { value: DemoFilter; label: string }[] = [
  { value: "none",      label: "Without demos" },
  { value: "all",       label: "All leads"     },
  { value: "completed", label: "Only with demos" },
];

const DATE_OPTIONS: { value: DateRange; label: string }[] = [
  { value: "all",    label: "All time"     },
  { value: "today",  label: "Today"        },
  { value: "week",   label: "This week"    },
  { value: "month",  label: "This month"   },
  { value: "custom", label: "Custom range" },
];

function DateRangeChips({ value, onChange }: { value: DateRange; onChange: (v: DateRange) => void }) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {DATE_OPTIONS.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              padding: "4px 10px",
              borderRadius: 6,
              border: active ? "1px solid rgba(255,255,255,0.4)" : "1px solid rgba(255,255,255,0.07)",
              background: active ? "rgba(255,255,255,0.08)" : "transparent",
              color: active ? "#f0f0f8" : "#5a5a72",
              fontSize: 11.5,
              fontWeight: active ? 600 : 400,
              cursor: "pointer",
              transition: "all 150ms ease-out",
              whiteSpace: "nowrap",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function FilterChips({
  value,
  onChange,
}: {
  value: DemoFilter;
  onChange: (v: DemoFilter) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {FILTER_OPTIONS.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              padding: "5px 12px",
              borderRadius: 6,
              border: active ? "1px solid #f0f0f8" : "1px solid rgba(255,255,255,0.1)",
              background: active ? "#f0f0f8" : "transparent",
              color: active ? "#0d0d18" : "#5a5a72",
              fontSize: 12,
              fontWeight: active ? 600 : 400,
              cursor: "pointer",
              transition: "all 150ms ease",
              whiteSpace: "nowrap",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function ExportButton({
  demoFilter, dateRange, dateStart, dateEnd, disabled, exporting, setExporting,
}: {
  demoFilter:  DemoFilter;
  dateRange:   DateRange;
  dateStart:   string;
  dateEnd:     string;
  disabled:    boolean;
  exporting:   boolean;
  setExporting: (v: boolean) => void;
}) {
  const handleClick = async () => {
    if (disabled || exporting) return;
    setExporting(true);
    try {
      const res = await fetch(api.exportLeadsUrl(demoFilter, dateRange, dateStart || undefined, dateEnd || undefined));
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const disposition = res.headers.get("content-disposition") ?? "";
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] ?? `leads-export-${new Date().toISOString().slice(0, 10)}.csv`;
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // swallow — nothing useful to show
    } finally {
      setExporting(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={disabled || exporting}
      title={disabled ? "No leads to export" : "Download CSV"}
      style={{
        padding: "5px 12px",
        borderRadius: 6,
        border: "1px solid rgba(255,255,255,0.1)",
        background: "transparent",
        color: disabled ? "#3a3a50" : "#9090a8",
        fontSize: 12,
        cursor: disabled || exporting ? "not-allowed" : "pointer",
        display: "flex",
        alignItems: "center",
        gap: 5,
        transition: "color 150ms ease",
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.color = "#f0f0f8";
      }}
      onMouseLeave={(e) => {
        if (!disabled) e.currentTarget.style.color = "#9090a8";
      }}
    >
      {exporting ? "Exporting…" : "↓ Export CSV"}
    </button>
  );
}

function StatPill({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div
      style={{
        padding: "6px 14px",
        borderRadius: 8,
        background: `${color}18`,
        border: `1px solid ${color}30`,
        display: "flex",
        alignItems: "center",
        gap: 7,
      }}
    >
      <span style={{ fontSize: 16, fontWeight: 700, color, fontFamily: "'Space Grotesk', sans-serif" }}>
        {value}
      </span>
      <span style={{ fontSize: 11, color: "#5a5a72", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>
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
      <p style={{ fontSize: 13, color: "#5a5a72", margin: 0, textAlign: "center", maxWidth: 340 }}>
        {subtitle}
      </p>
    </div>
  );
}

function Spinner({ size = 24 }: { size?: number }) {
  const thickness = Math.max(2, Math.round(size / 10));
  return (
    <div
      style={{
        width: size,
        height: size,
        border: `${thickness}px solid rgba(255,255,255,0.08)`,
        borderTop: `${thickness}px solid #7c3aed`,
        borderRadius: "50%",
        animation: "spin 0.7s linear infinite",
        flexShrink: 0,
      }}
    />
  );
}
