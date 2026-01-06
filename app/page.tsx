"use client";

import { useEffect, useRef, useState } from "react";

type Msg = {
  role: "user" | "assistant";
  content: string;
};

const SUGGESTED = [
  "Who has the best passer rating?",
  "Who leads the team in kills?",
  "Who leads in digs?",
  "Rank the best passers top to bottom.",
  "Best projected spring lineup?",
  "Should we protect Jayden in serve receive using Bodhi?",
  "Who improved vs regressed this season?",
  "Who is the best opposite on the team?"
];

export default function HomePage() {
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "assistant",
      content:
        "Ask me anything about MVVC 14 Black — stats, lineups, passing, trends, or player performance."
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

    const nextMessages = [...messages, { role: "user", content: question }];
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

      setMessages((m) => [...m, { role: "assistant", content: data.answer }]);
    } catch (e: any) {
      setError(e.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page">
      <section className="card">
        <header className="header">
          <h1>MVVC Coach Copilot</h1>
          <p>Fast, data-backed answers for coaches</p>
        </header>

        <div className="chat">
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              <div className="bubble">
                <strong>{m.role === "user" ? "You" : "Assistant"}</strong>
                <div className="text">{m.content}</div>
              </div>
            </div>
          ))}

          {loading && (
            <div className="msg assistant">
              <div className="bubble">
                <strong>Assistant</strong>
                <div className="text">Analyzing…</div>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        <div className="suggested">
          {SUGGESTED.map((q) => (
            <button key={q} onClick={() => sendQuestion(q)} disabled={loading}>
              {q}
            </button>
          ))}
        </div>

        <div className="inputBox">
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
          />
          <button onClick={() => sendQuestion()} disabled={loading || !input.trim()}>
            Send
          </button>
        </div>

        {error && <div className="error">{error}</div>}
      </section>

      <style jsx>{`
        .page {
          min-height: 100vh;
          background: linear-gradient(135deg, #0f172a, #020617);
          display: flex;
          justify-content: center;
          padding: 16px;
        }

        .card {
          background: white;
          width: 100%;
          max-width: 700px;
          border-radius: 14px;
          padding: 16px;
          display: flex;
          flex-direction: column;
        }

        .header h1 {
          margin: 0;
          font-size: 1.4rem;
        }

        .header p {
          margin: 4px 0 12px;
          color: #475569;
          font-size: 0.9rem;
        }

        .chat {
          flex: 1;
          overflow-y: auto;
          padding: 8px 0;
        }

        .msg {
          display: flex;
          margin-bottom: 10px;
        }

        .msg.user {
          justify-content: flex-end;
        }

        .bubble {
          background: #f1f5f9;
          border-radius: 12px;
          padding: 10px;
          max-width: 85%;
          font-size: 0.95rem;
        }

        .msg.user .bubble {
          background: #2563eb;
          color: white;
        }

        .text {
          margin-top: 4px;
          white-space: pre-wrap;
        }

        .suggested {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
          margin: 10px 0;
        }

        .suggested button {
          font-size: 0.75rem;
          padding: 6px 10px;
          border-radius: 999px;
          border: 1px solid #cbd5f5;
          background: #f8fafc;
          cursor: pointer;
        }

        .inputBox {
          display: flex;
          gap: 8px;
          margin-top: 6px;
        }

        textarea {
          flex: 1;
          resize: none;
          padding: 10px;
          border-radius: 10px;
          border: 1px solid #cbd5f5;
          font-size: 0.9rem;
        }

        .inputBox button {
          padding: 10px 14px;
          border-radius: 10px;
          border: none;
          background: #2563eb;
          color: white;
          font-weight: 600;
          cursor: pointer;
        }

        .error {
          color: #dc2626;
          font-size: 0.85rem;
          margin-top: 6px;
        }
      `}</style>
    </main>
  );
}
