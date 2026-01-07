import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black
const DEFAULT_SEASON = "spring"; // change to "fall" if you want your default season

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
  stats: any; // jsonb from supabase (may arrive as object or stringified json)
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

async function retrieveContext(teamId: string, season: string, question: string) {
  const supabase = supabaseService();

  // A) Roster chunks always
  const { data: rosterChunks, error: er } = await supabase
    .from("knowledge_chunks")
    .select("id,title,content,tags")
    .eq("team_id", teamId)
    .contains("tags", ["roster"])
    .limit(5);
  if (er) throw er;

  // B) Season-specific notes by search (optional, helpful for lineup rules / injuries)
  const cleaned = question.replace(/[^a-zA-Z0-9 ]/g, " ");
  const { data: searchChunks, error: e1 } = await supabase
    .from("knowledge_chunks")
    .select("id,title,content,tags")
    .eq("team_id", teamId)
    .eq("season", season)
    .textSearch("tsv", cleaned, { type: "websearch" })
    .limit(6);
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
    .limit(400);
  if (em) throw em;

  // D) Player stat rows (raw rows, we compute light aggregates below)
  const { data: statsRows, error: es } = await supabase
    .from("player_game_stats")
    .select("player_name,position,game_date,opponent,stats")
    .eq("team_id", teamId)
    .eq("season", season)
    .order("game_date", { ascending: false })
    .limit(1200);
  if (es) throw es;

  return { chunks: chunks ?? [], matches: (matches ?? []) as MatchRow[], statsRows: (statsRows ?? []) as StatRow[] };
}

function computeFacts(matches: MatchRow[], statsRows: StatRow[]) {
  // --- Win/Loss
  let wins = 0;
  let losses = 0;

  // opponent loss counts + set diff sums
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
    const sd = toNum(m.set_diff);
    oppSetDiff[opp] = (oppSetDiff[opp] ?? 0) + sd;
  }

  // --- Player totals + weighted SR rating
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

    // common fields based on your JSON sample
    t.kills += toNum(s.attack_kills);
    t.digs += toNum(s.digs_successful);
    t.aces += toNum(s.serve_aces);
    t.serveErrors += toNum(s.serve_errors);

    const srAtt = toNum(s.serve_receive_attempts);
    const srRating = toNum(s.serve_receive_passing_rating); // 0–3 scale
    if (srAtt > 0) {
      t.srAttempts += srAtt;
      t.srWeightedSum += srRating * srAtt;
    }
  }

  function leader(metric: keyof Tot) {
    let bestPlayer = "";
    let bestVal = -Infinity;
    for (const player of Object.keys(totals)) {
      const v = totals[player][metric];
      if (v > bestVal) {
        bestVal = v;
        bestPlayer = player;
      }
    }
    return bestPlayer ? { player: bestPlayer, value: bestVal } : null;
  }

  // Best passer rating (weighted)
  let bestPasser = "";
  let bestPasserRating = -Infinity;
  let bestPasserAtt = 0;

  for (const player of Object.keys(totals)) {
    const t = totals[player];
    if (t.srAttempts <= 0) continue;
    const r = t.srWeightedSum / t.srAttempts;
    if (r > bestPasserRating) {
      bestPasserRating = r;
      bestPasser = player;
      bestPasserAtt = t.srAttempts;
    }
  }

  // Team SR rating
  let teamSrAtt = 0;
  let teamSrSum = 0;
  for (const player of Object.keys(totals)) {
    teamSrAtt += totals[player].srAttempts;
    teamSrSum += totals[player].srWeightedSum;
  }
  const teamSrRating = teamSrAtt > 0 ? teamSrSum / teamSrAtt : 0;

  // Opponents causing trouble: sort by losses desc, then by set diff asc (more negative is worse)
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
    hasStats: Object.keys(totals).length > 0,
    hasMatches: matches.length > 0,
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

function buildFactsBlock(facts: ReturnType<typeof computeFacts>) {
  const lines: string[] = [];

  lines.push("Data-Backed (Facts)");
  lines.push("-------------------");

  if (!facts.hasMatches && !facts.hasStats) {
    lines.push("Insufficient data in the current dataset.");
    return lines.join("\n");
  }

  if (facts.hasMatches) {
    lines.push(`Win/Loss (from match_results): ${facts.wins}-${facts.losses}`);
  } else {
    lines.push("Win/Loss: (match_results not found)");
  }

  lines.push("");
  lines.push("__Team Leaders (season totals from player_game_stats)__");

  const k = facts.leaders.kills;
  const d = facts.leaders.digs;
  const a = facts.leaders.aces;
  const se = facts.leaders.serveErrors;

  if (k) lines.push(`• **${k.player}** — ${k.value} kills`);
  if (d) lines.push(`• **${d.player}** — ${d.value} digs`);
  if (a) lines.push(`• **${a.player}** — ${a.value} aces`);
  if (se) lines.push(`• **${se.player}** — ${se.value} serve errors`);

  if (facts.bestPasser) {
    lines.push("");
    lines.push("__Serve-Receive (0–3 scale)__");
    lines.push(
      `• Best passer rating: **${facts.bestPasser.player}** — ${facts.bestPasser.rating.toFixed(2)} on ${facts.bestPasser.attempts} attempts`
    );
    lines.push(`• Team weighted SR rating: ${facts.bestPasser.teamRating.toFixed(2)} on ${facts.bestPasser.attempts ? "multiple players" : "0"} attempts`);
  }

  if (facts.trouble.length) {
    lines.push("");
    lines.push("__Opponents That Caused the Most Trouble__");
    for (const t of facts.trouble) {
      lines.push(`• **${t.opponent}** — losses: ${t.losses}/${t.matches}, set diff: ${t.setDiff}`);
    }
  }

  return lines.join("\n");
}

function buildLLMInput(question: string, factsBlock: string, notesBlock: string) {
  const parts: string[] = [];
  parts.push(`QUESTION:\n${question}\n`);

  parts.push(`FACTS BLOCK (use for Data-Backed facts only):\n${factsBlock}\n`);

  if (notesBlock.trim()) {
    parts.push(`TEAM NOTES (optional context):\n${notesBlock}\n`);
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
      max_output_tokens: 900,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: `
You are a volleyball Coaching Assistant for MVVC 14 Black.

Write coach-friendly answers with:
- Clean spacing and short bullets.
- Two sections ONLY, in this exact order:

Data-Backed (Facts)
-------------------
(only what is explicitly supported by the FACTS BLOCK)

Coaching Insight (Inference)
----------------------------
(volleyball interpretation of those facts; make it practical: what it suggests, what to do next)

Rules:
- Data-Backed (Facts) must come ONLY from the FACTS BLOCK.
- Coaching Insight (Inference) may use volleyball knowledge to interpret those facts.
- Do NOT show citations like S3/K2/etc.
- Make player names stand out subtly using **bold** (example: **Koa**).
- If the FACTS BLOCK says "Insufficient data in the current dataset.", you must say that in Facts and then in Insight explain what data is missing + what to upload/track.
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

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { question: string };
    const question = String(body.question ?? "").trim();
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    const teamId = TEAM_ID;
    const season = DEFAULT_SEASON;

    const { chunks, matches, statsRows } = await retrieveContext(teamId, season, question);
    const facts = computeFacts(matches, statsRows);

    const factsBlock = buildFactsBlock(facts);
    const notesBlock = buildNotesBlock(chunks);

    // Try OpenAI
    let answer = "";
    try {
      answer = await callOpenAI(question, factsBlock, notesBlock);
    } catch (e) {
      // If OpenAI errors, we'll still return a useful response below.
      answer = "";
    }

    // Hard fallback so you don't get "No answer generated"
    if (!answer) {
      const fallbackLines: string[] = [];
      fallbackLines.push("Data-Backed (Facts)");
      fallbackLines.push("-------------------");
      fallbackLines.push(factsBlock.replace(/^Data-Backed \(Facts\)\n-+\n?/m, "").trim() || "Insufficient data in the current dataset.");
      fallbackLines.push("");
      fallbackLines.push("Coaching Insight (Inference)");
      fallbackLines.push("----------------------------");
      if (!facts.hasMatches && !facts.hasStats) {
        fallbackLines.push("Your tables returned no usable match_results or player_game_stats rows for this season/team. Re-import or confirm TEAM_ID + season + table contents.");
      } else {
        fallbackLines.push("Your data is loaded, but a full narrative summary needs more specific direction.");
        fallbackLines.push("Try one of these:");
        fallbackLines.push("• Strengths/weaknesses: ask “What do the leaders + win/loss pattern suggest we should focus on?”");
        fallbackLines.push("• Opponent trouble: ask “Break down why our worst opponents were hard (serve pressure, sideout, errors).”");
        fallbackLines.push("• Lineup: ask “Best starting six given passing + kills + blocks (if tracked).”");
      }
      answer = fallbackLines.join("\n");
    }

    return NextResponse.json({ answer });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
