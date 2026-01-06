"use client";

import { useEffect, useRef, useState } from "react";

type Msg = {
  role: "user" | "assistant";
  content: string;
};

const SUGGESTED = [
  "Summarize the season - key moments, strengths, improvement areas.",
  "Best projected spring lineup?",
  "Who has the best passer rating?",
  "Which types of opponets do we struggle against?",
  "Show me the average kill % per month"
];

export default function HomePage() {
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "assistant",
      content:
        "I’m your Coaching Assistant for MVVC 14 Black. Ask me about stats, lineups, passing, trends, or player performance."
    }
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function sendQuestion(text?: string) {
    const question = (text ?? input).trim();
    if (!question || loading) return;

    setLoading(true);
    setError(null);
    setInput("");

    const nextMessages: Msg[] = [
      ...messages,
      { role: "user" as const, content: question }
    ];
    setMessages(nextMessages);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          messages: nextMessages
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");

      setMessages((m): Msg[] => [
        ...m,
        { role: "assistant" as const, content: data.answer }
      ]);
    } catch (e: any) {
      setError(e.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={styles.page}>
      <section style={styles.card}>
        <header style={styles.header}>
          <h1 style={styles.title}>MVVC Coach Copilot</h1>
          <p style={styles.subtitle}>Fast, data-backed answers for coaches</p>
        </header>

        <div style={styles.chat}>
          {messages.map((m, i) => (
            <div
              key={i}
              style={{
                ...styles.msg,
                justifyContent: m.role === "user" ? "flex-end" : "flex-start"
              }}
            >
              <div
                style={{
                  ...styles.bubble,
                  ...(m.role === "user" ? styles.userBubble : {})
                }}
              >
                <strong>
                  {m.role === "user" ? "You" : "Coaching Assistant"}
                </strong>
                <div style={styles.text}>{m.content}</div>
              </div>
            </div>
          ))}

          {loading && (
            <div style={styles.msg}>
              <div style={styles.bubble}>
                <strong>Coaching Assistant</strong>
                <div style={styles.text}>Analyzing…</div>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        <div style={styles.suggested}>
          {SUGGESTED.map((q) => (
            <button
              key={q}
              style={styles.chip}
              onClick={() => sendQuestion(q)}
              disabled={loading}
            >
              {q}
            </button>
          ))}
        </div>

        <div style={styles.inputBox}>
          <textarea
            placeholder="Ask a question…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendQuestion();
              }
            }}
            disabled={loading}
            style={styles.textarea}
          />
          <button
            onClick={() => sendQuestion()}
            disabled={loading || !input.trim()}
            style={styles.sendButton}
          >
            Send
          </button>
        </div>

        {error && <div style={styles.error}>{error}</div>}
      </section>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    display: "flex",
    justifyContent: "center",
    padding: 16
  },
  card: {
    background: "#ffffff",
    width: "100%",
    maxWidth: 720,
    borderRadius: 16,
    padding: 16,
    display: "flex",
    flexDirection: "column"
  },
  header: {
    marginBottom: 12
  },
  title: {
    margin: 0,
    fontSize: "1.4rem"
  },
  subtitle: {
    margin: "4px 0 0",
    color: "#475569",
    fontSize: "0.9rem"
  },
  chat: {
    flex: 1,
    overflowY: "auto",
    margin: "12px 0"
  },
  msg: {
    display: "flex",
    marginBottom: 10
  },
  bubble: {
    background: "#f1f5f9",
    borderRadius: 12,
    padding: 10,
    maxWidth: "85%",
    fontSize: "0.95rem"
  },
  userBubble: {
    background: "#2563eb",
    color: "#ffffff"
  },
  text: {
    marginTop: 4,
    whiteSpace: "pre-wrap"
  },
  suggested: {
    display: "flex",
    gap: 6,
    flexWrap: "wrap",
    marginBottom: 8
  },
  chip: {
    fontSize: "0.75rem",
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid #cbd5f5",
    background: "#f8fafc",
    cursor: "pointer"
  },
  inputBox: {
    display: "flex",
    gap: 8
  },
  textarea: {
    flex: 1,
    resize: "none",
    padding: 10,
    borderRadius: 10,
    border: "1px solid #cbd5f5",
    fontSize: "0.9rem"
  },
  sendButton: {
    padding: "10px 14px",
    borderRadius: 10,
    border: "none",
    background: "#2563eb",
    color: "#ffffff",
    fontWeight: 600,
    cursor: "pointer"
  },
  error: {
    marginTop: 8,
    color: "#dc2626",
    fontSize: "0.85rem"
  }
};
