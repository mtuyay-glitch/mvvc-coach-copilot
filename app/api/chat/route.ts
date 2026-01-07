import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

/**
 * MVVC Coach Copilot - Chat API (2025–26)
 *
 * Key fixes in this file:
 * 1) Correctly extract text from OpenAI Responses API (it usually does NOT return json.output_text).
 * 2) Always return a real answer (deterministic fallback) so you never see "No response."
 * 3) Provide useful behavior for common questions like:
 *    - "best setter"
 *    - "starting lineup"
 *    - "projected lineup 6-2"
 *    - top leaders / month-by-month
 */

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black
const SEASON_START = "2025-08-01";
const SEASON_END_EXCLUSIVE = "2026-08-01";
const PERSONA = "Volleyball Guru";

/* -------------------------------- Types -------------------------------- */

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
  stats: any; // jsonb (object or stringified JSON)
};

/* ------------------------------ Small helpers ------------------------------ */

function s(q: string) {
  return (q || "").toLowerCase().trim();
}

function toNum(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(String(v).trim());
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
  // "2025-11-09" -> "2025-11"
  return isoDate.slice(0, 7);
}

/* -------------------------- Intent detection -------------------------- */

function isLineupQuestion(q: string) {
  const t = s(q);
  return (
    t.includes("lineup") ||
    t.includes("starting") ||
    t.includes("starting six") ||
    t.includes("starting 6") ||
    t.includes("rotation") ||
    t.includes("6-2") ||
    t.includes("6 2") ||
    t.includes("projected")
  );
}

function isSetterQuestion(q: string) {
  const t = s(q);
  // include "best setter", "top setter", "who is our setter"
  return t.includes("setter");
}

function isLeadersQuestion(q: string) {
  const t = s(q);
  return t.includes("leaders") || t.includes("top 5") || t.includes("top five") || t.includes("top 3") || t.includes("top three");
}

function isMonthByMonthQuestion(q: string) {
  const t = s(q);
  return t.includes("month") || t.includes("month over month") || t.includes("mom") || t.includes("trend");
}

function isBroadQuestion(q: string) {
  const t = s(q);
  const broadSignals = [
    "recap",
    "summarize",
    "strength",
    "weakness",
    "improve",
    "improvement",
    "recommend",
    "development",
    "tactics",
    "game plan",
    "beat",
    "position battle",
    "optimal position",
    "gaps",
    "add players",
    "recruit",
  ];
  return broadSignals.some((k) => t.includes(k)) || isLineupQuestion(q) || isMonthByMonthQuestion(q) || isLeadersQuestion(q);
}

/* -------------------------- Data retrieval -------------------------- */

async function retrieveData(teamId: string, question: string) {
  const supabase = supabaseService();

  // NOTE: Keep queries parallel to reduce latency.
  const matchesPromise = supabase
    .from("match_results")
    .select("match_date,tournament,opponent,result,score,round,sets_won,sets_lost,set_diff")
    .eq("team_id", teamId)
    .gte("match_date", SEASON_START)
    .lt("match_date", SEASON_END_EXCLUSIVE)
    .order("match_date", { ascending: true })
    .limit(3000);

  const statsPromise = supabase
    .from("player_game_stats")
    .select("player_name,position,game_date,opponent,stats")
    .eq("team_id", teamId)
    .gte("game_date", SEASON_START)
    .lt("game_date", SEASON_END_EXCLUSIVE)
    .order("game_date", { ascending: false })
    .limit(8000);

  const [matchesRes, statsRes] = await Promise.all([matchesPromise, statsPromise]);

  if (matchesRes.error) throw matchesRes.error;
  if (statsRes.error) throw statsRes.error;

  return {
    matches: (matchesRes.data ?? []) as MatchRow[],
    statsRows: (statsRes.data ?? []) as StatRow[], // ✅ correct type
  };
}

/* -------------------------- Aggregations -------------------------- */

/**
 * computeAggregates:
 * - totals any numeric stat key per player (kills, assists, setting_errors, etc.)
 * - computes SR weighted rating if SR fields exist
 * - builds month-by-month totals for any stat key
 */
function computeAggregates(matches: MatchRow[], statsRows: StatRow[]) {
  let wins = 0;
  let losses = 0;

  for (const m of matches) {
    const wl = normalizeWinLoss(m.result);
    if (wl === "W") wins++;
    if (wl === "L") losses++;
  }

  type PlayerAgg = {
    position: string | null;
    totals: Record<string, number>;
    srAttempts: number;
    srWeightedSum: number;
  };

  const byPlayer: Record<string, PlayerAgg> = {};
  const teamByMonth: Record<string, Record<string, number>> = {};
  const srByMonth: Record<string, { attempts: number; weightedSum: number }> = {};

  for (const row of statsRows) {
    const player = (row.player_name ?? "").trim();
    if (!player) continue;

    const stats = parseStats(row.stats);
    const pos = (row.position ?? stats.position ?? null) as string | null;

    const iso = (row.game_date ?? "").toString().trim();
    const mk = iso && iso.includes("-") ? monthKey(iso) : "";

    if (!byPlayer[player]) byPlayer[player] = { position: pos, totals: {}, srAttempts: 0, srWeightedSum: 0 };
    if (!byPlayer[player].position && pos) byPlayer[player].position = pos;

    // Sum every numeric-looking stat field
    for (const key of Object.keys(stats)) {
      if (key === "player_name" || key === "position" || key === "opponent" || key === "match_date" || key === "source_file") continue;
      const n = toNum(stats[key]);
      if (n === 0) continue;

      byPlayer[player].totals[key] = (byPlayer[player].totals[key] ?? 0) + n;

      if (mk) {
        teamByMonth[mk] = teamByMonth[mk] ?? {};
        teamByMonth[mk][key] = (teamByMonth[mk][key] ?? 0) + n;
      }
    }

    // Optional: SR weighted rating (0–3)
    const srAtt = toNum(stats.serve_receive_attempts);
    const srRating = toNum(stats.serve_receive_passing_rating);
    if (srAtt > 0) {
      byPlayer[player].srAttempts += srAtt;
      byPlayer[player].srWeightedSum += srRating * srAtt;

      if (mk) {
        srByMonth[mk] = srByMonth[mk] ?? { attempts: 0, weightedSum: 0 };
        srByMonth[mk].attempts += srAtt;
        srByMonth[mk].weightedSum += srRating * srAtt;
      }
    }
  }

  // Compute team SR overall
  let teamSrAttempts = 0;
  let teamSrWeightedSum = 0;
  for (const p of Object.keys(byPlayer)) {
    teamSrAttempts += byPlayer[p].srAttempts;
    teamSrWeightedSum += byPlayer[p].srWeightedSum;
  }
  const teamSrRating = teamSrAttempts > 0 ? teamSrWeightedSum / teamSrAttempts : 0;

  return {
    wins,
    losses,
    byPlayer,
    teamByMonth,
    srByMonth,
    teamSr: { rating: teamSrRating, attempts: teamSrAttempts },
    hasMatches: matches.length > 0,
    hasStats: Object.keys(byPlayer).length > 0,
  };
}

function topNForKey(byPlayer: Record<string, { totals: Record<string, number> }>, key: string, n: number) {
  return Object.keys(byPlayer)
    .map((p) => ({ player: p, value: toNum(byPlayer[p].totals[key]) }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}

/* -------------------------- Facts payload -------------------------- */

function buildFactsPayload(question: string, agg: ReturnType<typeof computeAggregates>) {
  const q = s(question);

  const base = {
    window: { start: SEASON_START, endExclusive: SEASON_END_EXCLUSIVE },
    winLoss: agg.hasMatches ? { wins: agg.wins, losses: agg.losses } : null,
    teamServeReceive:
      agg.teamSr.attempts > 0
        ? { scale: "0-3", rating: Number(agg.teamSr.rating.toFixed(2)), attempts: agg.teamSr.attempts }
        : null,
  };

  // Minimal but useful “building blocks” for the model
  const candidates = {
    settersByAssists: topNForKey(agg.byPlayer as any, "setting_assists", 6),
    hittersByKills: topNForKey(agg.byPlayer as any, "attack_kills", 10),
    blockersBySolo: topNForKey(agg.byPlayer as any, "blocks_solo", 8),
    blockersByAssist: topNForKey(agg.byPlayer as any, "blocks_assist", 8),
    serveAcesTop5: topNForKey(agg.byPlayer as any, "serve_aces", 5),
    digsTop5: topNForKey(agg.byPlayer as any, "digs_successful", 5),
    serveErrorsTop5: topNForKey(agg.byPlayer as any, "serve_errors", 5),
  };

  const positions: Record<string, string | null> = {};
  for (const p of Object.keys(agg.byPlayer || {})) positions[p] = agg.byPlayer[p].position ?? null;

  if (isLineupQuestion(question)) return { type: "lineup", ...base, candidates, positions };
  if (isSetterQuestion(question)) return { type: "setter", ...base, candidates, positions };
  if (isLeadersQuestion(question)) return { type: "leaders", ...base, candidates, positions };
  if (isMonthByMonthQuestion(question)) return { type: "month_over_month", ...base, teamByMonth: agg.teamByMonth, srByMonth: agg.srByMonth };
  if (isBroadQuestion(question)) return { type: "broad", ...base, candidates, positions };

  return { type: "minimal", ...base, candidates, positions };
}

/* -------------------------- OpenAI: extract text correctly -------------------------- */

/**
 * The Responses API frequently returns:
 * { output: [ { content: [ { type:"output_text", text:"..." } ] } ] }
 * NOT necessarily { output_text: "..." }.
 */
function safeExtractOutputText(json: any): string {
  let text = "";

  const out = json?.output;
  if (Array.isArray(out)) {
    for (const item of out) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === "output_text" && typeof c?.text === "string") text += c.text;
        }
      }
    }
  }

  if (!text && typeof json?.output_text === "string") text = json.output_text;
  if (!text && typeof json?.text === "string") text = json.text;

  return (text || "").trim();
}

async function callOpenAI(question: string, factsPayload: any) {
  assertEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";

  const broad = isBroadQuestion(question);
  const maxTokens = broad ? 900 : 350;

  const system = `
You are "${PERSONA}" for MVVC 14 Black boys volleyball.

Answer like ChatGPT: directly answer the question asked.

Hard rules:
- Do NOT echo the question.
- Do NOT output "Try these prompts".
- Keep narrow questions short.
- For lineup questions: always output a lineup recommendation (best-effort) even if positions are incomplete.
- FACTS_JSON is the only source for factual claims, but you may use general volleyball knowledge for coaching guidance.

When facts are missing:
- Say what's missing in 1–2 lines, then still give a best-effort answer.
`;

  const userObj = { question, FACTS_JSON: factsPayload };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_output_tokens: maxTokens,
      input: [
        { role: "system", content: [{ type: "input_text", text: system }] },
        { role: "user", content: [{ type: "input_text", text: JSON.stringify(userObj) }] },
      ],
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }

  const json = await res.json();
  return safeExtractOutputText(json);
}

/* -------------------------- Deterministic fallback -------------------------- */

function fallbackAnswer(question: string, facts: any) {
  const t = s(question);

  // Best setter
  if (facts?.type === "setter" || t.includes("best setter") || t === "best setter") {
    const setters = facts?.candidates?.settersByAssists ?? [];
    if (!Array.isArray(setters) || setters.length === 0) {
      return (
        "I don’t have enough setting_assists data to identify the best setter.\n\n" +
        "Fix: ensure player_game_stats.stats includes a numeric `setting_assists` field for each match."
      );
    }
    const top = setters[0];
    return `${top.player} leads the team in setting assists (${top.value}).`;
  }

  // Starting lineup / lineup
  if (facts?.type === "lineup" || t.includes("starting lineup") || t.includes("lineup")) {
    const setters = (facts?.candidates?.settersByAssists ?? []).slice(0, 2);
    const hitters = (facts?.candidates?.hittersByKills ?? []).slice(0, 4);
    const blockersSolo = (facts?.candidates?.blockersBySolo ?? []).slice(0, 2);
    const blockersAssist = (facts?.candidates?.blockersByAssist ?? []).slice(0, 2);

    const wl = facts?.winLoss ? `Record (2025–26): ${facts.winLoss.wins}-${facts.winLoss.losses}\n` : "";
    const sr =
      facts?.teamServeReceive
        ? `Team SR: ${facts.teamServeReceive.rating.toFixed(2)} (0–3) on ${facts.teamServeReceive.attempts} attempts\n`
        : "";

    const lines: string[] = [];
    lines.push("Projected starting lineup (best-effort from available stats)");
    if (wl || sr) lines.push(`${wl}${sr}`.trim());

    if (setters.length === 0 && hitters.length === 0) {
      lines.push("I don’t have enough player stat totals to project a lineup yet.");
      lines.push("Fix: make sure `player_game_stats` has rows for each match with `setting_assists` and `attack_kills` at minimum.");
      return lines.join("\n");
    }

    // This is intentionally “best-effort”: we don’t assume positions are correct unless stored.
    lines.push("");
    lines.push("Core picks from your data");
    if (setters.length) lines.push(`• Primary setter candidates (assists): ${setters.map((x: any) => `${x.player} (${x.value})`).join(", ")}`);
    if (hitters.length) lines.push(`• Top attackers (kills): ${hitters.map((x: any) => `${x.player} (${x.value})`).join(", ")}`);

    const blockProxy = [...blockersSolo, ...blockersAssist]
      .reduce<Record<string, number>>((acc, r: any) => {
        acc[r.player] = (acc[r.player] ?? 0) + (r.value ?? 0);
        return acc;
      }, {});
    const blockLeaders = Object.keys(blockProxy)
      .map((p) => ({ player: p, value: blockProxy[p] }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 2);
    if (blockLeaders.length) lines.push(`• Net presence (blocks proxy): ${blockLeaders.map((x) => `${x.player} (${x.value})`).join(", ")}`);

    lines.push("");
    lines.push("To make this a true on-court 6-player starting six");
    lines.push("• Add/confirm each player’s primary position (S/OH/OPP/MB/L/DS).");
    lines.push("• Then I’ll output a clean: S, OPP, OH, OH, MB, L (and 6-2 options if requested).");

    return lines.join("\n");
  }

  // Generic fallback
  return "I couldn’t generate an answer from the current data. Try asking for stat leaders (kills, assists, aces, digs) or confirm your stat keys exist in player_game_stats.stats.";
}

/* ------------------------------- Route ------------------------------- */

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { question: string };
    const question = String(body?.question ?? "").trim();
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    // 1) Pull data
    const { matches, statsRows } = await retrieveData(TEAM_ID, question);

    // 2) Aggregate
    const agg = computeAggregates(matches, statsRows);

    // 3) Build question-specific facts
    const factsPayload = buildFactsPayload(question, agg);

    // 4) Try OpenAI (never return blank text)
    let answer = "";
    try {
      answer = await callOpenAI(question, factsPayload);
    } catch (err: any) {
      console.error("[OpenAI]", err?.message ?? String(err));
      answer = "";
    }

    // 5) Deterministic fallback if OpenAI returns nothing
    if (!answer) answer = fallbackAnswer(question, factsPayload);

    return NextResponse.json({ answer });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
