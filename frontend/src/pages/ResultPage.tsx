import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, type GenerationStatus } from "../api/client";

const TERMINAL = new Set(["completed", "failed"]);
const POLL_MS = 3000;

const STEP_LABELS: Record<string, string> = {
  pending: "Initialising pipeline…",
  scraping: "Scraping website content…",
  generating: "Generating HTML with Claude…",
  deploying: "Deploying to Netlify…",
  completed: "Complete",
  failed: "Failed",
};

const STEP_ICONS: Record<string, string> = {
  pending: "⚙️",
  scraping: "🔍",
  generating: "✨",
  deploying: "🚀",
  completed: "🎉",
  failed: "💥",
};

const ORDERED_STEPS = ["pending", "scraping", "generating", "deploying", "completed"];

export default function ResultPage() {
  const { leadWebsiteId } = useParams<{ leadWebsiteId: string }>();
  const navigate = useNavigate();
  const [status, setStatus] = useState<GenerationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!leadWebsiteId) return;
    api
      .getGenerationStatus(leadWebsiteId)
      .then(setStatus)
      .catch((e) => setFetchError(e.message))
      .finally(() => setLoading(false));
  }, [leadWebsiteId]);

  useEffect(() => {
    if (!leadWebsiteId || !status || TERMINAL.has(status.status)) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }
    intervalRef.current = setInterval(async () => {
      try {
        const next = await api.getGenerationStatus(leadWebsiteId);
        setStatus(next);
      } catch {
        // swallow transient errors
      }
    }, POLL_MS);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [leadWebsiteId, status?.status]);

  const handleRetry = async () => {
    if (!status) return;
    setRetrying(true);
    try {
      const result = await api.generateForLead(status.lead_id);
      navigate(`/result/${result.lead_website_id}`);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Retry failed");
    } finally {
      setRetrying(false);
    }
  };

  if (loading) {
    return (
      <Centered>
        <Spinner size={36} />
        <p style={{ color: "#9090a8", fontSize: 14, margin: 0 }}>Loading result…</p>
      </Centered>
    );
  }

  if (fetchError) {
    return (
      <Centered>
        <div
          style={{
            background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(248,113,113,0.2)",
            borderRadius: 10,
            padding: "16px 24px",
            color: "#f87171",
            fontSize: 14,
          }}
        >
          ⚠️ {fetchError}
        </div>
        <BackButton onClick={() => navigate("/leads")} />
      </Centered>
    );
  }

  if (!status) {
    return (
      <Centered>
        <p style={{ color: "#9090a8", fontSize: 14 }}>Result not found.</p>
        <BackButton onClick={() => navigate("/leads")} />
      </Centered>
    );
  }

  // In-progress
  if (["pending", "scraping", "generating", "deploying"].includes(status.status)) {
    const currentStepIdx = ORDERED_STEPS.indexOf(status.status);
    return (
      <Centered>
        <div
          style={{
            width: "100%",
            maxWidth: 480,
            display: "flex",
            flexDirection: "column",
            gap: 28,
          }}
        >
          {/* Title */}
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>
              {STEP_ICONS[status.status]}
            </div>
            <h2
              style={{
                fontFamily: "'Space Grotesk', sans-serif",
                fontSize: 22,
                fontWeight: 700,
                color: "#f0f0f8",
                margin: "0 0 6px",
              }}
            >
              {STEP_LABELS[status.status] ?? "Working…"}
            </h2>
            <p style={{ fontSize: 13, color: "#5a5a72", margin: 0 }}>
              For {status.lead.name || status.lead.company_name || "this lead"}
            </p>
          </div>

          {/* Step tracker */}
          <div
            style={{
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.07)",
              borderRadius: 12,
              padding: "20px 24px",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            {ORDERED_STEPS.filter((s) => s !== "completed").map((step, idx) => {
              const isDone = idx < currentStepIdx;
              const isCurrent = idx === currentStepIdx;
              return (
                <div
                  key={step}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    opacity: idx > currentStepIdx ? 0.35 : 1,
                  }}
                >
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: "50%",
                      background: isDone
                        ? "rgba(74,222,128,0.15)"
                        : isCurrent
                        ? "rgba(124,58,237,0.2)"
                        : "rgba(255,255,255,0.05)",
                      border: isDone
                        ? "1.5px solid rgba(74,222,128,0.4)"
                        : isCurrent
                        ? "1.5px solid rgba(124,58,237,0.5)"
                        : "1.5px solid rgba(255,255,255,0.08)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 12,
                      flexShrink: 0,
                    }}
                  >
                    {isDone ? "✓" : isCurrent ? <Spinner size={12} /> : "○"}
                  </div>
                  <span
                    style={{
                      fontSize: 13.5,
                      fontWeight: isCurrent ? 600 : 400,
                      color: isDone ? "#4ade80" : isCurrent ? "#f0f0f8" : "#5a5a72",
                    }}
                  >
                    {STEP_LABELS[step]}
                  </span>
                </div>
              );
            })}
          </div>

          <p style={{ fontSize: 12, color: "#3a3a50", textAlign: "center", margin: 0 }}>
            Auto-refreshing every 3 seconds…
          </p>
        </div>
      </Centered>
    );
  }

  // Completed
  if (status.status === "completed" && status.netlify_url) {
    return (
      <div className="page-enter" style={{ minHeight: "100vh", padding: "36px 32px" }}>
        <div
          style={{
            maxWidth: 560,
            margin: "0 auto",
            display: "flex",
            flexDirection: "column",
            gap: 24,
          }}
        >
          {/* Hero success card */}
          <div
            style={{
              background: "rgba(74,222,128,0.06)",
              border: "1px solid rgba(74,222,128,0.2)",
              borderRadius: 16,
              padding: "32px",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 52, marginBottom: 16 }}>🎉</div>
            <span
              className="badge"
              style={{
                background: "rgba(74,222,128,0.12)",
                color: "#4ade80",
                borderColor: "rgba(74,222,128,0.3)",
                marginBottom: 14,
                display: "inline-flex",
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#4ade80", display: "inline-block" }} />
              Published Live
            </span>
            <h1
              style={{
                fontFamily: "'Space Grotesk', sans-serif",
                fontSize: 24,
                fontWeight: 700,
                color: "#f0f0f8",
                margin: "10px 0 8px",
                letterSpacing: "-0.4px",
              }}
            >
              Demo site generated!
            </h1>
            <p style={{ color: "#5a5a72", fontSize: 14, margin: 0 }}>
              For {status.lead.name || status.lead.company_name || "this lead"}
            </p>
          </div>

          {/* URL card */}
          <div
            style={{
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 12,
              padding: "20px 24px",
              background: "rgba(255,255,255,0.02)",
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            <p
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                color: "#5a5a72",
                textTransform: "uppercase",
                letterSpacing: "0.09em",
                margin: 0,
              }}
            >
              🌐 Netlify URL
            </p>
            <a
              href={status.netlify_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: "#7c7cff",
                fontSize: 14,
                fontWeight: 500,
                wordBreak: "break-all",
                textDecoration: "none",
                fontFamily: "monospace",
                transition: "color 150ms",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#a78bfa")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#7c7cff")}
            >
              {status.netlify_url}
            </a>
            <a
              href={status.netlify_url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary"
              style={{ textDecoration: "none", width: "fit-content" }}
            >
              🚀 Open in new tab
            </a>
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={() => navigate("/leads")} className="btn-outline">
              ← Generate another
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Failed
  return (
    <div className="page-enter" style={{ minHeight: "100vh", padding: "36px 32px" }}>
      <div
        style={{
          maxWidth: 560,
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: 24,
        }}
      >
        {/* Hero failed card */}
        <div
          style={{
            background: "rgba(239,68,68,0.06)",
            border: "1px solid rgba(248,113,113,0.2)",
            borderRadius: 16,
            padding: "32px",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 52, marginBottom: 16 }}>💥</div>
          <span
            className="badge"
            style={{
              background: "rgba(248,113,113,0.12)",
              color: "#f87171",
              borderColor: "rgba(248,113,113,0.3)",
              marginBottom: 14,
              display: "inline-flex",
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#f87171", display: "inline-block" }} />
            Generation Failed
          </span>
          <h1
            style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontSize: 24,
              fontWeight: 700,
              color: "#f0f0f8",
              margin: "10px 0 8px",
              letterSpacing: "-0.4px",
            }}
          >
            Generation failed
          </h1>
          <p style={{ color: "#5a5a72", fontSize: 14, margin: 0 }}>
            For {status.lead.name || status.lead.company_name || "this lead"}
          </p>
        </div>

        {/* Error detail */}
        {status.error && (
          <div
            style={{
              border: "1px solid rgba(248,113,113,0.2)",
              borderRadius: 12,
              padding: "18px 20px",
              background: "rgba(239,68,68,0.05)",
            }}
          >
            <p
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                color: "#f87171",
                textTransform: "uppercase",
                letterSpacing: "0.09em",
                margin: "0 0 10px",
              }}
            >
              Error Details
            </p>
            <p
              style={{
                fontFamily: "monospace",
                fontSize: 12.5,
                color: "#f87171",
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                opacity: 0.85,
              }}
            >
              {status.error}
            </p>
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={handleRetry}
            disabled={retrying}
            className="btn-primary"
            style={{ opacity: retrying ? 0.5 : 1 }}
          >
            {retrying ? <><Spinner size={12} />Retrying…</> : "↺ Try again"}
          </button>
          <button onClick={() => navigate("/leads")} className="btn-outline">
            ← Back to leads
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Sub-components ── */

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        padding: 32,
      }}
    >
      {children}
    </div>
  );
}

function Spinner({ size = 28 }: { size?: number }) {
  const t = Math.max(2, Math.round(size / 10));
  return (
    <div
      style={{
        width: size,
        height: size,
        border: `${t}px solid rgba(255,255,255,0.08)`,
        borderTop: `${t}px solid #7c3aed`,
        borderRadius: "50%",
        animation: "spin 0.7s linear infinite",
        flexShrink: 0,
      }}
    />
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="btn-outline">
      ← Back to leads
    </button>
  );
}
