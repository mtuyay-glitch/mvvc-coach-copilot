import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

/** Hard-coded team + season */
const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black
const DEFAULT_SEASON: "fall" | "spring" | "summer" = "spring";

/** Helpers */
function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

function toNum(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).trim();
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function parseStats(raw: any): Record<string, any> {
  // In your table, stats may arrive as:
  // 1) an object (ideal), OR
  // 2) a string containing JSON (your sample row shows this)
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return {};
    try {
      return JSON.parse(t);
    } catch {
      return {};
    }
  }
  return {};
}

type PlayerTotals = {
  kills: number;
  digs: number;
  aces: number;
  serveErrors: number;

  srAttempts: number;
  srRatingSum: number; // rating * attempts (weighted)
};

function computePlayerTotals(statsRows: any[]) {
  const totals = new Map<string, PlayerTotals>();

  for (const row of statsRows) {
    const player = String(row.player_name ?? "").trim();
    if (!player) continue;

    const s = parseStats(row.stats);

    const kills = toNum(s.attack_kills);
    const digs = toNum(s.digs_successful);
    const aces = toNum(s.serve_aces);
    const serveErrors = toNum(s.serve_errors);

    // Weighted SR rating (0–3): use rating * attempts if we can
    const srAttempts = toNum(s.serve_receive_attempts);
    const srRating = toNum(s.serve_receive_passing_rating);
    const srRatingSum = srAttempts > 0 ? srRating * srAttempts : 0;

    const prev = totals.get(player) ?? {
      kills: 0,
      digs: 0,
      aces: 0,
      serveErrors: 0,
      srAttempts: 0,
      srRatingSum: 0,
    };

    prev.kills += kills;
    prev.digs += digs;
    prev.aces += aces;
    prev.serveErrors += serveErrors;
    prev.srAttempts += srAttempts;
    prev.srRatingSum += srRatingSum;

    totals.set(player, prev);
  }

  // Convert to array with computed SR rating
  const out: Array<{
    player: string;
    kills: number;
    digs: number;
    aces: number;
    serveErrors: number;
    srAttempts: number;
    srRating: number | null;
  }> = [];

  for (const entry of Array.from(totals.entries())) {
    const player = entry[0];
    const t = entry[1];
    const srRating = t.srAttempts > 0 ? t.srRatingSum / t.srAttempts : null;

    out.push({
      player,
      kills: t.kills,
      digs: t.digs,
      aces: t.aces,
      serveErrors: t.serveErrors,
      srAttempts: t.srAttempts,
      srRating,
    });
  }

  return out;
}

function topN<T>(arr: T[], n: number, getVal: (x: T) => number) {
  return [...arr].sort((a, b) => getVal(b) - getVal(a)).slice(0, n);
}

function safeOpponentName(x: any) {
  return String(x ?? "").trim();
}

/** Data retrieval */
async function retrieveData(teamId: string, season: "fall" | "spring" | "summer") {
  const supabase = supabaseService();

  // A) Roster/notes chunks (optional)
  const { data: rosterChunks } = await supabase
    .from("knowledge_chunks")
    .select("id,title,content,tags")
    .eq("team_id", teamId)
    .contains("tags", ["roster"])
    .limit(5);

  // B) Match results (for win/loss + “trouble opponents”)
  const { data: matches, error: em } = await supabase
    .from("match_results")
    .select("match_date,tournament,opponent,result,score,round,sets_won,sets_lost,set_diff")
    .eq("team_id", teamId)
    .order("match_date", { ascending: true })
    .limit(1000);
  if (em) throw em;

  // C) Player game stats for the chosen season
  const { data: statsRows, error: es } = await supabase
    .from("player_game_stats")
    .select("player_name,position,game_date,opponent,stats,season")
    .eq("team_id", teamId)
    .eq("season", season)
    .order("game_date", { ascending: false })
    .limit(2000);
  if (es) throw es;

  return {
    rosterChunks: rosterChunks ?? [],
    matches: matches ?? [],
    statsRows: statsRows ?? [],
  };
}

/** Compute match summaries */
function computeWinLoss(matches: any[]) {
  let wins = 0;
  let losses = 0;

  for (const m of matches) {
    const r = String(m.result ?? "").toLowerCase();
    // supports values like "Won", "Lost", "W", "L"
    if (r.includes("won") || r === "w") wins++;
    if (r.includes("lost") || r === "l") losses++;
  }

  return { wins, losses, total: wins + losses };
}

function computeTroubleOpponents(matches: any[]) {
  // “Most trouble” = most losses vs that opponent, then worst set_diff
  const map = new Map<string, { losses: number; matches: number; setDiff: number }>();

  for (const m of matches) {
    const opp = safeOpponentName(m.opponent);
    if (!opp) continue;

    const r = String(m.result ?? "").toLowerCase();
    const isLoss = r.includes("lost") || r === "l";
    const sd = toNum(m.set_diff);

    const prev = map.get(opp) ?? { losses: 0, matches: 0, setDiff: 0 };
    prev.matches += 1;
    prev.losses += isLoss ? 1 : 0;
    prev.setDiff += sd;
    map.set(opp, prev);
  }

  const arr = Array.from(map.entries()).map(([opponent, v]) => ({
    opponent,
    losses: v.losses,
    matches: v.matches,
    setDiff: v.setDiff,
  }));

  arr.sort((a, b) => {
    if (b.losses !== a.losses) return b.losses - a.losses;
    return a.setDiff - b.setDiff; // more negative is worse
  });

  return arr.slice(0, 8);
}

/** Build a clean “Facts vs Coaching Insight” response */
function buildFactsBlock(opts: {
  wins: number;
  losses: number;
  season: string;
  leaders: ReturnType<typeof computePlayerTotals>;
  trouble: ReturnType<typeof computeTroubleOpponents>;
}) {
  const { wins, losses, season, leaders, trouble } = opts;

  const killsLeader = topN(leaders, 1, (x) => x.kills)[0];
  const digsLeader = topN(leaders, 1, (x) => x.digs)[0];
  const acesLeader = topN(leaders, 1, (x) => x.aces)[0];

  const srCandidates = leaders.filter((x) => (x.srAttempts ?? 0) >= 10 && x.srRating !== null);
  const srLeader = topN(srCandidates, 1, (x) => x.srRating ?? 0)[0];

  const lines: string[] = [];
  lines.push(`Data-Backed (Facts)`);
  lines.push(`-------------------`);
  lines.push(`Season in stats table: ${season}`);
  lines.push(`Win/Loss (from match_results): ${wins}-${losses}`);

  lines.push(``);
  lines.push(`__Team Leaders (season totals)__`);
  if (killsLeader) lines.push(`• **${killsLeader.player}** — ${killsLeader.kills} kills`);
  if (digsLeader) lines.push(`• **${digsLeader.player}** — ${digsLeader.digs} digs`);
  if (acesLeader) lines.push(`• **${acesLeader.player}** — ${acesLeader.aces} aces`);
  if (srLeader)
    lines.push(
      `• **${srLeader.player}** — best serve-receive rating: ${srLeader.srRating!.toFixed(2)} (0–3 scale) on ${srLeader.srAttempts} attempts`
    );
  else lines.push(`• Serve-receive leader: not enough SR attempts found to rank confidently (need ≥10 attempts).`);

  lines.push(``);
  lines.push(`__Opponents That Caused the Most Trouble__`);
  if (trouble.length === 0) {
    lines.push(`• Not enough match_results rows to rank opponents.`);
  } else {
    for (const t of trouble.slice(0, 5)) {
      lines.push(`• **${t.opponent}** — losses: ${t.losses}/${t.matches}, set diff: ${t.setDiff}`);
    }
  }

  return lines.join("\n");
}

/** OpenAI (optional narrative polish) */
async function callOpenAI(prompt: string) {
  assertEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";

  // Use SIMPLE string input to avoid content-type schema errors.
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_output_tokens: 700,
      input: prompt,
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }

  const json: any = await res.json();

  // Prefer convenience field if present
  if (typeof json.output_text === "string" && json.output_text.trim()) return json.output_text.trim();

  // Fallback parse
  const out = json.output ?? [];
  let text = "";
  for (const item of out) {
    const content = item.content ?? [];
    for (const c of content) {
      if (c.type === "output_text" && typeof c.text === "string") text += c.text;
    }
  }
  return (text || "").trim();
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { question?: string };
    const question = String(body.question ?? "").trim();
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    const teamId = TEAM_ID;
    const season = DEFAULT_SEASON;

    const { matches, statsRows } = await retrieveData(teamId, season);

    // Compute facts deterministically (no “empty context” issues)
    const { wins, losses } = computeWinLoss(matches);
    const leaders = computePlayerTotals(statsRows);
    const trouble = computeTroubleOpponents(matches);

    const factsBlock = buildFactsBlock({
      wins,
      losses,
      season,
      leaders,
      trouble,
    });

    // If question is very specific stats, answer directly from computed facts where possible
    // Otherwise, let OpenAI produce a nicer narrative but ALWAYS include Facts vs Coaching Insight.
    const prompt = `
You are the MVVC volleyball Coaching Assistant.
Write coach-friendly answers with good spacing and clear sections.

Formatting rules:
- Use EXACT section headers:
  Data-Backed (Facts)
  -------------------
  Coaching Insight (Inference)
  ----------------------------
- Underline sub-sections like "__Title__" (double underscores) and keep lists as bullets.
- Make player names subtly stand out by using **Name**.
- Do NOT include citation codes like S3/K2.

You MUST:
- Keep the "Data-Backed (Facts)" section strictly grounded in the provided facts block.
- Put any recommendations, hypotheses, lineup suggestions, and training ideas in "Coaching Insight (Inference)".

Facts block:
${factsBlock}

User question:
${question}
`;

    let aiText = "";
    try {
      aiText = await callOpenAI(prompt);
    } catch {
      aiText = "";
    }

    // Hard fallback: never return "No answer generated"
    if (!aiText) {
      aiText =
        factsBlock +
        `\n\nCoaching Insight (Inference)\n----------------------------\n• I can answer this more deeply if you ask a specific angle (lineup, serve-receive, hitting efficiency, opponent breakdown, etc.).`;
    }

    return NextResponse.json({ answer: aiText });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
