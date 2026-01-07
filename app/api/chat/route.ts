import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

/**
 * MVVC Coach Copilot — ChatGPT-like behavior
 * ------------------------------------------------------------
 * Goal: behave like ChatGPT (narrative + insight), while staying grounded in your Supabase data.
 *
 * Key design choice:
 * - ALWAYS call the model (no “try one of these prompts” fallbacks).
 * - Provide a compact, structured FACTS JSON (aggregates + leaders + position groups).
 * - Model must answer the user’s question first, then add only relevant supporting facts.
 *
 * This fixes:
 * - “Recap our season” returning a tiny snippet
 * - 6-2 lineup questions being ignored
 * - “Who leads in blocks?” getting a generic help message
 */

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black
const DEFAULT_SEASON = "spring"; // your statsRows show season="spring"

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

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
  position: string | null; // from table column
  game_date: string | null;
  opponent: string | null;
  stats: any; // jsonb: object or stringified JSON
};

/** ---------- Small helpers ---------- */

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

/**
 * Extract output text from Responses API safely.
 * Different models may return slightly different shapes; handle common ones.
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

/** ---------- Data fetch (keep it snappy) ---------- */

async function fetchTeamData(teamId: string, season: string, question: string) {
  const supabase = supabaseService();

  // Roster notes can help for “who plays what”, but keep it light.
  const { data: rosterChunks } = await supabase
    .from("knowledge_chunks")
    .select("id,title,content,tags")
    .eq("team_id", teamId)
    .contains("tags", ["roster"])
    .limit(10);

  // Match results: needed for record / recap / toughest opponents / trends.
  const { data: matches, error: em } = await supabase
    .from("match_results")
    .select("match_date,tournament,opponent,result,score,round,sets_won,sets_lost,set_diff")
    .eq("team_id", teamId)
    .order("match_date", { ascending: true })
    .limit(900);
  if (em) throw em;

  // Player stats rows: used for leaders, passer rating, blocks, assists, positions.
  const { data: statsRows, error: es } = await supabase
    .from("player_game_stats")
    .select("player_name,position,game_date,opponent,stats")
    .eq("team_id", teamId)
    .eq("season", season)
    .order("game_date", { ascending: false })
    .limit(2600);
  if (es) throw es;

  return {
    rosterChunks: rosterChunks ?? [],
    matches: (matches ?? []) as MatchRow[],
    statsRows: (statsRows ?? []) as StatRow[],
  };
}

/** ---------- Aggregations (fast, in-memory) ---------- */

type PlayerTotals = {
  player: string;
  // offense/defense
  kills: number;
  attackAttempts: number;
  attackErrors: number;
  attackPctWeightedSum: number; // attack_percentage * attempts, if available
  attackPctAttempts: number; // attempts used for weighting attack_percentage

  digs: number;

  // serving
  aces: number;
  serveErrors: number;

  // passing
  srAttempts: number;
  srWeightedSum: number; // sr_rating * attempts

  // setting
  assists: number;
  setAttempts: number;

  // blocking
  blocksSolo: number;
  blocksAssist: number;
  blocksTotal: number;
};

type Facts = {
  season: string;
  matchCount: number;
  statRowCount: number;

  winLoss: { wins: number; losses: number } | null;

  toughestOpponents: Array<{ opponent: string; losses: number; matches: number; setDiff: number }>;

  leaders: {
    kills?: { player: string; value: number };
    digs?: { player: string; value: number };
    aces?: { player: string; value: number };
    serveErrors?: { player: string; value: number };
    blocks?: { player: string; value: number } | null;
    assists?: { player: string; value: number } | null;
    passer?: { player: string; rating: number; attempts: number; teamRating: number; teamAttempts: number } | null;
  };

  // roster/positions
  positions: Record<string, string[]>; // player -> positions seen
  positionGroups: {
    setters: string[];
    opposites: string[];
    outsides: string[];
    middles: string[];
    liberosOrDS: string[];
    unknown: string[];
  };

  // “best opposite” helper (computed candidates)
  bestOppositeCandidate: { player: string; rationale: string } | null;

  // minimal warnings for missing stats
  missingSignals: string[];
};

function computeFacts(season: string, matches: MatchRow[], statsRows: StatRow[], rosterChunks: any[]): Facts {
  /** ---- Win/Loss + opponent trouble ---- */
  let wins = 0;
  let losses = 0;

  const oppLosses: Record<string, number> = {};
  const oppMatches: Record<string, number> = {};
  const oppSetDiff: Record<string, number> = {};

  for (const m of matches) {
    const wl = normalizeWinLoss(m.result);
    const opp = (m.opponent ?? "").trim() || "Unknown Opponent";
    oppMatches[opp] = (oppMatches[opp] ?? 0) + 1;

    if (wl === "W") wins++;
    if (wl === "L") {
      losses++;
      oppLosses[opp] = (oppLosses[opp] ?? 0) + 1;
    }
    oppSetDiff[opp] = (oppSetDiff[opp] ?? 0) + toNum(m.set_diff);
  }

  const toughestOpponents = Object.keys(oppMatches)
    .map((opp) => ({
      opponent: opp,
      losses: oppLosses[opp] ?? 0,
      matches: oppMatches[opp] ?? 0,
      setDiff: oppSetDiff[opp] ?? 0,
    }))
    .filter((x) => x.losses > 0)
    .sort((a, b) => (b.losses !== a.losses ? b.losses - a.losses : a.setDiff - b.setDiff))
    .slice(0, 10);

  const winLoss = matches.length ? { wins, losses } : null;

  /** ---- Player totals ---- */
  const totals: Record<string, PlayerTotals> = {};
  const positions: Record<string, Record<string, boolean>> = {};

  function ensure(player: string): PlayerTotals {
    if (!totals[player]) {
      totals[player] = {
        player,
        kills: 0,
        attackAttempts: 0,
        attackErrors: 0,
        attackPctWeightedSum: 0,
        attackPctAttempts: 0,
        digs: 0,
        aces: 0,
        serveErrors: 0,
        srAttempts: 0,
        srWeightedSum: 0,
        assists: 0,
        setAttempts: 0,
        blocksSolo: 0,
        blocksAssist: 0,
        blocksTotal: 0,
      };
    }
    return totals[player];
  }

  for (const row of statsRows) {
    const player = (row.player_name ?? "").trim();
    if (!player) continue;

    // capture position from column
    const posCol = (row.position ?? "").trim();
    if (!positions[player]) positions[player] = {};
    if (posCol) positions[player][posCol] = true;

    const s = parseStats(row.stats);
    const t = ensure(player);

    // offense
    t.kills += toNum(s.attack_kills);
    t.attackAttempts += toNum(s.attack_attempts);
    t.attackErrors += toNum(s.attack_errors);

    // some files provide attack_percentage; weight by attempts if possible
    const ap = toNum(s.attack_percentage);
    const aa = toNum(s.attack_attempts);
    if (aa > 0 && ap !== 0) {
      t.attackPctWeightedSum += ap * aa;
      t.attackPctAttempts += aa;
    }

    // defense
    t.digs += toNum(s.digs_successful);

    // serve
    t.aces += toNum(s.serve_aces);
    t.serveErrors += toNum(s.serve_errors);

    // passing
    const srAtt = toNum(s.serve_receive_attempts);
    const srRating = toNum(s.serve_receive_passing_rating); // 0–3
    if (srAtt > 0) {
      t.srAttempts += srAtt;
      t.srWeightedSum += srRating * srAtt;
    }

    // setting
    t.assists += toNum(s.setting_assists);
    t.setAttempts += toNum(s.setting_attempts);

    // blocking (fields often come as "", null, or number strings)
    const solo = toNum(s.blocks_solo);
    const assist = toNum(s.blocks_assist);
    t.blocksSolo += solo;
    t.blocksAssist += assist;
    t.blocksTotal += solo + assist;
  }

  const players = Object.keys(totals);

  function leaderNumber(get: (t: PlayerTotals) => number): { player: string; value: number } | null {
    let bestP = "";
    let bestV = -Infinity;
    for (const p of players) {
      const v = get(totals[p]);
      if (v > bestV) {
        bestV = v;
        bestP = p;
      }
    }
    return bestP ? { player: bestP, value: bestV } : null;
  }

  // passer leader (weighted SR)
  let bestPasser = "";
  let bestPasserRating = -Infinity;
  let bestPasserAttempts = 0;
  let teamSrAttempts = 0;
  let teamSrSum = 0;

  for (const p of players) {
    const t = totals[p];
    if (t.srAttempts > 0) {
      const r = t.srWeightedSum / t.srAttempts;
      if (r > bestPasserRating) {
        bestPasserRating = r;
        bestPasser = p;
        bestPasserAttempts = t.srAttempts;
      }
      teamSrAttempts += t.srAttempts;
      teamSrSum += t.srWeightedSum;
    }
  }

  const passer =
    bestPasser && teamSrAttempts > 0
      ? {
          player: bestPasser,
          rating: Number(bestPasserRating.toFixed(2)),
          attempts: bestPasserAttempts,
          teamRating: Number((teamSrSum / teamSrAttempts).toFixed(2)),
          teamAttempts: teamSrAttempts,
        }
      : null;

  // positions: make a nicer array form
  const positionsArr: Record<string, string[]> = {};
  for (const p of Object.keys(positions)) {
    positionsArr[p] = Object.keys(positions[p]).sort();
  }

  // crude role grouping (good enough for “best opposite”, “6-2 lineup”)
  const group = {
    setters: [] as string[],
    opposites: [] as string[],
    outsides: [] as string[],
    middles: [] as string[],
    liberosOrDS: [] as string[],
    unknown: [] as string[],
  };

  function classifyPositions(posList: string[]) {
    const joined = posList.join(" ").toLowerCase();
    const isSetter = joined.includes("setter") || joined.includes("s");
    const isOpp = joined.includes("opposite") || joined.includes("opp") || joined.includes("op");
    const isOH = joined.includes("outside") || joined.includes("oh");
    const isMB = joined.includes("middle") || joined.includes("mb");
    const isLib = joined.includes("libero") || joined.includes("ds") || joined.includes("defensive");
    return { isSetter, isOpp, isOH, isMB, isLib };
  }

  for (const p of players.sort((a, b) => a.localeCompare(b))) {
    const posList = positionsArr[p] ?? [];
    const c = classifyPositions(posList);
    if (c.isSetter) group.setters.push(p);
    if (c.isOpp) group.opposites.push(p);
    if (c.isOH) group.outsides.push(p);
    if (c.isMB) group.middles.push(p);
    if (c.isLib) group.liberosOrDS.push(p);
    if (!posList.length) group.unknown.push(p);
  }

  // Best opposite candidate: among opposites, choose composite (kills + efficiency)
  let bestOpp: { player: string; score: number; rationale: string } | null = null;
  for (const p of group.opposites) {
    const t = totals[p];
    const eff = t.attackPctAttempts > 0 ? t.attackPctWeightedSum / t.attackPctAttempts : 0;
    // composite: kills are king; efficiency helps break ties if present
    const score = t.kills * 1.0 + eff * 50; // small bump from efficiency
    const rationale = `kills=${t.kills}${t.attackPctAttempts > 0 ? `, attack%≈${eff.toFixed(2)}` : ""}`;
    if (!bestOpp || score > bestOpp.score) bestOpp = { player: p, score, rationale };
  }

  // missing signals for nicer “insufficient data” messages
  const missingSignals: string[] = [];
  const blocksLeader = leaderNumber((t) => t.blocksTotal);
  if (!blocksLeader || (blocksLeader && blocksLeader.value === 0)) missingSignals.push("No usable blocks_solo/blocks_assist found in player_game_stats.stats.");
  const assistsLeader = leaderNumber((t) => t.assists);
  if (!assistsLeader || (assistsLeader && assistsLeader.value === 0)) missingSignals.push("No usable setting_assists found in player_game_stats.stats.");

  return {
    season,
    matchCount: matches.length,
    statRowCount: statsRows.length,
    winLoss,
    toughestOpponents,
    leaders: {
      kills: leaderNumber((t) => t.kills) ?? undefined,
      digs: leaderNumber((t) => t.digs) ?? undefined,
      aces: leaderNumber((t) => t.aces) ?? undefined,
      serveErrors: leaderNumber((t) => t.serveErrors) ?? undefined,
      blocks: blocksLeader ? { player: blocksLeader.player, value: blocksLeader.value } : null,
      assists: assistsLeader ? { player: assistsLeader.player, value: assistsLeader.value } : null,
      passer,
    },
    positions: positionsArr,
    positionGroups: group,
    bestOppositeCandidate: bestOpp ? { player: bestOpp.player, rationale: bestOpp.rationale } : null,
    missingSignals,
  };
}

/** ---------- Model call: ChatGPT-like output ---------- */

async function callOpenAI(question: string, facts: Facts, rosterChunks: any[]) {
  assertEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";

  // Keep notes short; the model already has structured positions from stats.
  const rosterNotes = (rosterChunks ?? [])
    .slice(0, 4)
    .map((c: any) => ({
      title: String(c.title ?? "").trim(),
      content: String(c.content ?? "").trim().slice(0, 600),
    }))
    .filter((x: any) => x.title || x.content);

  const system = `
You are "Coaching Assistant" for MVVC 14 Black.

Behave like ChatGPT:
- Answer the user’s exact question directly (do not ask them to “pick an angle”).
- Use the dataset to generate a helpful narrative and practical coaching insight.

Critical rules:
- Do NOT dump unrelated stats. Include only stats that support the answer.
- If a stat is missing (e.g., blocks), say what is missing in one short line and still give a helpful coaching answer.

Style rules:
- No hyphen dividers (no "-----").
- Use short paragraphs and clean bullets only when helpful.
- Player names should be subtly emphasized with **bold** (example: **Koa Tuyay**).
- Team/opponent names should be plain text (no weird brackets).
- If the user asks for a lineup (especially “6-2”), you MUST actually propose a lineup structure:
  - Identify 2 setters and 2 opposites (if possible from positions/assists)
  - Identify primary passers/libero and middles
  - Explain assumptions if role data is incomplete
`;

  const userPayload = {
    question,
    facts,
    rosterNotes,
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_output_tokens: 900,
      input: [
        { role: "system", content: [{ type: "input_text", text: system }] },
        { role: "user", content: [{ type: "input_text", text: JSON.stringify(userPayload) }] },
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

/** ---------- Always return something useful ---------- */

function localFallback(question: string, facts: Facts): string {
  // This only triggers if OpenAI fails — but still behaves “ChatGPT-ish”.
  const q = question.toLowerCase();

  if (q.includes("block")) {
    if (!facts.leaders.blocks || facts.leaders.blocks.value === 0) {
      return `Blocks leader\nI don’t have usable blocks totals in your stats yet.\nIf you export blocks_solo/blocks_assist into player_game_stats.stats, I’ll rank them automatically.\nCoaching note: until blocks are tracked, use eye-test + video—who consistently forms a solid seal and gets controlled touches?`;
    }
    return `Blocks leader\n${facts.leaders.blocks.player} (${facts.leaders.blocks.value} total blocks)\nCoaching note: confirm whether “blocks_assist” is recorded consistently—some stat exports undercount assists.`;
  }

  if (q.includes("opposite") || q.includes("opp")) {
    if (!facts.bestOppositeCandidate) {
      return `Best opposite (data-driven)\nI can’t confidently identify an opposite from the current position data.\nIf you tag players as Opposite/OPP (or confirm who is playing opposite), I can rank by kills + efficiency.\nCoaching note: best opposite usually = reliable sideout + can score in transition + blocks well vs OH.`;
    }
    return `Best opposite (data-driven)\n${facts.bestOppositeCandidate.player}\nWhy: ${facts.bestOppositeCandidate.rationale}\nCoaching note: sanity-check this against role usage—if that player is only occasionally OPP, we should filter by rotations played at OPP.`;
  }

  if (q.includes("6-2") && (q.includes("lineup") || q.includes("projected"))) {
    // lightweight fallback: name top setters by assists and top opps by candidate lists
    const setterHint = facts.positionGroups.setters.length ? facts.positionGroups.setters.join(", ") : "Setter labels not found";
    const oppHint = facts.positionGroups.opposites.length ? facts.positionGroups.opposites.join(", ") : "Opposite labels not found";
    return `Projected 6-2 lineup (best-effort)\nSetters (2): ${setterHint}\nOpposites (2): ${oppHint}\nMiddles: ${facts.positionGroups.middles.join(", ") || "MB labels not found"}\nOutsides: ${facts.positionGroups.outsides.join(", ") || "OH labels not found"}\nLibero/DS: ${facts.positionGroups.liberosOrDS.join(", ") || "L/DS labels not found"}\nNote: For a true 6-2, confirm your two setters and two opposites (positions) so I can lock a rotation-by-rotation plan.`;
  }

  // General recap fallback
  const parts: string[] = [];
  parts.push("Season recap (data-driven snapshot)");
  if (facts.winLoss) parts.push(`Record: ${facts.winLoss.wins}-${facts.winLoss.losses}`);
  if (facts.leaders.kills) parts.push(`Kills leader: ${facts.leaders.kills.player} (${facts.leaders.kills.value})`);
  if (facts.leaders.passer) parts.push(`Best passer rating (0–3): ${facts.leaders.passer.player} (${facts.leaders.passer.rating} on ${facts.leaders.passer.attempts})`);
  if (facts.toughestOpponents.length) parts.push(`Toughest opponents: ${facts.toughestOpponents.slice(0, 3).map((t) => t.opponent).join(", ")}`);
  parts.push("Coaching note: if you want a deeper recap, I need either set-by-set momentum notes or video tags (runs, rotations, sideout/transition).");
  return parts.join("\n");
}

/** ---------- Route ---------- */

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { question: string };
    const question = String(body.question ?? "").trim();
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    const teamId = TEAM_ID;
    const season = DEFAULT_SEASON;

    const { rosterChunks, matches, statsRows } = await fetchTeamData(teamId, season, question);
    const facts = computeFacts(season, matches, statsRows, rosterChunks);

    let answer = "";
    try {
      answer = await callOpenAI(question, facts, rosterChunks);
    } catch {
      answer = "";
    }

    if (!answer) {
      answer = localFallback(question, facts);
    }

    return NextResponse.json({ answer });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
