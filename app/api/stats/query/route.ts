import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5";
const SEASON = "fall";

// Helper: pick likely stat keys from the user's question
function pickKeysFromQuestion(allKeys: string[], question: string) {
  const q = question.toLowerCase();

  // simple keyword → candidate key matching
  const matches = allKeys.filter((k) => q.includes(k.toLowerCase()));

  // common synonyms (add more over time)
  const synonyms: Array<[RegExp, string[]]> = [
    [/kill|kills|hitting/i, ["Kills", "K"]],
    [/ace|aces|serv/i, ["Aces", "Ace"]],
    [/block|blocks/i, ["Blocks", "Block"]],
    [/error|errors/i, ["Errors", "Err"]],
    [/assist|assists/i, ["Assists", "Ast"]],
    [/dig|digs/i, ["Digs", "Dig"]],
    [/attempt|attempts/i, ["Attempts", "Att"]],
  ];

  const extra: string[] = [];
  for (const [re, keys] of synonyms) {
    if (re.test(question)) extra.push(...keys);
  }

  const selected = new Set<string>(matches);
  for (const candidate of extra) {
    // include any real keys that contain the candidate text
    for (const realKey of allKeys) {
      if (realKey.toLowerCase().includes(candidate.toLowerCase())) selected.add(realKey);
    }
  }

  // If nothing matched, return a small default set of numeric keys (top 8)
  return Array.from(selected).slice(0, 8);
}

export async function POST(req: Request) {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url) return NextResponse.json({ error: "Missing NEXT_PUBLIC_SUPABASE_URL" }, { status: 500 });
    if (!key) return NextResponse.json({ error: "Missing SUPABASE_SERVICE_ROLE_KEY" }, { status: 500 });

    const supabase = createClient(url, key);

    const body = await req.json().catch(() => ({}));
    const question = String(body?.question ?? "").trim();
    if (!question) return NextResponse.json({ error: "question required" }, { status: 400 });

    // Pull all stats rows (for the season/team) — your dataset is small enough for this MVP
    const { data, error } = await supabase
      .from("player_game_stats")
      .select("player_name, stats")
      .eq("team_id", TEAM_ID)
      .eq("season", SEASON)
      .limit(100000);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Collect all available stat keys from the data
    const allKeysSet = new Set<string>();
    for (const row of data ?? []) {
      const stats = (row.stats ?? {}) as Record<string, any>;
      Object.keys(stats).forEach((k) => allKeysSet.add(k));
    }
    const allKeys = Array.from(allKeysSet).sort();

    // Choose relevant keys based on the question
    let keys = pickKeysFromQuestion(allKeys, question);

    // If we still have none, pick numeric-ish keys by sampling values
    if (keys.length === 0) {
      const numericCandidates: string[] = [];
      for (const k of allKeys) {
        let numericHits = 0;
        for (const row of data ?? []) {
          const v = (row.stats ?? {})[k];
          const n = Number(String(v ?? "").trim());
          if (Number.isFinite(n) && String(v ?? "").trim() !== "") numericHits++;
          if (numericHits >= 5) break;
        }
        if (numericHits >= 3) numericCandidates.push(k);
        if (numericCandidates.length >= 8) break;
      }
      keys = numericCandidates;
    }

    // Aggregate totals per player for selected keys
    const totalsByPlayer: Record<string, Record<string, number>> = {};
    for (const row of data ?? []) {
      const player = row.player_name as string;
      const stats = (row.stats ?? {}) as Record<string, any>;
      totalsByPlayer[player] ??= {};

      for (const k of keys) {
        const raw = stats[k];
        const n = Number(String(raw ?? "").trim());
        if (!Number.isFinite(n) || String(raw ?? "").trim() === "") continue;
        totalsByPlayer[player][k] = (totalsByPlayer[player][k] ?? 0) + n;
      }
    }

    // Produce a compact “facts” summary for the model
    const facts: string[] = [];
    facts.push(`Team: MVVC 14 Black | Season: ${SEASON}`);
    facts.push(`Available stat keys (sample): ${allKeys.slice(0, 30).join(", ")}${allKeys.length > 30 ? ", ..." : ""}`);
    facts.push(`Keys selected for this question: ${keys.join(", ") || "(none)"}`);

    for (const k of keys) {
      const leaderboard = Object.entries(totalsByPlayer)
        .map(([player_name, obj]) => ({ player_name, value: obj[k] ?? 0 }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 8);

      facts.push(`Top ${k}: ` + leaderboard.map((x) => `${x.player_name}=${x.value}`).join(" | "));
    }

    return NextResponse.json({ ok: true, facts: facts.join("\n") });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
