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
  srRatingSum: number; // rating * attempts
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

    const srAttempts = toNum(s.serve_receive_attempts);
    const srRating = toNum(s.serve_receive_passing_rating);
    const srRatingSum = srAttempts > 0 ? srRating * srAttempts : 0;

    const prev =
      totals.get(player) ?? ({
        kills: 0,
        digs: 0,
        aces: 0,
        serveErrors: 0,
        srAttempts: 0,
        srRatingSum: 0,
      } as PlayerTotals);

    prev.kills += kills;
    prev.digs += digs;
    prev.aces += aces;
    prev.serveErrors += serveErrors;
    prev.srAttempts += srAttempts;
    prev.srRatingSum += srRatingSum;

    totals.set(player, prev);
  }

  const out: Array<{
    player: string;
    kills: number;
    digs: number;
    aces: number;
    serveErrors: number;
    srAttempts: number;
    srRating: number | null;
  }> = [];

  for (const [player, t] of Array.from(totals.entries())) {
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

async function retrieveData(teamId: string, season: "fall" | "spring" | "summer") {
  const supabase = supabaseService();

  const { data: matches, error: em } = await supabase
    .from("match_results")
    .select("match_date,tournament,opponent,result,score,round,sets_won,sets_lost,set_diff")
    .eq("team_id", teamId)
    .order("match_date", { ascending: true })
    .limit(5000);
  if (em) throw em;

  const { data: statsRows, error: es } = await supabase
    .from("player_game_stats")
    .select("player_name,position,game_date,opponent,stats,season")
    .eq("team_id", teamId)
    .eq("season", season)
    .order("game_date", { ascending: false })
    .limit(5000);
  if (es) throw es;

  return { matches: matches ?? [], statsRows: statsRows ?? [] };
}

function computeWinLoss(matches: any[]) {
  let wins = 0;
  let losses = 0;
  for (const m of matches) {
    const r = String(m.result ?? "").toLowerCase();
    if (r.includes("won") || r === "w") wins++;
    else if (r.includes("lost") || r === "l") losses++;
  }
  return { wins, losses, total: wins + losses };
}

function computeTroubleOpponents(matches: any[]) {
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
    return a.setDiff - b.setDiff; // more negative = worse
  });

  return arr.slice(0, 8);
}

/** Detect common question intents so we can answer directly */
function detectIntent(q: string) {
  const s = q.toLowerCase();
  const isPasser =
    s.includes("passer rating") ||
    s.includes("passing rating") ||
    s.includes("serve receive") ||
    s.includes("serve-receive") ||
    s.includes("sr rating") ||
    s.includes("best passer");

  const isWinLoss =
    s.includes("win loss") || s.includes("win-loss") || s.includes("record") || s.includes("w-l");

  const isKillsLeader =
    s.includes("leads") && s.includes("kills") ||
    s.includes("most kills") ||
    s.includes("kills leader");

  const isTroubleOpp =
    s.includes("most trouble") ||
    s.includes("hardest opponent") ||
    s.includes("toughest opponent") ||
    s.includes("which opponents");

  return { isPasser, isWinLoss, isKillsLeader, isTroubleOpp };
}

function formatAnswer(opts: { facts: string[]; insight?: string[] }) {
  const lines: string[] = [];
  lines.push(`Data-Backed (Facts)`);
  lines.push(`-------------------`);
  lines.push(...opts.facts);

  lines.push(``);
  lines.push(`Coaching Insight (Inference)`);
  lines.push(`----------------------------`);
  if (opts.insight && opts.insight.length) lines.push(...opts.insight);
  else lines.push(`• Ask a follow-up angle (rotation, matchups, serve/receive, opponents) and I’ll tailor recommendations.`);

  return lines.join("\n");
}

/** Optional OpenAI narrative polish (kept, but NOT required for an answer) */
async function callOpenAI(prompt: string) {
  assertEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, max_output_tokens: 700, input: prompt }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }

  const json: any = await res.json();
  if (typeof json.output_text === "string" && json.output_text.trim()) return json.output_text.trim();

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
    const { wins, losses } = computeWinLoss(matches);
    const leaders = computePlayerTotals(statsRows);
    const trouble = computeTroubleOpponents(matches);

    const intent = detectIntent(question);

    // Precompute leader candidates
    const killsLeader = topN(leaders, 1, (x) => x.kills)[0];
    const srCandidates = leaders.filter((x) => (x.srAttempts ?? 0) >= 10 && x.srRating !== null);
    const srLeader = topN(srCandidates, 1, (x) => x.srRating ?? 0)[0];

    // ✅ DIRECT ANSWERS FIRST
    if (intent.isPasser) {
      if (!srLeader) {
        const answer = formatAnswer({
          facts: [
            `Short answer: Insufficient data in the current dataset to rank passer rating (need serve_receive_attempts and serve_receive_passing_rating).`,
            ``,
            `__What I looked for__`,
            `• serve_receive_passing_rating (0–3 scale) weighted by serve_receive_attempts`,
          ],
          insight: [`• If your CSV has SR rating counts (0/1/2/3), we can also validate the rating calculation per player.`],
        });
        return NextResponse.json({ answer });
      }

      const answer = formatAnswer({
        facts: [
          `Short answer: **${srLeader.player}** has the best passer (serve-receive) rating — ${srLeader.srRating!.toFixed(
            2
          )} on ${srLeader.srAttempts} attempts (0–3 scale).`,
          ``,
          `__Supporting context__`,
          `• Season: ${season}`,
          `• Win/Loss (from match_results): ${wins}-${losses}`,
        ],
        insight: [
          `• Treat **${srLeader.player}** as a primary serve-receive anchor. If you want, I can also list the top 5 passers and their attempt counts (confidence).`,
        ],
      });

      return NextResponse.json({ answer });
    }

    if (intent.isWinLoss) {
      const answer = formatAnswer({
        facts: [
          `Short answer: Win/Loss record is ${wins}-${losses} (from match_results).`,
          ``,
          `__Notes__`,
          `• If you want “by tournament” records, I can break it down if tournament names are populated consistently.`,
        ],
        insight: [`• If you share your season goals (e.g., gold bracket finishes), I can summarize progress vs goal.`],
      });
      return NextResponse.json({ answer });
    }

    if (intent.isKillsLeader) {
      if (!killsLeader) {
        const answer = formatAnswer({
          facts: [`Short answer: Insufficient data in the current dataset to identify a kills leader.`],
          insight: [`• Make sure player_game_stats has attack_kills per player per match (it looks like it does—so this likely means season filter mismatch).`],
        });
        return NextResponse.json({ answer });
      }

      const answer = formatAnswer({
        facts: [
          `Short answer: **${killsLeader.player}** leads the team in kills — ${killsLeader.kills}.`,
          ``,
          `__Supporting context__`,
          `• Season: ${season}`,
        ],
        insight: [`• If you want “kills per set” or “kills vs errors efficiency,” we can compute that too (if attempts/errors are present).`],
      });
      return NextResponse.json({ answer });
    }

    if (intent.isTroubleOpp) {
      const top = trouble.slice(0, 5);
      const answer = formatAnswer({
        facts: [
          `Short answer: These opponents caused the most trouble (by losses, then set differential):`,
          ``,
          `__Opponents__`,
          ...top.map((t) => `• **${t.opponent}** — losses: ${t.losses}/${t.matches}, set diff: ${t.setDiff}`),
        ],
        insight: [`• If you tell me what “trouble” means for you (tight sets vs blowouts vs serve-receive breakdown), I can re-rank using that definition.`],
      });
      return NextResponse.json({ answer });
    }

    // Otherwise: use OpenAI for narrative, but keep it grounded in computed facts
    const factsSummary = [
      `Season: ${season}`,
      `Win/Loss: ${wins}-${losses}`,
      srLeader ? `Best SR rating: ${srLeader.player} ${srLeader.srRating!.toFixed(2)} on ${srLeader.srAttempts} att` : `Best SR rating: (not enough data)`,
      killsLeader ? `Kills leader: ${killsLeader.player} ${killsLeader.kills}` : `Kills leader: (not enough data)`,
    ].join("\n");

    const prompt = `
You are the MVVC volleyball Coaching Assistant.

Write a coach-friendly response with great spacing.
Format exactly:

Data-Backed (Facts)
-------------------
<answer the user question directly, then bullets>

Coaching Insight (Inference)
----------------------------
<recommendations based on the facts>

Rules:
- Player names should be bold like **Name**.
- Do not include citations or codes.
- Facts must come ONLY from the facts block below.

FACTS BLOCK:
${factsSummary}

USER QUESTION:
${question}
`.trim();

    let aiText = "";
    try {
      aiText = await callOpenAI(prompt);
    } catch {
      aiText = "";
    }

    if (!aiText) {
      // Fallback: never "No answer generated"
      const answer = formatAnswer({
        facts: [
          `Short answer: I can’t generate a narrative answer right now, but your data is loaded.`,
          ``,
          `__Available facts__`,
          `• ${factsSummary.replace(/\n/g, "\n• ")}`,
        ],
        insight: [`• Ask something like “top 5 passers”, “kills vs errors efficiency”, or “break down record by tournament”.`],
      });
      return NextResponse.json({ answer });
    }

    return NextResponse.json({ answer: aiText });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
