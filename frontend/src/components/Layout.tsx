import { NavLink, Outlet } from "react-router-dom";

export default function Layout() {
  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <Sidebar />
      <main
        style={{
          flex: 1,
          marginLeft: 240,
          minHeight: "100vh",
          position: "relative",
        }}
      >
        <Outlet />
      </main>
    </div>
  );
}

function Sidebar() {
  return (
    <aside
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: 240,
        height: "100vh",
        background: "rgba(10,10,15,0.95)",
        borderRight: "1px solid rgba(255,255,255,0.07)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        backdropFilter: "blur(20px)",
        zIndex: 100,
      }}
    >
      {/* Top glow line */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 1,
          background: "linear-gradient(90deg, transparent, #7c3aed 40%, #ff6b01 60%, transparent)",
          opacity: 0.6,
        }}
      />

      {/* Brand */}
      <div
        style={{
          padding: "24px 20px 22px",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          marginBottom: 16,
        }}
      >
        {/* Logo icon */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: "linear-gradient(135deg, #7c3aed, #ff6b01)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 14,
              flexShrink: 0,
              boxShadow: "0 4px 12px rgba(124,58,237,0.4)",
            }}
          >
            ⚡
          </div>
          <div>
            <div
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: "#f0f0f8",
                fontFamily: "'Space Grotesk', sans-serif",
                letterSpacing: "-0.2px",
              }}
            >
              DemoGen
            </div>
            <div
              style={{
                fontSize: 10,
                fontWeight: 500,
                color: "#5a5a72",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                marginTop: 1,
              }}
            >
              AI Website Builder
            </div>
          </div>
        </div>
      </div>

      {/* Nav section label */}
      <div
        style={{
          padding: "0 20px 8px",
          fontSize: 10,
          fontWeight: 600,
          color: "#5a5a72",
          textTransform: "uppercase",
          letterSpacing: "0.12em",
        }}
      >
        Navigation
      </div>

      {/* Nav */}
      <nav
        style={{
          padding: "0 12px",
          display: "flex",
          flexDirection: "column",
          gap: 3,
        }}
      >
        <SidebarLink to="/dashboard"    icon="📊" label="Dashboard" />
        <SidebarLink to="/leads"        icon="🎯" label="Leads" end />
        <SidebarLink to="/custom-links" icon="🔗" label="Custom Links" />
        <SidebarLink to="/websites"     icon="🌐" label="Websites" />
        <SidebarLink to="/active"       icon="⚡" label="Active Runs" />
        <SidebarLink to="/history"      icon="📋" label="History" />
      </nav>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Bottom status card */}
      <div
        style={{
          margin: "0 12px 16px",
          padding: "12px 14px",
          borderRadius: 10,
          background: "rgba(124,58,237,0.08)",
          border: "1px solid rgba(124,58,237,0.18)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            marginBottom: 4,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "#4ade80",
              display: "inline-block",
              boxShadow: "0 0 6px rgba(74,222,128,0.6)",
            }}
          />
          <span style={{ fontSize: 11.5, fontWeight: 600, color: "#4ade80" }}>
            System Online
          </span>
        </div>
        <p style={{ fontSize: 11, color: "#5a5a72", lineHeight: 1.4 }}>
          AI generation pipeline ready
        </p>
      </div>
    </aside>
  );
}

function SidebarLink({
  to,
  label,
  icon,
  end,
}: {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
    >
      <span style={{ fontSize: 15 }}>{icon}</span>
      {label}
    </NavLink>
  );
}
