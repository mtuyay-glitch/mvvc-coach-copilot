"use client";

import { useEffect, useRef, useState } from "react";

type Msg = {
  role: "user" | "assistant";
  content: string;
};

const SUGGESTED = [
  "Summarize the season - key moments, strengths, improvement areas.",
  "Who has the best passer rating?",
  "Who leads the team in kills?",
  "Who leads in digs?",
  "Rank the best passers top to bottom.",
  "Best projected spring lineup?",
  "Should we protect Jayden in serve receive using Bodhi?",
  "Who improved vs regressed this season?",
  "Who is the best opposite on the team?"
];

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * Very small "markdown-ish" renderer:
 * - **bold**
 * - headings like "FACT:" / "PROJECTION:" / "Next steps:" / "Roster snapshot"
 * - bullet lists "- item"
 * - paragraphs with spacing
 */
function toNiceHtml(raw: string) {
  const text = escapeHtml(raw).replaceAll("\r\n", "\n");

  const lines = text.split("\n");
  let html = "";
  let inList = false;

  const closeList = () => {
    if (inList) {
      html += "</ul>";
      inList = false;
    }
  };

  const isHeading = (line: string) => {
    const t = line.trim();
    if (!t) return false;
    if (/^(FACT:|PROJECTION:|Next steps:)/i.test(t)) return true;
    if (
      /^(Short answer|Roster snapshot|Strengths|Improvement areas|Actionable Next steps|What I cannot provide)/i.test(
        t
      )
    )
      return true;
    if (/^[A-Za-z].{0,60}—/.test(t)) return true;
    return false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    if (!t) {
      closeList();
      html += `<div style="height:10px"></div>`;
      continue;
    }

    if (t.startsWith("- ")) {
      if (!inList) {
        closeList();
        inList = true;
        html += `<ul class="niceList">`;
      }
      const item = t.slice(2);
      html += `<li>${item}</li>`;
      continue;
    }

    if (isHeading(t)) {
      closeList();
      html += `<div class="niceHeading">${t}</div>`;
      continue;
    }

    closeList();
    html += `<div class="nicePara">${t}</div>`;
  }

  closeList();

  // Bold: **text**
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  return html;
}

function AssistantLabel() {
  return (
    <div style={styles.assistantLabel}>
      <img
        src="/mvvc-logo.png"
        alt="MVVC"
        width={18}
        height={18}
        style={styles.assistantLogo}
      />
      <span>Coaching Assistant</span>
    </div>
  );
}

export default function HomePage() {
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "assistant",
      content:
        "I’m your Coaching Assistant for MVVC 14 Black.\n\nAsk me about stats, lineups, passing, trends, strengths, or improvement areas."
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
          <div style={styles.headerRow}>
            <img
              src="/mvvc-logo.png"
              alt="MVVC"
              width={28}
              height={28}
              style={styles.headerLogo}
            />
            <div>
              <h1 style={styles.title}>MVVC Coach Copilot</h1>
              <p style={styles.subtitle}>
                Fast, coach-friendly answers from your team stats
              </p>
            </div>
          </div>
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
                <div style={styles.bubbleHeader}>
                  {m.role === "user" ? <strong>You</strong> : <AssistantLabel />}
                </div>

                {m.role === "user" ? (
                  <div style={styles.textPlain}>{m.content}</div>
                ) : (
                  <div
                    className="niceChat"
                    dangerouslySetInnerHTML={{ __html: toNiceHtml(m.content) }}
                  />
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div style={styles.msg}>
              <div style={styles.bubble}>
                <div style={styles.bubbleHeader}>
                  <AssistantLabel />
                </div>
                <div style={styles.textPlain}>Analyzing…</div>
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
            placeholder="Ask a question… (Enter to send, Shift+Enter for a new line)"
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

      <style>{`
        .niceChat { margin-top: 6px; line-height: 1.55; }
        .niceHeading { font-weight: 800; margin-top: 8px; }
        .nicePara { margin-top: 8px; }
        .niceList { margin: 10px 0 0 18px; padding: 0; }
        .niceList li { margin: 7px 0; }
      `}</style>
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
    maxWidth: 760,
    borderRadius: 16,
    padding: 16,
    display: "flex",
    flexDirection: "column"
  },
  header: {
    marginBottom: 12
  },
  headerRow: {
    display: "flex",
    alignItems: "center",
    gap: 10
  },
  headerLogo: {
    borderRadius: 8
  },
  title: {
    margin: 0,
    fontSize: "1.4rem"
  },
  subtitle: {
    margin: "6px 0 0",
    color: "#475569",
    fontSize: "0.95rem"
  },
  chat: {
    flex: 1,
    overflowY: "auto",
    margin: "12px 0"
  },
  msg: {
    display: "flex",
    marginBottom: 12
  },
  bubble: {
    background: "#f1f5f9",
    borderRadius: 14,
    padding: 12,
    maxWidth: "90%",
    fontSize: "0.96rem"
  },
  bubbleHeader: {
    opacity: 0.9
  },
  assistantLabel: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    fontWeight: 700
  },
  assistantLogo: {
    borderRadius: 4,
    display: "inline-block"
  },
  userBubble: {
    background: "#2563eb",
    color: "#ffffff"
  },
  textPlain: {
    marginTop: 6,
    whiteSpace: "pre-wrap",
    lineHeight: 1.5
  },
  suggested: {
    display: "flex",
    gap: 6,
    flexWrap: "wrap",
    marginBottom: 8
  },
  chip: {
    fontSize: "0.78rem",
    padding: "7px 10px",
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
    fontSize: "0.95rem",
    minHeight: 46
  },
  sendButton: {
    padding: "10px 14px",
    borderRadius: 10,
    border: "none",
    background: "#2563eb",
    color: "#ffffff",
    fontWeight: 700,
    cursor: "pointer"
  },
  error: {
    marginTop: 8,
    color: "#dc2626",
    fontSize: "0.9rem"
  }
};
