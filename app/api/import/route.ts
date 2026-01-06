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

export async function POST(req: Request) {
  const form = await req.formData();

  const secret = String(form.get("secret") ?? "");
  if (!process.env.IMPORT_SECRET || secret !== process.env.IMPORT_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const teamId = String(form.get("teamId") ?? "").trim();
  const season = String(form.get("season") ?? "").trim() as "fall" | "spring" | "summer";
  const file = form.get("file");

  if (!teamId) return NextResponse.json({ error: "teamId required" }, { status: 400 });
  if (!season) return NextResponse.json({ error: "season required" }, { status: 400 });
  if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(supabaseUrl, serviceKey);

  const text = await file.text();
  const rows = csvToRows(text);

  let gamesCreated = 0;
  let rowsInserted = 0;

  for (const r of rows) {
    const gameDate = r["GameDate"] ? r["GameDate"] : null;
    const opponent = r["Opponent"] ? r["Opponent"] : null;
    const sourceFile = r["SourceFile"] ? r["SourceFile"] : null;
    const isPartial = String(r["IsPartial"] ?? "").toLowerCase() === "true";

    // Upsert game (unique on team_id, season, game_date, opponent, source_file)
    const { data: existing, error: eFind } = await supabase
      .from("games")
      .select("id")
      .eq("team_id", teamId)
      .eq("season", season)
      .eq("game_date", gameDate)
      .eq("opponent", opponent)
      .eq("source_file", sourceFile)
      .maybeSingle();

    if (eFind) {
      return NextResponse.json({ error: eFind.message }, { status: 500 });
    }

    let gameId = existing?.id;

    if (!gameId) {
      const { data: ins, error: eIns } = await supabase
        .from("games")
        .insert({
          team_id: teamId,
          season,
          game_date: gameDate,
          opponent,
          source_file: sourceFile,
          is_partial: isPartial,
        })
        .select("id")
        .single();

      if (eIns) return NextResponse.json({ error: eIns.message }, { status: 500 });
      gameId = ins.id;
      gamesCreated++;
    }

    const playerName = r["Name"] || r["Player"] || "";
    if (!playerName) continue;

    const position = r["Position"] || null;

    // Store full row in stats JSON, minus the identity fields we already store
    const { SourceFile, GameDate, Opponent, IsPartial, Name, Position, ...rest } = r;

    const { error: eRow } = await supabase.from("player_game_stats").insert({
      team_id: teamId,
      season,
      game_id: gameId,
      game_date: gameDate,
      opponent,
      source_file: sourceFile,
      player_name: playerName,
      position,
      stats: rest,
    });

    if (eRow) return NextResponse.json({ error: eRow.message }, { status: 500 });
    rowsInserted++;
  }

  return NextResponse.json({ gamesCreated, rowsInserted });
}
