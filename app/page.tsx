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

function formatAssistantLabel() {
  return "Volleyball Guru";
}

export default function Page() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: uid(),
      role: "assistant",
      text:
        `I’m ${formatAssistantLabel()} for MVVC 14 Black.\n\n` +
        `Ask me about stats, month-over-month trends, lineup ideas (including 6–2), strengths/weaknesses, tactics vs opponents, or player development.`,
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
    } catch {}
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
          } catch {}
        }
      }

      const answer =
        typeof data?.answer === "string" && data.answer.trim() ? data.answer.trim() : "No answer generated.";

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
                  `Details: ${msg}\n\n` +
                  `Tip: Check Vercel logs (Function Logs) + confirm OPENAI_API_KEY is set.`,
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
          `New conversation started.\n\n` +
          `Ask me anything about MVVC 14 Black (stats, lineups, trends, development, tactics).`,
      },
    ]);
    setThreadId(null);
    try {
      localStorage.removeItem(THREAD_STORAGE_KEY);
    } catch {}
  }

  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          padding: "14px 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          position: "sticky",
          top: 0,
          backdropFilter: "blur(8px)",
          background: "rgba(2, 6, 23, 0.6)",
          zIndex: 10,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>MVVC · {formatAssistantLabel()}</div>
          <div style={{ fontSize: 12, opacity: 0.8 }}>{threadId ? `Thread: ${threadId.slice(0, 8)}…` : "Thread: new"}</div>
        </div>

        <button
          onClick={clearThread}
          style={{
            border: "1px solid rgba(255,255,255,0.15)",
            background: "rgba(255,255,255,0.06)",
            color: "white",
            padding: "8px 10px",
            borderRadius: 10,
            cursor: "pointer",
            fontSize: 13,
            whiteSpace: "nowrap",
          }}
          title="Start a new conversation"
        >
          New chat
        </button>
      </header>

      <section style={{ flex: 1, padding: "16px", width: "100%", maxWidth: 880, margin: "0 auto" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {messages.map((m) => {
            const isUser = m.role === "user";

            return (
              <div key={m.id} style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start" }}>
                <div
                  style={{
                    maxWidth: "92%",
                    width: "fit-content",
                    padding: "12px 12px",
                    borderRadius: 14,
                    border: "1px solid rgba(255,255,255,0.12)",
                    background: isUser ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.06)",
                    whiteSpace: "pre-wrap",
                    lineHeight: 1.35,
                    fontSize: 14,
                  }}
                >
                  {!isUser && (
                    <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>{formatAssistantLabel()}</div>
                  )}

                  {/* Render assistant messages as Markdown; user messages as plain text */}
                  {isUser ? (
                    m.text
                  ) : (
                    <ReactMarkdown
                      components={{
                        p: (props) => <p style={{ margin: "8px 0" }} {...props} />,
                        ul: (props) => <ul style={{ margin: "8px 0", paddingLeft: 18 }} {...props} />,
                        ol: (props) => <ol style={{ margin: "8px 0", paddingLeft: 18 }} {...props} />,
                        li: (props) => <li style={{ margin: "4px 0" }} {...props} />,
                        strong: (props) => <strong style={{ fontWeight: 800 }} {...props} />,
                        h1: (props) => <div style={{ fontSize: 18, fontWeight: 800, margin: "10px 0 6px" }} {...props} />,
                        h2: (props) => <div style={{ fontSize: 16, fontWeight: 800, margin: "10px 0 6px" }} {...props} />,
                        h3: (props) => <div style={{ fontSize: 14, fontWeight: 800, margin: "10px 0 6px" }} {...props} />,
                      }}
                    >
                      {m.text}
                    </ReactMarkdown>
                  )}
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      </section>

      <footer
        style={{
          padding: "14px 16px",
          borderTop: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(2, 6, 23, 0.6)",
          backdropFilter: "blur(8px)",
        }}
      >
        <div style={{ width: "100%", maxWidth: 880, margin: "0 auto", display: "flex", gap: 10, alignItems: "flex-end" }}>
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
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(255,255,255,0.05)",
              color: "white",
              fontSize: 14,
              outline: "none",
              lineHeight: 1.3,
            }}
          />

          <button
            onClick={sendMessage}
            disabled={!canSend}
            style={{
              padding: "11px 14px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.18)",
              background: canSend ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.06)",
              color: "white",
              cursor: canSend ? "pointer" : "not-allowed",
              fontSize: 14,
              fontWeight: 600,
              minWidth: 82,
            }}
          >
            {isSending ? "Sending…" : "Send"}
          </button>
        </div>
      </footer>
    </main>
  );
}
