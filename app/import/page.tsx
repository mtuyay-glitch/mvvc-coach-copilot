"use client";

import { useState } from "react";

export default function ImportPage() {
  const [secret, setSecret] = useState("");
  const [teamId, setTeamId] = useState("7d5c9d23-e78c-4b08-8869-64cece1acee5");
  const [season, setSeason] = useState("fall");
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState("");

  async function runImport() {
    try {
      setMsg("Uploading...");
      if (!file) {
        setMsg("Please choose a CSV file first.");
        return;
      }

      const form = new FormData();
      form.append("secret", secret);
      form.append("teamId", teamId);
      form.append("season", season);
      form.append("file", file);

      const res = await fetch("/api/import", { method: "POST", body: form });
      const raw = await res.text();
      let json: any = null;
      try { json = JSON.parse(raw); } catch {}

      if (!res.ok) {
        setMsg(`Import failed: ${json?.error ?? raw ?? res.statusText}`);
        return;
      }

      setMsg(`Success! rowsParsed=${json.rowsParsed}, rowsInserted=${json.rowsInserted}`);
    } catch (e: any) {
      setMsg(`Import failed: ${e?.message ?? String(e)}`);
    }
  }

  return (
    <main style={{ padding: 24, maxWidth: 720 }}>
      <h1>MVVC CSV Import</h1>

      <label style={{ display: "block", marginTop: 12 }}>
        Import Secret
        <input
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          style={{ display: "block", width: "100%", padding: 8, marginTop: 6 }}
          placeholder="mvvc-import-2026!"
        />
      </label>

      <label style={{ display: "block", marginTop: 12 }}>
        Team ID
        <input
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
          style={{ display: "block", width: "100%", padding: 8, marginTop: 6 }}
        />
      </label>

      <label style={{ display: "block", marginTop: 12 }}>
        Season
        <select
          value={season}
          onChange={(e) => setSeason(e.target.value)}
          style={{ display: "block", width: "100%", padding: 8, marginTop: 6 }}
        >
          <option value="fall">fall</option>
          <option value="spring">spring</option>
          <option value="summer">summer</option>
        </select>
      </label>

      <label style={{ display: "block", marginTop: 12 }}>
        CSV File
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          style={{ display: "block", marginTop: 6 }}
        />
      </label>

      <button
        type="button"
        onClick={runImport}
        style={{ marginTop: 16, padding: "10px 14px", fontWeight: 600 }}
      >
        Import CSV
      </button>

      <p style={{ marginTop: 16, whiteSpace: "pre-wrap" }}>{msg}</p>
    </main>
  );
}
