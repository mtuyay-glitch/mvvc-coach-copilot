"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type Msg = { role: "user" | "assistant"; content: string };

const SUGGESTED = [
  "Who has the best passer rating?",
  "Who leads the team in kills?",
  "Rank the players within each position.",
  "Best projected spring lineup?",
  "Who improved vs regressed this season?",
  "Who is the best opposite on the team?",
  "
];

export default function HomePage() {
  const [msgs, setMsgs] = useState<Msg[]>([
    {
      role: "assistant",
      content:
        "Ask me anything about MVVC 14 Black (stats, trends, lineups, serve receive, positions). I’ll answer using the uploaded dataset.",
    },
  ]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);

  async function send(qRaw?: string) {
    const q = (qRaw ?? question).trim();
    if (!q || busy) return;

    setBusy(true);
    setError(null);
    setQuestion("");
    setMsgs((m) => [...m, { role: "user", content: q }]);

    try {
      // Send conversation history for "memory"
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: q,
          messages: [...msgs, { role: "user", content: q }],
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Request failed");

      setMsgs((m) => [...m, { role: "assistant", content: data.answer }]);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <div className="frame">
        <header className="header">
          <div className="brand">
            <div className="logo" aria-hidden="true">🏐</div>
            <div className="brandText">
              <div className="title">MVVC Coach Copilot</div>
              <div className="subtitle">Fast, mobile-friendly, data-backed coaching answers</div>
            </div>
          </div>
        </header>

        <main className="main">
          <section className="card chat">
            <div className="chatTop">
              <div className="chatTitle">Chat</div>
              <div className="chatStatus">{busy ? "Thinking…" : "Ready"}</div>
            </div>

            <div className="chatBody">
              {msgs.map((m, i) => (
                <div key={i} className={`row ${m.role}`}>
                  <div className={`bubble ${m.role}`}>
                    <div className="label">{m.role === "user" ? "You" : "Assistant"}</div>
                    <div className="text">{m.content}</div>
                  </div>
                </div>
              ))}

              {busy && (
                <div className="row assistant">
                  <div className="bubble assistant">
                    <div className="label">Assistant</div>
                    <div className="text">
                      <span className="dots">
                        <span />
                        <span />
                        <span />
                      </span>
                    </div>
                  </div>
                </div>
              )}

              <div ref={endRef} />
            </div>

            <div className="composer">
              <div className="chips">
                {SUGGESTED.map((s) => (
                  <button key={s} className="chip" onClick={() => send(s)} disabled={busy}>
                    {s}
                  </button>
                ))}
              </div>

              <textarea
                className="input"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Ask a question… (Enter to send, Shift+Enter for new line)"
                rows={2}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                disabled={busy}
              />

              <div className="actions">
                <button className="btn" onClick={() => send()} disabled={busy || !question.trim()}>
                  Send
                </button>
              </div>

              {error && <div className="error">{error}</div>}
            </div>
          </section>
        </main>

        <footer className="footer">MVVC Coach Copilot • MVP</footer>
      </div>

      <style jsx global>{`
        :root {
          --bg: #0b1020;
          --panel: rgba(255, 255, 255, 0.06);
          --border: rgba(255, 255, 255, 0.12);
          --text: rgba(255, 255, 255, 0.92);
          --muted: rgba(255, 255, 255, 0.65);
          --accent: #7c5cff;
          --accent2: #2ee59d;
          --danger: #ff5a6a;
          --shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
          --radius: 18px;
        }
        * { box-sizing: border-box; }
        html, body { height: 100%; }
        body {
          margin: 0;
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
          color: var(--text);
          background:
            radial-gradient(1200px 800px at 10% 20%, rgba(124, 92, 255, 0.35), transparent 55%),
            radial-gradient(900px 700px at 85% 10%, rgba(46, 229, 157, 0.25), transparent 60%),
            var(--bg);
        }
      `}</style>

      <style jsx>{`
        .shell {
          min-height: 100vh;
          min-height: 100dvh;
          padding: 14px;
          display: flex;
          justify-content: center;
        }
        .frame {
          width: 100%;
          max-width: 1100px;
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .header {
          border: 1px solid var(--border);
          border-radius: var(--radius);
          background: linear-gradient(180deg, var(--panel), rgba(255,255,255,0.02));
          box-shadow: var(--shadow);
          padding: 14px 16px;
        }
        .brand { display: flex; align-items: center; gap: 12px; }
        .logo {
          width: 44px; height: 44px; border-radius: 14px;
          display: grid; place-items: center;
          background: linear-gradient(135deg, rgba(124,92,255,0.55), rgba(46,229,157,0.35));
          border: 1px solid rgba(255,255,255,0.18);
        }
        .title { font-weight: 900; letter-spacing: 0.2px; }
        .subtitle { font-size: 12px; color: var(--muted); margin-top: 2px; }

        .main { display: grid; grid-template-columns: 1fr; gap: 14px; }

        .card {
          border: 1px solid var(--border);
          border-radius: var(--radius);
          background: linear-gradient(180deg, var(--panel), rgba(255,255,255,0.02));
          box-shadow: var(--shadow);
          overflow: hidden;
        }

        .chat { min-height: 78dvh; display: flex; flex-direction: column; }

        .chatTop {
          display: flex; justify-content: space-between; align-items: center;
          padding: 12px 14px;
          border-bottom: 1px solid rgba(255,255,255,0.10);
          background: rgba(255,255,255,0.03);
        }
        .chatTitle { font-weight: 800; }
        .chatStatus { font-size: 12px; color: var(--muted); }

        .chatBody {
          flex: 1;
          padding: 14px;
          overflow: auto;
        }

        .row { display: flex; margin-bottom: 12px; }
        .row.user { justify-content: flex-end; }
        .row.assistant { justify-content: flex-start; }

        .bubble {
          max-width: 92%;
          padding: 10px 12px;
          border-radius: 16px;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(255,255,255,0.06);
        }
        .bubble.user {
          background: linear-gradient(135deg, rgba(124,92,255,0.55), rgba(46,229,157,0.24));
          border-color: rgba(255,255,255,0.18);
        }
        @media (min-width: 900px) { .bubble { max-width: 72%; } }
        .label { font-size: 11px; color: rgba(255,255,255,0.65); margin-bottom: 4px; }
        .text { white-space: pre-wrap; line-height: 1.4; font-size: 14px; }

        .composer {
          padding: 12px;
          border-top: 1px solid rgba(255,255,255,0.10);
          background: rgba(255,255,255,0.03);
        }

        .chips {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          margin-bottom: 10px;
        }

        .chip {
          border: 1px solid rgba(255,255,255,0.14);
          background: rgba(255,255,255,0.06);
          color: var(--muted);
          padding: 8px 10px;
          border-radius: 999px;
          font-size: 12px;
          cursor: pointer;
          max-width: 100%;
        }
        .chip:disabled { opacity: 0.5; cursor: not-allowed; }

        .input {
          width: 100%;
          border-radius: 14px;
          border: 1px solid rgba(255,255,255,0.14);
          background: rgba(0,0,0,0.18);
          color: var(--text);
          padding: 12px 12px;
          resize: none;
          outline: none;
        }
        .input:focus {
          border-color: rgba(124,92,255,0.6);
          box-shadow: 0 0 0 3px rgba(124,92,255,0.18);
        }

        .actions { display: flex; justify-content: flex-end; margin-top: 10px; }
        .btn {
          border: 1px solid rgba(255,255,255,0.18);
          background: linear-gradient(135deg, rgba(124,92,255,0.9), rgba(46,229,157,0.55));
          color: white;
          padding: 10px 14px;
          border-radius: 14px;
          cursor: pointer;
          font-weight: 800;
        }
        .btn:disabled { opacity: 0.55; cursor: not-allowed; }

        .error { margin-top: 10px; color: var(--danger); font-size: 13px; }
        .footer { text-align: center; color: rgba(255,255,255,0.55); font-size: 12px; padding: 6px 0 2px; }

        .dots { display: inline-flex; gap: 6px; }
        .dots span {
          width: 6px; height: 6px; border-radius: 999px;
          background: rgba(255,255,255,0.65);
          display: inline-block;
          animation: bounce 1.2s infinite ease-in-out;
        }
        .dots span:nth-child(2) { animation-delay: 0.15s; }
        .dots span:nth-child(3) { animation-delay: 0.3s; }
        @keyframes bounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.55; }
          40% { transform: translateY(-4px); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
