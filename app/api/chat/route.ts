import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

/**
 * Coaching Assistant for MVVC 14 Black
 *
 * What this file does:
 * 1) Fetches match_results + player_game_stats from Supabase
 * 2) Computes lightweight aggregates (record, leaders, SR, assists, blocks, etc.)
 * 3) Calls OpenAI for ChatGPT-like narrative answers
 * 4) If OpenAI is unavailable, returns a question-specific local fallback
 *
 * Key fixes vs your current behavior:
 * - Fixes the “everyone is a setter” bug (bad substring matching)
 * - Prevents generic recap fallback for unrelated questions (like “what is a 6-2 offense”)
 */

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5";
const DEFAULT_SEASON = "spring";

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
  position: string | null; // from your table column
  game_date: string | null;
  opponent: string | null;
  stats: any; // jsonb (object or stringified json)
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

/** ---------------- Intent detection (for smarter fallbacks) ---------------- */

function qLower(q: string) {
  return q.trim().toLowerCase();
}

function isDefinitional(q: string) {
  const s = qLower(q);
  return s.startsWith("what is ") || s.startsWith("what's ") || s.startsWith("explain ");
}

function asksSixTwo(q: string) {
  const s = qLower(q);
  return s.includes("6-2") || s.includes("6 2");
}

function asksLeaders(q: string) {
  const s = qLower(q);
  return s.includes("leaders") || s.includes("statistical leaders") || s.includes("key categories");
}

function asksRecap(q: string) {
  const s = qLower(q);
  return s.includes("recap") || s.includes("summarize") || s.includes("season so far") || s.includes("key moments");
}

/** ---------------- Supabase fetch (keep it fast) ---------------- */

async function fetchTeamData(teamId: string, season: string) {
  const supabase = supabaseService();

  // Match results
  const { data: matches, error: em } = await supabase
    .from("match_results")
    .select("match_date,tournament,opponent,result,score,round,sets_won,sets_lost,set_diff")
    .eq("team_id", teamId)
    .order("match_date", { ascending: true })
    .limit(900);
  if (em) throw em;

  // Player stats rows
  const { data: statsRows, error: es } = await supabase
    .from("player_game_stats")
    .select("player_name,position,game_date,opponent,stats")
    .eq("team_id", teamId)
    .eq("season", season)
    .order("game_date", { ascending: false })
    .limit(2600);
  if (es) throw es;

  return {
    matches: (matches ?? []) as MatchRow[],
    statsRows: (statsRows ?? []) as StatRow[],
  };
}

/** ---------------- Aggregation (lightweight) ---------------- */

type Totals = {
  kills: number;
  digs: number;
  aces: number;
  serveErrors: number;

  assists: number;

  srAttempts: number;
  srWeightedSum: number;

  blocksSolo: number;
  blocksAssist: number;
  blocksTotal: number;

  // optional hitter efficiency helper (if present)
  attackPctWeightedSum: number;
  attackPctAttempts: number;
};

function classifyPositionLabel(label: string): {
  setter: boolean;
  opp: boolean;
  oh: boolean;
  mb: boolean;
  liberoOrDs: boolean;
} {
  // IMPORTANT: NO single-letter matches. Only real keywords.
  const s = label.toLowerCase();

  const setter = s.includes("setter");
  const opp = s.includes("opposite") || s.includes("opp");
  const oh = s.includes("outside") || s.includes("oh");
  const mb = s.includes("middle") || s.includes("mb");
  const liberoOrDs = s.includes("libero") || s.includes("defensive") || s.includes(" ds") || s.endsWith("ds");

  return { setter, opp, oh, mb, liberoOrDs };
}

function computeFacts(matches: MatchRow[], statsRows: StatRow[]) {
  // Win/Loss
  let wins = 0;
  let losses = 0;

  // Opponent trouble
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
    .slice(0, 8);

  // Player totals + position groups
  const totals: Record<string, Totals> = {};
  const posGroups = {
    setters: new Set<string>(),
    opposites: new Set<string>(),
    outsides: new Set<string>(),
    middles: new Set<string>(),
    liberosOrDS: new Set<string>(),
  };

  function ensure(player: string) {
    if (!totals[player]) {
      totals[player] = {
        kills: 0,
        digs: 0,
        aces: 0,
        serveErrors: 0,
        assists: 0,
        srAttempts: 0,
        srWeightedSum: 0,
        blocksSolo: 0,
        blocksAssist: 0,
        blocksTotal: 0,
        attackPctWeightedSum: 0,
        attackPctAttempts: 0,
      };
    }
    return totals[player];
  }

  for (const row of statsRows) {
    const player = (row.player_name ?? "").trim();
    if (!player) continue;

    // position grouping (from table column)
    const pos = (row.position ?? "").trim();
    if (pos) {
      const c = classifyPositionLabel(pos);
      if (c.setter) posGroups.setters.add(player);
      if (c.opp) posGroups.opposites.add(player);
      if (c.oh) posGroups.outsides.add(player);
      if (c.mb) posGroups.middles.add(player);
      if (c.liberoOrDs) posGroups.liberosOrDS.add(player);
    }

    const s = parseStats(row.stats);
    const t = ensure(player);

    t.kills += toNum(s.attack_kills);
    t.digs += toNum(s.digs_successful);
    t.aces += toNum(s.serve_aces);
    t.serveErrors += toNum(s.serve_errors);

    t.assists += toNum(s.setting_assists);

    const srAtt = toNum(s.serve_receive_attempts);
    const srRating = toNum(s.serve_receive_passing_rating);
    if (srAtt > 0) {
      t.srAttempts += srAtt;
      t.srWeightedSum += srRating * srAtt;
    }

    const solo = toNum(s.blocks_solo);
    const assist = toNum(s.blocks_assist);
    t.blocksSolo += solo;
    t.blocksAssist += assist;
    t.blocksTotal += solo + assist;

    // optional attack percentage (if present) weighted by attempts
    const ap = toNum(s.attack_percentage);
    const aa = toNum(s.attack_attempts);
    if (aa > 0 && ap !== 0) {
      t.attackPctWeightedSum += ap * aa;
      t.attackPctAttempts += aa;
    }
  }

  const players = Object.keys(totals);

  function leaderBy(metric: keyof Totals) {
    let bestP = "";
    let bestV = -Infinity;
    for (const p of players) {
      const v = totals[p][metric];
      if (v > bestV) {
        bestV = v;
        bestP = p;
      }
    }
    return bestP ? { player: bestP, value: bestV } : null;
  }

  // Best passer (weighted SR)
  let bestPasser: null | { player: string; rating: number; attempts: number; teamRating: number; teamAttempts: number } = null;
  let teamAtt = 0;
  let teamSum = 0;

  for (const p of players) {
    const t = totals[p];
    if (t.srAttempts > 0) {
      const r = t.srWeightedSum / t.srAttempts;
      if (!bestPasser || r > bestPasser.rating) {
        bestPasser = { player: p, rating: r, attempts: t.srAttempts, teamRating: 0, teamAttempts: 0 };
      }
      teamAtt += t.srAttempts;
      teamSum += t.srWeightedSum;
    }
  }
  if (bestPasser && teamAtt > 0) {
    bestPasser.teamAttempts = teamAtt;
    bestPasser.teamRating = teamSum / teamAtt;
    bestPasser.rating = Number(bestPasser.rating.toFixed(2));
    bestPasser.teamRating = Number(bestPasser.teamRating.toFixed(2));
  }

  return {
    winLoss: matches.length ? { wins, losses } : null,
    toughestOpponents,
    leaders: {
      kills: leaderBy("kills"),
      digs: leaderBy("digs"),
      aces: leaderBy("aces"),
      serveErrors: leaderBy("serveErrors"),
      assists: leaderBy("assists"),
      blocks: leaderBy("blocksTotal"),
      passer: bestPasser,
    },
    posGroups: {
      setters: Array.from(posGroups.setters).sort(),
      opposites: Array.from(posGroups.opposites).sort(),
      outsides: Array.from(posGroups.outsides).sort(),
      middles: Array.from(posGroups.middles).sort(),
      liberosOrDS: Array.from(posGroups.liberosOrDS).sort(),
    },
    totals, // used for building 6-2 fallback lineup
  };
}

/** ---------------- OpenAI call (ChatGPT-style) ---------------- */

async function callOpenAI(question: string, season: string, facts: any) {
  // If OPENAI_API_KEY is missing, don't silently degrade into generic recaps.
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";

  const system = `
You are a volleyball assistant for MVVC 14 Black.
Behave like ChatGPT: answer the user's exact question directly.

Rules:
- Use FACTS_JSON for any team-specific facts/stats. Don't invent data.
- If the question is volleyball-theory (ex: "what is a 6-2 offense"), answer normally even without stats.
- Do not spam unrelated facts. Include only what's relevant to the question.
- Use **bold** for player names (example: **Koa Tuyay**).
- No divider lines like "-----".
- If asked for a 6-2 lineup, you MUST propose:
  - 2 setters, 2 opposites, 2 OH, 2 MB, 1 libero (and bench notes if needed)
  - If positions are incomplete, choose setters by assists and hitters by kills, then clearly state the assumption.
`;

  const payload = {
    question,
    season,
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
      input: [
        { role: "system", content: [{ type: "input_text", text: system }] },
        { role: "user", content: [{ type: "input_text", text: JSON.stringify(payload) }] },
      ],
    }),
  });

  if (!res.ok) return null;

  const json = await res.json();
  const text = safeExtractOutputText(json);
  return text || null;
}

/** ---------------- Smarter local fallbacks ---------------- */

function fmtPlayer(name: string) {
  return `**${name}**`;
}

function localFallback(question: string, facts: ReturnType<typeof computeFacts>) {
  const q = qLower(question);

  // 1) Volleyball theory questions should NEVER return a season recap
  if (isDefinitional(question) && asksSixTwo(question)) {
    return `A 6-2 offense is a system where you use 2 setters, and whoever is in the back row sets—so you always have 3 hitters available in the front row.\n\nHow it plays out:\n• Setter A sets when they’re back row; Setter B is front row and becomes a right-side attacker/blocker.\n• Then they switch roles when they rotate.\n\nWhy teams use it:\n• More attacking options (always 3 hitters front row)\n• Can hide a weaker hitter if one setter is a strong attacker\n\nTradeoffs:\n• More subs/complexity\n• You need solid passing and clean setter-opposite connections.`;
  }

  // 2) “Stat leaders” should return leaders, not a recap
  if (asksLeaders(question)) {
    const lines: string[] = [];
    lines.push("Statistical leaders (season totals)");
    if (facts.leaders.kills) lines.push(`Kills: ${fmtPlayer(facts.leaders.kills.player)} (${facts.leaders.kills.value})`);
    if (facts.leaders.digs) lines.push(`Digs: ${fmtPlayer(facts.leaders.digs.player)} (${facts.leaders.digs.value})`);
    if (facts.leaders.aces) lines.push(`Aces: ${fmtPlayer(facts.leaders.aces.player)} (${facts.leaders.aces.value})`);
    if (facts.leaders.blocks) lines.push(`Blocks: ${fmtPlayer(facts.leaders.blocks.player)} (${facts.leaders.blocks.value})`);
    if (facts.leaders.assists) lines.push(`Assists: ${fmtPlayer(facts.leaders.assists.player)} (${facts.leaders.assists.value})`);
    if (facts.leaders.serveErrors) lines.push(`Serve errors: ${fmtPlayer(facts.leaders.serveErrors.player)} (${facts.leaders.serveErrors.value})`);
    if (facts.leaders.passer) {
      lines.push(`Best passer rating (0–3): ${fmtPlayer(facts.leaders.passer.player)} (${facts.leaders.passer.rating} on ${facts.leaders.passer.attempts})`);
    }
    return lines.join("\n");
  }

  // 3) 6-2 lineup fallback: choose setters by assists (not by position strings)
  if (asksSixTwo(question) && q.includes("lineup")) {
    const totals = facts.totals;
    const players = Object.keys(totals);

    const byAssists = [...players].sort((a, b) => totals[b].assists - totals[a].assists);
    const byKills = [...players].sort((a, b) => totals[b].kills - totals[a].kills);

    const setters = byAssists.filter((p) => totals[p].assists > 0).slice(0, 2);
    const libero = facts.leaders.passer?.player ? [facts.leaders.passer.player] : [];

    // Avoid picking setters/libero again as hitters when possible
    const avoid = new Set([...setters, ...libero]);

    const hitters = byKills.filter((p) => !avoid.has(p) && totals[p].kills > 0);

    const opps = facts.posGroups.opposites.filter((p) => !avoid.has(p)).slice(0, 2);
    const outsides = facts.posGroups.outsides.filter((p) => !avoid.has(p)).slice(0, 2);
    const middles = facts.posGroups.middles.filter((p) => !avoid.has(p)).slice(0, 2);

    // If positions aren't labeled well, fall back to top killers for hitter slots
    const pick2 = (arr: string[], fallbackStart: number) => {
      if (arr.length >= 2) return arr.slice(0, 2);
      const more = hitters.slice(fallbackStart, fallbackStart + (2 - arr.length));
      return [...arr, ...more];
    };

    const finalOpps = pick2(opps, 0);
    const finalOH = pick2(outsides, 2);
    const finalMB = pick2(middles, 4);

    const lines: string[] = [];
    lines.push("Projected 6-2 lineup (best-effort from your stats)");
    if (setters.length === 2) lines.push(`Setters (2): ${setters.map(fmtPlayer).join(", ")}`);
    else lines.push("Setters (2): Insufficient setting_assists data to pick two setters.");

    lines.push(`Opposites (2): ${finalOpps.length ? finalOpps.map(fmtPlayer).join(", ") : "Insufficient role/kills data"}`);
    lines.push(`Outside hitters (2): ${finalOH.length ? finalOH.map(fmtPlayer).join(", ") : "Insufficient role/kills data"}`);
    lines.push(`Middles (2): ${finalMB.length ? finalMB.map(fmtPlayer).join(", ") : "Insufficient role/kills data"}`);

    if (libero.length) lines.push(`Libero / primary passer: ${libero.map(fmtPlayer).join(", ")}`);

    lines.push(
      "Note: This uses assists to identify setters and kills/position labels for hitters. If your position labels aren’t accurate in player_game_stats.position, the lineup will improve once those are cleaned up."
    );
    return lines.join("\n");
  }

  // 4) Recap fallback (only for actual recap questions)
  if (asksRecap(question)) {
    const parts: string[] = [];
    parts.push("Season recap (data-driven snapshot)");
    if (facts.winLoss) parts.push(`Record: ${facts.winLoss.wins}-${facts.winLoss.losses}`);
    if (facts.leaders.kills) parts.push(`Kills leader: ${fmtPlayer(facts.leaders.kills.player)} (${facts.leaders.kills.value})`);
    if (facts.leaders.passer) parts.push(`Best passer rating (0–3): ${fmtPlayer(facts.leaders.passer.player)} (${facts.leaders.passer.rating} on ${facts.leaders.passer.attempts})`);
    if (facts.toughestOpponents.length) parts.push(`Toughest opponents: ${facts.toughestOpponents.slice(0, 3).map((t) => t.opponent).join(", ")}`);
    return parts.join("\n");
  }

  // Default fallback: brief + question-aligned
  return `I can answer that, but the model call didn’t run.\nQuick check: confirm OPENAI_API_KEY is set in your deployment environment (Vercel/GitHub Actions) and redeploy.\nIf you paste the exact question again after that, you’ll get a full ChatGPT-style answer.`;
}

/** ---------------- Route handler ---------------- */

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { question: string };
    const question = String(body.question ?? "").trim();
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    const teamId = TEAM_ID;
    const season = DEFAULT_SEASON;

    const { matches, statsRows } = await fetchTeamData(teamId, season);
    const facts = computeFacts(matches, statsRows);

    // Try OpenAI first (ChatGPT-like output)
    const modelAnswer = await callOpenAI(question, season, facts);

    // If OpenAI unavailable/failing, use smarter local fallback (aligned to the question)
    const answer = modelAnswer ?? localFallback(question, facts);

    return NextResponse.json({ answer });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
