import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

/**
 * GET /api/import
 * Used only to verify the route is deployed
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    route: "/api/import",
    methods: ["GET", "POST"],
  });
}

/**
 * Very simple CSV parser
 * Assumes:
 * - First row is header
 * - No quoted commas
 */
function csvToRows(text: string) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = lines[0].split(",").map((s) => s.trim());
  const rows: any[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map((s) => s.trim());
    const obj: any = {};
    header.forEach((h, idx) => {
      obj[h] = values[idx] ?? "";
    });
    rows.push(obj);
  }

  return rows;
}

/**
 * POST /api/import
 * Handles CSV upload and inserts into Supabase
 */
export async function POST(req: Request) {
  try {
    const form = await req.formData();

    // --- Auth ---
    const secret = String(form.get("secret") ?? "");
    if (!process.env.IMPORT_SECRET || secret !== process.env.IMPORT_SECRET) {
      return NextResponse.json(
        { error: "Unauthorized (bad IMPORT_SECRET)" },
        { status: 401 }
      );
    }

    // --- Inputs ---
    const teamId = String(form.get("teamId") ?? "").trim();
    const season = String(form.get("season") ?? "").trim();
    const file = form.get("file");

    if (!teamId) {
      return NextResponse.json({ error: "teamId required" }, { status: 400 });
    }
    if (!season) {
      return NextResponse.json({ error: "season required" }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file required" }, { status: 400 });
    }

    // --- Supabase ---
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
      return NextResponse.json(
        { error: "Missing NEXT_PUBLIC_SUPABASE_URL" },
        { status: 500 }
      );
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return NextResponse.json(
        { error: "Missing SUPABASE_SERVICE_ROLE_KEY" },
        { status: 500 }
      );
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // --- Parse CSV ---
    const text = await file.text();
    const rows = csvToRows(text);

    if (rows.length === 0) {
      return NextResponse.json(
        { error: "CSV parsed 0 data rows" },
        { status: 400 }
      );
    }

    // --- Insert rows ---
    let rowsInserted = 0;

    for (const r of rows) {
      const playerName = (r["Name"] || r["Player"] || "").trim();
      if (!playerName) continue;

      const { Name, Player, ...stats } = r;

      const { error } = await supabase.from("player_game_stats").insert({
        team_id: teamId,
        season,
        player_name: playerName,
        stats,
      });

      if (error) {
        return NextResponse.json(
          { error: `Supabase insert failed: ${error.message}` },
          { status: 500 }
        );
      }

      rowsInserted++;
    }

    return NextResponse.json({
      ok: true,
      rowsParsed: rows.length,
      rowsInserted,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: String(e?.message ?? e) },
      { status: 500 }
    );
  }
}
