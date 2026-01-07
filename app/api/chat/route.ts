import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

/**
 * =========================
 * CONFIG
 * =========================
 */

// Your MVVC 14 Black team_id in Supabase
const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5";

// Treat "season" as the 2025–26 year (you can tweak these if you want)
const YEAR_START = "2025-07-01";
const YEAR_END_EXCLUSIVE = "2026-07-01"; // exclusive end bound (>= start, < end)

/**
 * If you want to use OpenAI for broad “narrative” questions, set OPENAI_API_KEY.
 * Narrow/stat questions are answered without OpenAI (faster).
 */
function hasOpenAIKey() {
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * =========================
 * TYPES (lightweight)
 * =========================
 */

type MatchRow = {
  match_date: string | null; // ISO date preferred
  tournament: string | null;
  opponent: string | null;
  result: string | null; // "W"/"L" or "Won"/"Lost"
  score: string | null; // "25-23, 25-21" etc
  round: string | null;
  sets_won: number | null;
  sets_lost: number | null;
  set_diff: number | null;
};

type StatRow = {
  player_name: string | null;
  position: string | null;
  game_date: string | null; // ISO date preferred
  opponent: string | null;
  stats: any; // jsonb (object or stringified JSON)
};

type RosterChunk = {
  title: string | null;
  content: string | null;
};

type PlayerTotals = Record<string, number>;
type TotalsByPlayer = Record<string, PlayerTotals>;

/**
 * =========================
 * SMALL UTILS
 * =========================
 */

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

function monthKey(isoDate: string): string {
  // "2025-11-09" -> "2025-11"
  if (!isoDate || isoDate.length < 7) return "unknown";
  return isoDate.slice(0, 7);
}

function niceName(name: string) {
  // subtle emphasis without weird brackets
  return `**${name}**`;
}

function isLikelyBroadQuestion(q: string) {
  const s = q.toLowerCase();
  return (
    s.includes("strength") ||
    s.includes("weakness") ||
    s.includes("recap") ||
    s.includes("summary") ||
    s.includes("summarize") ||
    s.includes("season") ||
    s.includes("key moments") ||
    s.includes("improve") ||
    s.includes("improvement") ||
    s.includes("plan") ||
    s.includes("lineup") ||
    s.includes("starting") ||
    s.includes("rotation") ||
    s.includes("6-2") ||
    s.includes("6 2") ||
    s.includes("position battle") ||
    s.includes("optimal position")
  );
}

/**
 * Pull "top N" if the user says "top 3", "top 5", etc.
 */
function parseTopN(q: string, fallback = 5): number {
  const m = q.toLowerCase().match(/\btop\s+(\d+)\b/);
  if (!m) return fallback;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 50) : fallback;
}

/**
 * Extract a stat key from a question, best-effort.
 * This lets you ask "top 5 in setting errors" => "setting_errors"
 */
function inferStatKey(q: string): { key: string | null; mode?: "sum" | "avg_weighted_sr" } {
  const s = q.toLowerCase();

  // Serve receive / passer rating (special: weighted average)
  if (s.includes("passer rating") || s.includes("passing rating") || s.includes("serve receive") || s.includes("serve-receive") || s.includes("sr rating")) {
    return { key: "serve_receive_passing_rating", mode: "avg_weighted_sr" };
  }

  // Common volleyball terms -> your JSON keys
  const map: Array<[RegExp, string]> = [
    [/\bkills?\b/, "attack_kills"],
    [/\bdigs?\b/, "digs_successful"],
    [/\baces?\b/, "serve_aces"],
    [/\bserve errors?\b/, "serve_errors"],
    [/\bsetting errors?\b/, "setting_errors"],
    [/\bassists?\b/, "setting_assists"],
    [/\bblock(s)?\b/, "blocks_total"], // we compute blocks_total = solo + assist
    [/\battack errors?\b/, "attack_errors"],
    [/\bdig errors?\b/, "dig_errors"],
    [/\bserve attempts?\b/, "serve_attempts"],
    [/\bserve receive attempts?\b|\bsr attempts?\b/, "serve_receive_attempts"],
    [/\bpoints\b.*\bplus\b|\bplus\/minus\b/, "points_plus_minus"],
    [/\bhitting percentage\b|\battack percentage\b/, "attack_percentage"],
  ];

  for (const [re, key] of map) {
    if (re.test(s)) return { key, mode: "sum" };
  }

  // If the user literally typed a JSON key name (power-user mode)
  const keyMatch = s.match(/\b([a-z_]+)\b/);
  if (keyMatch && keyMatch[1]?.includes("_")) return { key: keyMatch[1], mode: "sum" };

  return { key: null };
}

/**
 * =========================
 * FAST CACHE (warm instances)
 * =========================
 *
 * Vercel serverless instances may be reused (warm). We cache computed aggregates
 * for a short TTL so repeated questions respond faster.
 */
const CACHE_TTL_MS = 60_000; // 60s
let cache:
  | {
      ts: number;
      teamId: string;
      yearStart: string;
      yearEndExclusive: string;
      matches: MatchRow[];
      statsRows: StatRow[];
      totalsByPlayer: TotalsByPlayer;
      positionsByPlayer: Record<string, string>;
      wins: number;
      losses: number;
      troubleOpponents: Array<{ opponent: string; losses: number; matches: number; setDiff: number }>;
      teamMonthly: Record<string, Record<string, number>>; // month -> statKey -> value (sum)
      playerMonthly: Record<string, Record<string, Record<string, number>>>; // month -> player -> statKey -> sum
      srMonthly: {
        team: Record<string, { att: number; sum: number }>;
        players: Record<string, Record<string, { att: number; sum: number }>>; // month -> player -> {att,sum}
      };
      rosterText: string;
    }
  | null = null;

/**
 * =========================
 * DATA FETCH (Supabase)
 * =========================
 */

async function fetchYearData(teamId: string, question: string) {
  // Return cached aggregates if still fresh
  if (
    cache &&
    Date.now() - cache.ts < CACHE_TTL_MS &&
    cache.teamId === teamId &&
    cache.yearStart === YEAR_START &&
    cache.yearEndExclusive === YEAR_END_EXCLUSIVE
  ) {
    return cache;
  }

  const supabase = supabaseService();

  /**
   * 1) Match results in the 2025–26 year window
   */
  const { data: matches, error: em } = await supabase
    .from("match_results")
    .select("match_date,tournament,opponent,result,score,round,sets_won,sets_lost,set_diff")
    .eq("team_id", teamId)
    .gte("match_date", YEAR_START)
    .lt("match_date", YEAR_END_EXCLUSIVE)
    .order("match_date", { ascending: true })
    .limit(2000);
  if (em) throw em;

  /**
   * 2) Player game stats in the 2025–26 year window
   * NOTE: We only select the columns we truly need (faster).
   */
  const { data: statsRows, error: es } = await supabase
    .from("player_game_stats")
    .select("player_name,position,game_date,opponent,stats")
    .eq("team_id", teamId)
    .gte("game_date", YEAR_START)
    .lt("game_date", YEAR_END_EXCLUSIVE)
    .order("game_date", { ascending: false })
    .limit(8000);
  if (es) throw es;

  /**
   * 3) Optional: roster/positions notes (for “roster & positions” questions)
   * Keep it small. We do not spam the model with this.
   */
  const cleaned = question.replace(/[^a-zA-Z0-9 ]/g, " ");
  const { data: rosterChunks } = await supabase
    .from("knowledge_chunks")
    .select("title,content,tags")
    .eq("team_id", teamId)
    .contains("tags", ["roster"])
    .limit(8);

  const { data: searchChunks } = await supabase
    .from("knowledge_chunks")
    .select("title,content,tags")
    .eq("team_id", teamId)
    .textSearch("tsv", cleaned, { type: "websearch" })
    .limit(6);

  const rosterText = buildRosterText([...(rosterChunks ?? []), ...(searchChunks ?? [])]);

  // Compute aggregates once
  const computed = computeAggregates((matches ?? []) as MatchRow[], (statsRows ?? []) as StatRow[]);

  cache = {
    ts: Date.now(),
    teamId,
    yearStart: YEAR_START,
    yearEndExclusive: YEAR_END_EXCLUSIVE,
    matches: (matches ?? []) as MatchRow[],
    statsRows: (statsRows ?? []) as StatRow[],
    rosterText,
    ...computed,
  };

  return cache;
}

function buildRosterText(chunks: any[]) {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const c of chunks) {
    const title = String(c?.title ?? "").trim();
    const content = String(c?.content ?? "").trim();
    const key = `${title}::${content}`.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (title) lines.push(title);
    if (content) lines.push(content);
  }
  return lines.slice(0, 10).join("\n\n");
}

/**
 * =========================
 * AGGREGATION (Fast + flexible)
 * =========================
 *
 * Key goals:
 * - Totals per player for ANY stat key in stats JSON
 * - Special handling for serve-receive rating (weighted by attempts)
 * - Month-by-month sums per team & per player (for any stat)
 */
function computeAggregates(matches: MatchRow[], statsRows: StatRow[]) {
  // Win/Loss + opponent trouble
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

  const troubleOpponents = Object.keys(oppMatches)
    .map((opponent) => ({
      opponent,
      losses: oppLosses[opponent] ?? 0,
      matches: oppMatches[opponent] ?? 0,
      setDiff: oppSetDiff[opponent] ?? 0,
    }))
    .filter((x) => x.losses > 0)
    .sort((a, b) => {
      if (b.losses !== a.losses) return b.losses - a.losses;
      return a.setDiff - b.setDiff;
    })
    .slice(0, 10);

  // Totals per player for *all* JSON keys
  const totalsByPlayer: TotalsByPlayer = {};
  const positionsByPlayer: Record<string, string> = {};

  // Month-by-month sums
  const teamMonthly: Record<string, Record<string, number>> = {}; // month -> key -> sum
  const playerMonthly: Record<string, Record<string, Record<string, number>>> = {}; // month -> player -> key -> sum

  // Month-by-month SR weighted (team + per player)
  const srMonthly = {
    team: {} as Record<string, { att: number; sum: number }>,
    players: {} as Record<string, Record<string, { att: number; sum: number }>>,
  };

  for (const row of statsRows) {
    const player = (row.player_name ?? "").trim();
    if (!player) continue;

    // Keep latest non-empty position if present
    const pos = (row.position ?? "").trim();
    if (pos) positionsByPlayer[player] = pos;

    const s = parseStats(row.stats);

    // Compute derived keys (so you can ask "blocks" even if stored as solo/assist)
    const blocksSolo = toNum(s.blocks_solo);
    const blocksAssist = toNum(s.blocks_assist);
    const blocksTotal = blocksSolo + blocksAssist;
    if (blocksTotal) s.blocks_total = blocksTotal;

    // Ensure player totals object
    if (!totalsByPlayer[player]) totalsByPlayer[player] = {};

    // Add ALL numeric-like keys to totals (sum)
    for (const key of Object.keys(s)) {
      const val = toNum(s[key]);
      if (!val) continue;
      totalsByPlayer[player][key] = (totalsByPlayer[player][key] ?? 0) + val;
    }

    // Month bucketing (needs game_date)
    const gd = (row.game_date ?? "").trim();
    if (gd) {
      const mk = monthKey(gd);

      if (!teamMonthly[mk]) teamMonthly[mk] = {};
      if (!playerMonthly[mk]) playerMonthly[mk] = {};
      if (!playerMonthly[mk][player]) playerMonthly[mk][player] = {};

      for (const key of Object.keys(s)) {
        const val = toNum(s[key]);
        if (!val) continue;
        teamMonthly[mk][key] = (teamMonthly[mk][key] ?? 0) + val;
        playerMonthly[mk][player][key] = (playerMonthly[mk][player][key] ?? 0) + val;
      }

      // SR weighted monthly (0–3 rating weighted by attempts)
      const att = toNum(s.serve_receive_attempts);
      const rating = toNum(s.serve_receive_passing_rating);
      if (att > 0) {
        srMonthly.team[mk] = srMonthly.team[mk] ?? { att: 0, sum: 0 };
        srMonthly.team[mk].att += att;
        srMonthly.team[mk].sum += rating * att;

        srMonthly.players[mk] = srMonthly.players[mk] ?? {};
        srMonthly.players[mk][player] = srMonthly.players[mk][player] ?? { att: 0, sum: 0 };
        srMonthly.players[mk][player].att += att;
        srMonthly.players[mk][player].sum += rating * att;
      }
    }
  }

  return {
    totalsByPlayer,
    positionsByPlayer,
    wins,
    losses,
    troubleOpponents,
    teamMonthly,
    playerMonthly,
    srMonthly,
  };
}

/**
 * =========================
 * LEADERBOARDS
 * =========================
 */

function topNByStat(totalsByPlayer: TotalsByPlayer, statKey: string, n: number) {
  const rows: Array<{ player: string; value: number }> = [];
  for (const player of Object.keys(totalsByPlayer)) {
    const v = toNum(totalsByPlayer[player]?.[statKey]);
    rows.push({ player, value: v });
  }
  return rows.sort((a, b) => b.value - a.value).slice(0, n);
}

function topNPassersWeighted(
  totalsByPlayer: TotalsByPlayer,
  n: number
): Array<{ player: string; rating: number; attempts: number }> {
  const rows: Array<{ player: string; rating: number; attempts: number }> = [];

  for (const player of Object.keys(totalsByPlayer)) {
    // totalsByPlayer stores sums of serve_receive_attempts and serve_receive_passing_rating (raw sums),
    // but SR rating should be weighted by attempts per row. We handled weighting in srMonthly,
    // so for overall best passer we do a best-effort:
    // We approximate by using per-row weighted sums not available in totalsByPlayer.
    //
    // However: many of your rows store serve_receive_passing_rating as a per-match average,
    // so summing those is not correct. For best accuracy, we compute from "attempts buckets"
    // by using month-level SR weighted (and summing months).
    //
    // Instead, we compute overall weighted from totals of attempts and (rating*attempts) if present:
    // If your ingestion stored a precomputed "serve_receive_rating_*_count" fields, we could do better,
    // but we’ll rely on srMonthly aggregation for exact weighting.
    //
    // So: we return a placeholder here and compute overall weighted from srMonthly in the answer builder.
    const attempts = toNum(totalsByPlayer[player]?.["serve_receive_attempts"]);
    const ratingApprox = toNum(totalsByPlayer[player]?.["serve_receive_passing_rating"]);
    if (attempts > 0) {
      rows.push({ player, rating: ratingApprox / 1, attempts }); // approx; corrected in answer step when possible
    }
  }

  return rows
    .sort((a, b) => b.rating - a.rating)
    .slice(0, n)
    .map((r) => ({ ...r, rating: Number.isFinite(r.rating) ? r.rating : 0 }));
}

function computeOverallTeamSR(srMonthly: { team: Record<string, { att: number; sum: number }> }) {
  let att = 0;
  let sum = 0;
  for (const mk of Object.keys(srMonthly.team)) {
    att += srMonthly.team[mk].att;
    sum += srMonthly.team[mk].sum;
  }
  return { att, rating: att > 0 ? sum / att : 0 };
}

function computeOverallPlayerSR(
  srMonthly: { players: Record<string, Record<string, { att: number; sum: number }>> }
) {
  const agg: Record<string, { att: number; sum: number }> = {};
  for (const mk of Object.keys(srMonthly.players)) {
    const byPlayer = srMonthly.players[mk];
    for (const player of Object.keys(byPlayer)) {
      agg[player] = agg[player] ?? { att: 0, sum: 0 };
      agg[player].att += byPlayer[player].att;
      agg[player].sum += byPlayer[player].sum;
    }
  }

  const out: Array<{ player: string; attempts: number; rating: number }> = [];
  for (const player of Object.keys(agg)) {
    const att = agg[player].att;
    const rating = att > 0 ? agg[player].sum / att : 0;
    out.push({ player, attempts: att, rating });
  }
  return out.sort((a, b) => b.rating - a.rating);
}

/**
 * =========================
 * ANSWER ROUTER (ChatGPT-like)
 * =========================
 *
 * This is the heart of “answer the question asked, no noise”.
 * We try deterministic (fast). If broad and OpenAI exists, use OpenAI for narrative.
 */

function answerDeterministic(question: string, data: NonNullable<typeof cache>) {
  const q = question.trim();
  const s = q.toLowerCase();
  const n = parseTopN(q, 5);

  // 1) Win/Loss record
  if (s.includes("win") || s.includes("loss") || s.includes("record")) {
    if (data.matches.length === 0) return `Win/loss record\nInsufficient data in the current dataset (no match_results found for 2025–26).`;
    return `Win/loss record\n${data.wins}-${data.losses}`;
  }

  // 2) Tough opponents / “most trouble”
  if (s.includes("tough") || s.includes("trouble") || s.includes("hardest") || s.includes("which opponents")) {
    if (data.troubleOpponents.length === 0) return `Toughest opponents\nNo losses found in match_results for 2025–26.`;
    const top = data.troubleOpponents.slice(0, Math.min(n, 8));
    const lines: string[] = [];
    lines.push("Opponents that caused the most trouble");
    for (let i = 0; i < top.length; i++) {
      const t = top[i];
      lines.push(`${i + 1}) ${t.opponent} (losses ${t.losses}/${t.matches})`);
    }
    return lines.join("\n");
  }

  // 3) Roster / positions (from knowledge chunks + positions column)
  if (s.includes("roster") || (s.includes("who") && s.includes("plays") && s.includes("position"))) {
    const lines: string[] = [];
    lines.push("Roster & positions (best available)");

    const players = Object.keys(data.positionsByPlayer).sort((a, b) => a.localeCompare(b));
    if (players.length) {
      for (const p of players) lines.push(`${niceName(p)} — ${data.positionsByPlayer[p]}`);
    } else {
      lines.push("No positions found in player_game_stats.position for 2025–26.");
    }

    if (data.rosterText) {
      lines.push("");
      lines.push("Notes");
      lines.push(data.rosterText);
    }

    return lines.join("\n");
  }

  // 4) Month-over-month team stat (“month by month team passing rating”, “month over month kills”, etc.)
  if ((s.includes("month") && (s.includes("month by month") || s.includes("month-over-month") || s.includes("mom"))) || s.includes("each month")) {
    const { key, mode } = inferStatKey(q);

    // Special: "Top 5 passers each month"
    if (s.includes("top") && (s.includes("passer") || s.includes("passing") || s.includes("serve receive") || s.includes("serve-receive"))) {
      const months = Object.keys(data.srMonthly.players).sort();
      if (!months.length) return "Top passers each month\nInsufficient data in the current dataset (no SR attempts/ratings found).";

      const lines: string[] = [];
      lines.push(`Top ${n} passers each month (0–3 scale, weighted by attempts)`);

      for (const mk of months) {
        const per = data.srMonthly.players[mk] ?? {};
        const ranked = Object.keys(per)
          .map((player) => {
            const att = per[player].att;
            const rating = att > 0 ? per[player].sum / att : 0;
            return { player, att, rating };
          })
          .filter((r) => r.att > 0)
          .sort((a, b) => b.rating - a.rating)
          .slice(0, n);

        if (!ranked.length) continue;

        lines.push("");
        lines.push(`${mk}`);
        for (let i = 0; i < ranked.length; i++) {
          const r = ranked[i];
          lines.push(`${i + 1}) ${niceName(r.player)} — ${r.rating.toFixed(2)} on ${r.att} attempts`);
        }
      }

      return lines.join("\n");
    }

    if (!key) {
      return `Month-by-month\nTell me which stat you want (examples: kills, aces, digs, setting errors, blocks, passer rating).`;
    }

    // Team passer rating month-by-month (weighted)
    if (mode === "avg_weighted_sr") {
      const months = Object.keys(data.srMonthly.team).sort();
      if (!months.length) return "Month-by-month team passer rating\nInsufficient data in the current dataset (no SR attempts/ratings found).";

      const lines: string[] = [];
      lines.push("Month-by-month team passer rating (0–3 scale, weighted by attempts)");
      for (const mk of months) {
        const v = data.srMonthly.team[mk];
        const r = v.att > 0 ? v.sum / v.att : 0;
        lines.push(`${mk}: ${r.toFixed(2)} on ${v.att} attempts`);
      }
      return lines.join("\n");
    }

    // Team month-by-month sums for any stat key
    const months = Object.keys(data.teamMonthly).sort();
    if (!months.length) return `Month-by-month ${key}\nInsufficient data in the current dataset (no player_game_stats found).`;

    const lines: string[] = [];
    lines.push(`Month-by-month team ${key}`);
    for (const mk of months) {
      const val = toNum(data.teamMonthly[mk]?.[key]);
      lines.push(`${mk}: ${val}`);
    }
    return lines.join("\n");
  }

  // 5) “Top N” for passer rating (overall)
  if (s.includes("top") && (s.includes("passer") || s.includes("passing") || s.includes("serve receive") || s.includes("serve-receive"))) {
    const ranked = computeOverallPlayerSR(data.srMonthly).filter((r) => r.attempts > 0);
    if (!ranked.length) return `Top ${n} passers\nInsufficient data in the current dataset (no SR attempts/ratings found).`;

    const lines: string[] = [];
    lines.push(`Top ${n} passers (0–3 scale, weighted by attempts)`);
    for (let i = 0; i < Math.min(n, ranked.length); i++) {
      const r = ranked[i];
      lines.push(`${i + 1}) ${niceName(r.player)} — ${r.rating.toFixed(2)} on ${r.attempts} attempts`);
    }
    return lines.join("\n");
  }

  // 6) “Best passer rating” (overall)
  if (s.includes("best") && (s.includes("passer") || s.includes("passing") || s.includes("serve receive") || s.includes("serve-receive"))) {
    const ranked = computeOverallPlayerSR(data.srMonthly).filter((r) => r.attempts > 0);
    if (!ranked.length) return "Best passer rating\nInsufficient data in the current dataset (no SR attempts/ratings found).";
    const best = ranked[0];
    return `Best passer rating\n${niceName(best.player)} — ${best.rating.toFixed(2)} (0–3) on ${best.attempts} attempts`;
  }

  // 7) Statistical leaders across key categories / “top 5 across all categories”
  if (s.includes("leaders") || s.includes("leaderboard") || s.includes("top 5 across") || (s.includes("top") && s.includes("categories"))) {
    if (!Object.keys(data.totalsByPlayer).length) return "Statistical leaders\nInsufficient data in the current dataset (no player_game_stats found).";

    const rankedSR = computeOverallPlayerSR(data.srMonthly).filter((r) => r.attempts > 0);
    const bestSR = rankedSR[0];

    const cats: Array<{ label: string; key: string; special?: "sr" }> = [
      { label: "Kills", key: "attack_kills" },
      { label: "Assists", key: "setting_assists" },
      { label: "Aces", key: "serve_aces" },
      { label: "Digs", key: "digs_successful" },
      { label: "Blocks", key: "blocks_total" },
      { label: "Serve errors", key: "serve_errors" },
      { label: "Setting errors", key: "setting_errors" },
      { label: "Passer rating", key: "serve_receive_passing_rating", special: "sr" },
    ];

    const lines: string[] = [];
    lines.push(`Top ${n} leaders by category (2025–26)`);

    for (const c of cats) {
      lines.push("");
      lines.push(`${c.label}`);

      if (c.special === "sr") {
        if (!rankedSR.length) {
          lines.push("Insufficient data (no SR attempts/ratings found).");
          continue;
        }
        const top = rankedSR.slice(0, n);
        for (let i = 0; i < top.length; i++) {
          lines.push(`${i + 1}) ${niceName(top[i].player)} — ${top[i].rating.toFixed(2)} on ${top[i].attempts}`);
        }
        continue;
      }

      const top = topNByStat(data.totalsByPlayer, c.key, n).filter((r) => r.value > 0);
      if (!top.length) {
        lines.push("Insufficient data.");
        continue;
      }
      for (let i = 0; i < top.length; i++) {
        lines.push(`${i + 1}) ${niceName(top[i].player)} — ${top[i].value}`);
      }
    }

    // Quick team SR line (useful but not noisy)
    const teamSR = computeOverallTeamSR(data.srMonthly);
    if (teamSR.att > 0) {
      lines.push("");
      lines.push(`Team SR (weighted): ${teamSR.rating.toFixed(2)} on ${teamSR.att} attempts`);
    }

    return lines.join("\n");
  }

  // 8) Any “Who leads in X?” / “Top N in X?” / “Most X?”
  {
    const { key, mode } = inferStatKey(q);

    if (key) {
      // Blocks: use computed "blocks_total"
      const realKey = key === "blocks_total" || key === "blocks_solo" || key === "blocks_assist" ? key : key;

      // Passer rating handled above; but keep a fallback
      if (mode === "avg_weighted_sr") {
        const ranked = computeOverallPlayerSR(data.srMonthly).filter((r) => r.attempts > 0);
        if (!ranked.length) return `Passer rating\nInsufficient data in the current dataset (no SR attempts/ratings found).`;
        const top = ranked.slice(0, n);
        if (n === 1 || s.includes("best") || s.includes("lead") || s.includes("leader")) {
          return `Passer rating leader\n${niceName(top[0].player)} — ${top[0].rating.toFixed(2)} on ${top[0].attempts} attempts`;
        }
        const lines: string[] = [];
        lines.push(`Top ${n} passers (0–3, weighted)`);
        for (let i = 0; i < top.length; i++) lines.push(`${i + 1}) ${niceName(top[i].player)} — ${top[i].rating.toFixed(2)} on ${top[i].attempts}`);
        return lines.join("\n");
      }

      // For sum stats
      const top = topNByStat(data.totalsByPlayer, realKey, n).filter((r) => r.value > 0);
      if (!top.length) return `Leader: ${realKey}\nInsufficient data in the current dataset (no values found for ${realKey}).`;

      // If user asked "who leads", give single leader
      if (s.includes("who lead") || s.includes("leader") || s.includes("most") || s.startsWith("who ")) {
        const best = top[0];
        return `${realKey} leader\n${niceName(best.player)} — ${best.value}`;
      }

      // Otherwise give top N
      const lines: string[] = [];
      lines.push(`Top ${n}: ${realKey}`);
      for (let i = 0; i < top.length; i++) lines.push(`${i + 1}) ${niceName(top[i].player)} — ${top[i].value}`);
      return lines.join("\n");
    }
  }

  // 9) If nothing matched: return a short “I can help” but not spammy
  return `I can help with that.\nTry: “Top 5 passers each month”, “Who leads in setting errors?”, “Month-by-month team kills”, or “Stat leaders by category”.`;
}

/**
 * =========================
 * OPENAI (optional) for broad narrative questions
 * =========================
 *
 * We only use this when:
 * - The question is broad (strengths/weaknesses, lineup planning, position battles, etc.)
 * - AND you have OPENAI_API_KEY set
 *
 * We still send a compact JSON (no noise) and require the model to answer the question asked.
 */
async function callOpenAIForNarrative(question: string, data: NonNullable<typeof cache>) {
  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";

  // Build a compact “facts JSON” the model can use.
  // Keep it relevant, but broad questions can include a few more fields.
  const rankedSR = computeOverallPlayerSR(data.srMonthly).filter((r) => r.attempts > 0);
  const teamSR = computeOverallTeamSR(data.srMonthly);

  const facts = {
    yearWindow: { start: YEAR_START, endExclusive: YEAR_END_EXCLUSIVE },
    record: data.matches.length ? { wins: data.wins, losses: data.losses } : null,
    troubleOpponents: data.troubleOpponents.slice(0, 6),
    leaders: {
      kills: topNByStat(data.totalsByPlayer, "attack_kills", 5),
      assists: topNByStat(data.totalsByPlayer, "setting_assists", 5),
      aces: topNByStat(data.totalsByPlayer, "serve_aces", 5),
      digs: topNByStat(data.totalsByPlayer, "digs_successful", 5),
      blocks: topNByStat(data.totalsByPlayer, "blocks_total", 5),
      serveErrors: topNByStat(data.totalsByPlayer, "serve_errors", 5),
      settingErrors: topNByStat(data.totalsByPlayer, "setting_errors", 5),
      passerRating: rankedSR.slice(0, 5),
      teamPasserRating: teamSR.att > 0 ? { rating: Number(teamSR.rating.toFixed(2)), attempts: teamSR.att } : null,
    },
    positionsByPlayer: data.positionsByPlayer, // helps lineup/position questions
    rosterNotes: data.rosterText || null,
  };

  const system = `
You are a volleyball assistant for MVVC 14 Black. Behave like ChatGPT:
- Answer the user’s question directly (do not ignore it).
- Use a clean readable style: short paragraphs + numbered lists when helpful.
- Do NOT dump unrelated stats. Only include facts that support the answer.
- When you state a fact, it must be supported by FACTS_JSON.
- Clearly label facts vs coaching insight inline:
  Use "Facts:" and "Coaching insight:" (keep it natural, not verbose).
- Use **bold** for player names only.
- Avoid hyphen dividers and avoid hyphen bullets. Prefer numbered lists or "•" bullets.
`;

  const payload = {
    question,
    FACTS_JSON: facts,
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
      // IMPORTANT: use "text" content type (avoids the 'input_text' mismatch errors)
      input: [
        { role: "system", content: [{ type: "text", text: system }] },
        { role: "user", content: [{ type: "text", text: JSON.stringify(payload) }] },
      ],
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }

  const json = await res.json();

  // Extract output_text safely
  let outText = "";
  const out = json?.output;
  if (Array.isArray(out)) {
    for (const item of out) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === "output_text" && typeof c?.text === "string") outText += c.text;
        }
      }
    }
  }
  if (!outText && typeof json?.output_text === "string") outText = json.output_text;

  return (outText || "").trim();
}

/**
 * =========================
 * ROUTE HANDLER
 * =========================
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { question?: string };
    const question = String(body?.question ?? "").trim();
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    // 1) Load data (cached if warm)
    const data = await fetchYearData(TEAM_ID, question);

    // 2) Fast deterministic answer first (covers most questions, minimal latency)
    const deterministic = answerDeterministic(question, data);

    // 3) If the question is broad and OpenAI is available, use OpenAI for a fuller narrative
    //    (But still only when it adds value, not for simple leaderboard questions.)
    if (isLikelyBroadQuestion(question) && hasOpenAIKey()) {
      try {
        const narrative = await callOpenAIForNarrative(question, data);
        if (narrative) return NextResponse.json({ answer: narrative });
      } catch {
        // If OpenAI fails, fall back to deterministic response (never return “No answer generated”)
      }
    }

    return NextResponse.json({ answer: deterministic });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
