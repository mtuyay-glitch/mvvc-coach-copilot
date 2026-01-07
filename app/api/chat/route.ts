import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5";
const DEFAULT_SEASON = "spring";

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

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

function boldName(name: string) {
  const n = (name ?? "").toString().trim();
  return n ? `**${n}**` : "";
}

async function retrieveData(teamId: string, season: string) {
  const supabase = supabaseService();

  const { data: matches, error: em } = await supabase
    .from("match_results")
    .select("match_date,tournament,opponent,result,score,round,sets_won,sets_lost,set_diff")
    .eq("team_id", teamId)
    .order("match_date", { ascending: true })
    .limit(800);
  if (em) throw em;

  const { data: statsRows, error: es } = await supabase
    .from("player_game_stats")
    .select("player_name,position,game_date,opponent,stats")
    .eq("team_id", teamId)
    .eq("season", season)
    .order("game_date", { ascending: false })
    .limit(6000);
  if (es) throw es;

  return { matches: (matches ?? []) as MatchRow[], statsRows: (statsRows ?? []) as StatRow[] };
}

function computeFacts(matches: MatchRow[], statsRows: StatRow[]) {
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
    const sd = toNum(m.set_diff);
    oppSetDiff[opp] = (oppSetDiff[opp] ?? 0) + sd;
  }

  // Player totals + weighted SR rating
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
      totals[player] = { kills: 0, digs: 0, aces: 0, serveErrors: 0, srAttempts: 0, srWeightedSum: 0 };
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
    const srRating = toNum(s.serve_receive_passing_rating); // 0–3 scale
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

  // best passer weighted
  let bestPasserPlayer = "";
  let bestPasserRating = -Infinity;
  let bestPasserAttempts = 0;

  let teamSrAtt = 0;
  let teamSrSum = 0;

  for (const p of players) {
    const t = totals[p];
    teamSrAtt += t.srAttempts;
    teamSrSum += t.srWeightedSum;

    if (t.srAttempts > 0) {
      const r = t.srWeightedSum / t.srAttempts;
      if (r > bestPasserRating) {
        bestPasserRating = r;
        bestPasserPlayer = p;
        bestPasserAttempts = t.srAttempts;
      }
    }
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
    hasMatches: matches.length > 0,
    hasStats: players.length > 0,
    wins,
    losses,
    leaders: {
      kills: leader("kills"),
      digs: leader("digs"),
      aces: leader("aces"),
      serveErrors: leader("serveErrors"),
    },
    bestPasser: bestPasserPlayer
      ? { player: bestPasserPlayer, rating: bestPasserRating, attempts: bestPasserAttempts }
      : null,
    teamSrRating,
    trouble,
  };
}

function buildFactsPack(season: string, facts: ReturnType<typeof computeFacts>) {
  const lines: string[] = [];

  lines.push(`Season: ${season}`);

  if (facts.hasMatches) lines.push(`Win/Loss: ${facts.wins}-${facts.losses}`);
  else lines.push("Win/Loss: (no match_results rows found)");

  lines.push("");

  lines.push("Leaders:");
  if (facts.leaders.kills) lines.push(`Kills: ${facts.leaders.kills.player} = ${facts.leaders.kills.value}`);
  if (facts.leaders.digs) lines.push(`Digs: ${facts.leaders.digs.player} = ${facts.leaders.digs.value}`);
  if (facts.leaders.aces) lines.push(`Aces: ${facts.leaders.aces.player} = ${facts.leaders.aces.value}`);
  if (facts.leaders.serveErrors) lines.push(`Serve Errors: ${facts.leaders.serveErrors.player} = ${facts.leaders.serveErrors.value}`);

  lines.push("");

  if (facts.bestPasser) {
    lines.push("Serve-Receive (0–3 scale):");
    lines.push(`Best passer: ${facts.bestPasser.player} = ${facts.bestPasser.rating.toFixed(2)} on ${facts.bestPasser.attempts} attempts`);
    lines.push(`Team weighted SR rating: ${facts.teamSrRating.toFixed(2)}`);
    lines.push("");
  }

  if (facts.trouble.length) {
    lines.push("Toughest opponents (losses first):");
    for (const t of facts.trouble) {
      lines.push(`${t.opponent} | losses ${t.losses}/${t.matches} | set diff ${t.setDiff}`);
    }
  }

  return lines.join("\n");
}

function localFallbackNarrative(question: string, season: string, facts: ReturnType<typeof computeFacts>) {
  const out: string[] = [];

  out.push("Coaching Assistant");
  out.push("");
  out.push(`Question: ${question}`);
  out.push("");

  if (!facts.hasMatches && !facts.hasStats) {
    out.push("FACT");
    out.push("• Insufficient data in the current dataset.");
    out.push("");
    out.push("COACHING INSIGHT");
    out.push("• Confirm rows exist in match_results and player_game_stats for this TEAM_ID + season.");
    out.push("• If player_game_stats.stats is stored as text, it must be valid JSON.");
    return out.join("\n");
  }

  out.push("FACT");
  out.push(`• Season: ${season}`);
  if (facts.hasMatches) out.push(`• Win/Loss: ${facts.wins}-${facts.losses}`);

  out.push("• Leaders:");
  if (facts.leaders.kills) out.push(`  • Kills: ${boldName(facts.leaders.kills.player)} — ${facts.leaders.kills.value}`);
  if (facts.leaders.digs) out.push(`  • Digs: ${boldName(facts.leaders.digs.player)} — ${facts.leaders.digs.value}`);
  if (facts.leaders.aces) out.push(`  • Aces: ${boldName(facts.leaders.aces.player)} — ${facts.leaders.aces.value}`);
  if (facts.leaders.serveErrors) out.push(`  • Serve errors: ${boldName(facts.leaders.serveErrors.player)} — ${facts.leaders.serveErrors.value}`);

  if (facts.bestPasser) {
    out.push("• Serve-receive (0–3 scale):");
    out.push(`  • Best passer rating: ${boldName(facts.bestPasser.player)} — ${facts.bestPasser.rating.toFixed(2)} on ${facts.bestPasser.attempts} attempts`);
    out.push(`  • Team weighted SR rating: ${facts.teamSrRating.toFixed(2)}`);
  }

  if (facts.trouble.length) {
    out.push("• Toughest opponents:");
    for (const t of facts.trouble) {
      out.push(`  • ${t.opponent} — losses ${t.losses}/${t.matches}, set diff ${t.setDiff}`);
    }
  }

  out.push("");
  out.push("COACHING INSIGHT");
  out.push("• A practical season summary comes from connecting your record + serve-receive stability + error profile.");
  out.push("• If your top serve-error player is also a high-impact scorer/server, tune risk (targets + consistency) rather than removing aggression entirely.");
  if (facts.bestPasser) out.push(`• Build your serve-receive system around ${boldName(facts.bestPasser.player)} and use formations to protect weaker passers.`);
  if (facts.trouble.length) out.push("• For repeat-loss opponents, write a 3-part plan: serve targets, passing seams, and which rotation you got stuck in.");

  return out.join("\n");
}

async function callOpenAI(question: string, factsPack: string) {
  assertEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";

  // IMPORTANT: use plain-text messages (avoids input_text schema errors)
  const payload = {
    model,
    max_output_tokens: 900,
    input: [
      {
        role: "system",
        content: `You are a volleyball Coaching Assistant for MVVC 14 Black.

Write a coach-friendly response with a narrative style similar to ChatGPT.

Formatting rules:
• Use comfortable spacing (blank lines between sections).
• Use dot bullets only: "•" (do NOT use hyphen bullets).
• Do NOT use divider lines made of hyphens.
• Make player names subtly stand out using **bold** (example: **Koa Tuyay**).
• Keep team/opponent names plain text (NOT bracketed).

Structure rules:
1) Include a "FACT" section first (only use the Facts Pack).
2) Include a "COACHING INSIGHT" section next (your volleyball interpretation + practical next steps).
3) If the Facts Pack is missing something needed for the question, say so in FACT and explain what to track/import in COACHING INSIGHT.`,
      },
      {
        role: "user",
        content: `Question:\n${question}\n\nFacts Pack:\n${factsPack}`,
      },
    ],
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }

  const json = await res.json();

  // Try common shortcuts first
  if (typeof json.output_text === "string" && json.output_text.trim()) {
    return json.output_text.trim();
  }

  // Otherwise, traverse output blocks safely
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

    const season = DEFAULT_SEASON;

    const { matches, statsRows } = await retrieveData(TEAM_ID, season);
    const facts = computeFacts(matches, statsRows);
    const factsPack = buildFactsPack(season, facts);

    // OpenAI first, fallback if empty/error
    let answer = "";
    try {
      answer = await callOpenAI(question, factsPack);
    } catch {
      answer = "";
    }

    if (!answer) {
      answer = localFallbackNarrative(question, season, facts);
    }

    // Light cleanup: ensure no weird brackets make it through
    answer = answer.replace(/[【】]/g, "");

    return NextResponse.json({ answer });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
