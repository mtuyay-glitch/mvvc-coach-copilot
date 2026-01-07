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

// ✅ Put your logo here: /public/mvvc-logo.png
const LOGO_SRC = "/mvvc-logo.png";
const ASSISTANT_NAME = "MVVC Analyst";

export default function Page() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: uid(),
      role: "assistant",
      text:
        `Hi — I’m **${ASSISTANT_NAME}** for **MVVC 14 Black**.\n\n` +
        `Ask me about:\n` +
        `• Record, last opponent, record vs opponent\n` +
        `• Leaders (top 5) and “best” by role\n` +
        `• Lineups (5–1 vs 6–2) for best chance to win\n` +
        `• What we could change in losses (overall or vs a specific opponent)\n` +
        `• Month-over-month trends`,
    },
  ]);

  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);

  const bottomRef = useRef<HTMLDivElement | null>(null);

  const canSend = useMemo(() => input.trim().length > 0 && !isSending, [input, isSending]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

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
        body: JSON.stringify({ question }),
      });

      const data = await res.json();

      if (!res.ok) {
        const errText = typeof data?.error === "string" ? data.error : `Request failed (${res.status})`;
        throw new Error(errText);
      }

      const answer =
        typeof data?.answer === "string" && data.answer.trim()
          ? data.answer.trim()
          : "Sorry — I couldn’t generate a response.";

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
                  `Check Vercel Function Logs and confirm env vars (OPENAI_API_KEY / Supabase keys).`,
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

  function clearChat() {
    setMessages([
      {
        id: uid(),
        role: "assistant",
        text:
          `New conversation started.\n\n` +
          `Ask me about leaders, lineups (5–1 vs 6–2), record vs opponent, or what to change in losses.`,
      },
    ]);
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "linear-gradient(180deg, #f7f9ff 0%, #f3f6fb 60%, #eef2f7 100%)",
        color: "#0f172a",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Top bar */}
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 20,
          backdropFilter: "blur(10px)",
          background: "rgba(247, 249, 255, 0.75)",
          borderBottom: "1px solid rgba(15, 23, 42, 0.08)",
        }}
      >
        <div
          style={{
            maxWidth: 980,
            margin: "0 auto",
            padding: "14px 14px",
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
                background: "white",
                border: "1px solid rgba(15, 23, 42, 0.10)",
                boxShadow: "0 6px 18px rgba(15, 23, 42, 0.08)",
                display: "grid",
                placeItems: "center",
                overflow: "hidden",
                flex: "0 0 auto",
              }}
              title="MVVC"
            >
              {/* If the image is missing, you’ll see nothing here; add public/mvvc-logo.png */}
              <img
                src={LOGO_SRC}
                alt="MVVC logo"
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            </div>

            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: 0.2, lineHeight: 1.1 }}>
                MVVC Coach Copilot
              </div>
              <div
                style={{
                  fontSize: 12,
                  opacity: 0.85,
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <span style={{ fontWeight: 700 }}>{ASSISTANT_NAME}</span>
                <span style={{ opacity: 0.6 }}>•</span>
                <span>MVVC 14 Black</span>
              </div>
            </div>
          </div>

          <button
            onClick={clearChat}
            style={{
              border: "1px solid rgba(15, 23, 42, 0.12)",
              background: "white",
              color: "#0f172a",
              padding: "10px 12px",
              borderRadius: 12,
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 700,
              boxShadow: "0 8px 22px rgba(15, 23, 42, 0.08)",
              whiteSpace: "nowrap",
            }}
            title="Start a new conversation"
          >
            New chat
          </button>
        </div>
      </header>

      {/* Chat area */}
      <section
        style={{
          flex: 1,
          width: "100%",
          maxWidth: 980,
          margin: "0 auto",
          padding: "18px 14px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {messages.map((m) => {
            const isUser = m.role === "user";

            return (
              <div key={m.id} style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start" }}>
                <div
                  style={{
                    maxWidth: 820,
                    width: "fit-content",
                    borderRadius: 18,
                    padding: "12px 14px",
                    border: isUser ? "1px solid rgba(37, 99, 235, 0.18)" : "1px solid rgba(15, 23, 42, 0.10)",
                    background: isUser ? "rgba(37, 99, 235, 0.10)" : "rgba(255, 255, 255, 0.95)",
                    boxShadow: isUser
                      ? "0 10px 28px rgba(37, 99, 235, 0.10)"
                      : "0 10px 28px rgba(15, 23, 42, 0.08)",
                    overflow: "hidden",
                  }}
                >
                  {!isUser && (
                    <div style={{ fontSize: 12, fontWeight: 800, opacity: 0.72, marginBottom: 6 }}>
                      {ASSISTANT_NAME}
                    </div>
                  )}

                  <div style={{ fontSize: 14, lineHeight: 1.5, color: "#0f172a" }}>
                    {isUser ? (
                      <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
                    ) : (
                      <ReactMarkdown>{m.text}</ReactMarkdown>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {/* Quick chips */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            marginTop: 4,
          }}
        >
          {[
            "team record",
            "leaders (top 5)",
            "best passer",
            "recommended 5-1 lineup",
            "recommended 6-2 lineup",
            "what could we change in our losses",
          ].map((chip) => (
            <button
              key={chip}
              onClick={() => setInput(chip)}
              style={{
                border: "1px solid rgba(15, 23, 42, 0.10)",
                background: "rgba(255,255,255,0.9)",
                padding: "8px 10px",
                borderRadius: 999,
                fontSize: 13,
                cursor: "pointer",
                boxShadow: "0 10px 22px rgba(15,23,42,0.06)",
              }}
              title="Insert"
            >
              {chip}
            </button>
          ))}
        </div>
      </section>

      {/* Composer */}
      <footer
        style={{
          borderTop: "1px solid rgba(15, 23, 42, 0.08)",
          background: "rgba(247, 249, 255, 0.85)",
          backdropFilter: "blur(10px)",
        }}
      >
        <div
          style={{
            maxWidth: 980,
            margin: "0 auto",
            padding: "12px 14px 16px",
            display: "flex",
            gap: 10,
            alignItems: "flex-end",
          }}
        >
          <div style={{ flex: 1 }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask about record, leaders, 5–1 vs 6–2 lineups, or what to change in losses…"
              rows={2}
              style={{
                width: "100%",
                resize: "none",
                padding: "12px 12px",
                borderRadius: 14,
                border: "1px solid rgba(15, 23, 42, 0.12)",
                background: "white",
                color: "#0f172a",
                fontSize: 14,
                outline: "none",
                lineHeight: 1.35,
                boxShadow: "0 10px 26px rgba(15, 23, 42, 0.08)",
              }}
            />
            <div style={{ fontSize: 12, opacity: 0.65, marginTop: 6 }}>
              Enter to send • Shift+Enter for a new line
            </div>
          </div>

          <button
            onClick={sendMessage}
            disabled={!canSend}
            style={{
              padding: "12px 14px",
              borderRadius: 14,
              border: "1px solid rgba(37, 99, 235, 0.20)",
              background: canSend ? "rgba(37, 99, 235, 0.95)" : "rgba(148, 163, 184, 0.65)",
              color: "white",
              cursor: canSend ? "pointer" : "not-allowed",
              fontSize: 14,
              fontWeight: 800,
              minWidth: 96,
              boxShadow: canSend ? "0 14px 30px rgba(37, 99, 235, 0.22)" : "none",
            }}
          >
            {isSending ? "Sending…" : "Send"}
          </button>
        </div>
      </footer>
    </main>
  );
}
