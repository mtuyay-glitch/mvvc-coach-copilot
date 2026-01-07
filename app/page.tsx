"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

type Role = "user" | "assistant";

type Message = {
  id: string;
  role: Role;
  text: string;
};

function uid() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

const ASSISTANT_LABEL = "Volleyball Guru";
const APP_TITLE = "MVVC Coach Copilot";

// Put your MVVC logo file here:
// /public/mvvc-logo.png
const LOGO_SRC = "/mvvc-logo.png";

export default function Page() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: uid(),
      role: "assistant",
      text:
        `Hi — I’m **${ASSISTANT_LABEL}** for **MVVC 14 Black**.\n\n` +
        `Ask me about:\n` +
        `• stats + leaders (top 5)\n` +
        `• month-over-month trends (e.g., “Top 5 passers each month”)\n` +
        `• projected lineups (including 6–2)\n` +
        `• strengths/weaknesses + development plans\n` +
        `• tactics vs specific opponents`,
    },
  ]);

  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const THREAD_STORAGE_KEY = "mvvc_thread_id";

  useEffect(() => {
    try {
      const saved = localStorage.getItem(THREAD_STORAGE_KEY);
      if (saved) setThreadId(saved);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const canSend = useMemo(() => input.trim().length > 0 && !isSending, [input, isSending]);

  async function sendMessage() {
    const question = input.trim();
    if (!question || isSending) return;

    const userMsg: Message = { id: uid(), role: "user", text: question };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsSending(true);

    const thinkingId = uid();
    setMessages((prev) => [...prev, { id: thinkingId, role: "assistant", text: "Thinking…" }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, thread_id: threadId }),
      });

      const data = await res.json();

      if (!res.ok) {
        const errText = typeof data?.error === "string" ? data.error : `Request failed (${res.status})`;
        throw new Error(errText);
      }

      if (data?.thread_id && typeof data.thread_id === "string") {
        const newThreadId = data.thread_id;
        if (newThreadId !== threadId) {
          setThreadId(newThreadId);
          try {
            localStorage.setItem(THREAD_STORAGE_KEY, newThreadId);
          } catch {
            // ignore
          }
        }
      }

      const answer = typeof data?.answer === "string" && data.answer.trim() ? data.answer.trim() : "No answer generated.";

      setMessages((prev) => prev.map((m) => (m.id === thinkingId ? { ...m, text: answer } : m)));
    } catch (e: any) {
      const msg = typeof e?.message === "string" ? e.message : "Something went wrong calling /api/chat.";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === thinkingId
            ? {
                ...m,
                text:
                  `Sorry — I hit an error.\n\n` +
                  `**Details:** ${msg}\n\n` +
                  `Tip: check Vercel Function Logs and confirm env vars are set.`,
              }
            : m
        )
      );
    } finally {
      setIsSending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function clearThread() {
    setMessages([
      {
        id: uid(),
        role: "assistant",
        text: `New conversation started.\n\nAsk me anything about **MVVC 14 Black**.`,
      },
    ]);
    setThreadId(null);
    try {
      localStorage.removeItem(THREAD_STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  return (
    <main style={styles.page}>
      {/* Global styles (kept inline so you can drop this file in immediately) */}
      <style>{globalCss}</style>

      {/* Top bar */}
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div style={styles.brand}>
            <div style={styles.logoWrap} aria-hidden>
              <img
                src={LOGO_SRC}
                alt="MVVC"
                style={styles.logo}
                onError={(e) => {
                  // If logo missing, hide image but keep layout stable
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
            </div>

            <div style={styles.brandText}>
              <div style={styles.titleRow}>
                <div style={styles.appTitle}>{APP_TITLE}</div>
                <span style={styles.badge}>MVVC 14 Black</span>
              </div>
              <div style={styles.subTitle}>
                <span style={styles.subtle}>{ASSISTANT_LABEL}</span>
                <span style={styles.dot}>•</span>
                <span style={styles.subtle}>{threadId ? `Thread ${threadId.slice(0, 8)}…` : "New thread"}</span>
              </div>
            </div>
          </div>

          <div style={styles.headerActions}>
            <button onClick={clearThread} style={styles.secondaryButton} title="Start a new conversation">
              New chat
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      <section style={styles.content}>
        <div style={styles.chatCard}>
          <div style={styles.messages}>
            {messages.map((m) => {
              const isUser = m.role === "user";
              return (
                <div key={m.id} style={{ ...styles.row, justifyContent: isUser ? "flex-end" : "flex-start" }}>
                  <div style={{ ...styles.bubble, ...(isUser ? styles.userBubble : styles.assistantBubble) }}>
                    {!isUser && <div style={styles.bubbleLabel}>{ASSISTANT_LABEL}</div>}
                    <div style={styles.markdown}>
                      <ReactMarkdown>{m.text}</ReactMarkdown>
                    </div>
                  </div>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>

          {/* Composer */}
          <div style={styles.composerWrap}>
            <div style={styles.composer}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Ask a question… (Enter to send, Shift+Enter for a new line)"
                rows={2}
                style={styles.textarea}
              />
              <button onClick={sendMessage} disabled={!canSend} style={{ ...styles.primaryButton, ...(canSend ? {} : styles.primaryDisabled) }}>
                {isSending ? "Sending…" : "Send"}
              </button>
            </div>

            <div style={styles.hintRow}>
              <div style={styles.hintPill}>Try: “Top 5 passers each month”</div>
              <div style={styles.hintPill}>Try: “Strengths & weaknesses this year”</div>
              <div style={styles.hintPill}>Try: “Projected 6–2 lineup”</div>
            </div>
          </div>
        </div>

        <footer style={styles.footer}>
          <span style={styles.footerText}>
            Data is pulled from your Supabase stats + matches; coaching guidance uses general volleyball knowledge.
          </span>
        </footer>
      </section>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(180deg, #F7F8FB 0%, #FFFFFF 45%, #F7F8FB 100%)",
    color: "#0B1220",
  },

  header: {
    position: "sticky",
    top: 0,
    zIndex: 50,
    backdropFilter: "blur(10px)",
    background: "rgba(255,255,255,0.75)",
    borderBottom: "1px solid rgba(15,23,42,0.08)",
  },
  headerInner: {
    maxWidth: 980,
    margin: "0 auto",
    padding: "14px 14px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    minWidth: 0,
  },
  logoWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    background: "#FFFFFF",
    border: "1px solid rgba(15,23,42,0.08)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    boxShadow: "0 6px 22px rgba(15,23,42,0.08)",
    flex: "0 0 auto",
  },
  logo: {
    width: 34,
    height: 34,
    objectFit: "contain",
  },
  brandText: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  titleRow: { display: "flex", alignItems: "center", gap: 8, minWidth: 0, flexWrap: "wrap" as any },
  appTitle: { fontSize: 14, fontWeight: 800, letterSpacing: 0.2 },
  badge: {
    fontSize: 12,
    fontWeight: 700,
    padding: "4px 8px",
    borderRadius: 999,
    background: "rgba(37, 99, 235, 0.10)",
    color: "#1D4ED8",
    border: "1px solid rgba(37, 99, 235, 0.18)",
    whiteSpace: "nowrap",
  },
  subTitle: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#475569", minWidth: 0 },
  subtle: { whiteSpace: "nowrap" },
  dot: { opacity: 0.5 },

  headerActions: { display: "flex", alignItems: "center", gap: 10 },
  secondaryButton: {
    border: "1px solid rgba(15,23,42,0.12)",
    background: "#FFFFFF",
    color: "#0B1220",
    padding: "10px 12px",
    borderRadius: 12,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 700,
    boxShadow: "0 6px 18px rgba(15,23,42,0.06)",
  },

  content: {
    maxWidth: 980,
    margin: "0 auto",
    padding: "18px 14px 28px",
  },

  chatCard: {
    borderRadius: 18,
    border: "1px solid rgba(15,23,42,0.10)",
    background: "#FFFFFF",
    boxShadow: "0 14px 42px rgba(15,23,42,0.08)",
    overflow: "hidden",
  },

  messages: {
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 12,
    maxHeight: "calc(100vh - 250px)",
    overflowY: "auto",
  },

  row: { display: "flex" },

  bubble: {
    maxWidth: "92%",
    width: "fit-content",
    padding: "12px 12px",
    borderRadius: 16,
    border: "1px solid rgba(15,23,42,0.10)",
    boxShadow: "0 10px 22px rgba(15,23,42,0.06)",
  },
  assistantBubble: {
    background: "#F8FAFC",
  },
  userBubble: {
    background: "rgba(37, 99, 235, 0.10)",
    border: "1px solid rgba(37, 99, 235, 0.20)",
  },
  bubbleLabel: {
    fontSize: 12,
    fontWeight: 800,
    color: "#334155",
    marginBottom: 6,
  },

  markdown: {
    fontSize: 14,
    lineHeight: 1.45,
    color: "#0B1220",
  },

  composerWrap: {
    borderTop: "1px solid rgba(15,23,42,0.08)",
    padding: 14,
    background: "linear-gradient(180deg, rgba(248,250,252,0.9), rgba(255,255,255,1))",
  },
  composer: {
    display: "flex",
    gap: 10,
    alignItems: "flex-end",
  },
  textarea: {
    flex: 1,
    resize: "none",
    padding: "12px 12px",
    borderRadius: 14,
    border: "1px solid rgba(15,23,42,0.14)",
    background: "#FFFFFF",
    color: "#0B1220",
    fontSize: 14,
    outline: "none",
    lineHeight: 1.35,
    boxShadow: "0 10px 22px rgba(15,23,42,0.06)",
  },
  primaryButton: {
    padding: "12px 14px",
    borderRadius: 14,
    border: "1px solid rgba(37, 99, 235, 0.35)",
    background: "#2563EB",
    color: "#FFFFFF",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 800,
    minWidth: 86,
    boxShadow: "0 12px 28px rgba(37, 99, 235, 0.22)",
  },
  primaryDisabled: {
    opacity: 0.55,
    cursor: "not-allowed",
    boxShadow: "none",
  },

  hintRow: {
    marginTop: 10,
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
  },
  hintPill: {
    fontSize: 12,
    color: "#334155",
    background: "rgba(15, 23, 42, 0.04)",
    border: "1px solid rgba(15, 23, 42, 0.08)",
    padding: "6px 10px",
    borderRadius: 999,
    whiteSpace: "nowrap",
  },

  footer: {
    marginTop: 12,
    display: "flex",
    justifyContent: "center",
  },
  footerText: {
    fontSize: 12,
    color: "#64748B",
    textAlign: "center",
    padding: "8px 10px",
  },
};

const globalCss = `
  /* Make it feel “app-like” on mobile */
  html, body { padding: 0; margin: 0; }
  * { box-sizing: border-box; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"; }

  /* Nice markdown defaults */
  .markdown :where(p) { margin: 0.35rem 0; }
  .markdown :where(ul) { margin: 0.35rem 0; padding-left: 1.1rem; }
  .markdown :where(li) { margin: 0.2rem 0; }
  .markdown :where(h1,h2,h3) { margin: 0.6rem 0 0.2rem; line-height: 1.2; }
  .markdown :where(code) { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 0.92em; }
  .markdown :where(pre) { overflow: auto; padding: 12px; border-radius: 12px; background: rgba(15,23,42,0.06); border: 1px solid rgba(15,23,42,0.08); }

  /* Scrollbar (subtle) */
  ::-webkit-scrollbar { width: 10px; }
  ::-webkit-scrollbar-thumb { background: rgba(15,23,42,0.16); border-radius: 999px; border: 3px solid rgba(255,255,255,0.7); }
  ::-webkit-scrollbar-track { background: transparent; }

  /* Mobile tweaks */
  @media (max-width: 640px) {
    /* Make the chat area taller on phones */
    .messages { max-height: calc(100vh - 220px) !important; }
  }
`;
