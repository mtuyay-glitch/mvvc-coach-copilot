import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black
const DEFAULT_SEASON: "fall" | "spring" | "summer" = "spring";

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
  stats: any; // jsonb from supabase (object or stringified json)
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

function highlightName(name: string) {
  // Works even if markdown bold doesn't render in your UI
  // e.g., 【Koa Tuyay】 (and also **Koa Tuyay** if markdown renders)
  const clean = name.trim();
  if (!clean) return clean;
  return `【${clean}】`;
}

async function retrieveData(teamId: string, season: string, question: string) {
  const supabase = supabaseService();

  // A) Roster chunks always (good for identity questions)
  const { data: rosterChunks, error: er } = await supabase
    .from("knowledge_chunks")
    .select("id,title,content,tags")
    .eq("team_id", teamId)
    .contains("tags", ["roster"])
    .limit(8);
  if (er) throw er;

  // B) Season-specific notes by search (optional)
  const cleaned = question.replace(/[^a-zA-Z0-9 ]/g, " ");
  const { data: searchChunks, error: e1 } = await supabase
    .from("knowledge_chunks")
    .select("id,title,content,tags")
    .eq("team_id", teamId)
    .eq("season", season)
    .textSearch("tsv", cleaned, { type: "websearch" })
    .limit(10);
  if (e1) throw e1;

  // Merge + dedupe
  const mergedMap = new Map<number, any>();
  (rosterChunks ?? []).forEach((c: any) => mergedMap.set(c.id, c));
  (searchChunks ?? []).forEach((c: any) => mergedMap.set(c.id, c));
  const chunks = Array.from(mergedMap.values());

  // C) Match results
  const { data: matches, error: em } = await supabase
    .from("match_results")
    .select("match_date,tournament,opponent,result,score,round,sets_won,sets_lost,set_diff")
    .eq("team_id", teamId)
    .order("match_date", { ascending: true })
    .limit(800);
  if (em) throw em;

  // D) Player stat rows
  const { data: statsRows, error: es } = await supabase
    .from("player_game_stats")
    .select("player_name,position,game_date,opponent,stats")
    .eq("team_id", teamId)
    .eq("season", season)
    .order("game_date", { ascending: false })
    .limit(2500);
  if (es) throw es;

  return {
    chunks: chunks ?? [],
    matches: (matches ?? []) as MatchRow[],
    statsRows: (statsRows ?? []) as StatRow[],
  };
}

function computeAggregates(matches: MatchRow[], statsRows: StatRow[]) {
  // --- Win/Loss + opponent “trouble”
  let wins = 0;
  let losses = 0;

  const oppMatches: Record<string, number> = {};
  const oppLosses: Record<string, number> = {};
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

    const sd = toNum(m.set_diff);
    oppSetDiff[opp] = (oppSetDiff[opp] ?? 0) + sd;
  }

  // --- Player totals + weighted SR
  type Tot = {
    kills: number;
    digs: number;
    aces: number;
    serveErrors: number;
    srAttempts: number;
    srWeightedSum: number;
  };

  const totals: Record<string, Tot> = {};

  function ensure(player: string): Tot {
    if (!totals[player]) {
      totals[player] = { kills: 0, digs: 0, aces: 0, serveErrors: 0, srAttempts: 0, srWeightedSum: 0 };
    }
    return totals[player];
  }

  for (const row of statsRows) {
    const player = (row.player_name ?? "").trim();
    if (!player) continue;

    const s = parseStats(row.stats);
    const t = ensure(player);

    t.kills += toNum(s.attack_kills);
    t.digs += toNum(s.digs_successful);
    t.aces += toNum(s.serve_aces);
    t.serveErrors += toNum(s.serve_errors);

    const srAtt = toNum(s.serve_receive_attempts);
    const srRating = toNum(s.serve_receive_passing_rating); // should be 0–3 scale in your CSV
    if (srAtt > 0) {
      t.srAttempts += srAtt;
      t.srWeightedSum += srRating * srAtt;
    }
  }

  function leader(metric: keyof Tot) {
    let bestPlayer = "";
    let bestVal = -Infinity;
    const players = Object.keys(totals);
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const v = totals[p][metric];
      if (v > bestVal) {
        bestVal = v;
        bestPlayer = p;
      }
    }
    return bestPlayer ? { player: bestPlayer, value: bestVal } : null;
  }

  let bestPasser = "";
  let bestPasserRating = -Infinity;
  let bestPasserAtt = 0;

  const players = Object.keys(totals);
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const t = totals[p];
    if (t.srAttempts <= 0) continue;
    const r = t.srWeightedSum / t.srAttempts;
    if (r > bestPasserRating) {
      bestPasserRating = r;
      bestPasser = p;
      bestPasserAtt = t.srAttempts;
    }
  }

  let teamSrAtt = 0;
  let teamSrSum = 0;
  for (let i = 0; i < players.length; i++) {
    teamSrAtt += totals[players[i]].srAttempts;
    teamSrSum += totals[players[i]].srWeightedSum;
  }
  const teamSrRating = teamSrAtt > 0 ? teamSrSum / teamSrAtt : 0;

  const opps = Object.keys(oppMatches);
  const trouble = opps
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
    .slice(0, 6);

  return {
    wins,
    losses,
    hasMatches: matches.length > 0,
    hasStats: Object.keys(totals).length > 0,
    leaders: {
      kills: leader("kills"),
      digs: leader("digs"),
      aces: leader("aces"),
      serveErrors: leader("serveErrors"),
    },
    bestPasser: bestPasser
      ? { player: bestPasser, rating: bestPasserRating, attempts: bestPasserAtt, teamRating: teamSrRating }
      : null,
    trouble,
  };
}

function buildNotesBlock(chunks: any[]) {
  if (!chunks.length) return "";
  const lines: string[] = [];
  for (const c of chunks) {
    const title = (c.title ?? "").toString().trim();
    const content = (c.content ?? "").toString().trim();
    if (!title && !content) continue;
    lines.push(`- ${title}\n${content}`);
  }
  return lines.join("\n\n");
}

function buildFactsBlock(season: string, agg: ReturnType<typeof computeAggregates>) {
  const lines: string[] = [];

  lines.push(`Season: ${season}`);

  if (agg.hasMatches) {
    lines.push(`Record (match_results): ${agg.wins}-${agg.losses}`);
  } else {
    lines.push(`Record (match_results): not found`);
  }

  if (agg.hasStats) {
    lines.push(``);
    lines.push(`Team leaders (season totals from player_game_stats):`);
    if (agg.leaders.kills) lines.push(`- Kills: ${highlightName(agg.leaders.kills.player)} = ${agg.leaders.kills.value}`);
    if (agg.leaders.digs) lines.push(`- Digs: ${highlightName(agg.leaders.digs.player)} = ${agg.leaders.digs.value}`);
    if (agg.leaders.aces) lines.push(`- Aces: ${highlightName(agg.leaders.aces.player)} = ${agg.leaders.aces.value}`);
    if (agg.leaders.serveErrors) lines.push(`- Serve errors: ${highlightName(agg.leaders.serveErrors.player)} = ${agg.leaders.serveErrors.value}`);
  } else {
    lines.push(``);
    lines.push(`Team leaders: not found (player_game_stats empty for this season/team)`);
  }

  if (agg.bestPasser) {
    lines.push(``);
    lines.push(`Serve-receive (0–3 scale):`);
    lines.push(`- Best passer rating: ${highlightName(agg.bestPasser.player)} = ${agg.bestPasser.rating.toFixed(2)} (attempts: ${agg.bestPasser.attempts})`);
    lines.push(`- Team weighted SR rating: ${agg.bestPasser.teamRating.toFixed(2)} (weighted by attempts)`);
  }

  if (agg.trouble.length) {
    lines.push(``);
    lines.push(`Opponents with the most losses vs us:`);
    for (const t of agg.trouble) {
      lines.push(`- ${highlightName(t.opponent)} — losses ${t.losses}/${t.matches}, set diff ${t.setDiff}`);
    }
  }

  // If literally nothing exists:
  if (!agg.hasMatches && !agg.hasStats) {
    lines.push(``);
    lines.push(`Insufficient data in the current dataset (no match_results and no player_game_stats for this team/season).`);
  }

  return lines.join("\n");
}

function buildLLMInput(question: string, factsBlock: string, notesBlock: string) {
  const parts: string[] = [];
  parts.push(`QUESTION:\n${question}\n`);
  parts.push(`FACTS (use ONLY for Data-Backed Facts):\n${factsBlock}\n`);
  if (notesBlock.trim()) {
    parts.push(`TEAM NOTES (optional):\n${notesBlock}\n`);
  }
  return parts.join("\n");
}

async function callOpenAI(question: string, factsBlock: string, notesBlock: string) {
  assertEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";
  const inputText = buildLLMInput(question, factsBlock, notesBlock);

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_output_tokens: 950,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: `
You are the Volleyball Coaching Assistant for MVVC 14 Black.

You MUST answer the user's QUESTION directly, and you MUST use this exact format:

TITLE
-----
(2–8 words, relevant to the question)

Data-Backed (Facts)
-------------------
- 6–12 short bullets.
- ONLY facts that are explicitly present in the FACTS block or TEAM NOTES.
- If a requested stat is missing, include a bullet: "Insufficient data in the current dataset for <missing item>."

Coaching Insight (Inference)
----------------------------
- 6–12 short bullets.
- Practical coaching takeaways based on the facts above.
- Clearly label uncertain items as "likely" or "suggests".
- No citations. No source labels. Never output "No answer generated."

Name styling:
- When you mention a player, wrap the name like: 【Player Name】 (this must work even if bold markdown doesn't render).
- If you do use bold, you may also do **Player Name**, but ALWAYS include the brackets too: **【Player Name】**.
Spacing:
- Use blank lines between sections.
- Use hyphen bullets ("- ").
`,
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: inputText }],
        },
      ],
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }

  const json = await res.json();
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

function fallbackAnswer(question: string, factsBlock: string) {
  // Guaranteed non-empty, same formatting
  return [
    "Answer",
    "------",
    "",
    "Data-Backed (Facts)",
    "-------------------",
    ...factsBlock.split("\n").map((l) => (l.trim() ? `- ${l}` : "")),
    "",
    "Coaching Insight (Inference)",
    "----------------------------",
    "- I can’t generate a longer narrative right now, but the facts above confirm your data is being read.",
    "- If your question is broad, try asking for one angle: win/loss trend, toughest opponents, serve-receive, kills/digs/aces leaders.",
    `- Your question was: "${question}" — if you tell me which angle you care about (serve pressure, sideout, defense), I’ll tailor the insight.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { question: string };
    const question = String(body.question ?? "").trim();
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    const teamId = TEAM_ID;
    const season = DEFAULT_SEASON;

    const { chunks, matches, statsRows } = await retrieveData(teamId, season, question);
    const agg = computeAggregates(matches, statsRows);

    const factsBlock = buildFactsBlock(season, agg);
    const notesBlock = buildNotesBlock(chunks);

    let answer = "";
    try {
      answer = await callOpenAI(question, factsBlock, notesBlock);
    } catch {
      answer = "";
    }

    if (!answer) {
      answer = fallbackAnswer(question, factsBlock);
    }

    return NextResponse.json({ answer });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
