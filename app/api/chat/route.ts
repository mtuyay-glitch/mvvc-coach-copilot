import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

/**
 * MVVC Coach Copilot - Chat API (2025–26)
 *
 * Goals:
 * - Behave like ChatGPT: answer the user's question directly (no brittle "intent gating").
 * - Facts come from Supabase (match_results + player_game_stats). Coaching insight can use general volleyball knowledge.
 * - Avoid timeouts: cache season aggregates in-memory with TTL; avoid recomputing for every message.
 * - Always return a real answer (OpenAI + deterministic fallback).
 *
 * Logo/UI are handled client-side in app/page.tsx.
 */

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black
const SEASON_START = "2025-08-01";
const SEASON_END_EXCLUSIVE = "2026-08-01";
const PERSONA = "MVVC Analyst";

// Cache TTL: increase if your data only changes after uploads (e.g., 5–30 minutes).
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

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

function s(q: string) {
  return (q || "").toLowerCase().trim();
}

function toNum(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const str = String(v).trim();
  if (!str) return 0;
  const n = Number(str);
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
  return isoDate.slice(0, 7); // "YYYY-MM"
}

function safeIso(d: string | null) {
  const x = (d ?? "").trim();
  return x && x.includes("-") ? x : "";
}

/* ---------------------------- Caching layer ---------------------------- */

type Aggregates = ReturnType<typeof computeAggregates>;

let cache: {
  teamId: string;
  seasonStart: string;
  seasonEndExclusive: string;
  createdAt: number;
  // full data used for detailed questions
  matches: MatchRow[];
  statsRows: StatRow[];
  agg: Aggregates;
} | null = null;

let inflight: Promise<{
  matches: MatchRow[];
  statsRows: StatRow[];
  agg: Aggregates;
}> | null = null;

function cacheValid() {
  if (!cache) return false;
  if (cache.teamId !== TEAM_ID) return false;
  if (cache.seasonStart !== SEASON_START) return false;
  if (cache.seasonEndExclusive !== SEASON_END_EXCLUSIVE) return false;
  return Date.now() - cache.createdAt < CACHE_TTL_MS;
}

/* ---------------------------- Supabase fetch ---------------------------- */

async function fetchSeasonData() {
  const supabase = supabaseService();

  // These benefit hugely from indexes:
  // match_results(team_id, match_date)
  // player_game_stats(team_id, game_date)
  const matchesPromise = supabase
    .from("match_results")
    .select("match_date,tournament,opponent,result,score,round,sets_won,sets_lost,set_diff")
    .eq("team_id", TEAM_ID)
    .gte("match_date", SEASON_START)
    .lt("match_date", SEASON_END_EXCLUSIVE)
    .order("match_date", { ascending: true })
    .limit(5000);

  const statsPromise = supabase
    .from("player_game_stats")
    .select("player_name,position,game_date,opponent,stats")
    .eq("team_id", TEAM_ID)
    .gte("game_date", SEASON_START)
    .lt("game_date", SEASON_END_EXCLUSIVE)
    .order("game_date", { ascending: false })
    .limit(15000);

  const [matchesRes, statsRes] = await Promise.all([matchesPromise, statsPromise]);

  if (matchesRes.error) throw matchesRes.error;
  if (statsRes.error) throw statsRes.error;

  const matches = (matchesRes.data ?? []) as MatchRow[];
  const statsRows = (statsRes.data ?? []) as StatRow[];

  return { matches, statsRows };
}

async function getSeasonAggCached() {
  if (cacheValid()) return cache!;
  if (inflight) {
    const { matches, statsRows, agg } = await inflight;
    return {
      teamId: TEAM_ID,
      seasonStart: SEASON_START,
      seasonEndExclusive: SEASON_END_EXCLUSIVE,
      createdAt: Date.now(),
      matches,
      statsRows,
      agg,
    };
  }

  inflight = (async () => {
    const { matches, statsRows } = await fetchSeasonData();
    const agg = computeAggregates(matches, statsRows);
    return { matches, statsRows, agg };
  })();

  const { matches, statsRows, agg } = await inflight;
  inflight = null;

  cache = {
    teamId: TEAM_ID,
    seasonStart: SEASON_START,
    seasonEndExclusive: SEASON_END_EXCLUSIVE,
    createdAt: Date.now(),
    matches,
    statsRows,
    agg,
  };

  return cache!;
}

/* ---------------------------- Aggregation engine ---------------------------- */

type PlayerAgg = {
  position: string | null;
  totals: Record<string, number>;
  // serve-receive weighted rating support (0–3)
  srAttempts: number;
  srWeightedSum: number;

  // month-by-month per stat
  byMonth: Record<string, Record<string, number>>;

  // per-month SR
  srByMonth: Record<string, { attempts: number; weightedSum: number }>;
};

function computeAggregates(matches: MatchRow[], statsRows: StatRow[]) {
  // Team W/L
  let wins = 0;
  let losses = 0;

  // Opponent record
  const vs: Record<
    string,
    { wins: number; losses: number; matches: number; setDiff: number; lastDate: string; lastScore?: string | null }
  > = {};

  for (const m of matches) {
    const wl = normalizeWinLoss(m.result);
    const opp = (m.opponent ?? "").trim() || "Unknown Opponent";
    const date = safeIso(m.match_date);

    if (!vs[opp]) vs[opp] = { wins: 0, losses: 0, matches: 0, setDiff: 0, lastDate: "", lastScore: null };

    vs[opp].matches += 1;
    vs[opp].setDiff += toNum(m.set_diff);
    if (wl === "W") {
      wins++;
      vs[opp].wins += 1;
    }
    if (wl === "L") {
      losses++;
      vs[opp].losses += 1;
    }
    if (date && (!vs[opp].lastDate || date > vs[opp].lastDate)) {
      vs[opp].lastDate = date;
      vs[opp].lastScore = m.score ?? null;
    }
  }

  // Match list helpers
  const lastMatch = (() => {
    const ms = matches
      .filter((m) => safeIso(m.match_date))
      .slice()
      .sort((a, b) => safeIso(a.match_date).localeCompare(safeIso(b.match_date)));
    return ms.length ? ms[ms.length - 1] : null;
  })();

  // Players
  const byPlayer: Record<string, PlayerAgg> = {};

  // Team month totals (any numeric stat)
  const teamByMonth: Record<string, Record<string, number>> = {};
  const teamSrByMonth: Record<string, { attempts: number; weightedSum: number }> = {};

  // Discover available stat keys (numeric-ish) to help the model
  const statKeySet = new Set<string>();

  for (const row of statsRows) {
    const player = (row.player_name ?? "").trim();
    if (!player) continue;

    const stats = parseStats(row.stats);
    const pos = (row.position ?? stats.position ?? null) as string | null;

    const iso = safeIso(row.game_date);
    const mk = iso ? monthKey(iso) : "";

    if (!byPlayer[player]) {
      byPlayer[player] = {
        position: pos,
        totals: {},
        srAttempts: 0,
        srWeightedSum: 0,
        byMonth: {},
        srByMonth: {},
      };
    }
    if (!byPlayer[player].position && pos) byPlayer[player].position = pos;

    // Sum numeric keys
    for (const key of Object.keys(stats)) {
      if (key === "player_name" || key === "position" || key === "opponent" || key === "match_date" || key === "source_file") continue;

      const n = toNum(stats[key]);
      if (n === 0) continue;

      statKeySet.add(key);

      byPlayer[player].totals[key] = (byPlayer[player].totals[key] ?? 0) + n;

      if (mk) {
        // player by month
        byPlayer[player].byMonth[mk] = byPlayer[player].byMonth[mk] ?? {};
        byPlayer[player].byMonth[mk][key] = (byPlayer[player].byMonth[mk][key] ?? 0) + n;

        // team by month
        teamByMonth[mk] = teamByMonth[mk] ?? {};
        teamByMonth[mk][key] = (teamByMonth[mk][key] ?? 0) + n;
      }
    }

    // SR weighted rating
    const srAtt = toNum(stats.serve_receive_attempts);
    const srRating = toNum(stats.serve_receive_passing_rating);
    if (srAtt > 0) {
      byPlayer[player].srAttempts += srAtt;
      byPlayer[player].srWeightedSum += srRating * srAtt;

      if (mk) {
        byPlayer[player].srByMonth[mk] = byPlayer[player].srByMonth[mk] ?? { attempts: 0, weightedSum: 0 };
        byPlayer[player].srByMonth[mk].attempts += srAtt;
        byPlayer[player].srByMonth[mk].weightedSum += srRating * srAtt;

        teamSrByMonth[mk] = teamSrByMonth[mk] ?? { attempts: 0, weightedSum: 0 };
        teamSrByMonth[mk].attempts += srAtt;
        teamSrByMonth[mk].weightedSum += srRating * srAtt;
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

  // Trouble opponents (loss-heavy, then more negative setDiff)
  const troubleOpponents = Object.keys(vs)
    .map((opp) => ({ opponent: opp, ...vs[opp] }))
    .filter((x) => x.losses > 0)
    .sort((a, b) => {
      if (b.losses !== a.losses) return b.losses - a.losses;
      return a.setDiff - b.setDiff;
    })
    .slice(0, 10);

  // Positions map
  const positions: Record<string, string | null> = {};
  for (const p of Object.keys(byPlayer)) positions[p] = byPlayer[p].position ?? null;

  // Available stat keys (sorted)
  const availableStatKeys = Array.from(statKeySet.values()).sort();

  return {
    window: { start: SEASON_START, endExclusive: SEASON_END_EXCLUSIVE },
    wins,
    losses,
    lastMatch,
    vs,
    troubleOpponents,
    byPlayer,
    positions,
    availableStatKeys,
    teamByMonth,
    teamServeReceive: {
      scale: "0-3",
      rating: Number(teamSrRating.toFixed(2)),
      attempts: teamSrAttempts,
    },
    teamServeReceiveByMonth: Object.keys(teamSrByMonth)
      .sort()
      .map((m) => {
        const x = teamSrByMonth[m];
        const r = x.attempts > 0 ? x.weightedSum / x.attempts : 0;
        return { month: m, scale: "0-3", rating: Number(r.toFixed(2)), attempts: x.attempts };
      }),
  };
}

/* ---------------------------- Leader helpers ---------------------------- */

function topNForKey(byPlayer: Record<string, PlayerAgg>, key: string, n: number) {
  return Object.keys(byPlayer)
    .map((p) => ({ player: p, value: toNum(byPlayer[p].totals[key]) }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}

function topNPassersOverall(byPlayer: Record<string, PlayerAgg>, n: number) {
  return Object.keys(byPlayer)
    .map((p) => {
      const att = byPlayer[p].srAttempts;
      const sum = byPlayer[p].srWeightedSum;
      const r = att > 0 ? sum / att : 0;
      return { player: p, rating: r, attempts: att };
    })
    .filter((x) => x.attempts > 0)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, n)
    .map((r) => ({ ...r, rating: Number(r.rating.toFixed(2)) }));
}

function topNPassersEachMonth(byPlayer: Record<string, PlayerAgg>, n: number) {
  // Build month -> list of passers
  const monthSet = new Set<string>();
  for (const p of Object.keys(byPlayer)) {
    for (const m of Object.keys(byPlayer[p].srByMonth || {})) monthSet.add(m);
  }
  const months = Array.from(monthSet.values()).sort();

  return months.map((m) => {
    const rows = Object.keys(byPlayer)
      .map((p) => {
        const x = byPlayer[p].srByMonth?.[m];
        const att = x?.attempts ?? 0;
        const sum = x?.weightedSum ?? 0;
        const r = att > 0 ? sum / att : 0;
        return { player: p, rating: r, attempts: att };
      })
      .filter((x) => x.attempts > 0)
      .sort((a, b) => b.rating - a.rating)
      .slice(0, n)
      .map((r) => ({ ...r, rating: Number(r.rating.toFixed(2)) }));
    return { month: m, rows };
  });
}

/* ---------------------------- Stat key resolution ---------------------------- */

/**
 * We do NOT require users to ask with exact key names.
 * We attempt to resolve “best hitter”, “kills”, “blocks”, “aces”, “passing”, etc.
 * If we can’t resolve, we still answer with best-effort and show available keys.
 */
function resolveStatKey(question: string, availableKeys: string[]): { kind: "sr" | "key" | "unknown"; key?: string } {
  const q = s(question);

  // Serve receive / passing
  if (q.includes("pass") || q.includes("serve receive") || q.includes("serve-receive") || q.includes("sr")) {
    return { kind: "sr" };
  }

  // Common aliases
  const alias: Array<{ match: string[]; keys: string[] }> = [
    { match: ["kill", "hitter", "hits", "attacking"], keys: ["attack_kills", "kills"] },
    { match: ["dig", "defense", "digs"], keys: ["digs_successful", "digs"] },
    { match: ["ace", "serving points", "aces"], keys: ["serve_aces", "aces"] },
    { match: ["serve error", "service error", "serving error"], keys: ["serve_errors"] },
    { match: ["assist", "setter", "setting"], keys: ["setting_assists", "assists"] },
    { match: ["setting error"], keys: ["setting_errors"] },
    { match: ["block", "blocker", "blocks"], keys: ["blocks_solo", "blocks_assist", "blocks_total"] },
    { match: ["error", "attack error", "hitting error"], keys: ["attack_errors"] },
    { match: ["attempt", "attempts"], keys: ["attack_attempts"] },
  ];

  for (const a of alias) {
    if (a.match.some((w) => q.includes(w))) {
      // choose first key that exists
      for (const k of a.keys) {
        if (availableKeys.includes(k)) return { kind: "key", key: k };
      }
      // if none exist, return the first alias key anyway (model can mention missing)
      return { kind: "key", key: a.keys[0] };
    }
  }

  // If user typed an exact key-like token, try direct match
  for (const k of availableKeys) {
    if (q.includes(k.toLowerCase())) return { kind: "key", key: k };
  }

  return { kind: "unknown" };
}

/* ---------------------------- Facts payload (compact but powerful) ---------------------------- */

function buildFactsPayload(question: string, agg: Aggregates, matches: MatchRow[]) {
  const q = s(question);

  const wantsAllGames =
    q.includes("every game") ||
    q.includes("all game") ||
    q.includes("game results") ||
    q.includes("show every") ||
    (q.includes("show") && q.includes("results"));

  const wantsLastOpponent =
    q.includes("last opponent") ||
    (q.includes("last") && q.includes("opponent")) ||
    (q.includes("most recent") && q.includes("opponent"));

  const wantsRecord = q === "record" || q.includes("team record") || (q.includes("record") && !q.includes("vs"));
  const wantsVsOpponent = q.includes("record vs") || q.includes("record versus") || q.includes("vs ") || q.includes("against ");

  const statResolve = resolveStatKey(question, agg.availableStatKeys);

  // Useful precomputed blocks
  const top = {
    passersTop5: topNPassersOverall(agg.byPlayer, 5),
    passersEachMonthTop5: topNPassersEachMonth(agg.byPlayer, 5),
    killsTop5: topNForKey(agg.byPlayer, "attack_kills", 5),
    assistsTop5: topNForKey(agg.byPlayer, "setting_assists", 5),
    acesTop5: topNForKey(agg.byPlayer, "serve_aces", 5),
    digsTop5: topNForKey(agg.byPlayer, "digs_successful", 5),
    blocksSoloTop5: topNForKey(agg.byPlayer, "blocks_solo", 5),
    blocksAssistTop5: topNForKey(agg.byPlayer, "blocks_assist", 5),
    serveErrorsTop5: topNForKey(agg.byPlayer, "serve_errors", 5),
    settingErrorsTop5: topNForKey(agg.byPlayer, "setting_errors", 5),
  };

  // For “show every game”
  const games =
    wantsAllGames
      ? matches.map((m) => ({
          date: m.match_date,
          opponent: m.opponent,
          tournament: m.tournament,
          round: m.round,
          result: normalizeWinLoss(m.result),
          score: m.score,
          sets_won: m.sets_won,
          sets_lost: m.sets_lost,
          set_diff: m.set_diff,
        }))
      : null;

  return {
    persona: PERSONA,
    window: agg.window,
    team: {
      id: TEAM_ID,
      record: matches.length ? { wins: agg.wins, losses: agg.losses } : null,
      lastMatch: agg.lastMatch
        ? {
            date: agg.lastMatch.match_date,
            opponent: agg.lastMatch.opponent,
            result: normalizeWinLoss(agg.lastMatch.result),
            score: agg.lastMatch.score,
            tournament: agg.lastMatch.tournament,
          }
        : null,
      teamServeReceive: agg.teamServeReceive.attempts > 0 ? agg.teamServeReceive : null,
      teamServeReceiveByMonth: agg.teamServeReceiveByMonth,
      troubleOpponents: agg.troubleOpponents,
      vsOpponent: agg.vs, // record vs each opponent
    },
    players: {
      positions: agg.positions, // may be null/unknown
      availableStatKeys: agg.availableStatKeys, // helps explain “missing keys”
      // We do NOT send all per-player totals for every key (can be huge).
      // Instead we send the top blocks + allow the model to ask for specifics.
      top,
    },
    monthByMonth: {
      // teamByMonth can be large; still useful for MoM questions
      teamByMonth: agg.teamByMonth,
    },
    questionHints: {
      wantsAllGames,
      wantsLastOpponent,
      wantsRecord,
      wantsVsOpponent,
      statResolve,
    },
    games, // only included if asked (keeps payload small)
  };
}

/* ---------------------------- OpenAI call (Responses API) ---------------------------- */

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

  // Keep output bounded to reduce latency/timeouts
  const maxTokens = 900;

  const system = `
You are "${PERSONA}" for MVVC 14 Black boys volleyball.

Behave like ChatGPT:
- Answer the user's question directly.
- Do not ask them to use special prompts.
- Do not refuse just because the question doesn't match a pre-coded intent.

Facts policy:
- FACTS_JSON is the only source for factual claims (stats, results, names, numbers).
- You MAY use general volleyball knowledge for interpretation, coaching advice, and lineup logic.
- If a stat is missing, say what's missing briefly, then still give best-effort advice.

Output style:
- Clean, readable, mobile-friendly text.
- Use short headings and • bullets.
- Do not use "-----" divider lines.
- If asked for "every game result", print in date order and include opponent + W/L + score if present.

Lineups:
- Provide BOTH a 5–1 and a 6–2 option when the user asks for lineups or "best chance to win".
- If positions are uncertain, state assumptions and pick based on: setting_assists, SR stability, attack_kills, blocks.
- Give a short "why this wins" rationale.

Loss improvement:
- If asked "what could we have changed vs X", use the opponent record + common volleyball levers:
  serve targets, SR seams, sideout patterns, rotation fixes, error control, substitution triggers, blocking/defense adjustments.
- Keep it actionable.

Always produce an answer (no empty responses).
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

/* ---------------------------- Deterministic fallback (never blank) ---------------------------- */

function fallbackAnswer(question: string, facts: any) {
  const q = s(question);

  // Show every game
  if (facts?.games && Array.isArray(facts.games)) {
    const rows = facts.games as any[];
    if (!rows.length) return "No match results found in the 2025–26 window.";
    const lines: string[] = [];
    lines.push("Game results (2025–26)");
    for (const r of rows) {
      const d = r.date ?? "Unknown date";
      const opp = r.opponent ?? "Unknown opponent";
      const wl = r.result ?? "?";
      const score = r.score ? ` — ${r.score}` : "";
      lines.push(`• ${d}  vs ${opp}  ${wl}${score}`);
    }
    return lines.join("\n");
  }

  // Team record
  if (q.includes("team record") || q === "record" || q.includes("season record")) {
    const rec = facts?.team?.record;
    if (!rec) return "I don’t see match_results in the current dataset for the 2025–26 window.";
    return `Team record (2025–26): ${rec.wins}-${rec.losses}`;
  }

  // Last opponent
  if (q.includes("last opponent") || (q.includes("last") && q.includes("opponent"))) {
    const lm = facts?.team?.lastMatch;
    if (!lm) return "I don’t see a most recent match in match_results for the 2025–26 window.";
    const wl = lm.result ?? "?";
    const score = lm.score ? ` (${lm.score})` : "";
    return `Last opponent: ${lm.opponent ?? "Unknown"} — ${wl}${score} on ${lm.date ?? "unknown date"}`;
  }

  // Best setter/hitter/blocker/passer (best-effort)
  const top = facts?.players?.top ?? {};

  if (q.includes("best setter") || (q.includes("best") && q.includes("setter"))) {
    const rows = top.assistsTop5 ?? [];
    if (!rows.length) return "I don’t have setting_assists in your stats yet. Add `setting_assists` to player_game_stats.stats.";
    return `${rows[0].player} leads in assists (${rows[0].value}).`;
  }

  if (q.includes("best passer") || (q.includes("best") && q.includes("pass"))) {
    const rows = top.passersTop5 ?? [];
    if (!rows.length) return "I don’t have serve_receive_attempts + serve_receive_passing_rating in your stats yet.";
    const r = rows[0];
    return `${r.player} leads serve-receive rating (${r.rating} on ${r.attempts} attempts).`;
  }

  if (q.includes("best hitter") || (q.includes("best") && (q.includes("hitter") || q.includes("kills")))) {
    const rows = top.killsTop5 ?? [];
    if (!rows.length) return "I don’t have attack_kills in your stats yet. Add `attack_kills` to player_game_stats.stats.";
    return `${rows[0].player} leads in kills (${rows[0].value}).`;
  }

  if (q.includes("best blocker") || (q.includes("best") && q.includes("block"))) {
    const solo = top.blocksSoloTop5 ?? [];
    const ast = top.blocksAssistTop5 ?? [];
    const merged: Record<string, number> = {};
    for (const r of solo) merged[r.player] = (merged[r.player] ?? 0) + (r.value ?? 0);
    for (const r of ast) merged[r.player] = (merged[r.player] ?? 0) + (r.value ?? 0);
    const best = Object.keys(merged)
      .map((p) => ({ player: p, value: merged[p] }))
      .sort((a, b) => b.value - a.value)[0];
    if (!best) return "I don’t have blocks_solo / blocks_assist in your stats yet.";
    return `${best.player} leads blocks (proxy total ${best.value}).`;
  }

  // Generic fallback
  const keys = Array.isArray(facts?.players?.availableStatKeys) ? facts.players.availableStatKeys : [];
  return (
    "I couldn’t answer that precisely from the current data payload.\n\n" +
    (keys.length ? `Available stat keys in your dataset include: ${keys.slice(0, 25).join(", ")}${keys.length > 25 ? ", …" : ""}` : "")
  );
}

/* ---------------------------- Route ---------------------------- */

export async function POST(req: Request) {
  const t0 = Date.now();
  try {
    const body = (await req.json()) as { question?: string; thread_id?: string | null };
    const question = String(body?.question ?? "").trim();
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    // 1) Get cached season data + aggregates (big timeout fix)
    const season = await getSeasonAggCached();

    // 2) Build compact facts payload (includes full games only when asked)
    const factsPayload = buildFactsPayload(question, season.agg, season.matches);

    // 3) OpenAI (fast output, but always return something)
    let answer = "";
    try {
      answer = await callOpenAI(question, factsPayload);
    } catch (err: any) {
      console.error("[OpenAI]", err?.message ?? String(err));
      answer = "";
    }

    if (!answer) answer = fallbackAnswer(question, factsPayload);

    // Optional timing log
    const ms = Date.now() - t0;
    console.log(`[api/chat] ${ms}ms  q="${question.slice(0, 80)}"`);

    return NextResponse.json({
      answer,
      // keep thread_id contract if your UI uses it (we don't persist server-side yet)
      thread_id: body?.thread_id ?? null,
      meta: {
        cached: cacheValid(),
        ms,
      },
    });
  } catch (e: any) {
    console.error("[api/chat] error", e?.message ?? String(e));
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
