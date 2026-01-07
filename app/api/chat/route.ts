import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

// Hard-coded team + season
const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black
const DEFAULT_SEASON = "spring"; // change to "fall" if you want

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

  // A) roster chunks always
  const { data: rosterChunks, error: er } = await supabase
    .from("knowledge_chunks")
    .select("id,title,content,tags")
    .eq("team_id", teamId)
    .contains("tags", ["roster"])
    .limit(10);
  if (er) throw er;

  // B) season notes by search (optional)
  const cleaned = question.replace(/[^a-zA-Z0-9 ]/g, " ");
  const { data: searchChunks, error: e1 } = await supabase
    .from("knowledge_chunks")
    .select("id,title,content,tags")
    .eq("team_id", teamId)
    .eq("season", season)
    .textSearch("tsv", cleaned, { type: "websearch" })
    .limit(10);
  if (e1) throw e1;

  // merge + dedupe
  const mergedMap = new Map<number, any>();
  (rosterChunks ?? []).forEach((c: any) => mergedMap.set(c.id, c));
  (searchChunks ?? []).forEach((c: any) => mergedMap.set(c.id, c));
  const chunks = Array.from(mergedMap.values());

  // C) match results
  const { data: matches, error: em } = await supabase
    .from("match_results")
    .select("match_date,tournament,opponent,result,score,round,sets_won,sets_lost,set_diff")
    .eq("team_id", teamId)
    .order("match_date", { ascending: true })
    .limit(600);
  if (em) throw em;

  // D) player game stats
  const { data: statsRows, error: es } = await supabase
    .from("player_game_stats")
    .select("player_name,position,game_date,opponent,stats")
    .eq("team_id", teamId)
    .eq("season", season)
    .order("game_date", { ascending: false })
    .limit(2000);
  if (es) throw es;

  return {
    chunks: chunks ?? [],
    matches: (matches ?? []) as MatchRow[],
    statsRows: (statsRows ?? []) as StatRow[],
  };
}

function computeFacts(matches: MatchRow[], statsRows: StatRow[]) {
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

    const sd = toNum(m.set_diff);
    oppSetDiff[opp] = (oppSetDiff[opp] ?? 0) + sd;
  }

  type Tot = {
    kills: number;
    digs: number;
    aces: number;
    serveErrors: number;
    srAttempts: number;
    srWeightedSum: number;
  };

  const totals: Record<string, Tot> = {};

  const ensure = (player: string): Tot => {
    if (!totals[player]) {
      totals[player] = {
        kills: 0,
        digs: 0,
        aces: 0,
        serveErrors: 0,
        srAttempts: 0,
        srWeightedSum: 0,
      };
    }
    return totals[player];
  };

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
    const srRating = toNum(s.serve_receive_passing_rating);
    if (srAtt > 0) {
      t.srAttempts += srAtt;
      t.srWeightedSum += srRating * srAtt;
    }
  }

  const players = Object.keys(totals);

  const leader = (key: keyof Tot) => {
    let bestPlayer = "";
    let bestVal = -Infinity;
    for (const p of players) {
      const v = totals[p][key];
      if (v > bestVal) {
        bestVal = v;
        bestPlayer = p;
      }
    }
    return bestPlayer ? { player: bestPlayer, value: bestVal } : null;
  };

  let bestPasserPlayer = "";
  let bestPasserRating = -Infinity;
  let bestPasserAttempts = 0;

  for (const p of players) {
    const t = totals[p];
    if (t.srAttempts <= 0) continue;
    const r = t.srWeightedSum / t.srAttempts;
    if (r > bestPasserRating) {
      bestPasserRating = r;
      bestPasserPlayer = p;
      bestPasserAttempts = t.srAttempts;
    }
  }

  let teamSrAtt = 0;
  let teamSrSum = 0;
  for (const p of players) {
    teamSrAtt += totals[p].srAttempts;
    teamSrSum += totals[p].srWeightedSum;
  }
  const teamSrRating = teamSrAtt > 0 ? teamSrSum / teamSrAtt : 0;

  const trouble = Object.keys(oppMatches)
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
    hasStats: players.length > 0,
    leaders: {
      kills: leader("kills"),
      digs: leader("digs"),
      aces: leader("aces"),
      serveErrors: leader("serveErrors"),
    },
    bestPasser: bestPasserPlayer
      ? {
          player: bestPasserPlayer,
          rating: bestPasserRating,
          attempts: bestPasserAttempts,
          teamRating: teamSrRating,
        }
      : null,
    trouble,
  };
}

function buildNotesBlock(chunks: any[]) {
  if (!chunks.length) return "";
  const lines: string[] = [];
  for (const c of chunks) {
    const title = String(c.title ?? "").trim();
    const content = String(c.content ?? "").trim();
    if (!title && !content) continue;
    if (title) lines.push(`${title}\n${content}`);
    else lines.push(content);
  }
  return lines.join("\n\n");
}

function buildFactsBlock(season: string, facts: ReturnType<typeof computeFacts>) {
  const lines: string[] = [];

  lines.push("Data-Backed (Facts)");
  lines.push("");

  if (!facts.hasMatches && !facts.hasStats) {
    lines.push("Insufficient data in the current dataset.");
    return lines.join("\n");
  }

  lines.push(`Season: ${season}`);
  if (facts.hasMatches) lines.push(`Win/Loss: ${facts.wins}-${facts.losses}`);

  lines.push("");
  lines.push("Team leaders (season totals):");

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
    lines.push("Serve-receive (0–3 scale):");
    lines.push(`• Best passer rating: **${facts.bestPasser.player}** — ${facts.bestPasser.rating.toFixed(2)} on ${facts.bestPasser.attempts} attempts`);
    lines.push(`• Team weighted SR rating: ${facts.bestPasser.teamRating.toFixed(2)}`);
  }

  if (facts.trouble.length) {
    lines.push("");
    lines.push("Opponents that caused the most trouble:");
    for (const t of facts.trouble) {
      lines.push(`• ${t.opponent} — losses: ${t.losses}/${t.matches}, set diff: ${t.setDiff}`);
    }
  }

  return lines.join("\n");
}

function buildLLMInput(question: string, factsBlock: string, notesBlock: string) {
  const parts: string[] = [];
  parts.push(`QUESTION:\n${question}\n`);
  parts.push(`FACTS BLOCK:\n${factsBlock}\n`);
  if (notesBlock.trim()) parts.push(`TEAM NOTES:\n${notesBlock}\n`);
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

Return EXACTLY two sections, in this exact order:

Data-Backed (Facts)

Coaching Insight (Inference)

Formatting rules:
• Do NOT use hyphen bullets. Use the • bullet character.
• Do NOT use divider lines made of hyphens.
• Player names should be subtly emphasized using **bold** (example: **Koa Tuyay**).
• Team names must be plain text (no bold, no brackets like 【 】).
• Keep spacing readable: short paragraphs + small bullet groups.

Content rules:
• Data-Backed (Facts) must ONLY use what appears in the FACTS BLOCK.
• Coaching Insight (Inference) can be a normal-length narrative (like ChatGPT) interpreting the facts and giving practical coaching next steps.
• If the FACTS BLOCK says "Insufficient data in the current dataset.", repeat that in Facts and then explain what to upload/track in Insight.
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

function fallbackAnswer(season: string, factsBlock: string, notesBlock: string, question: string) {
  const lines: string[] = [];
  lines.push(factsBlock.trim() || "Data-Backed (Facts)\n\nInsufficient data in the current dataset.");
  lines.push("");
  lines.push("Coaching Insight (Inference)");
  lines.push("");

  if (factsBlock.includes("Insufficient data in the current dataset.")) {
    lines.push("Your database query returned no usable match_results or player_game_stats for this team/season.");
    lines.push("");
    lines.push("What to check:");
    lines.push("• Confirm TEAM_ID matches your team in Supabase.");
    lines.push("• Confirm DEFAULT_SEASON matches the rows you imported.");
    lines.push("• Confirm the tables contain rows (not just files uploaded).");
    lines.push("");
    lines.push("What to upload:");
    lines.push("• match_results (W/L + scores).");
    lines.push("• player_game_stats (per-match player stats).");
    return lines.join("\n");
  }

  lines.push("Here’s what the current season numbers suggest at a high level:");
  lines.push("");
  lines.push("• If your win/loss is strong, protect what’s working: serve pressure + first-ball sideout consistency.");
  lines.push("• If a few opponents repeatedly show up as losses, build match plans: serve targets, receive assignments, and rotation-specific adjustments for those teams.");
  lines.push("• If a team leader also leads serve errors, tighten serving risk: target zones and pace with fewer “miss-long” outcomes.");
  lines.push("• If one passer clearly leads by rating and attempts, stabilize serve-receive around them and protect weaker passers with formations.");
  lines.push("");
  lines.push("If you want this tailored, try one of these:");
  lines.push("• “What should our top 3 practice priorities be for the next 2 weeks?”");
  lines.push("• “Give me a starting six recommendation using passing + kills + errors.”");
  lines.push("• “Break down our toughest opponent with a coaching plan.”");
  lines.push("");
  lines.push(`(Your original question was: "${question}")`);

  if (notesBlock.trim()) {
    lines.push("");
    lines.push("I also have roster/team notes loaded, so I can incorporate role constraints into lineup recommendations.");
  }

  return lines.join("\n");
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { question: string };
    const question = String(body.question ?? "").trim();
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    const season = DEFAULT_SEASON;

    const { chunks, matches, statsRows } = await retrieveContext(TEAM_ID, season, question);
    const facts = computeFacts(matches, statsRows);

    const notesBlock = buildNotesBlock(chunks);
    const factsBlock = buildFactsBlock(season, facts);

    let answer = "";
    try {
      answer = await callOpenAI(question, factsBlock, notesBlock);
    } catch {
      answer = "";
    }

    if (!answer) {
      answer = fallbackAnswer(season, factsBlock, notesBlock, question);
    }

    return NextResponse.json({ answer });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
