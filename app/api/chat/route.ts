import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5";
const SEASON_START = "2025-08-01";
const SEASON_END_EXCLUSIVE = "2026-08-01";
const PERSONA = "MVVC Analyst";

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
  stats: any;
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

type PlayerAgg = {
  position: string | null;
  totals: Record<string, number>;
  srAttempts: number;
  srWeightedSum: number;
};

function computeAggregates(matches: MatchRow[], statsRows: StatRow[]) {
  let wins = 0;
  let losses = 0;

  // Opponent rollups (for "record vs opponent" / "what changed in losses")
  const vsOpponent: Record<
    string,
    {
      matches: number;
      wins: number;
      losses: number;
      setDiff: number;
      lastDate: string;
      lastScore: string;
      lastTournament: string;
    }
  > = {};

  for (const m of matches) {
    const wl = normalizeWinLoss(m.result);
    if (wl === "W") wins++;
    if (wl === "L") losses++;

    const opp = (m.opponent ?? "Unknown Opponent").trim() || "Unknown Opponent";
    const iso = safeIso(m.match_date);
    if (!vsOpponent[opp]) {
      vsOpponent[opp] = {
        matches: 0,
        wins: 0,
        losses: 0,
        setDiff: 0,
        lastDate: "",
        lastScore: "",
        lastTournament: "",
      };
    }
    vsOpponent[opp].matches += 1;
    if (wl === "W") vsOpponent[opp].wins += 1;
    if (wl === "L") vsOpponent[opp].losses += 1;
    vsOpponent[opp].setDiff += toNum(m.set_diff);

    if (iso && (!vsOpponent[opp].lastDate || iso > vsOpponent[opp].lastDate)) {
      vsOpponent[opp].lastDate = iso;
      vsOpponent[opp].lastScore = (m.score ?? "").trim();
      vsOpponent[opp].lastTournament = (m.tournament ?? "").trim();
    }
  }

  const byPlayer: Record<string, PlayerAgg> = {};
  const teamByMonth: Record<string, Record<string, number>> = {};
  const statKeySet = new Set<string>();

  for (const row of statsRows) {
    const player = (row.player_name ?? "").trim();
    if (!player) continue;

    const stats = parseStats(row.stats);
    const pos = (row.position ?? stats.position ?? null) as string | null;

    const iso = safeIso(row.game_date);
    const mk = iso ? monthKey(iso) : "";

    if (!byPlayer[player]) {
      byPlayer[player] = { position: pos, totals: {}, srAttempts: 0, srWeightedSum: 0 };
    }
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

    // SR weighted rating (0–3)
    const srAtt = toNum(stats.serve_receive_attempts);
    const srRating = toNum(stats.serve_receive_passing_rating);
    if (srAtt > 0) {
      byPlayer[player].srAttempts += srAtt;
      byPlayer[player].srWeightedSum += srRating * srAtt;
    }
  }

  let teamSrAttempts = 0;
  let teamSrWeightedSum = 0;
  for (const p of Object.keys(byPlayer)) {
    teamSrAttempts += byPlayer[p].srAttempts;
    teamSrWeightedSum += byPlayer[p].srWeightedSum;
  }
  const teamSrRating = teamSrAttempts > 0 ? teamSrWeightedSum / teamSrAttempts : 0;

  const lastMatch = (() => {
    const ms = matches
      .filter((m) => safeIso(m.match_date))
      .slice()
      .sort((a, b) => safeIso(a.match_date).localeCompare(safeIso(b.match_date)));
    return ms.length ? ms[ms.length - 1] : null;
  })();

  const positions: Record<string, string | null> = {};
  for (const p of Object.keys(byPlayer)) positions[p] = byPlayer[p].position ?? null;

  const vsOpponentRows = Object.keys(vsOpponent)
    .map((opp) => ({
      opponent: opp,
      matches: vsOpponent[opp].matches,
      wins: vsOpponent[opp].wins,
      losses: vsOpponent[opp].losses,
      setDiff: vsOpponent[opp].setDiff,
      lastDate: vsOpponent[opp].lastDate,
      lastScore: vsOpponent[opp].lastScore,
      lastTournament: vsOpponent[opp].lastTournament,
    }))
    .sort((a, b) => b.losses - a.losses || a.setDiff - b.setDiff);

  const troubleOpponents = vsOpponentRows.filter((r) => r.losses > 0).slice(0, 10);

  return {
    wins,
    losses,
    lastMatch,
    byPlayer,
    positions,
    availableStatKeys: Array.from(statKeySet.values()).sort(),
    teamServeReceive: teamSrAttempts > 0 ? { scale: "0-3", rating: Number(teamSrRating.toFixed(2)), attempts: teamSrAttempts } : null,
    teamByMonth,
    vsOpponentRows,
    troubleOpponents,
    hasMatches: matches.length > 0,
    hasStats: Object.keys(byPlayer).length > 0,
  };
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

// Simple in-memory cache
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

Critical: Your output must be BEAUTIFUL and easy to read.

Formatting rules:
- Use Markdown with spacing.
- Use headings (##) and short sections.
- Prefer tables for roster, leaderboards, opponent records, and match results.
- Always leave a blank line between sections.
- Use bullets only when it improves readability.
- Never output long dense paragraphs with inline bullets.
- When outputting a Markdown table, ALWAYS put each row on its own line.

Facts policy:
- FACTS_JSON is the only source of factual claims (names, numbers, results).
- You may use general volleyball knowledge for coaching insights, but label it as "coaching inference" when not directly supported by FACTS_JSON.

Behavior:
- Answer directly.
- If roster is requested: output a roster table with columns: Player | Position.
- If asked "best X": show a 1-line answer + a Top-3 table (Player | Value).
- If asked for leaders: show top 5 tables for the relevant categories.
- If asked for "show every game" / "all results": show a match results table.
- If asked for "record vs opponent": show an opponent table (Opponent | W | L | Set diff | Last played).
- If asked for changes in losses: provide 6–10 actionable bullets plus 1–2 "quick wins" for the next practice.
- If asked for lineups: provide BOTH a 5–1 and 6–2 option with short rationale, using:
  - setter_assists, attack_kills, serve_receive rating/attempts, blocks.
  - If positions are missing, state assumptions.
- If user asks "why did we lose to X": use available opponent summary + general volleyball troubleshooting (serve/pass, error control, matchup/rotation).

Never say "Try asking..." unless absolutely necessary.
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
      max_output_tokens: 1100,
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

function fallbackRoster(agg: ReturnType<typeof computeAggregates>) {
  const rec = agg.hasMatches ? `${agg.wins}-${agg.losses}` : "N/A";
  const last = agg.lastMatch
    ? `${agg.lastMatch.match_date ?? "?"} vs ${agg.lastMatch.opponent ?? "?"} — ${normalizeWinLoss(agg.lastMatch.result) ?? "?"}${
        agg.lastMatch.score ? ` (${agg.lastMatch.score})` : ""
      }`
    : "N/A";

  const players = Object.keys(agg.positions)
    .map((p) => ({ player: p, pos: agg.positions[p] ?? "Unknown" }))
    .sort((a, b) => a.player.localeCompare(b.player));

  const lines: string[] = [];
  lines.push(`## Team roster — MVVC 14 Black`);
  lines.push(`**Record:** ${rec}`);
  lines.push(`**Last match:** ${last}`);
  lines.push("");
  lines.push(`| Player | Position |`);
  lines.push(`|---|---|`);
  for (const r of players) lines.push(`| ${r.player} | ${r.pos} |`);

  const kills = topNForKey(agg.byPlayer, "attack_kills", 1)[0];
  const assists = topNForKey(agg.byPlayer, "setting_assists", 1)[0];
  const aces = topNForKey(agg.byPlayer, "serve_aces", 1)[0];
  const digs = topNForKey(agg.byPlayer, "digs_successful", 1)[0];
  const blocks = topNForKey(agg.byPlayer, "blocks_solo", 1)[0];

  lines.push("");
  lines.push(`## Quick leaders (data-backed)`);
  lines.push(`| Category | Leader | Value |`);
  lines.push(`|---|---|---:|`);
  if (kills) lines.push(`| Kills | ${kills.player} | ${kills.value} |`);
  if (assists) lines.push(`| Assists | ${assists.player} | ${assists.value} |`);
  if (aces) lines.push(`| Aces | ${aces.player} | ${aces.value} |`);
  if (digs) lines.push(`| Digs | ${digs.player} | ${digs.value} |`);
  if (blocks) lines.push(`| Solo blocks | ${blocks.player} | ${blocks.value} |`);

  return lines.join("\n");
}

function fallbackAllMatches(matches: MatchRow[]) {
  const ms = matches
    .slice()
    .sort((a, b) => safeIso(a.match_date).localeCompare(safeIso(b.match_date)));

  const lines: string[] = [];
  lines.push(`## Match results — MVVC 14 Black`);
  lines.push("");
  lines.push(`| Date | Opponent | Result | Score | Tournament | Round |`);
  lines.push(`|---|---|---|---|---|---|`);

  for (const m of ms) {
    const date = m.match_date ?? "";
    const opp = m.opponent ?? "";
    const res = normalizeWinLoss(m.result) ?? (m.result ?? "");
    const score = m.score ?? "";
    const tour = m.tournament ?? "";
    const round = m.round ?? "";
    lines.push(`| ${date} | ${opp} | ${res} | ${score} | ${tour} | ${round} |`);
  }

  return lines.join("\n");
}

function fallbackVsOpponent(agg: ReturnType<typeof computeAggregates>) {
  const rows = agg.vsOpponentRows || [];
  const lines: string[] = [];
  lines.push(`## Record vs opponents — MVVC 14 Black`);
  lines.push("");
  lines.push(`| Opponent | W | L | Set diff | Last played |`);
  lines.push(`|---|---:|---:|---:|---|`);
  for (const r of rows) {
    lines.push(`| ${r.opponent} | ${r.wins} | ${r.losses} | ${r.setDiff} | ${r.lastDate || ""} |`);
  }
  return lines.join("\n");
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { question?: string; thread_id?: string | null };
    const question = String(body?.question ?? "").trim();
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    const season = await getCachedSeason();
    const agg = season.agg;

    const factsPayload = {
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
              sets_won: agg.lastMatch.sets_won,
              sets_lost: agg.lastMatch.sets_lost,
              set_diff: agg.lastMatch.set_diff,
            }
          : null,
        teamServeReceive: agg.teamServeReceive,
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
          settingErrorsTop5: topNForKey(agg.byPlayer, "setting_errors", 5),
        },
      },
      opponents: {
        records: agg.vsOpponentRows,
        troubleOpponents: agg.troubleOpponents,
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
    };

    let answer = "";
    try {
      answer = await callOpenAI(question, factsPayload);
    } catch (err: any) {
      console.error("[OpenAI]", err?.message ?? String(err));
      answer = "";
    }

    if (!answer) {
      const q = s(question);

      // Strong deterministic fallbacks for the most common asks
      if (q.includes("roster")) answer = fallbackRoster(agg);
      else if (q.includes("every game") || q.includes("all game") || q.includes("game result") || q.includes("show all results") || q.includes("results")) {
        answer = fallbackAllMatches(season.matches);
      } else if (q.includes("record vs") || q.includes("vs opponent") || q.includes("against") && q.includes("record")) {
        answer = fallbackVsOpponent(agg);
      } else {
        answer =
          "I hit an error generating the response.\n\n" +
          "Try: **team roster**, **show every game result**, **record vs opponent**, or **leaders (top 5)**.";
      }
    }

    return NextResponse.json({ answer, thread_id: body?.thread_id ?? null });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
