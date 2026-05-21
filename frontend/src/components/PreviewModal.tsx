import { useState, useEffect, useRef } from "react";

interface AssetItem {
  filename: string;
  size: number;
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  imageUrl?: string;
}

export interface PreviewModalProps {
  label: string;
  previewUrl: string;
  assetsUrl: string;
  assetBaseUrl: string;
  htmlUrl: string;
  uploadUrl?: string;
  chatEditUrl?: string;
  undoUrl?: string;
  onDeploy?: () => void;
  deploying?: boolean;
  onClose: () => void;
}

type Tab = "preview" | "assets" | "chat" | "html";

export default function PreviewModal({
  label,
  previewUrl,
  assetsUrl,
  assetBaseUrl,
  htmlUrl,
  uploadUrl,
  chatEditUrl,
  undoUrl,
  onDeploy,
  deploying,
  onClose,
}: PreviewModalProps) {
  const [tab, setTab] = useState<Tab>("preview");
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [assetsLoaded, setAssetsLoaded] = useState(false);
  const [html, setHtml] = useState("");
  const [htmlLoading, setHtmlLoading] = useState(false);
  const [htmlLoaded, setHtmlLoaded] = useState(false);
  const [htmlSaving, setHtmlSaving] = useState(false);
  const [htmlSaved, setHtmlSaved] = useState(false);
  const [htmlError, setHtmlError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [copiedFilename, setCopiedFilename] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);

  // Chat state (ephemeral — resets on modal close)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatImage, setChatImage] = useState<{ file: File; url: string } | null>(null);
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [iframeNonce, setIframeNonce] = useState(0);

  const uploadInputRef = useRef<HTMLInputElement>(null);
  const chatImageInputRef = useRef<HTMLInputElement>(null);
  const chatTextareaRef = useRef<HTMLTextAreaElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (tab === "assets" && !assetsLoaded) {
      setAssetsLoading(true);
      fetch(assetsUrl)
        .then((r) => r.json())
        .then((data) => { setAssets(data.assets || []); setAssetsLoaded(true); })
        .catch(() => setAssets([]))
        .finally(() => setAssetsLoading(false));
    }
  }, [tab, assetsUrl, assetsLoaded]);

  useEffect(() => {
    if ((tab === "html" || tab === "chat") && !htmlLoaded) {
      setHtmlLoading(true);
      fetch(htmlUrl)
        .then((r) => r.json())
        .then((data) => {
          setHtml(data.html || "");
          setCanUndo(!!data.can_undo);
          setHtmlLoaded(true);
        })
        .catch(() => setHtml(""))
        .finally(() => setHtmlLoading(false));
    }
  }, [tab, htmlUrl, htmlLoaded]);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages, chatSending]);

  // Revoke object URLs on unmount so we don't leak memory
  useEffect(() => {
    return () => {
      chatMessages.forEach((m) => { if (m.imageUrl) URL.revokeObjectURL(m.imageUrl); });
      if (chatImage) URL.revokeObjectURL(chatImage.url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSaveHtml() {
    setHtmlSaving(true);
    setHtmlError(null);
    try {
      const res = await fetch(htmlUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail ?? "Save failed");
      }
      setHtmlSaved(true);
      setCanUndo(true);
      refreshPreview();
      setTimeout(() => setHtmlSaved(false), 2500);
    } catch (e: unknown) {
      setHtmlError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setHtmlSaving(false);
    }
  }

  async function handleUploadAsset(file: File) {
    if (!uploadUrl) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(uploadUrl, { method: "POST", body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail ?? "Upload failed");
      }
      const data = await res.json();
      setAssets((prev) => {
        const existing = prev.findIndex((a) => a.filename === data.filename);
        if (existing >= 0) {
          const next = [...prev];
          next[existing] = data;
          return next;
        }
        return [...prev, data];
      });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function handleCopyUrl(filename: string) {
    // Copy the relative path the HTML uses (images/<file>) — works in both
    // the preview iframe AND the deployed Netlify site. The absolute localhost
    // URL only works in preview and breaks once deployed.
    const path = `images/${filename}`;
    navigator.clipboard.writeText(path).then(() => {
      setCopiedFilename(filename);
      setTimeout(() => setCopiedFilename(null), 2000);
    });
  }

  function refreshPreview() {
    setIframeNonce((n) => n + 1);
  }

  function handlePickChatImage(file: File) {
    if (!file.type.startsWith("image/")) {
      setChatError("Only image files are supported");
      return;
    }
    if (chatImage) URL.revokeObjectURL(chatImage.url);
    setChatImage({ file, url: URL.createObjectURL(file) });
    setChatError(null);
  }

  function handleChatPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith("image/"));
    if (item) {
      const file = item.getAsFile();
      if (file) {
        // Give pasted file a sensible name with extension so the backend can detect type
        const ext = item.type.split("/")[1] || "png";
        const renamed = new File([file], `pasted-${Date.now()}.${ext}`, { type: item.type });
        handlePickChatImage(renamed);
        e.preventDefault();
      }
    }
  }

  async function handleSendChat() {
    if (!chatEditUrl) return;
    const message = chatInput.trim();
    if (!message) return;

    setChatError(null);
    setChatSending(true);

    const userMsg: ChatMessage = {
      role: "user",
      text: message,
      imageUrl: chatImage?.url,
    };
    setChatMessages((prev) => [...prev, userMsg]);

    const form = new FormData();
    form.append("message", message);
    if (chatImage) form.append("image", chatImage.file);

    setChatInput("");
    const pendingImage = chatImage;
    setChatImage(null);

    try {
      const res = await fetch(chatEditUrl, { method: "POST", body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail ?? "Edit failed");
      }
      const data = await res.json();
      setHtml(data.html || "");
      setCanUndo(true);
      refreshPreview();
      setChatMessages((prev) => [...prev, {
        role: "assistant",
        text: "Done — your changes are live in the preview. Use Undo to revert.",
      }]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Edit failed";
      setChatError(msg);
      setChatMessages((prev) => [...prev, { role: "assistant", text: `⚠ ${msg}` }]);
      // Re-attach the pending image so the user can retry
      if (pendingImage) setChatImage(pendingImage);
    } finally {
      setChatSending(false);
    }
  }

  async function handleUndo() {
    if (!undoUrl || !canUndo) return;
    setUndoing(true);
    setChatError(null);
    try {
      const res = await fetch(undoUrl, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail ?? "Undo failed");
      }
      const data = await res.json();
      setHtml(data.html || "");
      setCanUndo(false);
      refreshPreview();
      setChatMessages((prev) => [...prev, { role: "assistant", text: "↺ Reverted to previous version." }]);
    } catch (e: unknown) {
      setChatError(e instanceof Error ? e.message : "Undo failed");
    } finally {
      setUndoing(false);
    }
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "preview", label: "Preview" },
    { key: "assets", label: "Assets" },
    ...(chatEditUrl ? [{ key: "chat" as Tab, label: "Chat" }] : []),
    { key: "html", label: "Edit HTML" },
  ];

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      display: "flex", flexDirection: "column",
      background: "#0a0a0f",
      fontFamily: "Inter, sans-serif",
    }}>
      <style>{`@keyframes pm-spin { to { transform: rotate(360deg); } }
@keyframes pm-dots { 0%,80%,100%{opacity:0.2} 40%{opacity:1} }`}</style>

      {/* Top bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "10px 20px",
        background: "rgba(10,10,15,0.98)",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        flexShrink: 0,
      }}>
        {/* Label */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: "#FAFAFA", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {label}
          </div>
          <div style={{ fontSize: 11, color: "#5a5a72", marginTop: 1 }}>
            Review before deploying to Netlify
          </div>
        </div>

        {/* Tab switcher */}
        <div style={{ display: "flex", gap: 3, background: "rgba(255,255,255,0.04)", borderRadius: 7, padding: "3px" }}>
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                background: tab === t.key ? "rgba(124,58,237,0.35)" : "transparent",
                border: tab === t.key ? "1px solid rgba(124,58,237,0.4)" : "1px solid transparent",
                color: tab === t.key ? "#c4b5fd" : "#8A8A8A",
                borderRadius: 5,
                padding: "5px 14px",
                fontSize: 12.5,
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: "Inter, sans-serif",
                transition: "all 0.15s",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab-specific actions */}
        {tab === "preview" && (
          <button
            onClick={refreshPreview}
            style={{
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.1)",
              color: "#8A8A8A",
              borderRadius: 6,
              padding: "7px 14px",
              fontSize: 12.5,
              cursor: "pointer",
              fontFamily: "Inter, sans-serif",
            }}
          >
            ↺ Refresh
          </button>
        )}

        {tab === "chat" && undoUrl && (
          <button
            disabled={!canUndo || undoing || chatSending}
            onClick={handleUndo}
            title={canUndo ? "Revert to the previous version" : "No previous version to restore"}
            style={{
              background: canUndo ? "rgba(250,204,21,0.12)" : "rgba(255,255,255,0.04)",
              border: `1px solid ${canUndo ? "rgba(250,204,21,0.35)" : "rgba(255,255,255,0.08)"}`,
              color: canUndo ? "#facc15" : "#5a5a72",
              borderRadius: 6,
              padding: "7px 14px",
              fontSize: 12.5,
              cursor: canUndo && !undoing && !chatSending ? "pointer" : "not-allowed",
              fontFamily: "Inter, sans-serif",
              whiteSpace: "nowrap",
            }}
          >
            {undoing ? "Undoing…" : "↶ Undo last change"}
          </button>
        )}

        {tab === "html" && (
          <button
            disabled={htmlSaving || htmlLoading}
            onClick={handleSaveHtml}
            style={{
              background: htmlSaved ? "rgba(74,222,128,0.15)" : "rgba(255,255,255,0.06)",
              border: `1px solid ${htmlSaved ? "rgba(74,222,128,0.4)" : "rgba(255,255,255,0.12)"}`,
              color: htmlSaved ? "#4ade80" : "#FAFAFA",
              borderRadius: 6,
              padding: "7px 14px",
              fontSize: 12.5,
              cursor: htmlSaving || htmlLoading ? "not-allowed" : "pointer",
              fontFamily: "Inter, sans-serif",
              whiteSpace: "nowrap",
              opacity: htmlSaving || htmlLoading ? 0.5 : 1,
            }}
          >
            {htmlSaving ? "Saving…" : htmlSaved ? "✓ Saved" : "Save HTML"}
          </button>
        )}

        {/* Deploy button (only if caller provides onDeploy) */}
        {onDeploy && (
          <button
            disabled={deploying}
            onClick={onDeploy}
            style={{
              background: deploying
                ? "rgba(255,255,255,0.06)"
                : "linear-gradient(135deg, #7c3aed, #9333ea)",
              border: "none",
              color: deploying ? "#5a5a72" : "#fff",
              borderRadius: 6,
              padding: "7px 20px",
              fontSize: 13,
              fontWeight: 600,
              cursor: deploying ? "not-allowed" : "pointer",
              fontFamily: "Inter, sans-serif",
              whiteSpace: "nowrap",
            }}
          >
            {deploying ? "Deploying…" : "🚀 Deploy to Netlify"}
          </button>
        )}

        {/* Close */}
        <button
          onClick={onClose}
          style={{
            background: "rgba(248,113,113,0.08)",
            border: "1px solid rgba(248,113,113,0.2)",
            color: "#f87171",
            borderRadius: 6,
            padding: "7px 12px",
            fontSize: 13,
            cursor: "pointer",
            fontFamily: "Inter, sans-serif",
          }}
        >
          ✕ Close
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>

        {/* ── Preview tab ── */}
        {tab === "preview" && (
          <iframe
            ref={iframeRef}
            src={`${previewUrl}${previewUrl.includes("?") ? "&" : "?"}_=${iframeNonce}`}
            style={{ flex: 1, border: "none", background: "#fff" }}
            title={`Preview: ${label}`}
          />
        )}

        {/* ── Assets tab ── */}
        {tab === "assets" && (
          <div style={{ flex: 1, overflow: "auto", padding: "24px" }}>
            {/* Upload controls */}
            {uploadUrl && (
              <div style={{ marginBottom: 20, display: "flex", alignItems: "center", gap: 10 }}>
                <input
                  ref={uploadInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleUploadAsset(f);
                    e.target.value = "";
                  }}
                />
                <button
                  disabled={uploading}
                  onClick={() => uploadInputRef.current?.click()}
                  style={{
                    background: uploading ? "rgba(255,255,255,0.04)" : "rgba(124,58,237,0.15)",
                    border: "1px solid rgba(124,58,237,0.35)",
                    color: uploading ? "#5a5a72" : "#c4b5fd",
                    borderRadius: 6,
                    padding: "7px 16px",
                    fontSize: 12.5,
                    cursor: uploading ? "not-allowed" : "pointer",
                    fontFamily: "Inter, sans-serif",
                  }}
                >
                  {uploading ? "Uploading…" : "↑ Upload Image"}
                </button>
                <span style={{ fontSize: 11.5, color: "#5a5a72" }}>
                  PNG, JPG, GIF, WebP — replaces existing file with same name. Use <code style={{ background: "rgba(255,255,255,0.05)", padding: "1px 5px", borderRadius: 3, color: "#c4b5fd" }}>images/&lt;name&gt;</code> in HTML.
                </span>
              </div>
            )}

            {assetsLoading ? (
              <div style={{ textAlign: "center", color: "#8A8A8A", padding: "60px 0" }}>
                <div style={{
                  width: 24, height: 24, border: "2px solid rgba(255,255,255,0.08)",
                  borderTop: "2px solid #7c3aed", borderRadius: "50%",
                  animation: "pm-spin 0.7s linear infinite", margin: "0 auto 12px",
                }} />
                Loading assets…
              </div>
            ) : assets.length === 0 ? (
              <div style={{ textAlign: "center", color: "#5a5a72", padding: "60px 0", fontSize: 13 }}>
                No images were downloaded for this site.
              </div>
            ) : (
              <>
                <div style={{ fontSize: 12, color: "#5a5a72", marginBottom: 16 }}>
                  {assets.length} image{assets.length !== 1 ? "s" : ""} downloaded
                </div>
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                  gap: 12,
                }}>
                  {assets.map((asset) => (
                    <div
                      key={asset.filename}
                      style={{
                        background: "rgba(255,255,255,0.03)",
                        border: "1px solid rgba(255,255,255,0.08)",
                        borderRadius: 8,
                        overflow: "hidden",
                      }}
                    >
                      <div style={{
                        background: "#111", height: 120,
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>
                        <img
                          src={`${assetBaseUrl}/${asset.filename}`}
                          alt={asset.filename}
                          style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
                        />
                      </div>
                      <div style={{ padding: "8px 10px" }}>
                        <div style={{ fontSize: 11.5, color: "#FAFAFA", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={asset.filename}>
                          {asset.filename}
                        </div>
                        <div style={{ fontSize: 11, color: "#5a5a72", marginTop: 2 }}>
                          {(asset.size / 1024).toFixed(1)} KB
                        </div>
                        <button
                          onClick={() => handleCopyUrl(asset.filename)}
                          style={{
                            marginTop: 6,
                            width: "100%",
                            background: copiedFilename === asset.filename
                              ? "rgba(74,222,128,0.1)"
                              : "rgba(255,255,255,0.05)",
                            border: `1px solid ${copiedFilename === asset.filename ? "rgba(74,222,128,0.3)" : "rgba(255,255,255,0.1)"}`,
                            color: copiedFilename === asset.filename ? "#4ade80" : "#8A8A8A",
                            borderRadius: 5,
                            padding: "4px 0",
                            fontSize: 11,
                            cursor: "pointer",
                            fontFamily: "Inter, sans-serif",
                          }}
                        >
                          {copiedFilename === asset.filename ? "✓ Copied" : "Copy URL"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Chat tab ── */}
        {tab === "chat" && chatEditUrl && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {/* Helper banner */}
            <div style={{
              padding: "10px 20px",
              background: "rgba(124,58,237,0.06)",
              borderBottom: "1px solid rgba(124,58,237,0.15)",
              color: "#c4b5fd",
              fontSize: 12,
              flexShrink: 0,
              lineHeight: 1.5,
            }}>
              Describe the issue and the AI will edit the HTML — touching <strong>only</strong> what you ask. Paste a screenshot (Ctrl+V) to point at a specific spot. Use <strong>Undo</strong> in the top bar to revert the last change.
            </div>

            {chatError && (
              <div style={{
                padding: "8px 20px",
                background: "rgba(248,113,113,0.08)",
                borderBottom: "1px solid rgba(248,113,113,0.15)",
                color: "#f87171",
                fontSize: 12.5,
                flexShrink: 0,
              }}>
                ⚠ {chatError}
              </div>
            )}

            {/* Message list */}
            <div
              ref={chatScrollRef}
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "20px 24px",
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              {chatMessages.length === 0 && !chatSending && (
                <div style={{
                  margin: "auto",
                  textAlign: "center",
                  color: "#5a5a72",
                  fontSize: 13,
                  maxWidth: 420,
                  padding: "40px 20px",
                }}>
                  <div style={{ fontSize: 28, marginBottom: 10 }}>💬</div>
                  <div style={{ color: "#9090a8", fontWeight: 600, marginBottom: 6, fontSize: 14 }}>Tell the AI what to fix</div>
                  <div>e.g. "The hero headline overlaps the logo on mobile" — paste a screenshot if it helps.</div>
                </div>
              )}

              {chatMessages.map((m, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    justifyContent: m.role === "user" ? "flex-end" : "flex-start",
                  }}
                >
                  <div style={{
                    maxWidth: "75%",
                    background: m.role === "user"
                      ? "rgba(124,58,237,0.18)"
                      : "rgba(255,255,255,0.04)",
                    border: `1px solid ${m.role === "user" ? "rgba(124,58,237,0.35)" : "rgba(255,255,255,0.08)"}`,
                    color: m.role === "user" ? "#e9d8fd" : "#c9d1d9",
                    borderRadius: 10,
                    padding: "9px 13px",
                    fontSize: 13,
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}>
                    {m.imageUrl && (
                      <img
                        src={m.imageUrl}
                        alt="attached"
                        style={{
                          maxWidth: "100%",
                          maxHeight: 180,
                          borderRadius: 6,
                          marginBottom: m.text ? 8 : 0,
                          display: "block",
                        }}
                      />
                    )}
                    {m.text}
                  </div>
                </div>
              ))}

              {chatSending && (
                <div style={{ display: "flex", justifyContent: "flex-start" }}>
                  <div style={{
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 10,
                    padding: "10px 14px",
                    fontSize: 13,
                    color: "#8A8A8A",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}>
                    Editing HTML
                    <span style={{ display: "inline-flex", gap: 3 }}>
                      <span style={{ animation: "pm-dots 1.4s infinite", animationDelay: "0s" }}>•</span>
                      <span style={{ animation: "pm-dots 1.4s infinite", animationDelay: "0.2s" }}>•</span>
                      <span style={{ animation: "pm-dots 1.4s infinite", animationDelay: "0.4s" }}>•</span>
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Composer */}
            <div style={{
              padding: "12px 16px 14px",
              background: "rgba(10,10,15,0.95)",
              borderTop: "1px solid rgba(255,255,255,0.08)",
              flexShrink: 0,
            }}>
              {chatImage && (
                <div style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 8,
                  padding: "6px 10px 6px 6px",
                  marginBottom: 10,
                }}>
                  <img src={chatImage.url} alt="preview" style={{ width: 38, height: 38, objectFit: "cover", borderRadius: 4 }} />
                  <span style={{ fontSize: 11.5, color: "#c9d1d9", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {chatImage.file.name}
                  </span>
                  <button
                    onClick={() => {
                      if (chatImage) URL.revokeObjectURL(chatImage.url);
                      setChatImage(null);
                    }}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "#8A8A8A",
                      cursor: "pointer",
                      fontSize: 14,
                      padding: 2,
                    }}
                    title="Remove image"
                  >
                    ✕
                  </button>
                </div>
              )}

              <div style={{
                display: "flex",
                gap: 8,
                alignItems: "flex-end",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 10,
                padding: 8,
              }}>
                <input
                  ref={chatImageInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handlePickChatImage(f);
                    e.target.value = "";
                  }}
                />
                <button
                  onClick={() => chatImageInputRef.current?.click()}
                  disabled={chatSending}
                  title="Attach a screenshot"
                  style={{
                    background: "transparent",
                    border: "1px solid rgba(255,255,255,0.12)",
                    color: "#8A8A8A",
                    borderRadius: 6,
                    padding: "6px 10px",
                    fontSize: 14,
                    cursor: chatSending ? "not-allowed" : "pointer",
                    flexShrink: 0,
                    height: 34,
                  }}
                >
                  📎
                </button>
                <textarea
                  ref={chatTextareaRef}
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onPaste={handleChatPaste}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSendChat();
                    }
                  }}
                  placeholder={htmlLoading ? "Loading HTML…" : "Describe the issue — paste a screenshot with Ctrl+V"}
                  disabled={chatSending || htmlLoading}
                  rows={2}
                  style={{
                    flex: 1,
                    background: "transparent",
                    border: "none",
                    outline: "none",
                    color: "#f0f0f8",
                    fontSize: 13,
                    fontFamily: "Inter, sans-serif",
                    resize: "none",
                    lineHeight: 1.5,
                    padding: "6px 4px",
                    maxHeight: 140,
                  }}
                />
                <button
                  onClick={handleSendChat}
                  disabled={chatSending || htmlLoading || !chatInput.trim()}
                  style={{
                    background: !chatInput.trim() || chatSending || htmlLoading
                      ? "rgba(255,255,255,0.06)"
                      : "linear-gradient(135deg, #7c3aed, #9333ea)",
                    border: "none",
                    color: !chatInput.trim() || chatSending || htmlLoading ? "#5a5a72" : "#fff",
                    borderRadius: 6,
                    padding: "0 14px",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: chatSending || htmlLoading || !chatInput.trim() ? "not-allowed" : "pointer",
                    fontFamily: "Inter, sans-serif",
                    flexShrink: 0,
                    height: 34,
                  }}
                >
                  {chatSending ? "…" : "Send"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Edit HTML tab ── */}
        {tab === "html" && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {htmlError && (
              <div style={{
                padding: "8px 16px", flexShrink: 0,
                background: "rgba(248,113,113,0.08)",
                borderBottom: "1px solid rgba(248,113,113,0.15)",
                color: "#f87171", fontSize: 12.5,
              }}>
                {htmlError}
              </div>
            )}
            {htmlLoading ? (
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#8A8A8A", fontSize: 13 }}>
                Loading HTML…
              </div>
            ) : (
              <textarea
                value={html}
                onChange={(e) => setHtml(e.target.value)}
                spellCheck={false}
                style={{
                  flex: 1,
                  background: "#0d0d14",
                  color: "#c9d1d9",
                  border: "none",
                  outline: "none",
                  padding: "16px 20px",
                  fontFamily: "'Fira Code', 'Consolas', 'Courier New', monospace",
                  fontSize: 12.5,
                  lineHeight: 1.6,
                  resize: "none",
                  tabSize: 2,
                }}
              />
            )}
          </div>
        )}

      </div>
    </div>
  );
}
