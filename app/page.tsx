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

const ASSISTANT_NAME = "MVVC Analyst";
const TEAM_NAME = "MVVC 14 Black";

// Put this file in /public
const LOGO_SRC = "/mvvc-logo.png";

export default function Page() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: uid(),
      role: "assistant",
      text:
        `Hi — I’m **${ASSISTANT_NAME}** for **${TEAM_NAME}**.\n\n` +
        `Ask me things like:\n` +
        `• Show every game result and who we played\n` +
        `• Team record / last opponent\n` +
        `• Leaders (top 5) — kills, assists, aces, digs, blocks, errors\n` +
        `• Best setter / hitter / passer / blocker\n` +
        `• 5–1 vs 6–2 lineup options (best chance to win)\n` +
        `• What we could have changed in losses vs a specific opponent\n` +
        `• Month-over-month trends for any stat`,
    },
  ]);

  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);

  // optional client-side “thread” id (not persisted on server yet)
  const [threadId, setThreadId] = useState<string | null>(null);
  const THREAD_STORAGE_KEY = "mvvc_thread_id_v1";

  const bottomRef = useRef<HTMLDivElement | null>(null);

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
    setMessages((prev) => [...prev, { id: thinkingId, role: "assistant", text: "_Thinking…_" }]);

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
        const newThread = data.thread_id;
        if (newThread !== threadId) {
          setThreadId(newThread);
          try {
            localStorage.setItem(THREAD_STORAGE_KEY, newThread);
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
                  `If this keeps happening on Vercel, check Function Logs for timeouts and confirm env vars are set.`,
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
        text:
          `New chat started.\n\n` +
          `Ask me anything about **${TEAM_NAME}** — stats, lineups (5–1/6–2), trends, opponents, development.`,
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
    <main
      style={{
        minHeight: "100vh",
        background: "linear-gradient(180deg, #f7fafc 0%, #ffffff 70%)",
        color: "#0f172a",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 20,
          background: "rgba(255,255,255,0.9)",
          backdropFilter: "blur(10px)",
          borderBottom: "1px solid rgba(15,23,42,0.08)",
        }}
      >
        <div
          style={{
            maxWidth: 980,
            margin: "0 auto",
            padding: "14px 16px",
            display: "flex",
            alignItems: "center",
            gap: 14,
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 12,
                background: "rgba(15,23,42,0.04)",
                border: "1px solid rgba(15,23,42,0.08)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                overflow: "hidden",
                flexShrink: 0,
              }}
              title="MVVC"
            >
              {/* If logo missing, it’ll show alt text */}
              <img src={LOGO_SRC} alt="MVVC" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
            </div>

            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: 0.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {ASSISTANT_NAME}
              </div>
              <div style={{ fontSize: 12, color: "rgba(15,23,42,0.7)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {TEAM_NAME}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              onClick={clearThread}
              style={{
                border: "1px solid rgba(15,23,42,0.14)",
                background: "white",
                color: "#0f172a",
                padding: "9px 12px",
                borderRadius: 12,
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 700,
              }}
              title="Start a new chat"
            >
              New chat
            </button>
          </div>
        </div>
      </header>

      {/* Body */}
      <section
        style={{
          flex: 1,
          width: "100%",
          maxWidth: 980,
          margin: "0 auto",
          padding: "16px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {messages.map((m) => {
            const isUser = m.role === "user";

            return (
              <div key={m.id} style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start" }}>
                <div
                  style={{
                    width: "fit-content",
                    maxWidth: "94%",
                    borderRadius: 16,
                    padding: "12px 14px",
                    background: isUser ? "#0f172a" : "white",
                    color: isUser ? "white" : "#0f172a",
                    border: isUser ? "1px solid rgba(15,23,42,0.0)" : "1px solid rgba(15,23,42,0.10)",
                    boxShadow: isUser ? "0 6px 18px rgba(15,23,42,0.12)" : "0 6px 18px rgba(15,23,42,0.06)",
                    lineHeight: 1.35,
                    fontSize: 14,
                  }}
                >
                  {!isUser && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <div
                        style={{
                          width: 20,
                          height: 20,
                          borderRadius: 6,
                          overflow: "hidden",
                          border: "1px solid rgba(15,23,42,0.10)",
                          background: "rgba(15,23,42,0.03)",
                          flexShrink: 0,
                        }}
                      >
                        <img src={LOGO_SRC} alt="MVVC" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                      </div>
                      <div style={{ fontSize: 12, fontWeight: 800, color: "rgba(15,23,42,0.7)" }}>{ASSISTANT_NAME}</div>
                    </div>
                  )}

                  {/* Markdown render */}
                  <div style={{ whiteSpace: "normal" }}>
                    <ReactMarkdown
                      components={{
                        p: ({ children }) => <p style={{ margin: "0 0 10px 0" }}>{children}</p>,
                        li: ({ children }) => <li style={{ marginBottom: 6 }}>{children}</li>,
                        ul: ({ children }) => <ul style={{ margin: "8px 0 8px 18px" }}>{children}</ul>,
                        ol: ({ children }) => <ol style={{ margin: "8px 0 8px 18px" }}>{children}</ol>,
                        strong: ({ children }) => <strong style={{ fontWeight: 900 }}>{children}</strong>,
                        code: ({ children }) => (
                          <code
                            style={{
                              background: "rgba(15,23,42,0.06)",
                              border: "1px solid rgba(15,23,42,0.10)",
                              borderRadius: 8,
                              padding: "2px 6px",
                              fontSize: 13,
                            }}
                          >
                            {children}
                          </code>
                        ),
                      }}
                    >
                      {m.text}
                    </ReactMarkdown>
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      </section>

      {/* Composer */}
      <footer
        style={{
          position: "sticky",
          bottom: 0,
          background: "rgba(247,250,252,0.92)",
          backdropFilter: "blur(10px)",
          borderTop: "1px solid rgba(15,23,42,0.08)",
        }}
      >
        <div
          style={{
            maxWidth: 980,
            margin: "0 auto",
            padding: "12px 16px",
            display: "flex",
            gap: 10,
            alignItems: "flex-end",
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask a question… (Enter to send, Shift+Enter for a new line)"
            rows={2}
            style={{
              flex: 1,
              resize: "none",
              padding: "12px 12px",
              borderRadius: 14,
              border: "1px solid rgba(15,23,42,0.14)",
              background: "white",
              color: "#0f172a",
              fontSize: 14,
              outline: "none",
              lineHeight: 1.3,
              boxShadow: "0 6px 18px rgba(15,23,42,0.06)",
            }}
          />

          <button
            onClick={sendMessage}
            disabled={!canSend}
            style={{
              padding: "12px 14px",
              borderRadius: 14,
              border: "1px solid rgba(15,23,42,0.14)",
              background: canSend ? "#2563eb" : "rgba(37,99,235,0.45)",
              color: "white",
              cursor: canSend ? "pointer" : "not-allowed",
              fontSize: 14,
              fontWeight: 900,
              minWidth: 92,
              boxShadow: canSend ? "0 10px 24px rgba(37,99,235,0.25)" : "none",
            }}
          >
            {isSending ? "Sending…" : "Send"}
          </button>
        </div>

        <div
          style={{
            maxWidth: 980,
            margin: "0 auto",
            padding: "0 16px 10px 16px",
            fontSize: 12,
            color: "rgba(15,23,42,0.6)",
          }}
        >
          Tip: Try “show every game result and who they played”, “top 5 passers each month”, “record vs Bay to Bay 13-1”, or “best chance to win 5–1 vs 6–2 lineup”.
        </div>
      </footer>
    </main>
  );
}
