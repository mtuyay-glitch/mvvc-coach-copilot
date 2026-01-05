"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "../lib/supabaseClient";

type Msg = { role: "user" | "assistant"; content: string };

export default function HomePage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);

// Team and season are now fixed server-side
  const [question, setQuestion] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([
    { role: "assistant", content: "Ask a question (e.g., 'Best spring lineup?' or 'Protect Jayden in SR using Bodhi?'). I will cite the retrieved facts." }
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setSessionEmail(data.user?.email ?? null);
    });
  }, [supabase]);

  async function signIn(email: string) {
    setError(null);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.href }
    });
    if (error) setError(error.message);
    else setMsgs((m) => [{ role: "assistant", content: "Check your email for the magic link, then come back here." }, ...m]);
  }

  async function signOut() {
    await supabase.auth.signOut();
    setSessionEmail(null);
    setMsgs([{ role: "assistant", content: "Signed out." }]);
  }

  async function ask() {
    const q = question.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    setQuestion("");
    setMsgs((m) => [...m, { role: "user", content: q }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId, season, question: q })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Request failed");
      setMsgs((m) => [...m, { role: "assistant", content: data.answer }]);
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: 20 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>MVVC Coach Copilot (MVP)</div>
          <div style={{ opacity: 0.7, marginTop: 4 }}>Private, data-backed answers for coaches.</div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {sessionEmail ? (
            <>
              <div style={{ fontSize: 13, opacity: 0.8 }}>{sessionEmail}</div>
              <button onClick={signOut}>Sign out</button>
            </>
          ) : (
            <EmailLogin onSubmit={signIn} />
          )}
        </div>
      </header>

      <section style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: 12, opacity: 0.7 }}>Team ID (Supabase UUID)</span>
          <input value={teamId} onChange={(e) => setTeamId(e.target.value)} placeholder="e.g., 3b1a...uuid" />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: 12, opacity: 0.7 }}>Season</span>
          <select value={season} onChange={(e) => setSeason(e.target.value as any)}>
            <option value="fall">Fall</option>
            <option value="spring">Spring</option>
            <option value="summer">Summer</option>
          </select>
        </label>

        <div style={{ alignSelf: "end", fontSize: 12, opacity: 0.7 }}>
          Tip: for production, replace Team ID input with a dropdown populated from membership.
        </div>
      </section>

      <main style={{ marginTop: 16, border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
        <div style={{ height: 440, overflow: "auto", padding: 8, background: "#fafafa", borderRadius: 10 }}>
          {msgs.map((m, i) => (
            <div key={i} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, opacity: 0.65 }}>{m.role.toUpperCase()}</div>
              <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.35 }}>{m.content}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <input
            style={{ flex: 1 }}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask a question…"
            onKeyDown={(e) => { if (e.key === "Enter") ask(); }}
            disabled={busy}
          />
          <button onClick={ask} disabled={busy || !sessionEmail || !teamId}>
            {busy ? "Thinking…" : "Ask"}
          </button>
        </div>

        {error && <div style={{ marginTop: 10, color: "crimson" }}>{error}</div>}
        {!sessionEmail && <div style={{ marginTop: 10, opacity: 0.7 }}>Sign in to ask questions.</div>}
        {!teamId && <div style={{ marginTop: 6, opacity: 0.7 }}>Enter a Team ID to route queries to the correct dataset.</div>}
      </main>

      <footer style={{ marginTop: 14, fontSize: 12, opacity: 0.75 }}>
        MVP note: this starter uses server-side retrieval from Supabase + OpenAI Responses API.
      </footer>
    </div>
  );
}

function EmailLogin({ onSubmit }: { onSubmit: (email: string) => Promise<void> }) {
  const [email, setEmail] = useState("");
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit(email); }}
      style={{ display: "flex", gap: 8, alignItems: "center" }}
    >
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="coach@email.com" />
      <button type="submit">Magic link</button>
    </form>
  );
}
