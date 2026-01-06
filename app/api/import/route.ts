import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function csvToRows(text: string) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(",").map((s) => s.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    // simple CSV split (works if your CSV has no commas inside quoted fields)
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
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ ok: true, route: "/api/import", methods: ["GET", "POST"] });
}

// Simple CSV parser: works for "plain" CSVs (no commas inside quoted fields).
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

    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
      return NextResponse.json({ error: "Missing NEXT_PUBLIC_SUPABASE_URL" }, { status: 500 });
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return NextResponse.json({ error: "Missing SUPABASE_SERVICE_ROLE_KEY" }, { status: 500 });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const text = await file.text();
    const rows = csvToRows(text);

    if (rows.length === 0) {
      return NextResponse.json({ error: "CSV parsed 0 data rows (check headers / formatting)" }, { status: 400 });
    }

    // Expect at least: Name/Player, GameDate, Opponent, SourceFile (best effort)
    let rowsInserted = 0;

    for (const r of rows) {
      const playerName = (r["Name"] || r["Player"] || "").trim();
      if (!playerName) continue;

      const gameDate = (r["GameDate"] || "").trim() || null;
      const opponent = (r["Opponent"] || "").trim() || null;
      const sourceFile = (r["SourceFile"] || "").trim() || (file.name ?? null);
      const position = (r["Position"] || "").trim() || null;

      // Store entire row as JSON stats, minus the identity columns
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

      if (error) {
        return NextResponse.json({ error: `Supabase insert failed: ${error.message}` }, { status: 500 });
      }

      rowsInserted++;
    }

    return NextResponse.json({ ok: true, rowsParsed: rows.length, rowsInserted });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
