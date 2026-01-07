import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

/**
 * MVVC Coach Copilot - Chat API (2025–26)
 *
 * Design goals:
 * - Answer like ChatGPT: directly answer the question asked.
 * - Broad questions => narrative coaching response.
 * - Narrow questions => short answer, minimal noise.
 * - Facts MUST come from Supabase-derived FACTS_JSON only.
 * - Avoid "Try these prompts..." unless user asked for prompts.
 * - Highlight ALL player names consistently (no perceived favoritism).
 */

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black

// Treat “season” as 2025–26 year window (Aug 1, 2025 → Aug 1, 2026 exclusive)
const SEASON_START = "2025-08-01";
const SEASON_END_EXCLUSIVE = "2026-08-01";

const PERSONA = "Volleyball Guru";

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
  stats: any; // jsonb (object or stringified JSON)
};

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
  // "2025-11-09" -> "2025-11"
  return isoDate.slice(0, 7);
}

function fmtName(name: string) {
  // Consistent subtle emphasis
  return `**${name}**`;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Highlight ALL known player names in the final answer.
 * This prevents “only Koa is bolded” perceptions.
 */
function highlightAllPlayerNames(answer: string, playerNames: string[]) {
  if (!answer) return answer;
  const names = Array.from(new Set((playerNames || []).map((n) => (n || "").trim()).filter(Boolean))).sort(
    (a, b) => b.length - a.length
  );

  let out = answer;
  for (const name of names) {
    const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, "g");
    out = out.replace(re, `**${name}**`);
  }
  return out;
}

/** ---------------------- Intent detection (routing) ---------------------- **/

function s(q: string) {
  return (q || "").toLowerCase().trim();
}

function isPromptsQuestion(q: string) {
  const t = s(q);
  return t.includes("suggested prompt") || t.includes("suggest prompts") || t.includes("example prompt");
}

function isLineupQuestion(q: string) {
  const t = s(q);
  return (
    t.includes("6-2") ||
    t.includes("6 2") ||
    t.includes("lineup") ||
    t.includes("starting six") ||
    t.includes("starting 6") ||
    t.includes("rotation") ||
    t.includes("projected") ||
    t.includes("who should start")
  );
}

function isDefinitionQuestion(q: string) {
  const t = s(q);
  // These must behave like ChatGPT definitions, not season recaps.
  return (
    t.startsWith("what is ") ||
    t.startsWith("what’s ") ||
    t.startsWith("whats ") ||
    t.startsWith("define ") ||
    t.includes("what is a 6-2") ||
    t.includes("what is 6-2") ||
    t.includes("what is a 6 2")
  );
}

function isRosterQuestion(q: string) {
  const t = s(q);
  return t.includes("roster") || t.includes("who plays which") || t.includes("positions");
}

function isMonthByMonthQuestion(q: string) {
  const t = s(q);
  return t.includes("month") || t.includes("month over month") || t.includes("mom") || t.includes("trend");
}

function isPassingQuestion(q: string) {
  const t = s(q);
  return t.includes("pass") || t.includes("serve receive") || t.includes("serve-receive") || t.includes("sr");
}

function isLeadersQuestion(q: string) {
  const t = s(q);
  return t.includes("leaders") || t.includes("top 5") || t.includes("top five") || t.includes("top 3") || t.includes("top three");
}

function isBroadQuestion(q: string) {
  const t = s(q);

  // Broad coaching intents (narrative)
  const broadSignals = [
    "recap",
    "summarize",
    "season",
    "so far",
    "strength",
    "weakness",
    "improve",
    "improvement",
    "recommend",
    "development",
    "tactics",
    "game plan",
    "beat",
    "how do we",
    "position battle",
    "optimal position",
    "switch position",
    "move to",
    "lineup",
    "starting",
    "rotation",
    "6-2",
    "6 2",
    "gaps",
    "add players",
    "recruit",
    "what type of players",
    "who should we add",
  ];

  return broadSignals.some((k) => t.includes(k)) || isMonthByMonthQuestion(q) || isLeadersQuestion(q);
}

/**
 * Try to extract a stat key from a question for month-by-month.
 * Example: "Month-by-month team kills" -> "attack_kills"
 */
function inferStatKeyFromQuestion(q: string): string {
  const t = s(q);

  // Map friendly words to your stats JSON keys
  const map: Array<{ includes: string[]; key: string }> = [
    { includes: ["kill", "kills"], key: "attack_kills" },
    { includes: ["dig", "digs"], key: "digs_successful" },
    { includes: ["ace", "aces"], key: "serve_aces" },
    { includes: ["serve error", "serve errors"], key: "serve_errors" },
    { includes: ["assist", "assists", "setting assists"], key: "setting_assists" },
    { includes: ["setting error", "setting errors"], key: "setting_errors" },
    { includes: ["block", "blocks", "solo block", "solo blocks"], key: "blocks_solo" },
    { includes: ["block assist", "block assists"], key: "blocks_assist" },
    { includes: ["attack error", "attack errors"], key: "attack_errors" },
    { includes: ["attempt", "attempts", "attack attempts"], key: "attack_attempts" },
  ];

  for (const m of map) {
    if (m.includes.some((w) => t.includes(w))) return m.key;
  }

  // Default for month-by-month if nothing obvious is mentioned:
  // Serve receive rating is computed separately.
  return "";
}

/** ---------------------- Data fetching (fast) ---------------------- **/

/**
 * Fetch only what we need, as fast as possible.
 * - Notes/roster chunks only fetched for broad questions.
 * - DB queries run in parallel to reduce latency.
 */
async function retrieveData(teamId: string, question: string) {
  const supabase = supabaseService();
  const broad = isBroadQuestion(question) || isRosterQuestion(question);

  const cleaned = question.replace(/[^a-zA-Z0-9 ]/g, " ");

  const rosterPromise = broad
    ? supabase
        .from("knowledge_chunks")
        .select("id,title,content,tags")
        .eq("team_id", teamId)
        .contains("tags", ["roster"])
        .limit(10)
    : Promise.resolve({ data: [] as any[], error: null as any });

  const notesPromise = broad
    ? supabase
        .from("knowledge_chunks")
        .select("id,title,content,tags")
        .eq("team_id", teamId)
        .textSearch("tsv", cleaned, { type: "websearch" })
        .limit(10)
    : Promise.resolve({ data: [] as any[], error: null as any });

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

  const [rosterRes, notesRes, matchesRes, statsRes] = await Promise.all([
    rosterPromise,
    notesPromise,
    matchesPromise,
    statsPromise,
  ]);

  if (rosterRes.error) throw rosterRes.error;
  if (notesRes.error) throw notesRes.error;
  if (matchesRes.error) throw matchesRes.error;
  if (statsRes.error) throw statsRes.error;

  // Merge + dedupe chunks
  const merged = new Map<number, any>();
  (rosterRes.data ?? []).forEach((c: any) => merged.set(c.id, c));
  (notesRes.data ?? []).forEach((c: any) => merged.set(c.id, c));
  const chunks = Array.from(merged.values());

  return {
    chunks,
    matches: (matchesRes.data ?? []) as MatchRow[],
    statsRows: (statsRes.data ?? []) as StatRow[],
  };
}

/** ---------------------- Aggregations (all stats + MoM) ---------------------- **/

/**
 * Core aggregation engine:
 * - sums EVERY numeric-ish stat field per player (kills, digs, setting_errors, blocks, etc.)
 * - supports weighted SR rating if serve_receive_attempts + serve_receive_passing_rating exist
 * - month-by-month totals for ANY stat key + month-by-month SR + top passers each month
 */
function computeAggregates(matches: MatchRow[], statsRows: StatRow[]) {
  // W/L + opponent trouble
  let wins = 0;
  let losses = 0;

  const oppLosses: Record<string, number> = {};
  const oppMatches: Record<string, number> = {};
  const oppSetDiff: Record<string, number> = {};

  for (const m of matches) {
    const wl = normalizeWinLoss(m.result);
    const opp = (m.opponent ?? "").trim() || "Unknown Opponent";

    oppMatches[opp] = (oppMatches[opp] ?? 0) + 1;
    oppSetDiff[opp] = (oppSetDiff[opp] ?? 0) + toNum(m.set_diff);

    if (wl === "W") wins++;
    if (wl === "L") {
      losses++;
      oppLosses[opp] = (oppLosses[opp] ?? 0) + 1;
    }
  }

  // Per-player totals across all keys
  type PlayerAgg = {
    position: string | null;
    totals: Record<string, number>;
    srAttempts: number;
    srWeightedSum: number;
  };

  const byPlayer: Record<string, PlayerAgg> = {};

  // Month-by-month team totals for ANY key
  const teamByMonth: Record<string, Record<string, number>> = {};

  // Month-by-month SR team totals
  const srByMonth: Record<string, { attempts: number; weightedSum: number }> = {};

  // Month-by-month per player SR (for “Top 5 passers each month”)
  const passerByMonth: Record<string, Record<string, { attempts: number; weightedSum: number }>> = {};

  for (const row of statsRows) {
    const player = (row.player_name ?? "").trim();
    if (!player) continue;

    const stats = parseStats(row.stats);
    const pos = (row.position ?? stats.position ?? null) as string | null;

    // Use game_date (ISO) for MoM
    const iso = (row.game_date ?? "").toString().trim();
    const mk = iso && iso.includes("-") ? monthKey(iso) : "";

    if (!byPlayer[player]) {
      byPlayer[player] = { position: pos, totals: {}, srAttempts: 0, srWeightedSum: 0 };
    }
    if (!byPlayer[player].position && pos) byPlayer[player].position = pos;

    // Sum every numeric-like field in stats
    for (const key of Object.keys(stats)) {
      // Skip obvious non-stat fields
      if (key === "player_name" || key === "position" || key === "opponent" || key === "match_date" || key === "source_file") {
        continue;
      }

      const n = toNum(stats[key]);
      if (n === 0) continue;

      byPlayer[player].totals[key] = (byPlayer[player].totals[key] ?? 0) + n;

      if (mk) {
        teamByMonth[mk] = teamByMonth[mk] ?? {};
        teamByMonth[mk][key] = (teamByMonth[mk][key] ?? 0) + n;
      }
    }

    // Serve receive weighted rating support (0–3)
    const srAtt = toNum(stats.serve_receive_attempts);
    const srRating = toNum(stats.serve_receive_passing_rating);
    if (srAtt > 0) {
      byPlayer[player].srAttempts += srAtt;
      byPlayer[player].srWeightedSum += srRating * srAtt;

      if (mk) {
        srByMonth[mk] = srByMonth[mk] ?? { attempts: 0, weightedSum: 0 };
        srByMonth[mk].attempts += srAtt;
        srByMonth[mk].weightedSum += srRating * srAtt;

        passerByMonth[mk] = passerByMonth[mk] ?? {};
        passerByMonth[mk][player] = passerByMonth[mk][player] ?? { attempts: 0, weightedSum: 0 };
        passerByMonth[mk][player].attempts += srAtt;
        passerByMonth[mk][player].weightedSum += srRating * srAtt;
      }
    }
  }

  // Team SR overall
  let teamSrAttempts = 0;
  let teamSrWeightedSum = 0;
  for (const p of Object.keys(byPlayer)) {
    teamSrAttempts += byPlayer[p].srAttempts;
    teamSrWeightedSum += byPlayer[p].srWeightedSum;
  }
  const teamSrRating = teamSrAttempts > 0 ? teamSrWeightedSum / teamSrAttempts : 0;

  // Trouble opponents (losses desc, then setDiff asc)
  const troubleOpponents = Object.keys(oppMatches)
    .map((opp) => ({
      opponent: opp,
      losses: oppLosses[opp] ?? 0,
      matches: oppMatches[opp] ?? 0,
      setDiff: oppSetDiff[opp] ?? 0,
    }))
    .filter((x) => x.losses > 0)
    .sort((a, b) => {
      if (b.losses !== a.losses) return b.losses - a.losses;
      return a.setDiff - b.setDiff;
    })
    .slice(0, 10);

  return {
    wins,
    losses,
    hasMatches: matches.length > 0,
    hasStats: Object.keys(byPlayer).length > 0,
    byPlayer,
    teamByMonth,
    srByMonth,
    passerByMonth,
    teamSr: { rating: teamSrRating, attempts: teamSrAttempts },
    troubleOpponents,
  };
}

/** ---------------------- Helpers: leaderboards & passers ---------------------- **/

function topNForKey(byPlayer: Record<string, { totals: Record<string, number> }>, key: string, n: number) {
  return Object.keys(byPlayer)
    .map((p) => ({ player: p, value: toNum(byPlayer[p].totals[key]) }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}

function topNPassersOverall(byPlayer: Record<string, { srAttempts: number; srWeightedSum: number }>, n: number) {
  return Object.keys(byPlayer)
    .map((p) => {
      const att = byPlayer[p].srAttempts;
      const sum = byPlayer[p].srWeightedSum;
      const r = att > 0 ? sum / att : 0;
      return { player: p, rating: r, attempts: att };
    })
    .filter((x) => x.attempts > 0)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, n);
}

function topNPassersEachMonth(
  passerByMonth: Record<string, Record<string, { attempts: number; weightedSum: number }>>,
  n: number
) {
  const out: Array<{ month: string; rows: Array<{ player: string; rating: number; attempts: number }> }> = [];
  const months = Object.keys(passerByMonth).sort();

  for (const m of months) {
    const players = passerByMonth[m];
    const rows = Object.keys(players)
      .map((p) => {
        const att = players[p].attempts;
        const r = att > 0 ? players[p].weightedSum / att : 0;
        return { player: p, rating: r, attempts: att };
      })
      .filter((x) => x.attempts > 0)
      .sort((a, b) => b.rating - a.rating)
      .slice(0, n);

    out.push({ month: m, rows });
  }

  return out;
}

/** ---------------------- Notes for broad questions ---------------------- **/

function buildNotes(chunks: any[]) {
  if (!chunks?.length) return "";
  const parts: string[] = [];

  for (const c of chunks.slice(0, 10)) {
    const title = String(c.title ?? "").trim();
    const content = String(c.content ?? "").trim();
    if (!title && !content) continue;

    if (title) parts.push(title);
    if (content) parts.push(content);
    parts.push("");
  }

  return parts.join("\n").trim();
}

/** ---------------------- Facts payload (question-specific) ---------------------- **/

function buildFactsPayload(question: string, agg: ReturnType<typeof computeAggregates>, notes: string) {
  const q = question.trim().toLowerCase();

  const base = {
    window: { start: SEASON_START, endExclusive: SEASON_END_EXCLUSIVE },
    winLoss: agg.hasMatches ? { wins: agg.wins, losses: agg.losses } : null,
    teamServeReceive:
      agg.teamSr.attempts > 0
        ? { scale: "0-3", rating: Number(agg.teamSr.rating.toFixed(2)), attempts: agg.teamSr.attempts }
        : null,
    troubleOpponents: agg.troubleOpponents.slice(0, 6),
  };

  // Definitions should behave like ChatGPT: no stats required.
  if (isDefinitionQuestion(question)) {
    return { type: "definition", ...base };
  }

  // Roster/positions: use notes primarily
  if (isRosterQuestion(question)) {
    return { type: "roster", ...base, notes };
  }

  // Lineup questions: send only what’s helpful for lineup decisions
  if (isLineupQuestion(question)) {
    const killsTop = topNForKey(agg.byPlayer as any, "attack_kills", 8);
    const assistsTop = topNForKey(agg.byPlayer as any, "setting_assists", 8);
    const blocksSoloTop = topNForKey(agg.byPlayer as any, "blocks_solo", 8);
    const blocksAssistTop = topNForKey(agg.byPlayer as any, "blocks_assist", 8);
    const bestPassersTop = topNPassersOverall(agg.byPlayer, 8).map((r) => ({
      player: r.player,
      rating: Number(r.rating.toFixed(2)),
      attempts: r.attempts,
    }));

    return {
      type: "lineup",
      ...base,
      candidates: {
        killsTop,
        assistsTop,
        blocksSoloTop,
        blocksAssistTop,
        bestPassersTop,
      },
      // Provide any roster notes that might mention positions
      notes,
    };
  }

  // Passing questions: support top N + month-by-month top passers
  if (isPassingQuestion(question)) {
    const wantsTop3 = q.includes("top 3") || q.includes("top three");
    const wantsTop5 = q.includes("top 5") || q.includes("top five");
    const n = wantsTop5 ? 5 : wantsTop3 ? 3 : 1;

    const overallTop = topNPassersOverall(agg.byPlayer, Math.max(n, 5)).map((r) => ({
      player: r.player,
      rating: Number(r.rating.toFixed(2)),
      attempts: r.attempts,
    }));

    const wantsEachMonth = q.includes("each month") || q.includes("per month") || q.includes("month");
    const byMonthTop5 = wantsEachMonth ? topNPassersEachMonth(agg.passerByMonth, 5) : null;

    return {
      type: "serve_receive",
      ...base,
      requested: { topN: n, eachMonth: wantsEachMonth },
      overallTop,
      byMonthTop5,
    };
  }

  // Leaders questions: top 5 across a set of common keys
  if (isLeadersQuestion(question)) {
    const commonKeys = [
      "attack_kills",
      "digs_successful",
      "serve_aces",
      "serve_errors",
      "setting_assists",
      "setting_errors",
      "blocks_solo",
      "blocks_assist",
      "attack_errors",
      "attack_attempts",
    ];

    const leaderboards: Record<string, Array<{ player: string; value: number }>> = {};
    for (const key of commonKeys) {
      const rows = topNForKey(agg.byPlayer as any, key, 5);
      if (rows.length) leaderboards[key] = rows;
    }

    return {
      type: "leaderboards",
      ...base,
      leaderboards,
      note: "Leaderboards are computed by summing each stat across all matches in the 2025–26 window.",
    };
  }

  // Month-by-month for ANY stat key
  if (isMonthByMonthQuestion(question)) {
    const key = inferStatKeyFromQuestion(question);

    // Team SR by month always available if SR exists
    const teamServeReceiveByMonth = Object.keys(agg.srByMonth)
      .sort()
      .map((m) => {
        const x = agg.srByMonth[m];
        const r = x.attempts > 0 ? x.weightedSum / x.attempts : 0;
        return { month: m, scale: "0-3", rating: Number(r.toFixed(2)), attempts: x.attempts };
      });

    // Any numeric stat key month-by-month totals
    const statByMonth =
      key && Object.keys(agg.teamByMonth).length
        ? Object.keys(agg.teamByMonth)
            .sort()
            .map((m) => ({ month: m, key, value: toNum(agg.teamByMonth[m]?.[key]) }))
        : null;

    return {
      type: "month_over_month",
      ...base,
      inferredKey: key || null,
      statByMonth,
      teamServeReceiveByMonth,
    };
  }

  // Broad coaching: include a compact snapshot across key areas
  if (isBroadQuestion(question)) {
    const snapshot = {
      killsTop5: topNForKey(agg.byPlayer as any, "attack_kills", 5),
      digsTop5: topNForKey(agg.byPlayer as any, "digs_successful", 5),
      acesTop5: topNForKey(agg.byPlayer as any, "serve_aces", 5),
      serveErrorsTop5: topNForKey(agg.byPlayer as any, "serve_errors", 5),
      assistsTop5: topNForKey(agg.byPlayer as any, "setting_assists", 5),
      settingErrorsTop5: topNForKey(agg.byPlayer as any, "setting_errors", 5),
      blocksSoloTop5: topNForKey(agg.byPlayer as any, "blocks_solo", 5),
      blocksAssistTop5: topNForKey(agg.byPlayer as any, "blocks_assist", 5),
      bestPassersTop5: topNPassersOverall(agg.byPlayer, 5).map((r) => ({
        player: r.player,
        rating: Number(r.rating.toFixed(2)),
        attempts: r.attempts,
      })),
    };

    return {
      type: "broad_coaching",
      ...base,
      snapshot,
      notes,
    };
  }

  // Minimal fallback facts
  return { type: "minimal", ...base };
}

/** ---------------------- OpenAI call (snappy + correct) ---------------------- **/

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
  const narrow = !broad && !isLineupQuestion(question) && !isMonthByMonthQuestion(question) && !isLeadersQuestion(question);

  // Smaller token budgets = faster responses
  const maxTokens = broad ? 1000 : narrow ? 350 : 700;

  const askedForPrompts = isPromptsQuestion(question);

  const system = `
You are "${PERSONA}" for MVVC 14 Black boys volleyball.

Answer like ChatGPT: directly answer the question asked.

Hard rules:
- Do NOT echo the question.
- Do NOT dump unrelated stats.
- Do NOT output "Try these prompts" unless the user asked for prompts.
- Do NOT use hyphen dividers (no "-----") and do NOT use hyphen bullets.
  Use short headings and either numbered lists or • bullets.

Facts:
- You receive FACTS_JSON which is the ONLY source of factual claims.
- If the needed fact is missing, say what's missing and how to fix it.

Response behavior by type:
- If FACTS_JSON.type === "definition": give a clean volleyball definition (no season recap).
- If type === "lineup": answer as a lineup (especially for 6-2). Provide a best-effort lineup + rotation logic.
- If type === "serve_receive": if asked for top 3/5, list top 3/5 (not just one). If asked by month, show month blocks.
- If type === "leaderboards": show top 5 across key categories, grouped by category.
- If type === "month_over_month": show month-by-month for the inferred stat; if no stat inferred, ask what stat they want and suggest 3 examples.
- If type === "broad_coaching": write a real narrative (12–30 lines). Include practical next steps.

Make sure you mention what is data-backed vs coaching inference naturally in the wording (but do NOT create separate sections unless it helps clarity).
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
  const answer = safeExtractOutputText(json);

  // If user didn't ask for prompts, discourage prompt-dumping (instruction should already prevent it)
  if (!askedForPrompts && answer.toLowerCase().includes("try:")) return answer;

  return answer;
}

/** ---------------------- Deterministic fallback (still answers) ---------------------- **/

function fallbackAnswer(question: string, factsPayload: any) {
  const t = s(question);
  const lines: string[] = [];

  if (factsPayload?.type === "definition") {
    lines.push("A 6-2 offense (simple definition)");
    lines.push("A 6-2 means you play two setters and they set only when they are in the back row.");
    lines.push("That keeps three front-row hitters available at all times, but requires subs and good serve-receive to run smoothly.");
    return lines.join("\n");
  }

  if (factsPayload?.type === "serve_receive") {
    const n = factsPayload?.requested?.topN ?? 1;
    const overall = factsPayload?.overallTop ?? [];
    const byMonth = factsPayload?.byMonthTop5 ?? null;

    if (byMonth && (t.includes("each month") || t.includes("per month") || t.includes("month"))) {
      lines.push("Top passers each month (0–3 serve-receive)");
      for (const block of byMonth) {
        lines.push(`${block.month}`);
        const rows = (block.rows ?? []).slice(0, 5);
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          lines.push(`${i + 1}) ${fmtName(r.player)}  ${Number(r.rating).toFixed(2)} on ${r.attempts}`);
        }
        lines.push("");
      }
      return lines.join("\n").trim();
    }

    lines.push(n === 1 ? "Best passer rating (0–3 serve-receive)" : `Top ${n} passers (0–3 serve-receive)`);
    if (!overall.length) {
      lines.push("Insufficient data in the current dataset.");
      lines.push("Missing serve_receive_attempts and serve_receive_passing_rating fields in player stats.");
      return lines.join("\n");
    }
    const slice = overall.slice(0, n);
    for (let i = 0; i < slice.length; i++) {
      const r = slice[i];
      lines.push(`${i + 1}) ${fmtName(r.player)}  ${Number(r.rating).toFixed(2)} on ${r.attempts} attempts`);
    }
    return lines.join("\n");
  }

  if (factsPayload?.type === "leaderboards") {
    lines.push("Top 5 leaders by category (season totals, 2025–26)");

    const pretty: Record<string, string> = {
      attack_kills: "Kills",
      digs_successful: "Digs",
      serve_aces: "Aces",
      serve_errors: "Serve errors",
      setting_assists: "Assists",
      setting_errors: "Setting errors",
      blocks_solo: "Solo blocks",
      blocks_assist: "Block assists",
      attack_errors: "Attack errors",
      attack_attempts: "Attack attempts",
    };

    const lb = factsPayload?.leaderboards ?? {};
    const keys = Object.keys(pretty).filter((k) => Array.isArray(lb[k]) && lb[k].length);

    if (!keys.length) {
      lines.push("Insufficient data in the current dataset.");
      lines.push("Missing player_game_stats rows within the 2025–26 window.");
      return lines.join("\n");
    }

    for (const k of keys) {
      lines.push("");
      lines.push(pretty[k] ?? k);
      const rows = lb[k].slice(0, 5);
      for (let i = 0; i < rows.length; i++) {
        lines.push(`${i + 1}) ${fmtName(rows[i].player)}  ${rows[i].value}`);
      }
    }
    return lines.join("\n").trim();
  }

  if (factsPayload?.type === "month_over_month") {
    const inferred = factsPayload?.inferredKey;
    if (!inferred || !factsPayload?.statByMonth) {
      lines.push("Month-by-month tracking");
      lines.push("Tell me which stat you want month-by-month (examples: kills, aces, digs, assists, serve errors).");
      return lines.join("\n");
    }
    lines.push(`Month-by-month team totals: ${inferred}`);
    for (const row of factsPayload.statByMonth) {
      lines.push(`${row.month}: ${row.value}`);
    }
    return lines.join("\n");
  }

  if (factsPayload?.type === "lineup") {
    lines.push("Projected lineup (best-effort)");
    lines.push("Insufficient data in the current dataset to lock positions/rotations cleanly.");
    lines.push("To improve: ensure roster notes include each player’s primary position(s), and confirm who your two setters are for a true 6-2.");
    return lines.join("\n");
  }

  // Broad default
  if (isBroadQuestion(question)) {
    const wl = factsPayload?.winLoss;
    lines.push("Coach recap (best-effort)");
    if (wl) lines.push(`Record: ${wl.wins}-${wl.losses}`);
    lines.push("I can give a stronger narrative once we confirm: primary positions, rotation preferences, and whether you prioritize sideout stability or point scoring.");
    return lines.join("\n");
  }

  return "I couldn’t generate a response from the current data.";
}

/** ---------------------- Route handler ---------------------- **/

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { question: string };
    const question = String(body?.question ?? "").trim();
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    // 1) Fast fetch
    const { chunks, matches, statsRows } = await retrieveData(TEAM_ID, question);

    // 2) Aggregate once
    const agg = computeAggregates(matches, statsRows);

    // 3) Notes for broad/roster/lineup questions only (reduces noise + latency)
    const notes = (isBroadQuestion(question) || isRosterQuestion(question) || isLineupQuestion(question)) ? buildNotes(chunks) : "";

    // 4) Question-specific facts payload (this is the key to “no noise”)
    const factsPayload = buildFactsPayload(question, agg, notes);

    // 5) Call OpenAI (or fallback)
    let answer = "";
    try {
      answer = await callOpenAI(question, factsPayload);
    } catch {
      answer = "";
    }
    if (!answer) answer = fallbackAnswer(question, factsPayload);

    // 6) Highlight all known players consistently
    const playerNames = Object.keys(agg.byPlayer || {});
    answer = highlightAllPlayerNames(answer, playerNames);

    return NextResponse.json({ answer });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
