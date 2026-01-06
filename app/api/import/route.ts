import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

// Simple CSV parser (plain CSV; no commas inside quoted fields).
function csvToRows(text: string) {
  const lines = text
    .replace(/^\uFEFF/, "") // strip BOM if present
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);

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
    const season = String(form.get("season") ?? "").trim() as "fall" | "spring" | "summer";
    const file = form.get("file");

    if (!teamId) return NextResponse.json({ error: "teamId required" }, { status: 400 });
    if (!season) return NextResponse.json({ error: "season required" }, { status: 400 });
    if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl) return NextResponse.json({ error: "Missing NEXT_PUBLIC_SUPABASE_URL" }, { status: 500 });
    if (!serviceKey) return NextResponse.json({ error: "Missing SUPABASE_SERVICE_ROLE_KEY" }, { status: 500 });

    const supabase = createClient(supabaseUrl, serviceKey);

    const text = await file.text();
    const rows = csvToRows(text);

    if (rows.length === 0) {
      return NextResponse.json({ error: "CSV parsed 0 data rows" }, { status: 400 });
    }

    let rowsInserted = 0;
    let rowsSkippedNoName = 0;

    for (const r of rows) {
      // ✅ Support your CURRENT CSV headers first
      // Current: player_name, match_date, opponent, position, source_file, sets_played
      // Older: Name/Player, GameDate, Opponent, Position, SourceFile
      const playerName = String(r["player_name"] ?? r["Name"] ?? r["Player"] ?? "").trim();
      if (!playerName) {
        rowsSkippedNoName++;
        continue;
      }

      const gameDate = String(r["match_date"] ?? r["GameDate"] ?? "").trim() || null;
      const opponent = String(r["opponent"] ?? r["Opponent"] ?? "").trim() || null;
      const position = String(r["position"] ?? r["Position"] ?? "").trim() || null;
      const setsPlayedRaw = String(r["sets_played"] ?? r["SetsPlayed"] ?? "").trim();
      const setsPlayed = setsPlayedRaw !== "" && Number.isFinite(Number(setsPlayedRaw)) ? Number(setsPlayedRaw) : null;

      const sourceFile =
        String(r["source_file"] ?? r["SourceFile"] ?? "").trim() || (file.name ?? null);

      // Remove identity columns from stats payload so stats is "just stats"
      const {
        player_name,
        match_date,
        opponent: opp2,
        position: pos2,
        source_file,
        sets_played,
        Name,
        Player,
        GameDate,
        Opponent,
        Position,
        SourceFile,
        SetsPlayed,
        ...rest
      } = r;

      // Put sets_played into stats too (handy for per-set questions) if present
      if (setsPlayed !== null) rest["sets_played"] = setsPlayed;

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

      if (error) {
        return NextResponse.json({ error: `Supabase insert failed: ${error.message}` }, { status: 500 });
      }

      rowsInserted++;
    }

    return NextResponse.json({
      ok: true,
      rowsParsed: rows.length,
      rowsInserted,
      rowsSkippedNoName,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
