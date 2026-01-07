"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

type Role = "user" | "assistant";
type Message = { id: string; role: Role; text: string };

function uid() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

const ASSISTANT_NAME = "MVVC Analyst";
const TEAM_NAME = "MVVC 14 Black";
const LOGO_SRC = "/mvvc-logo.png"; // put logo in /public

export default function Page() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: uid(),
      role: "assistant",
      text:
        `Hi — I’m **${ASSISTANT_NAME}** for **${TEAM_NAME}**.\n\n` +
        `Try:\n` +
        `• **team roster**\n` +
        `• **show every game result**\n` +
        `• **best setter / hitter / passer / blocker**\n` +
        `• **5–1 and 6–2 lineup (best chance to win)**`,
    },
  ]);

  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);

  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const canSend = useMemo(() => input.trim().length > 0 && !isSending, [input, isSending]);

  async function sendMessage() {
    const question = input.trim();
    if (!question || isSending) return;

    setMessages((prev) => [...prev, { id: uid(), role: "user", text: question }]);
    setInput("");
    setIsSending(true);

    const thinkingId = uid();
    setMessages((prev) => [...prev, { id: thinkingId, role: "assistant", text: "_Thinking…_" }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : `Request failed (${res.status})`);

      const answer = typeof data?.answer === "string" && data.answer.trim() ? data.answer.trim() : "No answer generated.";
      setMessages((prev) => prev.map((m) => (m.id === thinkingId ? { ...m, text: answer } : m)));
    } catch (e: any) {
      const msg = typeof e?.message === "string" ? e.message : "Unknown error.";
      setMessages((prev) =>
        prev.map((m) => (m.id === thinkingId ? { ...m, text: `**Error:** ${msg}` } : m))
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

  function clearChat() {
    setMessages([
      {
        id: uid(),
        role: "assistant",
        text: `New chat started. Try **team roster** or **show every game result**.`,
      },
    ]);
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f6f7fb",
        color: "#0f172a",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 20,
          background: "rgba(255,255,255,0.92)",
          backdropFilter: "blur(10px)",
          borderBottom: "1px solid rgba(15,23,42,0.08)",
        }}
      >
        <div
          style={{
            maxWidth: 1040,
            margin: "0 auto",
            padding: "14px 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
            <div
              style={{
                width: 42,
                height: 42,
                borderRadius: 12,
                background: "#fff",
                border: "1px solid rgba(15,23,42,0.10)",
                overflow: "hidden",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <img src={LOGO_SRC} alt="MVVC" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
            </div>

            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 900, letterSpacing: 0.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {ASSISTANT_NAME}
              </div>
              <div style={{ fontSize: 12, color: "rgba(15,23,42,0.65)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {TEAM_NAME}
              </div>
            </div>
          </div>

          <button
            onClick={clearChat}
            style={{
              border: "1px solid rgba(15,23,42,0.14)",
              background: "#fff",
              color: "#0f172a",
              padding: "10px 12px",
              borderRadius: 12,
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 800,
              boxShadow: "0 6px 16px rgba(15,23,42,0.06)",
            }}
          >
            New chat
          </button>
        </div>
      </header>

      <section style={{ flex: 1, width: "100%" }}>
        <div style={{ maxWidth: 1040, margin: "0 auto", padding: "18px 16px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {messages.map((m) => {
              const isUser = m.role === "user";
              return (
                <div key={m.id} style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start" }}>
                  <div
                    style={{
                      width: "fit-content",
                      maxWidth: "96%",
                      borderRadius: 18,
                      padding: "14px 16px",
                      background: isUser ? "#0f172a" : "#ffffff",
                      color: isUser ? "#ffffff" : "#0f172a",
                      border: isUser ? "1px solid rgba(15,23,42,0.0)" : "1px solid rgba(15,23,42,0.10)",
                      boxShadow: "0 10px 26px rgba(15,23,42,0.08)",
                      lineHeight: 1.5,
                      fontSize: 14,
                    }}
                  >
                    {!isUser && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                        <div
                          style={{
                            width: 22,
                            height: 22,
                            borderRadius: 8,
                            overflow: "hidden",
                            border: "1px solid rgba(15,23,42,0.10)",
                            background: "rgba(15,23,42,0.03)",
                            flexShrink: 0,
                          }}
                        >
                          <img src={LOGO_SRC} alt="MVVC" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                        </div>
                        <div style={{ fontSize: 12, fontWeight: 900, color: "rgba(15,23,42,0.70)" }}>{ASSISTANT_NAME}</div>
                      </div>
                    )}

                    <ReactMarkdown
                      components={{
                        h2: ({ children }) => (
                          <h2 style={{ fontSize: 16, fontWeight: 950, margin: "12px 0 8px 0" }}>{children}</h2>
                        ),
                        h3: ({ children }) => (
                          <h3 style={{ fontSize: 14, fontWeight: 950, margin: "12px 0 6px 0" }}>{children}</h3>
                        ),
                        p: ({ children }) => <p style={{ margin: "0 0 10px 0" }}>{children}</p>,
                        ul: ({ children }) => <ul style={{ margin: "8px 0 10px 18px" }}>{children}</ul>,
                        ol: ({ children }) => <ol style={{ margin: "8px 0 10px 18px" }}>{children}</ol>,
                        li: ({ children }) => <li style={{ marginBottom: 6 }}>{children}</li>,
                        strong: ({ children }) => <strong style={{ fontWeight: 950 }}>{children}</strong>,
                        table: ({ children }) => (
                          <div style={{ overflowX: "auto", margin: "10px 0 12px 0" }}>
                            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
                              {children}
                            </table>
                          </div>
                        ),
                        thead: ({ children }) => <thead>{children}</thead>,
                        th: ({ children }) => (
                          <th
                            style={{
                              textAlign: "left",
                              padding: "10px 10px",
                              background: "rgba(15,23,42,0.04)",
                              borderTop: "1px solid rgba(15,23,42,0.10)",
                              borderBottom: "1px solid rgba(15,23,42,0.10)",
                              fontWeight: 950,
                              whiteSpace: "nowrap",
                            }}
                          >
                            {children}
                          </th>
                        ),
                        td: ({ children }) => (
                          <td
                            style={{
                              padding: "10px 10px",
                              borderBottom: "1px solid rgba(15,23,42,0.08)",
                              verticalAlign: "top",
                            }}
                          >
                            {children}
                          </td>
                        ),
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
              );
            })}
            <div ref={bottomRef} />
          </div>
        </div>
      </section>

      <footer
        style={{
          position: "sticky",
          bottom: 0,
          background: "rgba(246,247,251,0.92)",
          backdropFilter: "blur(10px)",
          borderTop: "1px solid rgba(15,23,42,0.08)",
        }}
      >
        <div style={{ maxWidth: 1040, margin: "0 auto", padding: "12px 16px", display: "flex", gap: 10, alignItems: "flex-end" }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask a question… (Enter to send, Shift+Enter for new line)"
            rows={2}
            style={{
              flex: 1,
              resize: "none",
              padding: "12px 12px",
              borderRadius: 14,
              border: "1px solid rgba(15,23,42,0.14)",
              background: "#fff",
              color: "#0f172a",
              fontSize: 14,
              outline: "none",
              lineHeight: 1.3,
              boxShadow: "0 10px 26px rgba(15,23,42,0.06)",
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
              fontWeight: 950,
              minWidth: 92,
              boxShadow: canSend ? "0 14px 30px rgba(37,99,235,0.25)" : "none",
            }}
          >
            {isSending ? "Sending…" : "Send"}
          </button>
        </div>
      </footer>
    </main>
  );
}
