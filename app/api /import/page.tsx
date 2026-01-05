"use client";

import { useState } from "react";

export default function ImportPage() {
  const [secret, setSecret] = useState("");
  const [teamId, setTeamId] = useState("");
  const [season, setSeason] = useState<"fall" | "spring" | "summer">("fall");
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState<string>("");

  async function runImport() {
    if (!file) return setMsg("Choose a CSV file first.");
    if (!secret) return setMsg("Enter IMPORT_SECRET.");
    if (!teamId) return setMsg("Enter Team ID once (we can hardcode later).");

    setMsg("Uploading…");

    const form = new FormData();
    form.append("file", file);
    form.append("teamId", teamId);
    form.append("season", season);
    form.append("secret", secret);

    const res = await fetch("/api/import", { method: "POST", body: form });
    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      setMsg(`Import failed: ${json?.error ?? res.statusText}`);
      return;
    }
    setMsg(`Imported: games=${json.gamesCreated}, rows=${json.rowsInserted}`);
  }

  return (
    <main style={{ maxWidth: 720, margin: "40px auto", padding: 16 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700 }}>MVVC CSV Import</h1>
      <p style={{ opacity: 0.8 }}>
        Upload your master stats CSV (or one game CSV). Only works with your IMPORT_SECRET.
      </p>

      <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
        <label>
          IMPORT_SECRET
          <input
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            style={{ width: "100%", padding: 10, marginTop: 6 }}
            placeholder="mvvc-import-2026! (example)"
          />
        </label>

        <label>
          Team ID (one-time)
          <input
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            style={{ width: "100%", padding: 10, marginTop: 6 }}
            placeholder="UUID from Supabase teams table"
          />
        </label>

        <label>
          Season
          <select
            value={season}
            onChange={(e) => setSeason(e.target.value as any)}
            style={{ width: "100%", padding: 10, marginTop: 6 }}
          >
            <option value="fall">fall</option>
            <option value="spring">spring</option>
            <option value="summer">summer</option>
          </select>
        </label>

        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />

        <button onClick={runImport} style={{ padding: 12, fontWeight: 600 }}>
          Import CSV
        </button>

        {msg && <div style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>{msg}</div>}
      </div>
    </main>
  );
}
