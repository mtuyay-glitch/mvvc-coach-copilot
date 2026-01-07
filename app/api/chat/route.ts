import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

/**
 * NOTE:
 * - This route pulls match results + player stats from Supabase.
 * - It computes season totals locally (fast).
 * - It only sends a SMALL facts payload to the model to reduce “noise”.
 * - It aggregates *all* numeric columns inside stats JSON automatically.
 */

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black
const DEFAULT_SEASON = "spring"; // set your default here

type MatchRow = {
  match_date: string | null;
  tournament: string | null;
  opponent: string | null;
  result: string | null; // "W"/"L" or "Won"/"Lost"
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
  stats: any; // jsonb from supabase (object or string)
};

function toNum(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  // accept numbers like "2", "2.29", "-0.43"
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
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

function boldName(name: string) {
  return `**${name}**`;
}

/**
 * Simple question intent detectors so we can keep responses tight (no noise).
 * If the question is narrow, we only send relevant facts.
 * If broad, we send a compact snapshot.
 */
function isBroadQuestion(q: string) {
  const s = q.toLowerCase();
  return (
    s.includes("strength") ||
    s.includes("weakness") ||
    s.includes("recap") ||
    s.includes("summarize") ||
    s.includes("season") ||
    s.includes("lineup") ||
    s.includes("starting") ||
    s.includes("rotation") ||
    s.includes("6-2") ||
    s.includes("plan") ||
    s.includes("improve") ||
    s.includes("trend")
  );
}

function wantsWinLoss(q: string) {
  const s = q.toLowerCase();
  return s.includes("win") || s.includes("loss") || s.includes("record");
}

function wantsToughOpponents(q: string) {
  const s = q.toLowerCase();
  return s.includes("tough") || s.includes("trouble") || s.includes("hardest") || s.includes("worst opponent");
}

/**
 * Map common human phrases → your JSON keys.
 * Add to this over time as you see real user questions.
 */
const STAT_ALIASES: Record<string, string> = {
  // serve receive / passing
  "passer rating": "serve_receive_passing_rating",
  "passing rating": "serve_receive_passing_rating",
  "serve receive": "serve_receive_passing_rating",
  "serve-receive": "serve_receive_passing_rating",
  "sr rating": "serve_receive_passing_rating",

  // attempts (used for weighted averages)
  "serve receive attempts": "serve_receive_attempts",
  "serve-receive attempts": "serve_receive_attempts",

  // common volleyball box stats
  kills: "attack_kills",
  "attack kills": "attack_kills",
  digs: "digs_successful",
  aces: "serve_aces",
  "serve errors": "serve_errors",
  "setting errors": "setting_errors",
  assists: "setting_assists",
  "setting assists": "setting_assists",

  // blocks
  blocks: "blocks_total",
  "total blocks": "blocks_total",
  "solo blocks": "blocks_solo",
  "block assists": "blocks_assist",
};

function findRequestedStatKey(question: string): string | null {
  const q = question.toLowerCase();

  // First: alias match
  for (const phrase of Object.keys(STAT_ALIASES)) {
    if (q.includes(phrase)) return STAT_ALIASES[phrase];
  }

  // Second: if user literally types an underscore key (power user mode)
  const m = q.match(/[a-z]+_[a-z0-9_]+/);
  if (m?.[0]) return m[0];

  return null;
}

/**
 * Pull just the data we need.
 * Keep it fast:
 * - match_results: needed for win/loss and toughest opponents
 * - player_game_stats: needed for stat leaders / passer rating / everything in CSV
 */
async function retrieveData(teamId: string, season: string) {
  const supabase = supabaseService();

  const { data: matches, error: em } = await supabase
    .from("match_results")
    .select("match_date,tournament,opponent,result,score,round,sets_won,sets_lost,set_diff")
    .eq("team_id", teamId)
    .order("match_date", { ascending: true })
    .limit(800);
  if (em) throw em;

  const { data: statsRows, error: es } = await supabase
    .from("player_game_stats")
    .select("player_name,position,game_date,opponent,stats")
    .eq("team_id", teamId)
    .eq("season", season)
    .order("game_date", { ascending: false })
    .limit(3000);
  if (es) throw es;

  return {
    matches: (matches ?? []) as MatchRow[],
    statsRows: (statsRows ?? []) as StatRow[],
  };
}

/**
 * IMPORTANT CHANGE:
 * We aggregate ALL numeric fields in stats JSON automatically.
 *
 * - totalsByPlayer[player][statKey] = season total
 * - Also compute weighted serve-receive rating if attempts exist:
 *     srWeightedSum / srAttempts
 */
function computeSeasonAggregates(matches: MatchRow[], statsRows: StatRow[]) {
  // ---- Win/Loss + opponent trouble
  let wins = 0;
  let losses = 0;

  const oppMatches: Record<string, number> = {};
  const oppLosses: Record<string, number> = {};
  const oppSetDiff: Record<string, number> = {};

  for (const m of matches) {
    const wl = normalizeWinLoss(m.result);
    const opp = (m.opponent ?? "").trim() || "Unknown Opponent";

    oppMatches[opp] = (oppMatches[opp] ?? 0) + 1;
    oppSetDiff[opp] = (oppSetDiff[opp] ?? 0) + (m.set_diff ?? 0);

    if (wl === "W") wins++;
    if (wl === "L") {
      losses++;
      oppLosses[opp] = (oppLosses[opp] ?? 0) + 1;
    }
  }

  const toughestOpponents = Object.keys(oppMatches)
    .map((opp) => ({
      opponent: opp,
      losses: oppLosses[opp] ?? 0,
      matches: oppMatches[opp] ?? 0,
      setDiff: oppSetDiff[opp] ?? 0,
    }))
    .filter((x) => x.losses > 0)
    .sort((a, b) => {
      // losses desc, then setDiff asc (more negative = worse)
      if (b.losses !== a.losses) return b.losses - a.losses;
      return a.setDiff - b.setDiff;
    })
    .slice(0, 6);

  // ---- Aggregate ALL numeric stats per player
  const totalsByPlayer: Record<string, Record<string, number>> = {};

  // For weighted SR rating
  const srAttempts: Record<string, number> = {};
  const srWeightedSum: Record<string, number> = {};

  for (const row of statsRows) {
    const player = (row.player_name ?? "").trim();
    if (!player) continue;

    const s = parseStats(row.stats);
    if (!totalsByPlayer[player]) totalsByPlayer[player] = {};

    // 1) Sum ALL numeric fields found in the JSON
    for (const [k, v] of Object.entries(s)) {
      const n = toNum(v);
      if (n === null) continue;

      totalsByPlayer[player][k] = (totalsByPlayer[player][k] ?? 0) + n;
    }

    // 2) Weighted SR rating (0–3 scale) if attempts exist
    const att = toNum(s["serve_receive_attempts"]) ?? 0;
    const rating = toNum(s["serve_receive_passing_rating"]) ?? 0;
    if (att > 0) {
      srAttempts[player] = (srAttempts[player] ?? 0) + att;
      srWeightedSum[player] = (srWeightedSum[player] ?? 0) + rating * att;
    }
  }

  // Compute best passer (weighted)
  let bestPasserPlayer = "";
  let bestPasserRating = -Infinity;
  let bestPasserAtt = 0;

  let teamAtt = 0;
  let teamSum = 0;

  for (const player of Object.keys(srAttempts)) {
    const att = srAttempts[player] ?? 0;
    const sum = srWeightedSum[player] ?? 0;
    if (att <= 0) continue;

    const r = sum / att;
    if (r > bestPasserRating) {
      bestPasserRating = r;
      bestPasserPlayer = player;
      bestPasserAtt = att;
    }

    teamAtt += att;
    teamSum += sum;
  }

  const teamSrRating = teamAtt > 0 ? teamSum / teamAtt : 0;

  return {
    wins,
    losses,
    toughestOpponents,
    totalsByPlayer,
    serveReceive: bestPasserPlayer
      ? {
          bestPlayer: bestPasserPlayer,
          bestRating: bestPasserRating,
          bestAttempts: bestPasserAtt,
          teamRating: teamSrRating,
          teamAttempts: teamAtt,
          scale: "0-3",
        }
      : null,
    hasMatches: matches.length > 0,
    hasStats: Object.keys(totalsByPlayer).length > 0,
  };
}

/**
 * Find a stat leader for ANY stat key (since we now store everything).
 * Example statKey: "setting_errors", "attack_kills", "blocks_total"
 */
function statLeader(totalsByPlayer: Record<string, Record<string, number>>, statKey: string) {
  let bestPlayer = "";
  let bestVal = -Infinity;

  for (const [player, totals] of Object.entries(totalsByPlayer)) {
    const v = totals?.[statKey];
    if (typeof v !== "number") continue;
    if (v > bestVal) {
      bestVal = v;
      bestPlayer = player;
    }
  }

  return bestPlayer ? { player: bestPlayer, value: bestVal } : null;
}

/**
 * Keep FACTS_JSON minimal to avoid noise.
 * - Narrow question: include only what’s needed.
 * - Broad question: include a compact snapshot.
 */
function buildFactsJSON(question: string, season: string, agg: ReturnType<typeof computeSeasonAggregates>) {
  const requestedStatKey = findRequestedStatKey(question);

  // Narrow: stat leader questions
  if (requestedStatKey) {
    const leader = statLeader(agg.totalsByPlayer, requestedStatKey);

    // Special case: passing rating is weighted by attempts (more meaningful)
    if (requestedStatKey === "serve_receive_passing_rating") {
      return {
        season,
        type: "serve_receive_rating",
        serveReceive: agg.serveReceive,
        availability: { hasStats: agg.hasStats },
      };
    }

    return {
      season,
      type: "stat_leader",
      statKey: requestedStatKey,
      leader,
      availability: { hasStats: agg.hasStats },
    };
  }

  // Narrow: win/loss
  if (wantsWinLoss(question)) {
    return {
      season,
      type: "win_loss",
      winLoss: agg.hasMatches ? { wins: agg.wins, losses: agg.losses } : null,
      availability: { hasMatches: agg.hasMatches },
    };
  }

  // Narrow: toughest opponents
  if (wantsToughOpponents(question)) {
    return {
      season,
      type: "toughest_opponents",
      toughestOpponents: agg.toughestOpponents,
      availability: { hasMatches: agg.hasMatches },
    };
  }

  // Broad: season snapshot
  if (isBroadQuestion(question)) {
    // leaders we often want for “strengths & weaknesses”
    const killsLeader = statLeader(agg.totalsByPlayer, "attack_kills");
    const digsLeader = statLeader(agg.totalsByPlayer, "digs_successful");
    const aceLeader = statLeader(agg.totalsByPlayer, "serve_aces");
    const serveErrLeader = statLeader(agg.totalsByPlayer, "serve_errors");

    return {
      season,
      type: "season_snapshot",
      record: agg.hasMatches ? { wins: agg.wins, losses: agg.losses } : null,
      serveReceive: agg.serveReceive,
      leaders: { killsLeader, digsLeader, aceLeader, serveErrLeader },
      toughestOpponents: agg.toughestOpponents,
      availability: { hasMatches: agg.hasMatches, hasStats: agg.hasStats },
    };
  }

  // Default minimal
  return {
    season,
    type: "default",
    availability: { hasMatches: agg.hasMatches, hasStats: agg.hasStats },
  };
}

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

async function callOpenAI(question: string, factsJSON: any) {
  assertEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";

  // Keep instructions simple so it behaves more like ChatGPT (answers the question asked).
  const system = `
You are "Volleyball Guru" for MVVC 14 Black.

Answer the user's question directly like ChatGPT.
Rules:
- Use ONLY FACTS_JSON for any stats/records/leaders.
- Do not dump unrelated stats.
- No hyphen dividers, no noisy sections.
- Use subtle emphasis for names: **Name**.
- If missing: say "Insufficient data in the current dataset." then ONE short line describing what data is missing.
`;

  const payload = { question, FACTS_JSON: factsJSON };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_output_tokens: 650,
      input: [
        { role: "system", content: [{ type: "input_text", text: system }] },
        { role: "user", content: [{ type: "input_text", text: JSON.stringify(payload) }] },
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

function fallbackAnswer(question: string, factsJSON: any) {
  // A guaranteed non-empty answer even if OpenAI fails.
  const t = factsJSON?.type;

  if (t === "serve_receive_rating") {
    const sr = factsJSON?.serveReceive;
    if (!sr) return "Insufficient data in the current dataset.\nNeed serve_receive_attempts + serve_receive_passing_rating.";
    return `Best passer rating: ${boldName(sr.bestPlayer)} — ${sr.bestRating.toFixed(2)} (0–3) on ${sr.bestAttempts} attempts.`;
  }

  if (t === "stat_leader") {
    const leader = factsJSON?.leader;
    if (!leader) return "Insufficient data in the current dataset.\nThat stat key was not found in player stats.";
    return `${factsJSON.statKey} leader: ${boldName(leader.player)} — ${leader.value}.`;
  }

  if (t === "win_loss") {
    const wl = factsJSON?.winLoss;
    if (!wl) return "Insufficient data in the current dataset.\nNeed match_results rows for this team/season.";
    return `Win/Loss: ${wl.wins}-${wl.losses}.`;
  }

  if (t === "toughest_opponents") {
    const opps = factsJSON?.toughestOpponents ?? [];
    if (!opps.length) return "Insufficient data in the current dataset.\nNeed match_results rows with opponent + result.";
    return `Toughest opponents (by losses): ${opps.slice(0, 3).map((o: any) => o.opponent).join(", ")}.`;
  }

  return "I couldn’t generate a response right now, but your data is loaded.";
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { question: string };
    const question = String(body.question ?? "").trim();
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    const season = DEFAULT_SEASON;

    // 1) Pull raw data fast
    const { matches, statsRows } = await retrieveData(TEAM_ID, season);

    // 2) Compute all season aggregates (including EVERY numeric field)
    const agg = computeSeasonAggregates(matches, statsRows);

    // 3) Build a minimal facts payload based on what the question asks
    const factsJSON = buildFactsJSON(question, season, agg);

    // 4) Ask model to answer directly (ChatGPT-like)
    let answer = "";
    try {
      answer = await callOpenAI(question, factsJSON);
    } catch {
      answer = "";
    }

    if (!answer) answer = fallbackAnswer(question, factsJSON);

    return NextResponse.json({ answer });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
