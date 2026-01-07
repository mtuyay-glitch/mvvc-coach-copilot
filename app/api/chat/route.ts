import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

/**
 * MVVC Coach Copilot - Chat API
 * Goal:
 * - Answer like ChatGPT: directly answer the question asked.
 * - Broad questions (strengths/weaknesses, lineup, tactics, development, recap, trends) => narrative.
 * - Narrow questions (single stat leader, win/loss record) => short, minimal noise.
 * - Use only your Supabase data for facts; allow volleyball knowledge for interpretation.
 */

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black

// Treat "season" as the 2025–26 year window (Aug 1, 2025 → Jul 31, 2026)
const SEASON_START = "2025-08-01";
const SEASON_END_EXCLUSIVE = "2026-08-01"; // exclusive upper bound

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
  // isoDate like "2025-11-09" -> "2025-11"
  return isoDate.slice(0, 7);
}

function fmtName(name: string) {
  // Subtle highlight (Markdown bold)
  return `**${name}**`;
}

function isBroadQuestion(q: string) {
  const s = q.toLowerCase();

  // Broad coaching intents (force narrative)
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
    "lineup",
    "starting",
    "starting six",
    "projected",
    "rotation",
    "6-2",
    "6 2",
    "position battle",
    "optimal position",
    "move to",
    "switch position",
    "month",
    "month over month",
    "mom",
    "trend",
    "top 5",
    "top five",
    "top 3",
    "top three",
    "gaps",
    "add players",
    "recruit",
    "what type of players",
    "who should we add",
  ];

  return broadSignals.some((k) => s.includes(k));
}

function isNarrowSingleStatQuestion(q: string) {
  const s = q.toLowerCase();

  // Narrow questions: direct leader / direct value
  // Examples: "best passer rating", "win loss record", "who leads in kills", etc.
  const narrowSignals = [
    "who leads",
    "who has the most",
    "best passer",
    "best passing",
    "best serve receive",
    "win loss",
    "record",
    "how many",
    "total",
  ];

  // If it’s explicitly asking for lineup/tactics/strengths etc, not narrow.
  if (isBroadQuestion(q)) return false;

  return narrowSignals.some((k) => s.includes(k));
}

function extractOpponentFromQuestion(q: string) {
  // Lightweight heuristic: if question includes "vs X" or "against X"
  const s = q.trim();
  const vsIdx = s.toLowerCase().indexOf("vs ");
  if (vsIdx >= 0) return s.slice(vsIdx + 3).trim();
  const againstIdx = s.toLowerCase().indexOf("against ");
  if (againstIdx >= 0) return s.slice(againstIdx + 8).trim();
  return "";
}

/**
 * Fetch only what we need, as fast as possible.
 * Notes are optional and only used for broad questions.
 */
async function retrieveData(teamId: string, question: string) {
  const supabase = supabaseService();
  const broad = isBroadQuestion(question);

  // Run DB calls in parallel to reduce latency.
  const cleaned = question.replace(/[^a-zA-Z0-9 ]/g, " ");

  const rosterPromise = broad
    ? supabase
        .from("knowledge_chunks")
        .select("id,title,content,tags")
        .eq("team_id", teamId)
        .contains("tags", ["roster"])
        .limit(8)
    : Promise.resolve({ data: [] as any[], error: null as any });

  const notesPromise = broad
    ? supabase
        .from("knowledge_chunks")
        .select("id,title,content,tags")
        .eq("team_id", teamId)
        .textSearch("tsv", cleaned, { type: "websearch" })
        .limit(8)
    : Promise.resolve({ data: [] as any[], error: null as any });

  const matchesPromise = supabase
    .from("match_results")
    .select("match_date,tournament,opponent,result,score,round,sets_won,sets_lost,set_diff")
    .eq("team_id", teamId)
    .gte("match_date", SEASON_START)
    .lt("match_date", SEASON_END_EXCLUSIVE)
    .order("match_date", { ascending: true })
    .limit(2000);

  const statsPromise = supabase
    .from("player_game_stats")
    .select("player_name,position,game_date,opponent,stats")
    .eq("team_id", teamId)
    .gte("game_date", SEASON_START)
    .lt("game_date", SEASON_END_EXCLUSIVE)
    .order("game_date", { ascending: false })
    .limit(6000);

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

/**
 * Core aggregation engine:
 * - Sums every numeric-ish stat field per player (kills, digs, setting_errors, blocks, etc.)
 * - Supports weighted SR rating if serve_receive_attempts + serve_receive_passing_rating exist.
 * - Builds month-by-month totals for ANY stat key.
 */
function computeAggregates(matches: MatchRow[], statsRows: StatRow[]) {
  // Win/Loss and opponent trouble
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

  // Player totals across all numeric stat keys
  type PlayerAgg = {
    position: string | null;
    totals: Record<string, number>;
    // SR weighted calc (0–3)
    srAttempts: number;
    srWeightedSum: number;
  };

  const byPlayer: Record<string, PlayerAgg> = {};

  // Month-by-month totals (team totals by key), plus per-player by month for "top passers each month"
  const teamByMonth: Record<string, Record<string, number>> = {};
  const srByMonth: Record<string, { attempts: number; weightedSum: number }> = {};
  const passerByMonth: Record<string, Record<string, { attempts: number; weightedSum: number }>> = {};

  for (const row of statsRows) {
    const player = (row.player_name ?? "").trim();
    if (!player) continue;

    const stats = parseStats(row.stats);
    const pos = (row.position ?? stats.position ?? null) as string | null;

    const d = (row.game_date ?? stats.game_date ?? stats.match_date ?? "").toString().trim();
    const iso = d.includes("-") ? d : ""; // we rely on game_date being ISO in table
    const mk = iso ? monthKey(iso) : "";

    if (!byPlayer[player]) {
      byPlayer[player] = { position: pos, totals: {}, srAttempts: 0, srWeightedSum: 0 };
    }
    if (!byPlayer[player].position && pos) byPlayer[player].position = pos;

    // Sum every numeric-like field in stats
    for (const key of Object.keys(stats)) {
      // Skip obvious non-stat text fields
      if (
        key === "player_name" ||
        key === "position" ||
        key === "opponent" ||
        key === "match_date" ||
        key === "source_file"
      ) {
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

    // Serve receive weighted rating support
    const srAtt = toNum(stats.serve_receive_attempts);
    const srRating = toNum(stats.serve_receive_passing_rating); // 0–3 scale
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

  // Compute team SR overall
  let teamSrAttempts = 0;
  let teamSrWeightedSum = 0;
  for (const p of Object.keys(byPlayer)) {
    teamSrAttempts += byPlayer[p].srAttempts;
    teamSrWeightedSum += byPlayer[p].srWeightedSum;
  }
  const teamSrRating = teamSrAttempts > 0 ? teamSrWeightedSum / teamSrAttempts : 0;

  // Build “trouble opponents” list
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
      return a.setDiff - b.setDiff; // more negative first
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

function topNForKey(byPlayer: Record<string, { totals: Record<string, number> }>, key: string, n: number) {
  const rows = Object.keys(byPlayer)
    .map((p) => ({ player: p, value: toNum(byPlayer[p].totals[key]) }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
  return rows;
}

function topNPassersOverall(
  byPlayer: Record<string, { srAttempts: number; srWeightedSum: number }>,
  n: number
) {
  const rows = Object.keys(byPlayer)
    .map((p) => {
      const att = byPlayer[p].srAttempts;
      const sum = byPlayer[p].srWeightedSum;
      const r = att > 0 ? sum / att : 0;
      return { player: p, rating: r, attempts: att };
    })
    .filter((x) => x.attempts > 0)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, n);
  return rows;
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

function buildNotes(chunks: any[]) {
  if (!chunks?.length) return "";
  const parts: string[] = [];
  for (const c of chunks.slice(0, 8)) {
    const title = String(c.title ?? "").trim();
    const content = String(c.content ?? "").trim();
    if (!title && !content) continue;
    if (title) parts.push(title);
    if (content) parts.push(content);
    parts.push(""); // spacing
  }
  return parts.join("\n").trim();
}

/**
 * Build a question-specific facts payload.
 * Key idea: for narrow questions, keep facts tiny so the model answers directly.
 * For broad questions, include enough structured facts to write a real narrative.
 */
function buildFactsPayload(question: string, agg: ReturnType<typeof computeAggregates>) {
  const q = question.trim().toLowerCase();
  const opponentHint = extractOpponentFromQuestion(question);

  // "All facts" are still from your DB; this JSON is just a structured summary.
  const base = {
    window: { start: SEASON_START, endExclusive: SEASON_END_EXCLUSIVE },
    winLoss: agg.hasMatches ? { wins: agg.wins, losses: agg.losses } : null,
    teamServeReceive: agg.teamSr.attempts > 0 ? { scale: "0-3", rating: Number(agg.teamSr.rating.toFixed(2)), attempts: agg.teamSr.attempts } : null,
    troubleOpponents: agg.troubleOpponents.slice(0, 6),
  };

  // Narrow: best passer / top N passers
  if (q.includes("pass") || q.includes("serve receive") || q.includes("serve-receive") || q.includes("sr")) {
    const wantsTop3 = q.includes("top 3") || q.includes("top three");
    const wantsTop5 = q.includes("top 5") || q.includes("top five");
    const n = wantsTop5 ? 5 : wantsTop3 ? 3 : 1;

    const overall = topNPassersOverall(agg.byPlayer, Math.max(n, 5)); // compute up to 5 so we can answer top3/top5 cleanly
    const byMonthTop5 = q.includes("each month") || q.includes("per month") || q.includes("month")
      ? topNPassersEachMonth(agg.passerByMonth, 5)
      : null;

    return {
      type: "serve_receive",
      ...base,
      requested: { topN: n, byMonth: Boolean(byMonthTop5) },
      overallTop: overall.map((r) => ({
        player: r.player,
        rating: Number(r.rating.toFixed(2)),
        attempts: r.attempts,
      })),
      byMonthTop5,
    };
  }

  // Narrow-ish: leaders across key categories / top 5 in categories
  if (q.includes("leaders") || q.includes("top 5") || q.includes("top five") || q.includes("top 3") || q.includes("top three")) {
    // Use a standard set of keys commonly in your stats JSON
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

  // Month over month requests for any stat
  if (q.includes("month") || q.includes("month over month") || q.includes("mom") || q.includes("trend")) {
    return {
      type: "month_over_month",
      ...base,
      teamByMonth: agg.teamByMonth,
      teamServeReceiveByMonth: Object.keys(agg.srByMonth)
        .sort()
        .map((m) => {
          const x = agg.srByMonth[m];
          const r = x.attempts > 0 ? x.weightedSum / x.attempts : 0;
          return { month: m, scale: "0-3", rating: Number(r.toFixed(2)), attempts: x.attempts };
        }),
    };
  }

  // Broad coaching questions: include richer summary
  if (isBroadQuestion(question)) {
    // Provide a compact “top contributors” snapshot across several categories
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
      opponentHint: opponentHint || null,
    };
  }

  // Default: minimal base
  return { type: "minimal", ...base };
}

/**
 * Extract text from Responses API safely.
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

/**
 * OpenAI call:
 * - Broad => longer narrative
 * - Narrow => short answer
 *
 * We also explicitly prohibit “Try these prompts…” unless user asked for prompts.
 */
async function callOpenAI(question: string, factsPayload: any, notes: string) {
  assertEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";

  const broad = isBroadQuestion(question);
  const askedForPrompts = question.toLowerCase().includes("suggested prompt") || question.toLowerCase().includes("suggest prompts");

  const system = `
You are "Volleyball Guru" for the MVVC 14 Black boys volleyball team.

Your job: answer like ChatGPT — directly answer the user’s question.

Style rules:
1) Do NOT echo the question.
2) Do NOT dump unrelated stats.
3) Use subtle emphasis for names like **Koa Tuyay**.
4) Do NOT use hyphen dividers (no -----) and do NOT use hyphen bullets.
   Use short headings and either numbered lists or • bullets.
5) Do NOT respond with "Try these prompts" unless the user explicitly asked for suggested prompts.

Facts and accuracy:
- You will receive FACTS_JSON which is the ONLY source of factual claims.
- If FACTS_JSON lacks something needed, say plainly what's missing and what would fix it.

Response length policy:
- If the question is narrow (single stat/leader), answer in 1–6 lines max.
- If the question is broad (strengths/weaknesses, lineup, tactics, development, recap, trends), write a real narrative:
  roughly 12–30 lines, combining facts + coaching insight.
  Always include practical next steps.

For lineups (including 6–2):
- Give a best-effort projected lineup using available facts (kills, passing/SR, assists, blocks if present).
- If positions/blocks aren’t in FACTS_JSON, state that constraint and propose 2–3 lineup options with rationale anyway.

For tactics vs a specific opponent:
- If opponent is in troubleOpponents, propose a focused match plan (serve targets, SR seams, rotation fixes, error control).
- If not enough data, provide a general plan template and request the missing specifics.

For “what players to add”:
- Identify gaps from facts (passing stability, net presence/blocks, serving errors, sideout scoring depth) and recommend player archetypes to recruit.
`;

  const userObj = {
    question,
    FACTS_JSON: factsPayload,
    TEAM_NOTES_OPTIONAL: notes ? notes : null,
  };

  const maxTokens = broad ? 1100 : 450;

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
        {
          role: "user",
          content: [{ type: "input_text", text: JSON.stringify(userObj) }],
        },
      ],
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }

  const json = await res.json();
  const answer = safeExtractOutputText(json);

  // Safety: if model tries to be “prompty” without being asked, we’ll still return it,
  // but the system instruction should prevent it in normal operation.
  if (!askedForPrompts && answer.toLowerCase().includes("try:")) {
    // Not hard-blocking; just return. If you want to hard-block, we can.
    return answer;
  }

  return answer;
}

/**
 * Deterministic fallback that still reads like a coach narrative.
 * This prevents “it didn’t answer” even if OpenAI is down.
 */
function fallbackAnswer(question: string, factsPayload: any) {
  const q = question.toLowerCase();
  const broad = isBroadQuestion(question);

  // Narrow SR questions
  if (factsPayload?.type === "serve_receive") {
    const reqN = factsPayload?.requested?.topN ?? 1;
    const overall = Array.isArray(factsPayload?.overallTop) ? factsPayload.overallTop : [];
    const byMonth = factsPayload?.byMonthTop5;

    const lines: string[] = [];
    if (byMonth && (q.includes("each month") || q.includes("per month") || q.includes("month"))) {
      lines.push("Top passers each month (0–3 serve-receive)");
      for (const block of byMonth) {
        lines.push(`${block.month}`);
        const rows = block.rows ?? [];
        const top = rows.slice(0, 5);
        for (let i = 0; i < top.length; i++) {
          const r = top[i];
          lines.push(`${i + 1}) ${fmtName(r.player)}  ${r.rating.toFixed(2)} on ${r.attempts}`);
        }
        lines.push("");
      }
      return lines.join("\n").trim();
    }

    lines.push(reqN === 1 ? "Best passer rating (0–3 serve-receive)" : `Top ${reqN} passers (0–3 serve-receive)`);
    if (!overall.length) {
      lines.push("Insufficient data in the current dataset.");
      lines.push("Missing serve_receive_attempts and serve_receive_passing_rating in player_game_stats.stats.");
      return lines.join("\n");
    }
    const slice = overall.slice(0, Math.max(reqN, 1));
    for (let i = 0; i < slice.length; i++) {
      const r = slice[i];
      const prefix = reqN === 1 ? "" : `${i + 1}) `;
      lines.push(`${prefix}${fmtName(r.player)}  ${Number(r.rating).toFixed(2)} on ${r.attempts} attempts`);
    }
    return lines.join("\n");
  }

  // Leaderboards fallback
  if (factsPayload?.type === "leaderboards") {
    const lb = factsPayload?.leaderboards ?? {};
    const lines: string[] = [];
    lines.push("Top leaders (season totals, 2025–26)");
    const prettyName: Record<string, string> = {
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

    const keys = Object.keys(prettyName).filter((k) => Array.isArray(lb[k]) && lb[k].length);
    if (!keys.length) {
      lines.push("Insufficient data in the current dataset.");
      lines.push("Missing player stats rows in player_game_stats for the 2025–26 window.");
      return lines.join("\n");
    }

    for (const k of keys) {
      lines.push("");
      lines.push(prettyName[k] ?? k);
      const rows = lb[k] as Array<{ player: string; value: number }>;
      const top5 = rows.slice(0, 5);
      for (let i = 0; i < top5.length; i++) {
        const r = top5[i];
        lines.push(`${i + 1}) ${fmtName(r.player)}  ${r.value}`);
      }
    }
    return lines.join("\n").trim();
  }

  // Broad fallback: narrative
  if (broad) {
    const wl = factsPayload?.winLoss;
    const teamSR = factsPayload?.teamServeReceive;
    const trouble = factsPayload?.troubleOpponents ?? [];
    const snap = factsPayload?.snapshot ?? {};

    const lines: string[] = [];
    lines.push("Coach recap (best-effort, data-backed + coaching read)");

    if (wl) lines.push(`Record: ${wl.wins}-${wl.losses}`);
    if (teamSR) lines.push(`Team serve-receive: ${teamSR.rating.toFixed(2)} (0–3 scale, ${teamSR.attempts} attempts)`);

    // Strengths
    lines.push("");
    lines.push("Strengths (what your data suggests)");
    const bestPasser = snap?.bestPassersTop5?.[0];
    const killsLeader = snap?.killsTop5?.[0];
    const acesLeader = snap?.acesTop5?.[0];
    const digsLeader = snap?.digsTop5?.[0];

    if (killsLeader) lines.push(`1) Reliable scoring base: ${fmtName(killsLeader.player)} leads kills (${killsLeader.value})`);
    if (bestPasser) lines.push(`2) Passing anchor: ${fmtName(bestPasser.player)} leads SR (${bestPasser.rating.toFixed(2)} on ${bestPasser.attempts})`);
    if (acesLeader) lines.push(`3) Serve pressure: ${fmtName(acesLeader.player)} leads aces (${acesLeader.value})`);
    if (digsLeader) lines.push(`4) Defensive production: ${fmtName(digsLeader.player)} leads digs (${digsLeader.value})`);
    if (!killsLeader && !bestPasser && !acesLeader && !digsLeader) {
      lines.push("1) Player leader data wasn’t available in the computed snapshot.");
    }

    // Weaknesses / risks
    lines.push("");
    lines.push("Weaknesses / risk areas to address");
    const serveErrorsLeader = snap?.serveErrorsTop5?.[0];
    if (serveErrorsLeader) {
      lines.push(`1) Serving volatility: ${fmtName(serveErrorsLeader.player)} has the most serve errors (${serveErrorsLeader.value}).`);
      lines.push("   Coaching read: keep aggression, but simplify targets and reduce “free points” in tight sets.");
    } else {
      lines.push("1) Serving error profile isn’t available in the snapshot.");
    }

    if (Array.isArray(trouble) && trouble.length) {
      lines.push("2) Repeat-problem opponents (by losses)");
      const top = trouble.slice(0, 4);
      for (let i = 0; i < top.length; i++) {
        const t = top[i];
        lines.push(`${i + 1}) ${t.opponent}  losses ${t.losses}/${t.matches}`);
      }
      lines.push("   Coaching read: these teams likely create serve pressure or trap you in 1–2 rotations.");
    } else {
      lines.push("2) Opponent trouble list not available (needs match_results with opponent + result).");
    }

    // Next steps
    lines.push("");
    lines.push("Next steps (practical)");
    lines.push("1) Identify your 3 best passers and build your primary serve-receive shape around them.");
    lines.push("2) For high-error servers: use 2 consistent target zones per match and track error type (net vs long vs wide).");
    lines.push("3) For trouble opponents: pre-write a plan (serve targets, SR seam ownership, rotation escape plan).");
    lines.push("4) For lineup questions: decide whether your priority is sideout stability (passing) or point scoring (kills/blocks/serve pressure).");

    return lines.join("\n");
  }

  // Default minimal
  return "I couldn’t generate a response from the current data.";
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { question: string };
    const question = String(body?.question ?? "").trim();
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    // 1) Pull data (fast, parallel queries)
    const { chunks, matches, statsRows } = await retrieveData(TEAM_ID, question);

    // 2) Aggregate once (fast; we reuse for any question)
    const agg = computeAggregates(matches, statsRows);

    // 3) Build question-specific facts (prevents “noise”)
    const factsPayload = buildFactsPayload(question, agg);

    // 4) Notes only for broad narrative questions (keeps narrow Qs fast + clean)
    const notes = isBroadQuestion(question) ? buildNotes(chunks) : "";

    // 5) Ask OpenAI for the final answer; fall back to deterministic narrative if it fails
    let answer = "";
    try {
      answer = await callOpenAI(question, factsPayload, notes);
    } catch {
      answer = "";
    }

    if (!answer) {
      answer = fallbackAnswer(question, factsPayload);
    }

    return NextResponse.json({ answer });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
