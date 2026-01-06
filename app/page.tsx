"use client";

import { useState } from "react";

export default function Home() {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function askQuestion() {
    if (!question.trim()) return;

    setLoading(true);
    setError("");
    setAnswer("");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Something went wrong");
      }

      setAnswer(data.answer);
    } catch (err: any) {
      setError(err.message || "Failed to get answer");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>MVVC 14 Black — Coach Assistant</h1>
        <p style={styles.subtitle}>
          Ask questions about lineups, stats, passing, rotations, or player performance.
        </p>

        <textarea
          placeholder="Example: Who has the best passer rating?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={3}
          style={styles.textarea}
        />

        <button
          onClick={askQuestion}
          disabled={loading}
          style={{
            ...styles.button,
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? "Analyzing…" : "Ask Coach Assistant"}
        </button>

        {error && <p style={styles.error}>{error}</p>}

        {answer && (
          <div style={styles.answerBox}>
            <h2 style={styles.answerTitle}>Answer</h2>
            <p style={styles.answerText}>{answer}</p>
          </div>
        )}
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(135deg, #0f172a, #020617)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "16px",
  },
  card: {
    background: "#ffffff",
    borderRadius: "14px",
    padding: "20px",
    width: "100%",
    maxWidth: "520px",
    boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
  },
  title: {
    margin: 0,
    fontSize: "1.4rem",
    fontWeight: 700,
    color: "#020617",
  },
  subtitle: {
    marginTop: "6px",
    marginBottom: "16px",
    fontSize: "0.95rem",
    color: "#475569",
  },
  textarea: {
    width: "100%",
    padding: "12px",
    fontSize: "1rem",
    borderRadius: "10px",
    border: "1px solid #cbd5f5",
    outline: "none",
    resize: "none",
    marginBottom: "12px",
  },
  button: {
    width: "100%",
    padding: "14px",
    fontSize: "1rem",
    fontWeight: 600,
    backgroundColor: "#2563eb",
    color: "#ffffff",
    border: "none",
    borderRadius: "10px",
    cursor: "pointer",
  },
  error: {
    marginTop: "12px",
    color: "#dc2626",
    fontSize: "0.9rem",
  },
  answerBox: {
    marginTop: "20px",
    padding: "16px",
    background: "#f8fafc",
    borderRadius: "10px",
    border: "1px solid #e2e8f0",
  },
  answerTitle: {
    margin: 0,
    marginBottom: "6px",
    fontSize: "1rem",
    fontWeight: 600,
    color: "#020617",
  },
  answerText: {
    margin: 0,
    fontSize: "0.95rem",
    lineHeight: 1.5,
    color: "#020617",
    whiteSpace: "pre-wrap",
  },
};
