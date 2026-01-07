import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

// Very simple CSV parser (OK for plain CSV without quoted commas)
function csvToRows(text: string) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = lines[0].split(",").map((s) => s.trim());
  const rows: any[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map((s) => s.trim());
    const obj: any = {};
    header.forEach((h, idx) => (obj[h] = values[idx] ?? ""));
    rows.push(obj);
  }
  return rows;
}

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

function toInt(v: any) {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : null;
}

function toDateISO(v: any) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  // expecting YYYY-MM-DD in your master file
  return s;
}

export async function GET() {
  return NextResponse.json({ ok: true, route: "/api/import", methods: ["GET", "POST"] });
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();

    const secret = String(form.get("secret") ?? "");
    if (!process.env.IMPORT_SECRET || secret !== process.env.IMPORT_SECRET) {
      return NextResponse.json({ error: "Unauthorized (bad IMPORT_SECRET)" }, { status: 401 });
    }

    const teamId = String(form.get("teamId") ?? "").trim();
    const season = String(form.get("season") ?? "").trim() as "fall" | "spring" | "summer"; // still used for player stats imports
    const file = form.get("file");

    if (!teamId) return NextResponse.json({ error: "teamId required" }, { status: 400 });
    if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });

    assertEnv("NEXT_PUBLIC_SUPABASE_URL");
    assertEnv("SUPABASE_SERVICE_ROLE_KEY");

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const text = await file.text();
    const rows = csvToRows(text);

    if (rows.length === 0) {
      return NextResponse.json({ error: "CSV parsed 0 data rows (check headers / formatting)" }, { status: 400 });
    }

    // Detect which kind of CSV this is by looking at headers
    const first = rows[0] ?? {};
    const keys = new Set(Object.keys(first));

    const isMatchResults =
      keys.has("match_date") &&
      keys.has("opponent") &&
      keys.has("result") &&
      (keys.has("tournament") || keys.has("score"));

    // =========================
    // A) MATCH RESULTS IMPORT
    // =========================
    if (isMatchResults) {
      let inserted = 0;

      for (const r of rows) {
        const match_date = toDateISO(r["match_date"]);
        const opponent = String(r["opponent"] ?? "").trim();
        const result = String(r["result"] ?? "").trim();

        if (!opponent || (result !== "W" && result !== "L")) continue;

        const payload = {
          team_id: teamId,
          match_date,
          tournament: String(r["tournament"] ?? "").trim() || null,
          round: String(r["round"] ?? "").trim() || null,
          opponent,
          result,
          score: String(r["score"] ?? "").trim() || null,

          sets_won: toInt(r["sets_won"]),
          sets_lost: toInt(r["sets_lost"]),
          set_diff: toInt(r["set_diff"]),

          match_win: toInt(r["match_win"]),
          match_loss: toInt(r["match_loss"]),
        };

        const { error } = await supabase.from("match_results").insert(payload);
        if (error) return NextResponse.json({ error: `Supabase insert failed: ${error.message}` }, { status: 500 });

        inserted++;
      }

      return NextResponse.json({ ok: true, type: "match_results", rowsParsed: rows.length, rowsInserted: inserted });
    }

    // =========================
    // B) PLAYER GAME STATS IMPORT (existing behavior)
    // =========================
    if (!season) return NextResponse.json({ error: "season required for player stats import" }, { status: 400 });

    let rowsInserted = 0;

    for (const r of rows) {
      const playerName = (r["Name"] || r["Player"] || r["player_name"] || "").trim();
      if (!playerName) continue;

      const gameDate = (r["GameDate"] || r["game_date"] || r["match_date"] || "").trim() || null;
      const opponent = (r["Opponent"] || r["opponent"] || "").trim() || null;
      const sourceFile = (r["SourceFile"] || r["source_file"] || "").trim() || (file.name ?? null);
      const position = (r["Position"] || r["position"] || "").trim() || null;

      const { Name, Player, GameDate, Opponent, SourceFile, Position, ...rest } = r;

      const { error } = await supabase.from("player_game_stats").insert({
        team_id: teamId,
        season,
        game_date: gameDate,
        opponent,
        source_file: sourceFile,
        player_name: playerName,
        position,
        stats: rest,
      });

      if (error) return NextResponse.json({ error: `Supabase insert failed: ${error.message}` }, { status: 500 });

      rowsInserted++;
    }

    return NextResponse.json({ ok: true, type: "player_game_stats", rowsParsed: rows.length, rowsInserted });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
