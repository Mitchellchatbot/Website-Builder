import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Lead, type DemoFilter, type DateRange } from "../api/client";

type ImportedFilter = "all" | "today" | "week" | "month" | "custom";

export default function LeadsPage() {
  const navigate = useNavigate();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [demoFilter,      setDemoFilter]      = useState<DemoFilter>("none");
  const [dateRange,       setDateRange]       = useState<DateRange>("all");
  const [dateStart,       setDateStart]       = useState("");
  const [dateEnd,         setDateEnd]         = useState("");
  const [importedFilter,  setImportedFilter]  = useState<ImportedFilter>("all");
  const [importedFrom,    setImportedFrom]    = useState("");
  const [importedTo,      setImportedTo]      = useState("");
  const [loading,     setLoading]     = useState(true);
  const [fetchError,  setFetchError]  = useState<string | null>(null);
  const [selected,    setSelected]    = useState<Set<string>>(new Set());
  const [editingId,   setEditingId]   = useState<string | null>(null);
  const [submitting,  setSubmitting]  = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [query,       setQuery]       = useState("");

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

  const { importedSinceMs, importedBeforeMs } = useMemo(() => {
    if (importedFilter === "today") {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      return { importedSinceMs: start.getTime(), importedBeforeMs: null };
    }
    if (importedFilter === "week")  return { importedSinceMs: Date.now() - 7  * 86_400_000, importedBeforeMs: null };
    if (importedFilter === "month") return { importedSinceMs: Date.now() - 30 * 86_400_000, importedBeforeMs: null };
    if (importedFilter === "custom") {
      const from = importedFrom ? new Date(`${importedFrom}T00:00:00`).getTime() : null;
      const to   = importedTo   ? new Date(`${importedTo}T23:59:59.999`).getTime() : null;
      return { importedSinceMs: from, importedBeforeMs: to };
    }
    return { importedSinceMs: null, importedBeforeMs: null };
  }, [importedFilter, importedFrom, importedTo]);

  const visibleLeads = useMemo(() => {
    const q = query.trim().toLowerCase();
    return leads.filter((l) => {
      if (q && !(
        l.name.toLowerCase().includes(q) ||
        (l.company_name ?? "").toLowerCase().includes(q) ||
        (l.company_website_url ?? "").toLowerCase().includes(q)
      )) return false;

      if (importedSinceMs != null || importedBeforeMs != null) {
        if (!l.imported_at) return false;
        const t = new Date(l.imported_at).getTime();
        if (importedSinceMs != null && t < importedSinceMs) return false;
        if (importedBeforeMs != null && t > importedBeforeMs) return false;
      }

      return true;
    });
  }, [leads, query, importedSinceMs, importedBeforeMs]);

  const allSelected = visibleLeads.length > 0 && visibleLeads.every((l) => selected.has(l.id));

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) visibleLeads.forEach((l) => next.delete(l.id));
      else             visibleLeads.forEach((l) => next.add(l.id));
      return next;
    });
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
            <StatPill label={visibleLeads.length < leads.length ? "Filtered" : "Total"} value={visibleLeads.length} color="#7c3aed" />
            <StatPill label="Selected" value={selected.size} color="#ff6b01" />
            <StatPill
              label="With Demo"
              value={visibleLeads.filter((l) => l.has_demo).length}
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
          {/* Row 1: generate button + search + demo filter + export */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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

              {/* Search */}
              <div style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "#5a5a72", pointerEvents: "none" }}>
                  🔍
                </span>
                <input
                  type="search"
                  placeholder="Search leads…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  style={{
                    paddingLeft: 32,
                    paddingRight: query ? 28 : 12,
                    paddingTop: 6,
                    paddingBottom: 6,
                    borderRadius: 6,
                    border: "1px solid rgba(255,255,255,0.1)",
                    background: "rgba(255,255,255,0.04)",
                    color: "#f0f0f8",
                    fontSize: 13,
                    width: 220,
                    outline: "none",
                    transition: "border-color 150ms ease, width 150ms ease",
                  }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.25)")}
                  onBlur={(e)  => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.1)")}
                />
                {query && (
                  <button
                    onClick={() => setQuery("")}
                    style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#5a5a72", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0 }}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <FilterChips value={demoFilter} onChange={(v) => { setDemoFilter(v); setDateRange("all"); }} />
              <ExportButton
                leads={visibleLeads}
                disabled={visibleLeads.length === 0}
              />
            </div>
          </div>

          {/* Row 2: demo-date filters (grayed out when demo filter = "none") */}
          <div
            title={demoFilter === "none" ? "Date filters apply when filtering by demo creation date." : undefined}
            style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", opacity: demoFilter === "none" ? 0.35 : 1, transition: "opacity 150ms ease-out", pointerEvents: demoFilter === "none" ? "none" : undefined }}
          >
            <DateRangeChips value={dateRange} onChange={setDateRange} />
            {dateRange === "custom" && (
              <>
                <input type="date" value={dateStart} onChange={(e) => setDateStart(e.target.value)} style={dateInputStyle} />
                <span style={{ color: "#8A8A8A", fontSize: 12 }}>–</span>
                <input type="date" value={dateEnd} onChange={(e) => setDateEnd(e.target.value)} style={dateInputStyle} />
              </>
            )}
          </div>

          {/* Row 3: imported-at filter — always enabled, client-side */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
            <span style={{ fontSize: 11, color: "#5a5a72", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", whiteSpace: "nowrap" }}>
              Imported
            </span>
            <ImportedFilterChips value={importedFilter} onChange={(v) => {
              setImportedFilter(v);
              if (v !== "custom") { setImportedFrom(""); setImportedTo(""); }
            }} />
            {importedFilter === "custom" && (
              <>
                <input type="date" value={importedFrom} onChange={(e) => setImportedFrom(e.target.value)} style={dateInputStyle} />
                <span style={{ color: "#8A8A8A", fontSize: 12 }}>–</span>
                <input type="date" value={importedTo} onChange={(e) => setImportedTo(e.target.value)} style={dateInputStyle} />
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
        ) : visibleLeads.length === 0 ? (
          <EmptyState
            icon="🔍"
            title="No matches"
            subtitle={`No leads match "${query}". Try a different name, company, or URL.`}
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
                  <th style={{ width: 36, borderBottom: "1px solid rgba(255,255,255,0.07)" }} />
                </tr>
              </thead>
              <tbody>
                {visibleLeads.map((lead, i) => {
                  const isSelected = selected.has(lead.id);
                  const isEditing  = editingId === lead.id;
                  return (
                    <LeadRow
                      key={lead.id}
                      lead={lead}
                      isSelected={isSelected}
                      isEditing={isEditing}
                      isLast={i === visibleLeads.length - 1}
                      onToggle={() => toggleOne(lead.id)}
                      onEdit={() => setEditingId(isEditing ? null : lead.id)}
                      onSaved={(patch) => {
                        setLeads((prev) => prev.map((l) =>
                          l.id === lead.id ? { ...l, ...patch } : l
                        ));
                        setEditingId(null);
                      }}
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
  isEditing,
  isLast,
  onToggle,
  onEdit,
  onSaved,
}: {
  lead: Lead;
  isSelected: boolean;
  isEditing: boolean;
  isLast: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onSaved: (patch: Partial<Lead>) => void;
}) {
  const [hovered,  setHovered]  = useState(false);
  const [website,  setWebsite]  = useState(lead.company_website_url ?? "");
  const [demoUrl,  setDemoUrl]  = useState(lead.demo_url ?? "");
  const [saving,   setSaving]   = useState(false);
  const [saveErr,  setSaveErr]  = useState<string | null>(null);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveErr(null);
    try {
      await api.updateLead(lead.id, {
        company_website_url: website.trim() || null,
        demo_site_url:       demoUrl.trim() || null,
      });
      onSaved({
        company_website_url: website.trim() || null,
        has_demo:            !!demoUrl.trim(),
        demo_url:            demoUrl.trim() || null,
      });
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : "Save failed");
      setSaving(false);
    }
  };

  const rowBorder = isLast && !isEditing ? "none" : "1px solid rgba(255,255,255,0.05)";
  const rowBg = isSelected
    ? "rgba(124,58,237,0.12)"
    : hovered
    ? "rgba(255,255,255,0.03)"
    : "transparent";

  return (
    <>
      <tr
        onClick={onToggle}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{ borderBottom: rowBorder, background: rowBg, cursor: "pointer", transition: "background 150ms ease" }}
      >
        <td style={{ padding: "13px 16px" }} onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={isSelected} onChange={onToggle}
            style={{ accentColor: "#7c3aed", width: 14, height: 14, cursor: "pointer" }} />
        </td>
        <td style={{ padding: "13px 16px", fontSize: 14, color: "#f0f0f8", fontWeight: 500 }}>
          {lead.name || <span style={{ color: "#5a5a72" }}>—</span>}
        </td>
        <td style={{ padding: "13px 16px", fontSize: 14, color: "#9090a8" }}>
          {lead.company_name || <span style={{ color: "#5a5a72" }}>—</span>}
        </td>
        <td style={{ padding: "13px 16px", fontSize: 12.5, color: "#9090a8", maxWidth: 220 }}>
          {lead.company_website_url ? (
            <a
              href={/^https?:\/\//i.test(lead.company_website_url) ? lead.company_website_url : `https://${lead.company_website_url}`}
              target="_blank" rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{ color: "#7c7cff", textDecoration: "none", fontFamily: "monospace", fontSize: 12, transition: "color 150ms" }}
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
            <span className="badge" style={{ background: "rgba(74,222,128,0.12)", color: "#4ade80", borderColor: "rgba(74,222,128,0.25)" }}>
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#4ade80", display: "inline-block" }} />
              Demo ready
            </span>
          ) : (
            <span style={{ fontSize: 12, color: "#3a3a50" }}>No demo</span>
          )}
        </td>
        <td style={{ padding: "13px 8px", width: 36 }} onClick={(e) => e.stopPropagation()}>
          <button
            onClick={onEdit}
            title={isEditing ? "Close edit" : "Edit lead"}
            style={{
              background: isEditing ? "rgba(124,58,237,0.2)" : "transparent",
              border: isEditing ? "1px solid rgba(124,58,237,0.4)" : "1px solid transparent",
              borderRadius: 5,
              color: isEditing ? "#a78bfa" : "#5a5a72",
              cursor: "pointer",
              padding: "3px 6px",
              fontSize: 13,
              lineHeight: 1,
              transition: "all 150ms",
            }}
            onMouseEnter={(e) => { if (!isEditing) e.currentTarget.style.color = "#f0f0f8"; }}
            onMouseLeave={(e) => { if (!isEditing) e.currentTarget.style.color = "#5a5a72"; }}
          >
            {isEditing ? "✕" : "✎"}
          </button>
        </td>
      </tr>

      {isEditing && (
        <tr style={{ borderBottom: isLast ? "none" : "1px solid rgba(255,255,255,0.05)", background: "rgba(124,58,237,0.05)" }}>
          <td colSpan={6} style={{ padding: "0 16px 14px 48px" }}>
            <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
                <label style={{ flex: 1, minWidth: 200 }}>
                  <span style={{ display: "block", fontSize: 10.5, color: "#5a5a72", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
                    Website URL
                  </span>
                  <input
                    type="url"
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder="https://example.com"
                    style={{ ...editFieldStyle, width: "100%" }}
                  />
                </label>
                <label style={{ flex: 1, minWidth: 200 }}>
                  <span style={{ display: "block", fontSize: 10.5, color: "#5a5a72", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
                    Netlify Demo URL
                  </span>
                  <input
                    type="url"
                    value={demoUrl}
                    onChange={(e) => setDemoUrl(e.target.value)}
                    placeholder="https://your-site.netlify.app"
                    style={{ ...editFieldStyle, width: "100%" }}
                  />
                </label>
                <div style={{ display: "flex", gap: 6, paddingBottom: 1 }}>
                  <button type="submit" disabled={saving}
                    style={{ padding: "6px 14px", borderRadius: 5, background: "rgba(124,58,237,0.2)", border: "1px solid rgba(124,58,237,0.4)", color: "#a78bfa", fontSize: 12, fontWeight: 600, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.6 : 1 }}>
                    {saving ? "Saving…" : "Save"}
                  </button>
                  <button type="button" onClick={onEdit}
                    style={{ padding: "6px 12px", borderRadius: 5, background: "transparent", border: "1px solid rgba(255,255,255,0.1)", color: "#5a5a72", fontSize: 12, cursor: "pointer" }}>
                    Cancel
                  </button>
                </div>
              </div>
              {saveErr && <span style={{ fontSize: 12, color: "#f87171" }}>⚠ {saveErr}</span>}
            </form>
          </td>
        </tr>
      )}
    </>
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

const editFieldStyle: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.04)",
  color: "#f0f0f8",
  fontSize: 12.5,
  outline: "none",
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

const IMPORTED_OPTIONS: { value: ImportedFilter; label: string }[] = [
  { value: "all",    label: "All time"     },
  { value: "today",  label: "Today"        },
  { value: "week",   label: "Last 7 days"  },
  { value: "month",  label: "Last 30 days" },
  { value: "custom", label: "Custom"       },
];

function ImportedFilterChips({ value, onChange }: { value: ImportedFilter; onChange: (v: ImportedFilter) => void }) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {IMPORTED_OPTIONS.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              padding: "4px 10px",
              borderRadius: 6,
              border: active ? "1px solid rgba(96,165,250,0.6)" : "1px solid rgba(255,255,255,0.07)",
              background: active ? "rgba(96,165,250,0.12)" : "transparent",
              color: active ? "#93c5fd" : "#5a5a72",
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

function ExportButton({ leads, disabled }: { leads: Lead[]; disabled: boolean }) {
  const handleClick = () => {
    if (disabled) return;

    const rows = [
      ["Lead ID", "First Name", "Last Name", "Company Email", "Company Name", "Website", "Demo Site URL", "Generated At", "Imported At"],
      ...leads.map((l) => [
        l.id,
        l.first_name,
        l.last_name,
        l.email,
        l.company_name ?? "",
        l.company_website_url ?? "",
        l.demo_url ?? "",
        l.demo_generated_at ? l.demo_generated_at.slice(0, 10) : "",
        l.imported_at ? l.imported_at.slice(0, 10) : "",
      ]),
    ];

    const csv = rows
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `leads-export-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <button
      onClick={handleClick}
      disabled={disabled}
      title={disabled ? "No leads to export" : `Export ${leads.length} lead${leads.length !== 1 ? "s" : ""} as CSV`}
      style={{
        padding: "5px 12px",
        borderRadius: 6,
        border: "1px solid rgba(255,255,255,0.1)",
        background: "transparent",
        color: disabled ? "#3a3a50" : "#9090a8",
        fontSize: 12,
        cursor: disabled ? "not-allowed" : "pointer",
        display: "flex",
        alignItems: "center",
        gap: 5,
        transition: "color 150ms ease",
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.color = "#f0f0f8"; }}
      onMouseLeave={(e) => { if (!disabled) e.currentTarget.style.color = "#9090a8"; }}
    >
      ↓ Export CSV
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
