import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

/**
 * MVVC Coach Copilot - Chat API (2025–26)
 * Goal:
 * - Answer like ChatGPT: directly answer the question asked.
 * - Broad questions => narrative.
 * - Narrow questions => short, minimal noise.
 * - Facts MUST come only from Supabase-derived FACTS_JSON.
 */

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black
const SEASON_START = "2025-08-01";
const SEASON_END_EXCLUSIVE = "2026-08-01";
const PERSONA = "Volleyball Guru";

/* ----------------------------- Types ----------------------------- */

type MatchRow = {
  match_date: string | null;
  tournament: string | null;
  opponent: string | null;
  result: string | null;
  score: string | null;
  round: string | null;
  sets_won: number | null;
  sets_lost: number | null;
  set_diff: number | null;
};

type StatRow = {
  player_name: string | null;
  position: string | null;
  game_date: string | null;
  opponent: string | null;
  stats: any;
};

/* --------------------------- Utilities --------------------------- */

function toNum(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).trim();
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function parseStats(stats: any): Record<string, any> {
  if (!stats) return {};
  if (typeof stats === "object") return stats;
  try {
    return JSON.parse(stats);
  } catch {
    return {};
  }
}

function normalizeWinLoss(result: string | null): "W" | "L" | null {
  if (!result) return null;
  const r = result.toLowerCase();
  if (r === "w" || r.includes("won") || r.includes("win")) return "W";
  if (r === "l" || r.includes("lost") || r.includes("loss")) return "L";
  return null;
}

function monthKey(isoDate: string) {
  return isoDate.slice(0, 7);
}

/* ---------------------- Intent Detection ------------------------ */

function s(q: string) {
  return (q || "").toLowerCase().trim();
}

function isBroadQuestion(q: string) {
  const t = s(q);
  return (
    t.includes("recap") ||
    t.includes("summary") ||
    t.includes("strength") ||
    t.includes("weakness") ||
    t.includes("improve") ||
    t.includes("lineup") ||
    t.includes("6-2") ||
    t.includes("trend") ||
    t.includes("month")
  );
}

/* ---------------------- Data Retrieval -------------------------- */

async function retrieveData(teamId: string, question: string) {
  const supabase = supabaseService();
  const broad = isBroadQuestion(question);

  const rosterPromise = broad
    ? supabase
        .from("knowledge_chunks")
        .select("id,title,content,tags")
        .eq("team_id", teamId)
        .contains("tags", ["roster"])
        .limit(10)
    : Promise.resolve({ data: [], error: null });

  const matchesPromise = supabase
    .from("match_results")
    .select(
      "match_date,tournament,opponent,result,score,round,sets_won,sets_lost,set_diff"
    )
    .eq("team_id", teamId)
    .gte("match_date", SEASON_START)
    .lt("match_date", SEASON_END_EXCLUSIVE)
    .order("match_date", { ascending: true });

  const statsPromise = supabase
    .from("player_game_stats")
    .select("player_name,position,game_date,opponent,stats")
    .eq("team_id", teamId)
    .gte("game_date", SEASON_START)
    .lt("game_date", SEASON_END_EXCLUSIVE);

  const [rosterRes, matchesRes, statsRes] = await Promise.all([
    rosterPromise,
    matchesPromise,
    statsPromise,
  ]);

  if (rosterRes.error) throw rosterRes.error;
  if (matchesRes.error) throw matchesRes.error;
  if (statsRes.error) throw statsRes.error;

  return {
    chunks: rosterRes.data ?? [],
    matches: (matchesRes.data ?? []) as MatchRow[],
    statsRows: (statsRes.data ?? []) as StatRow[], // ✅ FIXED HERE
  };
}

/* ---------------------- Aggregation ----------------------------- */

function computeAggregates(matches: MatchRow[], statsRows: StatRow[]) {
  let wins = 0;
  let losses = 0;

  for (const m of matches) {
    const wl = normalizeWinLoss(m.result);
    if (wl === "W") wins++;
    if (wl === "L") losses++;
  }

  return {
    wins,
    losses,
    hasMatches: matches.length > 0,
    hasStats: statsRows.length > 0,
  };
}

/* ---------------------- OpenAI Call ----------------------------- */

async function callOpenAI(question: string, factsPayload: any) {
  assertEnv("OPENAI_API_KEY");

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5-mini",
      max_output_tokens: 800,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: `You are ${PERSONA}. Answer naturally like ChatGPT.`,
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: question }],
        },
      ],
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(txt);
  }

  const json = await res.json();
  return json.output_text || "No response.";
}

/* ---------------------- Route ----------------------------- */

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const question = String(body?.question ?? "").trim();
    if (!question)
      return NextResponse.json({ error: "question required" }, { status: 400 });

    const { matches, statsRows } = await retrieveData(TEAM_ID, question);
    const agg = computeAggregates(matches, statsRows);

    const answer = await callOpenAI(question, agg);

    return NextResponse.json({ answer });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Server error" },
      { status: 500 }
    );
  }
}
