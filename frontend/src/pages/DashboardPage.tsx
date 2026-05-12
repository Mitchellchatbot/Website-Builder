import { useState, useEffect } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { api, type DashboardStats } from "../api/client";

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function DashboardPage() {
  const [stats,   setStats]   = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    api.getDashboardStats()
      .then(setStats)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  const thisWeek  = stats?.daily_counts.slice(-7).reduce((a, d) => a + d.completed, 0) ?? 0;
  const thisMonth = stats?.daily_counts.reduce((a, d) => a + d.completed, 0) ?? 0;

  return (
    <div style={{ minHeight: "100vh", padding: "36px 32px", fontFamily: "Inter, sans-serif" }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>

        <div style={{ marginBottom: 28 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: "#FFFFFF", margin: 0 }}>
            Dashboard
          </h1>
        </div>

        {error && (
          <div style={{
            background: "rgba(196,69,45,0.08)", border: "1px solid rgba(196,69,45,0.25)",
            borderRadius: 4, padding: "10px 14px", color: "#C4452D", fontSize: 13, marginBottom: 20,
          }}>
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "80px 0" }}>
            <Spinner />
          </div>
        ) : stats ? (
          <>
            {/* ── KPI Tiles ────────────────────────────────────────────────── */}
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
              marginBottom: 32,
            }}>
              <KpiTile
                label="Total demos generated"
                value={stats.totals.completed.toLocaleString()}
              />
              <KpiTile
                label="Success rate"
                value={
                  stats.totals.success_rate !== null
                    ? `${Math.round(stats.totals.success_rate * 100)}%`
                    : "—"
                }
              />
              <KpiTile
                label="Generated today"
                value={stats.today.completed.toLocaleString()}
              />
              <KpiTile
                label="Avg generation time"
                value={formatDuration(stats.avg_duration_seconds)}
              />
            </div>

            {/* ── Activity Chart ───────────────────────────────────────────── */}
            <div style={{
              border: "1px solid rgba(232,232,232,0.1)",
              borderRadius: 4,
              padding: "20px 20px 12px",
              marginBottom: 28,
              background: "rgba(255,255,255,0.01)",
            }}>
              <p style={{ fontSize: 11, fontWeight: 600, color: "#8A8A8A", textTransform: "uppercase", letterSpacing: "0.1em", margin: "0 0 16px" }}>
                Demos generated · last 30 days
              </p>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={stats.daily_counts} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10, fill: "#8A8A8A" }}
                    tickFormatter={(v: string) => v.slice(5)}
                    interval={6}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: "#8A8A8A" }}
                    allowDecimals={false}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#1a1a2e",
                      border: "1px solid rgba(255,255,255,0.1)",
                      borderRadius: 4,
                      fontSize: 12,
                      color: "#FAFAFA",
                    }}
                    labelStyle={{ color: "#8A8A8A", marginBottom: 4 }}
                    formatter={(value: number) => [value, "Demos"]}
                  />
                  <Line
                    type="monotone"
                    dataKey="completed"
                    stroke="#FF6B01"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, fill: "#FF6B01" }}
                  />
                </LineChart>
              </ResponsiveContainer>
              <p style={{ fontSize: 12, color: "#8A8A8A", marginTop: 10, textAlign: "center" }}>
                Total this week: <strong style={{ color: "#FAFAFA" }}>{thisWeek}</strong>
                &nbsp;·&nbsp;
                Total this month: <strong style={{ color: "#FAFAFA" }}>{thisMonth}</strong>
              </p>
            </div>

            {/* ── Failure Breakdown ────────────────────────────────────────── */}
            {stats.top_failure_reasons.length > 0 && (
              <div style={{
                border: "1px solid rgba(196,69,45,0.18)",
                borderRadius: 4,
                overflow: "hidden",
                background: "rgba(196,69,45,0.03)",
              }}>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(196,69,45,0.12)" }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: "#8A8A8A", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                    Top failure reasons · last 30 days
                  </span>
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      {["Error", "Count", "Example lead"].map((h) => (
                        <th key={h} style={{
                          textAlign: "left", padding: "9px 14px",
                          fontSize: 10.5, fontWeight: 600, color: "#8A8A8A",
                          textTransform: "uppercase", letterSpacing: "0.08em",
                          borderBottom: "1px solid rgba(196,69,45,0.10)",
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {stats.top_failure_reasons.map((fr, i) => (
                      <tr key={i} style={{ borderBottom: "1px solid rgba(196,69,45,0.07)" }}>
                        <td style={{ padding: "11px 14px", maxWidth: 340 }}>
                          <span title={fr.error} style={{
                            fontSize: 12.5, color: "#C4452D", display: "inline-block",
                            maxWidth: 340, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          }}>
                            {fr.error}
                          </span>
                        </td>
                        <td style={{ padding: "11px 14px", fontSize: 13, fontWeight: 600, color: "#FAFAFA", whiteSpace: "nowrap" }}>
                          {fr.count}×
                        </td>
                        <td style={{ padding: "11px 14px", fontSize: 12.5, color: "#8A8A8A" }}>
                          {fr.example_lead}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}

      </div>
    </div>
  );
}

function KpiTile({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      border: "1px solid rgba(232,232,232,0.1)",
      borderRadius: 4,
      padding: "16px 18px",
      background: "rgba(255,255,255,0.015)",
    }}>
      <p style={{ fontSize: 10.5, fontWeight: 600, color: "#8A8A8A", textTransform: "uppercase", letterSpacing: "0.1em", margin: "0 0 8px" }}>
        {label}
      </p>
      <p style={{ fontSize: 28, fontWeight: 600, color: "#FFFFFF", margin: 0, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </p>
    </div>
  );
}

function Spinner() {
  return (
    <div style={{
      width: 28, height: 28,
      border: "2px solid rgba(255,255,255,0.08)",
      borderTop: "2px solid #FF6B01",
      borderRadius: "50%",
      animation: "spin 0.7s linear infinite",
    }} />
  );
}
