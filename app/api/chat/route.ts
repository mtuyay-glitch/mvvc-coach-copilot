import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

/**
 * MVVC Coach Copilot - Chat API (2025–26)
 * Persona: "MVVC Analyst"
 *
 * Handles common questions from coaches / players / parents:
 * - Record, last opponent, record vs opponent
 * - Leaders (top 5), best setter/hitter/blocker/passer/server/defender
 * - Trends: month-over-month team or player, top 5 each month
 * - Lineups: recommended 5–1 and 6–2 (best chance to win) based on available stats
 * - Loss review: "What could we have changed in losses?" overall or vs an opponent
 * - Tactics: "How do we beat <opponent>?" (data-backed if possible, otherwise solid template)
 *
 * Facts policy:
 * - ALL factual claims must come from Supabase-derived stats.
 * - Volleyball knowledge is allowed ONLY for interpretation/recommendations.
 *
 * Note: Team logo is UI only (page.tsx). This API returns text.
 */

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black
const WINDOW_START = "2025-08-01";
const WINDOW_END_EXCLUSIVE = "2026-08-01";
const PERSONA = "MVVC Analyst";

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

type PlayerAgg = {
  position: string | null;
  totals: Record<string, number>;
  srAttempts: number;
  srWeightedSum: number;
};

type TeamAgg = {
  totals: Record<string, number>;
  srAttempts: number;
  srWeightedSum: number;
};

type Intent =
  | "team_record"
  | "last_opponent"
  | "record_vs_opponent"
  | "leaders"
  | "best_setter"
  | "best_hitter"
  | "best_blocker"
  | "best_passer"
  | "best_server"
  | "best_defender"
  | "lineup"
  | "lineup_51"
  | "lineup_62"
  | "strengths_weaknesses"
  | "areas_to_improve"
  | "month_over_month_team"
  | "month_over_month_player"
  | "top5_each_month"
  | "tactics_vs_opponent"
  | "loss_review"
  | "loss_review_vs_opponent"
  | "generic";

/* ------------------------------ Helpers ------------------------------ */

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
  return isoDate.slice(0, 7);
}

function inferStatKeyFromQuestion(q: string): string {
  const t = s(q);
  const map: Array<{ includes: string[]; key: string }> = [
    { includes: ["serve receive", "serve-receive", "passing rating", "sr rating"], key: "serve_receive_passing_rating" },
    { includes: ["serve receive attempts", "sr attempts"], key: "serve_receive_attempts" },

    { includes: ["kills", "kill"], key: "attack_kills" },
    { includes: ["assists", "assist"], key: "setting_assists" },
    { includes: ["digs", "dig"], key: "digs_successful" },

    { includes: ["aces", "ace"], key: "serve_aces" },
    { includes: ["serve errors", "serve error"], key: "serve_errors" },

    { includes: ["blocks solo", "solo blocks", "solo block"], key: "blocks_solo" },
    { includes: ["block assists", "block assist"], key: "blocks_assist" },
    { includes: ["blocks", "block"], key: "blocks_solo" },

    { includes: ["attack errors", "attack error", "hitting errors", "hitting error"], key: "attack_errors" },
    { includes: ["setting errors", "setting error"], key: "setting_errors" },
  ];

  for (const m of map) {
    if (m.includes.some((w) => t.includes(w))) return m.key;
  }
  return "";
}

function extractOpponentFromQuestion(q: string): string {
  const raw = (q || "").trim();
  const lower = raw.toLowerCase();
  const markers = [" vs ", " vs. ", " against ", " versus "];

  for (const m of markers) {
    const idx = lower.indexOf(m);
    if (idx >= 0) {
      const after = raw.slice(idx + m.length).trim();
      const cut = after.split(/[,.;!?]/)[0].trim();
      return cut;
    }
  }
  // also handle "against <team>" without spaces sometimes
  const m2 = raw.match(/\bagainst\s+(.+?)$/i);
  if (m2?.[1]) return m2[1].split(/[,.;!?]/)[0].trim();
  return "";
}

function matchKey(date: string | null, opponent: string | null) {
  return `${String(date ?? "").slice(0, 10)}|${(opponent ?? "").trim().toLowerCase()}`;
}

/* -------------------------- Intent detection -------------------------- */

function detectIntent(question: string): { intent: Intent; opponent?: string; inferredKey?: string } {
  const t = s(question);
  const opponent = extractOpponentFromQuestion(question);
  const inferredKey = inferStatKeyFromQuestion(question);

  // Loss review (overall / vs opponent)
  if (
    t.includes("what could") && t.includes("loss") ||
    t.includes("in our losses") ||
    t.includes("why did we lose") ||
    t.includes("what went wrong") ||
    t.includes("could have done differently") ||
    t.includes("what should we have changed")
  ) {
    if (opponent) return { intent: "loss_review_vs_opponent", opponent };
    return { intent: "loss_review" };
  }

  // Lineup variants
  if (t.includes("5-1") || t.includes("5 1")) return { intent: "lineup_51" };
  if (t.includes("6-2") || t.includes("6 2")) return { intent: "lineup_62" };

  // General lineup
  if (
    t.includes("lineup") ||
    t.includes("starting") ||
    t.includes("starting six") ||
    t.includes("rotation") ||
    t.includes("who should start")
  ) {
    return { intent: "lineup" };
  }

  if (t === "team record" || t.includes("team record") || t.includes("win loss") || t === "record") return { intent: "team_record" };
  if (t.includes("last opponent") || t.includes("last match") || t.includes("who did we play last") || t.includes("most recent opponent"))
    return { intent: "last_opponent" };
  if ((t.includes("record") && (t.includes("vs") || t.includes("against") || t.includes("versus"))) && opponent)
    return { intent: "record_vs_opponent", opponent };

  if (t.includes("leaders") || t.includes("top 5") || t.includes("top five") || t.includes("top 3") || t.includes("top three"))
    return { intent: "leaders", inferredKey: inferredKey || undefined };

  if (t.includes("best setter") || (t.includes("best") && t.includes("setter"))) return { intent: "best_setter" };
  if (t.includes("best hitter") || (t.includes("best") && (t.includes("hitter") || t.includes("attacker") || t.includes("finisher"))))
    return { intent: "best_hitter" };
  if (t.includes("best blocker") || (t.includes("best") && t.includes("block"))) return { intent: "best_blocker" };
  if (t.includes("best passer") || (t.includes("best") && (t.includes("pass") || t.includes("serve receive") || t.includes("serve-receive") || t.includes("sr"))))
    return { intent: "best_passer" };
  if (t.includes("best server") || (t.includes("best") && t.includes("serve") && !t.includes("serve receive"))) return { intent: "best_server" };
  if (t.includes("best defender") || (t.includes("best") && (t.includes("defense") || t.includes("dig")))) return { intent: "best_defender" };

  if (t.includes("strength") || t.includes("weakness") || t.includes("recap") || t.includes("summary") || t.includes("so far"))
    return { intent: "strengths_weaknesses" };
  if (t.includes("improve") || t.includes("areas to improve") || t.includes("what should we work on") || t.includes("fix"))
    return { intent: "areas_to_improve" };

  if (t.includes("top 5") && (t.includes("each month") || t.includes("per month") || t.includes("every month")))
    return { intent: "top5_each_month", inferredKey: inferredKey || undefined };

  if (t.includes("month") || t.includes("month over month") || t.includes("mom") || t.includes("trend")) {
    if (t.includes("player") || t.includes("for ")) return { intent: "month_over_month_player", inferredKey: inferredKey || undefined };
    return { intent: "month_over_month_team", inferredKey: inferredKey || undefined };
  }

  if (t.includes("tactics") || t.includes("game plan") || t.includes("how do we beat") || t.includes("how to beat") || t.includes("beat ")) {
    if (opponent) return { intent: "tactics_vs_opponent", opponent };
    return { intent: "tactics_vs_opponent" };
  }

  return { intent: "generic", inferredKey: inferredKey || undefined, opponent: opponent || undefined };
}

/* -------------------------- Data retrieval -------------------------- */

async function retrieveData(teamId: string) {
  const supabase = supabaseService();

  const matchesPromise = supabase
    .from("match_results")
    .select("match_date,tournament,opponent,result,score,round,sets_won,sets_lost,set_diff")
    .eq("team_id", teamId)
    .gte("match_date", WINDOW_START)
    .lt("match_date", WINDOW_END_EXCLUSIVE)
    .order("match_date", { ascending: true })
    .limit(5000);

  const statsPromise = supabase
    .from("player_game_stats")
    .select("player_name,position,game_date,opponent,stats")
    .eq("team_id", teamId)
    .gte("game_date", WINDOW_START)
    .lt("game_date", WINDOW_END_EXCLUSIVE)
    .order("game_date", { ascending: false })
    .limit(20000);

  const [matchesRes, statsRes] = await Promise.all([matchesPromise, statsPromise]);

  if (matchesRes.error) throw matchesRes.error;
  if (statsRes.error) throw statsRes.error;

  return {
    matches: (matchesRes.data ?? []) as MatchRow[],
    statsRows: (statsRes.data ?? []) as StatRow[],
  };
}

/* -------------------------- Aggregations -------------------------- */

function computeAggregates(matches: MatchRow[], statsRows: StatRow[]) {
  // Team W/L + vs opponent
  let wins = 0;
  let losses = 0;

  const vsOpp: Record<string, { wins: number; losses: number; matches: number; setDiff: number }> = {};

  for (const m of matches) {
    const wl = normalizeWinLoss(m.result);
    const opp = (m.opponent ?? "").trim() || "Unknown Opponent";

    if (!vsOpp[opp]) vsOpp[opp] = { wins: 0, losses: 0, matches: 0, setDiff: 0 };
    vsOpp[opp].matches += 1;
    vsOpp[opp].setDiff += toNum(m.set_diff);

    if (wl === "W") {
      wins++;
      vsOpp[opp].wins += 1;
    } else if (wl === "L") {
      losses++;
      vsOpp[opp].losses += 1;
    }
  }

  const lastMatch = [...matches]
    .filter((x) => x.match_date && x.opponent)
    .sort((a, b) => String(b.match_date).localeCompare(String(a.match_date)))[0];

  // Player totals + SR weighted
  const byPlayer: Record<string, PlayerAgg> = {};
  const teamByMonth: Record<string, Record<string, number>> = {};
  const srByMonth: Record<string, { attempts: number; weightedSum: number }> = {};

  // Per-match team aggregates (for win vs loss comparisons)
  const teamByMatch: Record<string, TeamAgg> = {};

  for (const row of statsRows) {
    const player = (row.player_name ?? "").trim();
    if (!player) continue;

    const stats = parseStats(row.stats);
    const pos = (row.position ?? stats.position ?? null) as string | null;

    const iso = (row.game_date ?? "").toString().trim().slice(0, 10);
    const opp = (row.opponent ?? stats.opponent ?? "").toString().trim();
    const mk = iso && iso.includes("-") ? monthKey(iso) : "";

    if (!byPlayer[player]) byPlayer[player] = { position: pos, totals: {}, srAttempts: 0, srWeightedSum: 0 };
    if (!byPlayer[player].position && pos) byPlayer[player].position = pos;

    const keyForMatch = matchKey(iso || null, opp || null);
    if (!teamByMatch[keyForMatch]) teamByMatch[keyForMatch] = { totals: {}, srAttempts: 0, srWeightedSum: 0 };

    // Sum all numeric fields
    for (const key of Object.keys(stats)) {
      if (key === "player_name" || key === "position" || key === "opponent" || key === "match_date" || key === "source_file") continue;
      const n = toNum(stats[key]);
      if (n === 0) continue;

      byPlayer[player].totals[key] = (byPlayer[player].totals[key] ?? 0) + n;

      teamByMatch[keyForMatch].totals[key] = (teamByMatch[keyForMatch].totals[key] ?? 0) + n;

      if (mk) {
        teamByMonth[mk] = teamByMonth[mk] ?? {};
        teamByMonth[mk][key] = (teamByMonth[mk][key] ?? 0) + n;
      }
    }

    // SR weighted rating (0–3) if present
    const srAtt = toNum(stats.serve_receive_attempts);
    const srRating = toNum(stats.serve_receive_passing_rating);
    if (srAtt > 0) {
      byPlayer[player].srAttempts += srAtt;
      byPlayer[player].srWeightedSum += srRating * srAtt;

      teamByMatch[keyForMatch].srAttempts += srAtt;
      teamByMatch[keyForMatch].srWeightedSum += srRating * srAtt;

      if (mk) {
        srByMonth[mk] = srByMonth[mk] ?? { attempts: 0, weightedSum: 0 };
        srByMonth[mk].attempts += srAtt;
        srByMonth[mk].weightedSum += srRating * srAtt;
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

  // Blocks proxy
  const blocksProxy: Record<string, number> = {};
  for (const p of Object.keys(byPlayer)) {
    const solo = toNum(byPlayer[p].totals["blocks_solo"]);
    const assist = toNum(byPlayer[p].totals["blocks_assist"]);
    const total = solo + assist;
    if (total > 0) blocksProxy[p] = total;
  }

  // Build win/loss splits using match_results + teamByMatch
  const winMatches: string[] = [];
  const lossMatches: string[] = [];
  const winMatchesByOpponent: Record<string, string[]> = {};
  const lossMatchesByOpponent: Record<string, string[]> = {};

  for (const m of matches) {
    const wl = normalizeWinLoss(m.result);
    const key = matchKey(m.match_date ? String(m.match_date).slice(0, 10) : null, m.opponent);
    const opp = (m.opponent ?? "").trim() || "Unknown Opponent";

    if (wl === "W") {
      winMatches.push(key);
      (winMatchesByOpponent[opp] = winMatchesByOpponent[opp] ?? []).push(key);
    } else if (wl === "L") {
      lossMatches.push(key);
      (lossMatchesByOpponent[opp] = lossMatchesByOpponent[opp] ?? []).push(key);
    }
  }

  function combineTeamAgg(keys: string[]): TeamAgg {
    const out: TeamAgg = { totals: {}, srAttempts: 0, srWeightedSum: 0 };
    for (const k of keys) {
      const a = teamByMatch[k];
      if (!a) continue;
      out.srAttempts += a.srAttempts;
      out.srWeightedSum += a.srWeightedSum;
      for (const statKey of Object.keys(a.totals)) {
        out.totals[statKey] = (out.totals[statKey] ?? 0) + toNum(a.totals[statKey]);
      }
    }
    return out;
  }

  const winsAgg = combineTeamAgg(winMatches);
  const lossesAgg = combineTeamAgg(lossMatches);

  return {
    wins,
    losses,
    vsOpp,
    lastMatch: lastMatch
      ? {
          date: lastMatch.match_date,
          opponent: lastMatch.opponent,
          result: lastMatch.result,
          score: lastMatch.score,
          tournament: lastMatch.tournament,
        }
      : null,
    byPlayer,
    blocksProxy,
    teamByMonth,
    srByMonth,
    teamSr: { rating: teamSrRating, attempts: teamSrAttempts },
    teamByMatch,
    winMatches,
    lossMatches,
    winsAgg,
    lossesAgg,
    winMatchesByOpponent,
    lossMatchesByOpponent,
  };
}

/* -------------------------- Leader utilities -------------------------- */

function topNForKey(byPlayer: Record<string, { totals: Record<string, number> }>, key: string, n: number) {
  return Object.keys(byPlayer)
    .map((p) => ({ player: p, value: toNum(byPlayer[p].totals[key]) }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}

function topNPassersOverall(byPlayer: Record<string, { srAttempts: number; srWeightedSum: number }>, n: number, minAttempts = 1) {
  return Object.keys(byPlayer)
    .map((p) => {
      const att = (byPlayer as any)[p].srAttempts as number;
      const sum = (byPlayer as any)[p].srWeightedSum as number;
      const rating = att > 0 ? sum / att : 0;
      return { player: p, rating, attempts: att };
    })
    .filter((x) => x.attempts >= minAttempts)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, n);
}

function topNBlocksProxy(blocksProxy: Record<string, number>, n: number) {
  return Object.keys(blocksProxy)
    .map((p) => ({ player: p, value: blocksProxy[p] }))
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}

/* -------------------------- Lineup building (best chance to win) -------------------------- */

function uniqKeepOrder(list: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of list) {
    if (!x) continue;
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function buildLineups(agg: ReturnType<typeof computeAggregates>) {
  // Use stats-driven heuristics:
  // - Setters: top setting_assists
  // - Hitters: top attack_kills
  // - Passers: top SR rating (min attempts threshold)
  // - Blockers: blocks proxy
  const setters = topNForKey(agg.byPlayer as any, "setting_assists", 4);
  const hitters = topNForKey(agg.byPlayer as any, "attack_kills", 12);
  const passers = topNPassersOverall(agg.byPlayer as any, 8, 50); // minAttempts=50 to avoid tiny-sample noise
  const blockers = topNBlocksProxy(agg.blocksProxy, 8);

  const setter1 = setters[0]?.player ?? null;
  const setter2 = setters[1]?.player ?? null;

  // Helper: pick top hitters excluding a set of players
  const pickHitters = (count: number, exclude: Set<string>) =>
    hitters.map((h) => h.player).filter((p) => !exclude.has(p)).slice(0, count);

  // Helper: pick top passers excluding
  const pickPassers = (count: number, exclude: Set<string>) =>
    passers.map((p) => p.player).filter((p) => !exclude.has(p)).slice(0, count);

  // Helper: pick blockers excluding
  const pickBlockers = (count: number, exclude: Set<string>) =>
    blockers.map((b) => b.player).filter((p) => !exclude.has(p)).slice(0, count);

  // --- 5–1 (one setter, maximum stability) ---
  // Priorities: SR stability + point scoring
  const exclude51 = new Set<string>();
  if (setter1) exclude51.add(setter1);

  // Libero: best passer (even if also hitter)
  const libero51 = pickPassers(1, new Set<string>())[0] ?? null;

  // OHs: pick top passers who also appear as hitters (if possible)
  const passerNames = new Set(passers.map((p) => p.player));
  const hitterNames = new Set(hitters.map((h) => h.player));

  const ohCandidates = passers
    .map((p) => p.player)
    .filter((p) => hitterNames.has(p))
    .slice(0, 3);

  const oh51 = uniqKeepOrder([
    ohCandidates[0] ?? null,
    ohCandidates[1] ?? null,
  ]).filter(Boolean) as string[];

  for (const p of oh51) exclude51.add(p);

  // OPP: top hitter (not setter1) not already picked
  const opp51 = pickHitters(1, exclude51)[0] ?? null;
  if (opp51) exclude51.add(opp51);

  // MBs: top blockers
  const mbs51 = pickBlockers(2, exclude51);
  for (const p of mbs51) exclude51.add(p);

  // If we still don't have 2 OHs, fill from remaining hitters
  while (oh51.length < 2) {
    const add = pickHitters(1, exclude51)[0];
    if (!add) break;
    oh51.push(add);
    exclude51.add(add);
  }

  const lineup51 = {
    system: "5-1",
    setter: setter1,
    libero: libero51,
    outsideHitters: oh51.slice(0, 2),
    opposite: opp51,
    middleBlockers: mbs51.slice(0, 2),
    rationale:
      "5–1 prioritizes sideout stability and cleaner decision-making. This build favors strong pass-core + top scoring option + best block presence.",
  };

  // --- 6–2 (two setters, more attacking options) ---
  const exclude62 = new Set<string>();
  if (setter1) exclude62.add(setter1);
  if (setter2) exclude62.add(setter2);

  const libero62 = libero51 ?? pickPassers(1, new Set<string>())[0] ?? null;

  // OPPs: 2 top hitters not the setters
  const opps62 = pickHitters(2, exclude62);
  for (const p of opps62) exclude62.add(p);

  // OHs: 2 best pass+hit options
  const oh62 = uniqKeepOrder(
    passers
      .map((p) => p.player)
      .filter((p) => hitterNames.has(p) && !exclude62.has(p))
      .slice(0, 3)
  ).slice(0, 2);
  for (const p of oh62) exclude62.add(p);

  // MBs: top blockers not already used
  const mbs62 = pickBlockers(2, exclude62);

  const lineup62 = {
    system: "6-2",
    setters: [setter1, setter2].filter(Boolean),
    libero: libero62,
    outsides: oh62,
    opposites: opps62,
    middleBlockers: mbs62,
    rationale:
      "6–2 increases front-row firepower if both setters can set consistently and defend/serve. Best when you want more point-scoring options without sacrificing sideout too much.",
  };

  return {
    candidates: {
      setters,
      hitters,
      passers: passers.map((p) => ({ ...p, rating: Number(p.rating.toFixed(2)) })),
      blockers,
    },
    lineup51,
    lineup62,
  };
}

/* -------------------------- Loss review (what to change) -------------------------- */

function teamRateFromAgg(a: TeamAgg) {
  const sr = a.srAttempts > 0 ? a.srWeightedSum / a.srAttempts : 0;
  return { srAttempts: a.srAttempts, srRating: sr };
}

function metric(a: TeamAgg, key: string) {
  return toNum(a.totals?.[key]);
}

function lossChangeRecommendations(
  overallWins: TeamAgg,
  overallLosses: TeamAgg,
  label: string
) {
  // Choose a small set of common, useful metrics (only if present)
  const keys = [
    { k: "serve_errors", name: "serve errors", better: "lower" as const },
    { k: "serve_aces", name: "aces", better: "higher" as const },
    { k: "attack_errors", name: "attack errors", better: "lower" as const },
    { k: "setting_errors", name: "setting errors", better: "lower" as const },
    { k: "attack_kills", name: "kills", better: "higher" as const },
  ];

  const winsSR = teamRateFromAgg(overallWins);
  const lossesSR = teamRateFromAgg(overallLosses);

  const observations: string[] = [];
  const adjustments: string[] = [];

  // SR
  if (winsSR.srAttempts > 0 || lossesSR.srAttempts > 0) {
    const w = winsSR.srAttempts > 0 ? winsSR.srRating : null;
    const l = lossesSR.srAttempts > 0 ? lossesSR.srRating : null;
    if (w !== null && l !== null && Math.abs(w - l) >= 0.05) {
      observations.push(`Serve-receive rating: wins ${w.toFixed(2)} vs losses ${l.toFixed(2)} (0–3).`);
      if (l < w) {
        adjustments.push("Sideout: tighten seam ownership + simplify first-ball options (high % tempo, fewer forced swings).");
      }
    }
  }

  // Stats keys
  for (const item of keys) {
    const w = metric(overallWins, item.k);
    const l = metric(overallLosses, item.k);
    if (w === 0 && l === 0) continue;

    const diff = l - w;
    const abs = Math.abs(diff);

    // Only surface meaningful deltas
    if (abs < 3) continue;

    observations.push(`${item.name}: wins ${w} vs losses ${l}.`);
    if (item.better === "lower" && l > w) {
      adjustments.push(`Reduce ${item.name}: set a “green/yellow/red” serve plan and avoid gifting free points in tight sets.`);
    }
    if (item.better === "higher" && l < w) {
      adjustments.push(`Increase ${item.name}: use targeted serving (two zones) and scout the weakest passer/rotation.`);
    }
  }

  // Always add a tactical, non-stat-specific item (coaching inference)
  adjustments.push("End-game: pre-commit to 2–3 “money plays” (safe sideout patterns) and a timeout script (serve target + hitter choice).");

  // De-duplicate adjustments while keeping order
  const seen = new Set<string>();
  const adj = adjustments.filter((x) => {
    if (seen.has(x)) return false;
    seen.add(x);
    return true;
  });

  return {
    title: label,
    observations: observations.slice(0, 6),
    adjustments: adj.slice(0, 6),
  };
}

function buildLossReview(agg: ReturnType<typeof computeAggregates>, opponent?: string) {
  // Overall
  const overall = lossChangeRecommendations(agg.winsAgg, agg.lossesAgg, "Across all matches");

  // Vs opponent
  let vs: ReturnType<typeof lossChangeRecommendations> | null = null;

  if (opponent) {
    const oppKey = opponent.trim();
    const lossKeys = agg.lossMatchesByOpponent?.[oppKey] ?? null;
    const winKeys = agg.winMatchesByOpponent?.[oppKey] ?? null;

    // If exact key doesn't match, try case-insensitive lookup
    if (!lossKeys || !winKeys) {
      const found = Object.keys(agg.lossMatchesByOpponent || {}).find((k) => k.toLowerCase() === oppKey.toLowerCase());
      const found2 = Object.keys(agg.winMatchesByOpponent || {}).find((k) => k.toLowerCase() === oppKey.toLowerCase());
      const lk = (found ? agg.lossMatchesByOpponent[found] : null) ?? null;
      const wk = (found2 ? agg.winMatchesByOpponent[found2] : null) ?? null;

      if (lk || wk) {
        const combine = (keys: string[]) => {
          const out: TeamAgg = { totals: {}, srAttempts: 0, srWeightedSum: 0 };
          for (const k of keys || []) {
            const a = agg.teamByMatch[k];
            if (!a) continue;
            out.srAttempts += a.srAttempts;
            out.srWeightedSum += a.srWeightedSum;
            for (const statKey of Object.keys(a.totals)) {
              out.totals[statKey] = (out.totals[statKey] ?? 0) + toNum(a.totals[statKey]);
            }
          }
          return out;
        };

        const winsA = wk && wk.length ? combine(wk) : { totals: {}, srAttempts: 0, srWeightedSum: 0 };
        const lossesA = lk && lk.length ? combine(lk) : { totals: {}, srAttempts: 0, srWeightedSum: 0 };

        vs = lossChangeRecommendations(winsA, lossesA, `Against ${found ?? found2 ?? oppKey}`);
      }
    } else {
      // Exact match present
      const combine = (keys: string[]) => {
        const out: TeamAgg = { totals: {}, srAttempts: 0, srWeightedSum: 0 };
        for (const k of keys || []) {
          const a = agg.teamByMatch[k];
          if (!a) continue;
          out.srAttempts += a.srAttempts;
          out.srWeightedSum += a.srWeightedSum;
          for (const statKey of Object.keys(a.totals)) {
            out.totals[statKey] = (out.totals[statKey] ?? 0) + toNum(a.totals[statKey]);
          }
        }
        return out;
      };

      const winsA = winKeys && winKeys.length ? combine(winKeys) : { totals: {}, srAttempts: 0, srWeightedSum: 0 };
      const lossesA = lossKeys && lossKeys.length ? combine(lossKeys) : { totals: {}, srAttempts: 0, srWeightedSum: 0 };

      vs = lossChangeRecommendations(winsA, lossesA, `Against ${oppKey}`);
    }
  }

  return { overall, vs };
}

/* -------------------------- Facts payload -------------------------- */

function buildFactsPayload(question: string, agg: ReturnType<typeof computeAggregates>) {
  const { intent, opponent, inferredKey } = detectIntent(question);

  const setters = topNForKey(agg.byPlayer as any, "setting_assists", 6);
  const hitters = topNForKey(agg.byPlayer as any, "attack_kills", 10);
  const blockersSolo = topNForKey(agg.byPlayer as any, "blocks_solo", 8);
  const blockersAssist = topNForKey(agg.byPlayer as any, "blocks_assist", 8);
  const blockersProxy = topNBlocksProxy(agg.blocksProxy, 8);
  const passers = topNPassersOverall(agg.byPlayer as any, 8, 50).map((p) => ({ ...p, rating: Number(p.rating.toFixed(2)) }));
  const digs = topNForKey(agg.byPlayer as any, "digs_successful", 8);
  const aces = topNForKey(agg.byPlayer as any, "serve_aces", 8);
  const serveErrors = topNForKey(agg.byPlayer as any, "serve_errors", 8);

  const teamServeReceive =
    agg.teamSr.attempts > 0 ? { scale: "0-3", rating: Number(agg.teamSr.rating.toFixed(2)), attempts: agg.teamSr.attempts } : null;

  const vsRecord = opponent ? agg.vsOpp?.[opponent] ?? null : null;

  const lineups = buildLineups(agg);
  const lossReview = intent === "loss_review" || intent === "loss_review_vs_opponent" ? buildLossReview(agg, opponent) : null;

  return {
    persona: PERSONA,
    window: { start: WINDOW_START, endExclusive: WINDOW_END_EXCLUSIVE },
    intent,
    opponent: opponent || null,
    inferredKey: inferredKey || null,

    team: {
      record: { wins: agg.wins, losses: agg.losses },
      teamServeReceive,
      lastMatch: agg.lastMatch,
      vsRecord: vsRecord ? { opponent, ...vsRecord } : null,
    },

    leaders: {
      settersByAssists: setters,
      hittersByKills: hitters,
      blockersBySolo: blockersSolo,
      blockersByAssist: blockersAssist,
      blockersByProxy: blockersProxy,
      passersBySrRating: passers,
      defendersByDigs: digs,
      serversByAces: aces,
      serveErrorsTop: serveErrors,
    },

    lineups: {
      candidates: lineups.candidates,
      recommended51: lineups.lineup51,
      recommended62: lineups.lineup62,
    },

    lossReview,

    // keep some raw series for MoM
    teamByMonth: agg.teamByMonth,
    srByMonth: Object.keys(agg.srByMonth)
      .sort()
      .map((m) => {
        const x = agg.srByMonth[m];
        const rating = x.attempts > 0 ? x.weightedSum / x.attempts : 0;
        return { month: m, scale: "0-3", rating: Number(rating.toFixed(2)), attempts: x.attempts };
      }),
  };
}

/* -------------------------- OpenAI: safe extract -------------------------- */

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

  const broadIntents: Intent[] = [
    "lineup",
    "lineup_51",
    "lineup_62",
    "strengths_weaknesses",
    "areas_to_improve",
    "tactics_vs_opponent",
    "loss_review",
    "loss_review_vs_opponent",
    "month_over_month_team",
    "month_over_month_player",
    "top5_each_month",
  ];

  const intent = factsPayload?.intent as Intent;
  const broad = broadIntents.includes(intent);
  const maxTokens = broad ? 1100 : 350;

  const system = `
You are "${PERSONA}" for MVVC 14 Black boys volleyball.

Answer like ChatGPT: directly answer the question asked.

Hard rules:
- Do NOT echo the question.
- Do NOT include “Try these prompts”.
- Use short headings and • bullets (no hyphen dividers).
- FACTS_JSON is the only source of factual claims.
- You may use volleyball knowledge only for interpretation/recommendations.

When facts are missing:
- Say what's missing in 1–2 lines, then still give a best-effort recommendation.
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

/* -------------------------- Deterministic fallback answers -------------------------- */

function fmtRecord(w: number, l: number) {
  return `${w}–${l}`;
}

function fallbackAnswer(question: string, facts: any) {
  const intent: Intent = facts?.intent ?? "generic";

  const team = facts?.team ?? {};
  const leaders = facts?.leaders ?? {};
  const lineups = facts?.lineups ?? {};
  const lossReview = facts?.lossReview ?? null;

  if (intent === "team_record") {
    return `Season record: ${fmtRecord(team?.record?.wins ?? 0, team?.record?.losses ?? 0)}.`;
  }

  if (intent === "last_opponent") {
    const lm = team?.lastMatch;
    if (!lm) return "I don’t have enough match_results data yet to identify the last opponent.";
    const bits: string[] = [];
    bits.push(`Last opponent: ${lm.opponent} on ${lm.date}`);
    if (lm.result) bits.push(`Result: ${lm.result}${lm.score ? ` (${lm.score})` : ""}`);
    if (lm.tournament) bits.push(`Tournament: ${lm.tournament}`);
    return bits.join("\n");
  }

  if (intent === "record_vs_opponent") {
    const vs = team?.vsRecord;
    if (!vs) return "I can’t compute record vs that opponent (opponent name might not match exactly).";
    const sd = toNum(vs.setDiff);
    const sdStr = sd === 0 ? "0" : sd > 0 ? `+${sd}` : `${sd}`;
    return `Record vs ${vs.opponent}: ${fmtRecord(vs.wins, vs.losses)} (${vs.matches} matches, set diff ${sdStr}).`;
  }

  if (intent === "best_setter") {
    const rows = leaders?.settersByAssists ?? [];
    if (!rows.length) return "I don’t see `setting_assists` in the current stats totals.";
    return `${rows[0].player} leads the team in setting assists (${rows[0].value}).`;
  }

  if (intent === "best_hitter") {
    const rows = leaders?.hittersByKills ?? [];
    if (!rows.length) return "I don’t see `attack_kills` in the current stats totals.";
    return `${rows[0].player} leads the team in kills (${rows[0].value}).`;
  }

  if (intent === "best_blocker") {
    const rows = leaders?.blockersByProxy ?? [];
    if (!rows.length) return "I don’t see block stats (`blocks_solo`/`blocks_assist`) in the current totals.";
    return `${rows[0].player} leads the team in blocks (solo+assist proxy: ${rows[0].value}).`;
  }

  if (intent === "best_passer") {
    const rows = leaders?.passersBySrRating ?? [];
    if (!rows.length) return "I don’t see serve-receive rating fields in the current totals.";
    const top = rows[0];
    return `${top.player} leads serve-receive rating (${Number(top.rating).toFixed(2)} on ${top.attempts} attempts).`;
  }

  if (intent === "best_server") {
    const rows = leaders?.serversByAces ?? [];
    if (!rows.length) return "I don’t see `serve_aces` in the current totals.";
    const top = rows[0];
    return `${top.player} leads in aces (${top.value}).`;
  }

  if (intent === "best_defender") {
    const rows = leaders?.defendersByDigs ?? [];
    if (!rows.length) return "I don’t see `digs_successful` in the current totals.";
    const top = rows[0];
    return `${top.player} leads in digs (${top.value}).`;
  }

  if (intent === "leaders") {
    const lines: string[] = [];

    lines.push("Top leaders (season totals)");
    lines.push("");

    const section = (title: string, rows: any[]) => {
      if (!Array.isArray(rows) || rows.length === 0) return;
      lines.push(title);
      for (let i = 0; i < Math.min(5, rows.length); i++) lines.push(`${i + 1}) ${rows[i].player} — ${rows[i].value}`);
      lines.push("");
    };

    section("Setters — Assists", leaders.settersByAssists ?? []);
    section("Hitters — Kills", leaders.hittersByKills ?? []);
    section("Defenders — Digs", leaders.defendersByDigs ?? []);
    section("Servers — Aces", leaders.serversByAces ?? []);
    section("Serve errors", leaders.serveErrorsTop ?? []);
    section("Blockers — Blocks (solo+assist proxy)", leaders.blockersByProxy ?? []);

    const sr = team?.teamServeReceive;
    if (sr) {
      lines.push(`Team serve-receive: ${Number(sr.rating).toFixed(2)} (0–3) on ${sr.attempts} attempts`);
    }

    return lines.join("\n").trim();
  }

  if (intent === "lineup" || intent === "lineup_51" || intent === "lineup_62") {
    const sr = team?.teamServeReceive;
    const rec = team?.record;

    const lines: string[] = [];
    lines.push("Lineup recommendations (best chance to win, best-effort from available stats)");
    if (rec) lines.push(`Record: ${fmtRecord(rec.wins, rec.losses)}`);
    if (sr) lines.push(`Team SR: ${Number(sr.rating).toFixed(2)} (0–3) on ${sr.attempts}`);
    lines.push("");

    const l51 = lineups?.recommended51;
    const l62 = lineups?.recommended62;

    const print51 = () => {
      if (!l51) return;
      lines.push("Recommended 5–1");
      lines.push(`• Setter: ${l51.setter ?? "Unknown"}`);
      lines.push(`• Opposite: ${l51.opposite ?? "Unknown"}`);
      lines.push(`• OH: ${(l51.outsideHitters ?? []).join(", ") || "Unknown"}`);
      lines.push(`• MB: ${(l51.middleBlockers ?? []).join(", ") || "Unknown"}`);
      lines.push(`• Libero: ${l51.libero ?? "Unknown"}`);
      lines.push(`• Why: ${l51.rationale}`);
      lines.push("");
    };

    const print62 = () => {
      if (!l62) return;
      lines.push("Recommended 6–2");
      lines.push(`• Setters: ${(l62.setters ?? []).join(", ") || "Unknown"}`);
      lines.push(`• Opposites: ${(l62.opposites ?? []).join(", ") || "Unknown"}`);
      lines.push(`• OH: ${(l62.outsides ?? []).join(", ") || "Unknown"}`);
      lines.push(`• MB: ${(l62.middleBlockers ?? []).join(", ") || "Unknown"}`);
      lines.push(`• Libero: ${l62.libero ?? "Unknown"}`);
      lines.push(`• Why: ${l62.rationale}`);
      lines.push("");
    };

    if (intent === "lineup_51") {
      print51();
      lines.push("If you want this rotation-accurate: confirm each player’s primary position (S/OH/OPP/MB/L/DS) in your data.");
      return lines.join("\n").trim();
    }

    if (intent === "lineup_62") {
      print62();
      lines.push("If you want this rotation-accurate: confirm each player’s primary position (S/OH/OPP/MB/L/DS) in your data.");
      return lines.join("\n").trim();
    }

    // general lineup question → show both, and explain when to use which
    print51();
    print62();
    lines.push("When to choose which");
    lines.push("• Choose 5–1 if you want cleaner sideout and fewer moving parts (usually best for winning when passing is inconsistent).");
    lines.push("• Choose 6–2 if both setters are steady and you need more front-row point scoring.");
    lines.push("");
    lines.push("To make this truly “best chance to win” by matchup, tell me the opponent (e.g., “6–2 vs NCVC”) and I’ll tailor serve/sideout priorities.");

    return lines.join("\n").trim();
  }

  if (intent === "loss_review" || intent === "loss_review_vs_opponent") {
    if (!lossReview) {
      return "I couldn’t build a data-backed loss review yet (missing match-linked team stats by date/opponent).";
    }

    const lines: string[] = [];
    lines.push("What could we change in losses (data-backed + coaching plan)");
    lines.push("");

    const block = (title: string, obj: any) => {
      if (!obj) return;
      lines.push(title);
      if (obj.observations?.length) {
        lines.push("• Observations");
        for (const o of obj.observations) lines.push(`  • ${o}`);
      }
      if (obj.adjustments?.length) {
        lines.push("• High-impact changes");
        for (const a of obj.adjustments) lines.push(`  • ${a}`);
      }
      lines.push("");
    };

    block(lossReview.overall?.title ?? "Across all matches", lossReview.overall);
    if (lossReview.vs) block(lossReview.vs.title, lossReview.vs);

    // If vs opponent but no vs block, still provide a matchup template
    if (intent === "loss_review_vs_opponent" && !lossReview.vs) {
      lines.push("Opponent-specific note");
      lines.push("• I can’t isolate match-linked stats vs that opponent yet (name/date mismatch).");
      lines.push("• Still: prioritize fewer free points (serve errors) + simplify sideout choices in tight rotations.");
      lines.push("");
    }

    return lines.join("\n").trim();
  }

  if (intent === "strengths_weaknesses" || intent === "areas_to_improve" || intent === "tactics_vs_opponent") {
    // Deterministic but useful narrative, while keeping facts only from known totals/leaders
    const rec = team?.record;
    const sr = team?.teamServeReceive;

    const topKill = (leaders?.hittersByKills ?? [])[0];
    const topAce = (leaders?.serversByAces ?? [])[0];
    const topDig = (leaders?.defendersByDigs ?? [])[0];
    const topSetter = (leaders?.settersByAssists ?? [])[0];
    const topBlock = (leaders?.blockersByProxy ?? [])[0];
    const topServeErr = (leaders?.serveErrorsTop ?? [])[0];

    const lines: string[] = [];
    lines.push("Team snapshot");
    if (rec) lines.push(`• Record: ${fmtRecord(rec.wins, rec.losses)}`);
    if (sr) lines.push(`• Team serve-receive: ${Number(sr.rating).toFixed(2)} (0–3) on ${sr.attempts} attempts`);
    lines.push("");

    lines.push("What the data points to");
    if (topSetter) lines.push(`• Setting volume leader: ${topSetter.player} (${topSetter.value} assists)`);
    if (topKill) lines.push(`• Primary scoring: ${topKill.player} (${topKill.value} kills)`);
    if (topBlock) lines.push(`• Net presence (blocks proxy): ${topBlock.player} (${topBlock.value})`);
    if (topAce) lines.push(`• Serve pressure: ${topAce.player} (${topAce.value} aces)`);
    if (topDig) lines.push(`• Defense: ${topDig.player} (${topDig.value} digs)`);
    if (topServeErr) lines.push(`• “Free point” risk: ${topServeErr.player} leads serve errors (${topServeErr.value})`);
    lines.push("");

    if (intent === "areas_to_improve") {
      lines.push("High-impact improvements (winning-focused)");
      lines.push("• Sideout: build rotations around your best 2–3 passers and reduce “hero swings” on bad passes.");
      lines.push("• Serving: stay aggressive but reduce free points—define 2 target zones per set and live with a smaller miss window.");
      lines.push("• Transition: assign one predictable out-of-system option (high seam or high line) to cut decision errors.");
      return lines.join("\n");
    }

    if (intent === "tactics_vs_opponent") {
      const opp = facts?.opponent;
      if (opp) lines.push(`Tactics vs ${opp} (best-practice template)`);
      else lines.push("Tactics (best-practice template)");

      // add record vs opponent if present
      const vs = team?.vsRecord;
      if (vs) lines.push(`• Record vs ${vs.opponent}: ${fmtRecord(vs.wins, vs.losses)} (${vs.matches} matches)`);

      lines.push("• Serve: pick 2 zones and target their weakest passer/rotation; avoid gifting runs with back-to-back misses.");
      lines.push("• Sideout: simplify—first ball to your highest % option; if pass is off, use a high ball system with clear hitter priority.");
      lines.push("• Block/defense: commit to one read (line vs cross) per rotation; don’t change mid-rally.");
      lines.push("• End game: pre-plan your timeout script (serve target + hitter choice + freeball play).");
      return lines.join("\n");
    }

    // strengths/weaknesses
    lines.push("Strengths / weaknesses (best-effort)");
    lines.push("• Strength: if your SR is solid, you can run faster offense and spread scoring.");
    lines.push("• Weakness risk: free points (serve errors) + out-of-system swings—these swing close sets.");
    return lines.join("\n");
  }

  // Generic safe fallback
  return "Ask me about: team record, leaders (top 5), best setter/hitter/blocker/passer, lineup 5–1 or 6–2, record vs opponent, or what we should change in losses.";
}

/* ------------------------------- Route ------------------------------- */

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { question?: string; thread_id?: string };
    const question = String(body?.question ?? "").trim();
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    const { matches, statsRows } = await retrieveData(TEAM_ID);
    const agg = computeAggregates(matches, statsRows);
    const factsPayload = buildFactsPayload(question, agg);

    // Try OpenAI for richer narrative (but never fail blank)
    let answer = "";
    try {
      // Only call OpenAI if key is present; otherwise deterministic only
      if (process.env.OPENAI_API_KEY) {
        answer = await callOpenAI(question, factsPayload);
      }
    } catch (err: any) {
      console.error("[OpenAI]", err?.message ?? String(err));
      answer = "";
    }

    if (!answer) answer = fallbackAnswer(question, factsPayload);

    return NextResponse.json({
      answer,
      // optional metadata if you want UI to display it later
      persona: PERSONA,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
