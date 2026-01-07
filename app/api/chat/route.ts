import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5";
const SEASON_START = "2025-08-01";
const SEASON_END_EXCLUSIVE = "2026-08-01";
const PERSONA = "MVVC Analyst";

// Cache season data to avoid hammering Supabase on every request
const CACHE_TTL_MS = 2 * 60 * 1000;

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

function safeIso(d: string | null) {
  const x = (d ?? "").trim();
  return x && x.includes("-") ? x : "";
}

function monthKey(isoDate: string) {
  return isoDate.slice(0, 7);
}

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
      return { player: p, rating: Number(r.toFixed(2)), attempts: att };
    })
    .filter((x) => x.attempts > 0)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, n);
}

function computeAggregates(matches: MatchRow[], statsRows: StatRow[]) {
  let wins = 0;
  let losses = 0;

  // Opponent breakdown + trouble opponents
  const opp: Record<
    string,
    { matches: number; wins: number; losses: number; setDiff: number; lastDate: string; lastScore?: string | null }
  > = {};

  // last match
  let lastMatch: MatchRow | null = null;

  for (const m of matches) {
    const iso = safeIso(m.match_date);
    if (iso) {
      if (!lastMatch || safeIso(lastMatch.match_date).localeCompare(iso) < 0) lastMatch = m;
    }

    const wl = normalizeWinLoss(m.result);
    if (wl === "W") wins++;
    if (wl === "L") losses++;

    const opponent = (m.opponent ?? "").trim() || "Unknown Opponent";
    if (!opp[opponent]) opp[opponent] = { matches: 0, wins: 0, losses: 0, setDiff: 0, lastDate: "", lastScore: null };
    opp[opponent].matches += 1;
    if (wl === "W") opp[opponent].wins += 1;
    if (wl === "L") opp[opponent].losses += 1;
    opp[opponent].setDiff += toNum(m.set_diff);
    if (iso && opp[opponent].lastDate.localeCompare(iso) < 0) {
      opp[opponent].lastDate = iso;
      opp[opponent].lastScore = m.score ?? null;
    }
  }

  const byPlayer: Record<string, PlayerAgg> = {};
  const teamByMonth: Record<string, Record<string, number>> = {};
  const srByMonth: Record<string, { attempts: number; weightedSum: number }> = {};
  const statKeySet = new Set<string>();

  for (const row of statsRows) {
    const player = (row.player_name ?? "").trim();
    if (!player) continue;

    const stats = parseStats(row.stats);
    const pos = (row.position ?? stats.position ?? null) as string | null;

    const iso = safeIso(row.game_date);
    const mk = iso ? monthKey(iso) : "";

    if (!byPlayer[player]) byPlayer[player] = { position: pos, totals: {}, srAttempts: 0, srWeightedSum: 0 };
    if (!byPlayer[player].position && pos) byPlayer[player].position = pos;

    for (const key of Object.keys(stats)) {
      if (key === "player_name" || key === "position" || key === "opponent" || key === "match_date" || key === "source_file") continue;
      const n = toNum(stats[key]);
      if (n === 0) continue;

      statKeySet.add(key);
      byPlayer[player].totals[key] = (byPlayer[player].totals[key] ?? 0) + n;

      if (mk) {
        teamByMonth[mk] = teamByMonth[mk] ?? {};
        teamByMonth[mk][key] = (teamByMonth[mk][key] ?? 0) + n;
      }
    }

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

  // Team SR overall
  let teamSrAttempts = 0;
  let teamSrWeightedSum = 0;
  for (const p of Object.keys(byPlayer)) {
    teamSrAttempts += byPlayer[p].srAttempts;
    teamSrWeightedSum += byPlayer[p].srWeightedSum;
  }
  const teamSrRating = teamSrAttempts > 0 ? teamSrWeightedSum / teamSrAttempts : 0;

  // Positions map
  const positions: Record<string, string | null> = {};
  for (const p of Object.keys(byPlayer)) positions[p] = byPlayer[p].position ?? null;

  // Last 5 losses (for "what would we change in losses?")
  const lossesList = matches
    .filter((m) => normalizeWinLoss(m.result) === "L" && safeIso(m.match_date))
    .slice()
    .sort((a, b) => safeIso(b.match_date).localeCompare(safeIso(a.match_date)))
    .slice(0, 5)
    .map((m) => ({
      date: m.match_date,
      opponent: m.opponent,
      tournament: m.tournament,
      round: m.round,
      score: m.score,
      set_diff: m.set_diff,
    }));

  // Opponent summary sorted by "trouble" (losses, then setDiff)
  const opponentSummary = Object.keys(opp)
    .map((k) => ({
      opponent: k,
      matches: opp[k].matches,
      wins: opp[k].wins,
      losses: opp[k].losses,
      setDiff: opp[k].setDiff,
      lastDate: opp[k].lastDate || null,
      lastScore: opp[k].lastScore ?? null,
    }))
    .sort((a, b) => (b.losses !== a.losses ? b.losses - a.losses : a.setDiff - b.setDiff));

  return {
    wins,
    losses,
    lastMatch,
    lossesList,
    byPlayer,
    positions,
    opponentSummary,
    availableStatKeys: Array.from(statKeySet.values()).sort(),
    teamServeReceive: teamSrAttempts > 0 ? { scale: "0-3", rating: Number(teamSrRating.toFixed(2)), attempts: teamSrAttempts } : null,
    teamByMonth,
    srByMonth,
    hasMatches: matches.length > 0,
    hasStats: Object.keys(byPlayer).length > 0,
  };
}

/* -------------------------- Supabase fetch + cache -------------------------- */

async function fetchSeasonData() {
  const supabase = supabaseService();

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

  return {
    matches: (matchesRes.data ?? []) as MatchRow[],
    statsRows: (statsRes.data ?? []) as StatRow[],
  };
}

let cache:
  | {
      createdAt: number;
      matches: MatchRow[];
      statsRows: StatRow[];
      agg: ReturnType<typeof computeAggregates>;
    }
  | null = null;

let inflight: Promise<{
  matches: MatchRow[];
  statsRows: StatRow[];
  agg: ReturnType<typeof computeAggregates>;
}> | null = null;

function cacheValid() {
  return !!cache && Date.now() - cache.createdAt < CACHE_TTL_MS;
}

async function getCachedSeason() {
  if (cacheValid()) return cache!;
  if (inflight) return inflight;

  inflight = (async () => {
    const { matches, statsRows } = await fetchSeasonData();
    const agg = computeAggregates(matches, statsRows);
    const value = { createdAt: Date.now(), matches, statsRows, agg };
    cache = value;
    return value;
  })();

  const out = await inflight;
  inflight = null;
  return out;
}

/* -------------------------- OpenAI (robust extract + timeout) -------------------------- */

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

  const system = `
You are "${PERSONA}" for MVVC 14 Black boys volleyball.

Non-negotiable behavior:
- ALWAYS answer the user’s question (no "I hit an error", no "no response", no prompt-dumping).
- Output must be BEAUTIFUL Markdown: headings, spacing, and tables when appropriate.
- FACTS_JSON is the only source of factual claims (names, numbers, match results).
- You may use volleyball knowledge for coaching insights; label it as "coaching inference" when not directly supported by FACTS_JSON.

Formatting rules:
- Use short sections with blank lines between them.
- Prefer tables for roster, leaderboards, and match lists.
- Avoid long dense paragraphs.
- If user asks for lineup: provide BOTH 5–1 and 6–2 options + 3–6 bullet rationale.
- If user asks "what could we have changed in losses vs X": give 6–10 actionable adjustments (serve plan, SR seams, first ball, rotation escapes, block/defense).
`;

  const userObj = { question, FACTS_JSON: factsPayload };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
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
          { role: "user", content: [{ type: "input_text", text: JSON.stringify(userObj) }] },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`OpenAI error ${res.status}: ${txt}`);
    }

    const json = await res.json();
    return safeExtractOutputText(json);
  } finally {
    clearTimeout(timeout);
  }
}

/* -------------------------- Universal fallback (never blank) -------------------------- */

function renderRosterTable(positions: Record<string, string | null>) {
  const players = Object.keys(positions)
    .map((p) => ({ player: p, pos: positions[p] ?? "Unknown" }))
    .sort((a, b) => a.player.localeCompare(b.player));

  const lines: string[] = [];
  lines.push(`| Player | Position |`);
  lines.push(`|---|---|`);
  for (const r of players) lines.push(`| ${r.player} | ${r.pos || "Unknown"} |`);
  return lines.join("\n");
}

function renderLeadersTable(agg: ReturnType<typeof computeAggregates>) {
  const kills = topNForKey(agg.byPlayer, "attack_kills", 5);
  const assists = topNForKey(agg.byPlayer, "setting_assists", 5);
  const aces = topNForKey(agg.byPlayer, "serve_aces", 5);
  const digs = topNForKey(agg.byPlayer, "digs_successful", 5);
  const soloBlocks = topNForKey(agg.byPlayer, "blocks_solo", 5);
  const passers = topNPassersOverall(agg.byPlayer, 5);

  const lines: string[] = [];
  lines.push(`## Leaders (data-backed)`);
  lines.push("");
  lines.push(`| Category | #1 | #2 | #3 |`);
  lines.push(`|---|---|---|---|`);

  const fmt3 = (rows: Array<{ player: string; value: number }>) => {
    const a = rows[0] ? `${rows[0].player} (${rows[0].value})` : "—";
    const b = rows[1] ? `${rows[1].player} (${rows[1].value})` : "—";
    const c = rows[2] ? `${rows[2].player} (${rows[2].value})` : "—";
    return [a, b, c];
  };

  const [k1, k2, k3] = fmt3(kills);
  const [a1, a2, a3] = fmt3(assists);
  const [s1, s2, s3] = fmt3(aces);
  const [d1, d2, d3] = fmt3(digs);
  const [b1, b2, b3] = fmt3(soloBlocks);

  const p1 = passers[0] ? `${passers[0].player} (${passers[0].rating} on ${passers[0].attempts})` : "—";
  const p2 = passers[1] ? `${passers[1].player} (${passers[1].rating} on ${passers[1].attempts})` : "—";
  const p3 = passers[2] ? `${passers[2].player} (${passers[2].rating} on ${passers[2].attempts})` : "—";

  lines.push(`| Kills | ${k1} | ${k2} | ${k3} |`);
  lines.push(`| Assists | ${a1} | ${a2} | ${a3} |`);
  lines.push(`| Aces | ${s1} | ${s2} | ${s3} |`);
  lines.push(`| Digs | ${d1} | ${d2} | ${d3} |`);
  lines.push(`| Solo blocks | ${b1} | ${b2} | ${b3} |`);
  lines.push(`| Serve-receive (SR) | ${p1} | ${p2} | ${p3} |`);

  return lines.join("\n");
}

function renderMatchesTable(matches: Array<any>) {
  const lines: string[] = [];
  lines.push(`| Date | Opponent | Result | Score | Tournament | Round |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const m of matches) {
    const date = m.date ?? "—";
    const opp = m.opponent ?? "—";
    const res = m.result ?? "—";
    const score = m.score ?? "—";
    const t = m.tournament ?? "—";
    const r = m.round ?? "—";
    lines.push(`| ${date} | ${opp} | ${res} | ${score} | ${t} | ${r} |`);
  }
  return lines.join("\n");
}

function bestEffortLineups(agg: ReturnType<typeof computeAggregates>) {
  // Data-driven picks:
  const setters = topNForKey(agg.byPlayer, "setting_assists", 4);
  const hitters = topNForKey(agg.byPlayer, "attack_kills", 8);
  const passers = topNPassersOverall(agg.byPlayer, 6);
  const soloBlocks = topNForKey(agg.byPlayer, "blocks_solo", 6);
  const assistBlocks = topNForKey(agg.byPlayer, "blocks_assist", 6);

  // Net proxy (blocks)
  const blockProxy: Record<string, number> = {};
  for (const r of [...soloBlocks, ...assistBlocks]) blockProxy[r.player] = (blockProxy[r.player] ?? 0) + r.value;
  const net = Object.keys(blockProxy)
    .map((p) => ({ player: p, value: blockProxy[p] }))
    .sort((a, b) => b.value - a.value);

  const s1 = setters[0]?.player ?? null;
  const s2 = setters[1]?.player ?? null;

  // “Winning bias” heuristics (coaching inference):
  // - prioritize SR stability + point scoring: top passers + top kills + net presence
  const corePass = passers.slice(0, 3).map((x) => x.player);
  const coreKills = hitters.slice(0, 4).map((x) => x.player);
  const coreNet = net.slice(0, 2).map((x) => x.player);

  // Dedup while preserving order
  const pick = (arr: (string | null | undefined)[], max: number) => {
    const out: string[] = [];
    for (const x of arr) {
      const v = (x ?? "").trim();
      if (!v) continue;
      if (!out.includes(v)) out.push(v);
      if (out.length >= max) break;
    }
    return out;
  };

  // 5–1: 1 setter + best 5 others
  const lineup51 = {
    setter: s1 ?? "Unknown setter",
    others: pick([...(corePass as any), ...(coreKills as any), ...(coreNet as any), s2 ?? undefined], 5),
  };

  // 6–2: 2 setters + best 4 others (ideally setters are different people)
  const lineup62 = {
    setters: pick([s1, s2], 2),
    others: pick([...(corePass as any), ...(coreKills as any), ...(coreNet as any)], 4),
  };

  return { lineup51, lineup62, debug: { setters, hitters, passers, net } };
}

function universalFallbackAnswer(question: string, facts: any) {
  const q = s(question);
  const agg = facts?._agg as ReturnType<typeof computeAggregates> | null;

  const record =
    facts?.team?.record && typeof facts.team.record.wins === "number"
      ? `${facts.team.record.wins}-${facts.team.record.losses}`
      : "N/A";

  const last =
    facts?.team?.lastMatch?.date
      ? `${facts.team.lastMatch.date} vs ${facts.team.lastMatch.opponent ?? "?"} — ${facts.team.lastMatch.result ?? "?"}${
          facts.team.lastMatch.score ? ` (${facts.team.lastMatch.score})` : ""
        }`
      : "N/A";

  const sr =
    facts?.team?.teamServeReceive?.attempts
      ? `${Number(facts.team.teamServeReceive.rating).toFixed(2)} (0–3) on ${facts.team.teamServeReceive.attempts} attempts`
      : "N/A";

  const lines: string[] = [];
  lines.push(`## MVVC 14 Black — ${PERSONA}`);
  lines.push("");
  lines.push(`**Record:** ${record}`);
  lines.push(`**Team SR:** ${sr}`);
  lines.push(`**Last match:** ${last}`);
  lines.push("");

  // If they ask for matches / every game
  if (q.includes("every game") || q.includes("all games") || q.includes("game result") || q.includes("results") || q.includes("schedule")) {
    const all = Array.isArray(facts?.matches?.all) ? facts.matches.all : [];
    lines.push(`## Game results (season)`);
    lines.push("");
    if (!all.length) {
      lines.push(`I don’t have match results in the current dataset.`);
      return lines.join("\n");
    }
    lines.push(renderMatchesTable(all));
    return lines.join("\n");
  }

  // Roster
  if (q.includes("roster") || q.includes("players")) {
    const pos = facts?.players?.positions ?? {};
    lines.push(`## Team roster`);
    lines.push("");
    lines.push(renderRosterTable(pos));
    lines.push("");
    lines.push(renderLeadersTable(facts._agg ?? agg));
    return lines.join("\n");
  }

  // Lineup
  if (q.includes("lineup") || q.includes("5-1") || q.includes("6-2") || q.includes("starting")) {
    if (!agg) {
      lines.push(`## Projected lineups (best-effort)`);
      lines.push("");
      lines.push(`I don’t have enough player stat totals to build lineups from data right now.`);
      lines.push(`Coaching inference: confirm your setter(s), primary passers, and top terminators, and I’ll lock this down.`);
      return lines.join("\n");
    }

    const { lineup51, lineup62 } = bestEffortLineups(agg);

    lines.push(`## Projected lineups (best-effort, biased toward winning)`);
    lines.push("");
    lines.push(`### 5–1 (stability / clearer tempo)`);
    lines.push(`**Setter:** ${lineup51.setter}`);
    lines.push(`**Other 5:** ${lineup51.others.join(", ") || "TBD"}`);
    lines.push("");
    lines.push(`### 6–2 (more front-row options, higher sub/connection demands)`);
    lines.push(`**Setters:** ${lineup62.setters.join(", ") || "TBD"}`);
    lines.push(`**Other 4:** ${lineup62.others.join(", ") || "TBD"}`);
    lines.push("");
    lines.push(`### Why this gives you the best chance to win (coaching inference)`);
    lines.push(`• Prioritizes your highest-volume setters (assists) for repeatable in-system offense.`);
    lines.push(`• Anchors serve-receive around your best SR passers to keep first-ball sideout high.`);
    lines.push(`• Keeps your top kill producers on the floor to convert in transition and score points.`);
    lines.push(`• Adds net presence using blocks as a proxy for MB/OPP impact when positions are incomplete.`);
    lines.push("");
    lines.push(`If you want a true on-court 6 (S/OH/OH/MB/MB/OPP + L), I need primary positions for each player.`);
    return lines.join("\n");
  }

  // Loss improvement / opponent adjustments
  if (
    q.includes("loss") ||
    q.includes("lost") ||
    q.includes("what could we have done") ||
    q.includes("what should we have done") ||
    q.includes("how do we beat") ||
    q.includes("beat") ||
    q.includes("changes") ||
    q.includes("adjust")
  ) {
    const oppSummary = Array.isArray(facts?.team?.opponents) ? facts.team.opponents : [];
    const recentLosses = Array.isArray(facts?.team?.recentLosses) ? facts.team.recentLosses : [];

    lines.push(`## What to change in losses (best-effort)`);
    lines.push("");
    if (recentLosses.length) {
      lines.push(`### Most recent losses (data-backed)`);
      lines.push("");
      lines.push(`| Date | Opponent | Score | Tournament |`);
      lines.push(`|---|---|---|---|`);
      for (const L of recentLosses) {
        lines.push(`| ${L.date ?? "—"} | ${L.opponent ?? "—"} | ${L.score ?? "—"} | ${L.tournament ?? "—"} |`);
      }
      lines.push("");
    }

    lines.push(`### High-leverage adjustments (coaching inference)`);
    lines.push(`• **Serve plan:** pick 1–2 targets (weak passer / short zone / seam) and track misses (net/long/wide) to reduce free points.`);
    lines.push(`• **SR seams:** assign seams explicitly (who takes middle seam balls) and simplify to 2–3 passers if you’re getting pushed off the net.`);
    lines.push(`• **First-ball offense:** when out-of-system, run higher-margin sets (high OH/OPP) and prioritize “in-play” swings over low-percentage kills.`);
    lines.push(`• **Rotation escape:** pre-plan one “bad rotation” escape (serve sub, different passer pattern, or a safe set sequence).`);
    lines.push(`• **Block/defense:** if you’re getting tool’d, soften hands and funnel to your best digger; if you’re getting beat line, commit the defender and take cross.`);
    lines.push(`• **Transition scoring:** call 2–3 transition plays (pipe, quick, or OPP D-ball) you trust—transition points often decide tight matches.`);
    lines.push("");

    if (oppSummary.length) {
      lines.push(`### Who has given you the most trouble (data-backed)`);
      lines.push("");
      lines.push(`| Opponent | W | L | Matches | Set diff |`);
      lines.push(`|---|---:|---:|---:|---:|`);
      for (const o of oppSummary.slice(0, 6)) {
        lines.push(`| ${o.opponent} | ${o.wins} | ${o.losses} | ${o.matches} | ${o.setDiff} |`);
      }
    }

    return lines.join("\n");
  }

  // Default: answer broadly using leaders + coaching guidance
  lines.push(`## Best-effort answer`);
  lines.push("");
  lines.push(
    `I can answer this better if you tell me what you want to optimize (sideout stability vs point scoring), ` +
      `but here’s a solid coaching read based on what’s available.`
  );
  lines.push("");
  if (agg) {
    lines.push(renderLeadersTable(agg));
    lines.push("");
  }
  lines.push(`### Practical next steps (coaching inference)`);
  lines.push(`• Tighten SR seams and prioritize first-ball sideout.`);
  lines.push(`• Reduce free points from serve errors while keeping pressure.`);
  lines.push(`• Identify 1–2 “go-to” attackers in high leverage moments and simplify late-game decision-making.`);
  lines.push("");
  lines.push(`If you paste the exact question you want answered (or name an opponent), I’ll tailor the plan.`);
  return lines.join("\n");
}

/* -------------------------- Route -------------------------- */

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { question?: string; thread_id?: string | null };
    const question = String(body?.question ?? "").trim();
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    // 1) Load season data (cached)
    const season = await getCachedSeason();
    const agg = season.agg;

    // 2) Facts payload (include ALL matches by default, per your request)
    const factsPayload: any = {
      persona: PERSONA,
      window: { start: SEASON_START, endExclusive: SEASON_END_EXCLUSIVE },
      team: {
        record: agg.hasMatches ? { wins: agg.wins, losses: agg.losses } : null,
        lastMatch: agg.lastMatch
          ? {
              date: agg.lastMatch.match_date,
              opponent: agg.lastMatch.opponent,
              result: normalizeWinLoss(agg.lastMatch.result),
              score: agg.lastMatch.score,
              tournament: agg.lastMatch.tournament,
              round: agg.lastMatch.round,
            }
          : null,
        teamServeReceive: agg.teamServeReceive,
        opponents: agg.opponentSummary.slice(0, 50), // cap to keep payload sane
        recentLosses: agg.lossesList,
      },
      players: {
        positions: agg.positions,
        availableStatKeys: agg.availableStatKeys,
        leaders: {
          killsTop5: topNForKey(agg.byPlayer, "attack_kills", 5),
          assistsTop5: topNForKey(agg.byPlayer, "setting_assists", 5),
          acesTop5: topNForKey(agg.byPlayer, "serve_aces", 5),
          digsTop5: topNForKey(agg.byPlayer, "digs_successful", 5),
          blocksSoloTop5: topNForKey(agg.byPlayer, "blocks_solo", 5),
          blocksAssistTop5: topNForKey(agg.byPlayer, "blocks_assist", 5),
          passersTop5: topNPassersOverall(agg.byPlayer, 5),
          serveErrorsTop5: topNForKey(agg.byPlayer, "serve_errors", 5),
          attackErrorsTop5: topNForKey(agg.byPlayer, "attack_errors", 5),
        },
      },
      matches: {
        all: season.matches.map((m) => ({
          date: m.match_date,
          opponent: m.opponent,
          tournament: m.tournament,
          round: m.round,
          result: normalizeWinLoss(m.result),
          score: m.score,
          sets_won: m.sets_won,
          sets_lost: m.sets_lost,
          set_diff: m.set_diff,
        })),
      },
      // Internal-only helper for fallback (not a “fact source” for OpenAI)
      _agg: agg,
    };

    // 3) OpenAI (best) + universal fallback (always returns an answer)
    let answer = "";
    try {
      answer = await callOpenAI(question, factsPayload);
    } catch (err: any) {
      console.error("[OpenAI]", err?.message ?? String(err));
      answer = "";
    }

    if (!answer) {
      answer = universalFallbackAnswer(question, factsPayload);
    }

    return NextResponse.json({ answer, thread_id: body?.thread_id ?? null });
  } catch (e: any) {
    // Even here: return a readable answer (no blank)
    const msg = e?.message ?? String(e);
    const answer =
      `## MVVC 14 Black — ${PERSONA}\n\n` +
      `I hit a server error, but you can keep going.\n\n` +
      `**Error:** ${msg}\n\n` +
      `Try again, or ask: **team roster**, **show every game result**, **leaders (top 5)**, or **projected 5–1 lineup**.`;

    return NextResponse.json({ answer, error: msg }, { status: 200 });
  }
}
