import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

/**
 * CONFIG
 * - Hard-code the team + default season so the UI doesn't need to send them.
 */
const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black
const DEFAULT_SEASON = "spring"; // change if you want

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

/**
 * Types match your tables.
 */
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
  stats: any; // jsonb from supabase (object or string)
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

/**
 * INTENT DETECTORS
 * These decide when we answer in code (fast, correct, no hallucinations).
 */
function wantsRosterPositions(q: string) {
  const s = q.toLowerCase();
  return (
    s.includes("roster") ||
    (s.includes("who") && s.includes("plays")) ||
    s.includes("positions") ||
    s.includes("position") ||
    s.includes("who plays which") ||
    s.includes("who plays what")
  );
}

function wantsLeaders(q: string) {
  const s = q.toLowerCase();
  return s.includes("leader") || s.includes("leaders") || s.includes("statistical leaders") || s.includes("top performers");
}

function wantsWinLoss(q: string) {
  const s = q.toLowerCase();
  return s.includes("win") || s.includes("loss") || s.includes("record");
}

function wantsToughOpponents(q: string) {
  const s = q.toLowerCase();
  return s.includes("tough") || s.includes("trouble") || s.includes("hardest") || s.includes("worst opponent") || s.includes("which opponents");
}

function wantsPasserRating(q: string) {
  const s = q.toLowerCase();
  return s.includes("passer rating") || s.includes("passing rating") || s.includes("serve receive") || s.includes("serve-receive") || s.includes("sr rating");
}

function wantsKillsLeader(q: string) {
  const s = q.toLowerCase();
  return s.includes("kills") && (s.includes("lead") || s.includes("leader") || s.includes("most") || s.includes("top"));
}

function isBroadQuestion(q: string) {
  const s = q.toLowerCase();
  return (
    s.includes("summarize") ||
    s.includes("season") ||
    s.includes("strength") ||
    s.includes("weakness") ||
    s.includes("improve") ||
    s.includes("regress") ||
    s.includes("key moments") ||
    s.includes("plan") ||
    s.includes("lineup") ||
    s.includes("starting six") ||
    s.includes("rotation")
  );
}

/**
 * DATA FETCH
 * Keep it relatively light. We'll ONLY use OpenAI for broad questions.
 * For roster/positions and narrow stats, we answer in code.
 */
async function fetchData(teamId: string, season: string, question: string) {
  const supabase = supabaseService();
  const cleaned = question.replace(/[^a-zA-Z0-9 ]/g, " ");

  // Roster notes: used for "roster/positions" questions
  const { data: rosterChunks, error: er } = await supabase
    .from("knowledge_chunks")
    .select("id,title,content,tags")
    .eq("team_id", teamId)
    .contains("tags", ["roster"])
    .limit(10);
  if (er) throw er;

  // Optional notes: only useful for broad questions
  let searchChunks: any[] = [];
  if (isBroadQuestion(question)) {
    const { data, error } = await supabase
      .from("knowledge_chunks")
      .select("id,title,content,tags")
      .eq("team_id", teamId)
      .eq("season", season)
      .textSearch("tsv", cleaned, { type: "websearch" })
      .limit(6);
    if (error) throw error;
    searchChunks = data ?? [];
  }

  // Match results: used for record + toughest opponents
  const { data: matches, error: em } = await supabase
    .from("match_results")
    .select("match_date,tournament,opponent,result,score,round,sets_won,sets_lost,set_diff")
    .eq("team_id", teamId)
    .order("match_date", { ascending: true })
    .limit(800);
  if (em) throw em;

  // Player stats: used for leaders + passer rating, and also provides positions
  const { data: statsRows, error: es } = await supabase
    .from("player_game_stats")
    .select("player_name,position,game_date,opponent,stats")
    .eq("team_id", teamId)
    .eq("season", season)
    .order("game_date", { ascending: false })
    .limit(2500);
  if (es) throw es;

  // Dedupe notes (roster + optional search)
  const merged: Record<string, { title: string; content: string }> = {};
  for (const c of [...(rosterChunks ?? []), ...(searchChunks ?? [])]) {
    const id = String(c.id);
    merged[id] = { title: String(c.title ?? ""), content: String(c.content ?? "") };
  }

  return {
    rosterChunks: rosterChunks ?? [],
    notes: Object.values(merged),
    matches: (matches ?? []) as MatchRow[],
    statsRows: (statsRows ?? []) as StatRow[],
  };
}

/**
 * COMPUTE FACTS (fast aggregates)
 */
function computeFacts(matches: MatchRow[], statsRows: StatRow[]) {
  // win/loss
  let wins = 0;
  let losses = 0;

  // opponent trouble
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

  // player totals + weighted SR
  type Tot = { kills: number; digs: number; aces: number; serveErrors: number; srAttempts: number; srWeightedSum: number };
  const totals: Record<string, Tot> = {};

  function ensure(player: string): Tot {
    if (!totals[player]) totals[player] = { kills: 0, digs: 0, aces: 0, serveErrors: 0, srAttempts: 0, srWeightedSum: 0 };
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
    const srRating = toNum(s.serve_receive_passing_rating); // 0–3 scale
    if (srAtt > 0) {
      t.srAttempts += srAtt;
      t.srWeightedSum += srRating * srAtt;
    }
  }

  const players = Object.keys(totals);

  function leader(metric: keyof Tot) {
    let bestPlayer = "";
    let bestVal = -Infinity;
    for (const p of players) {
      const v = totals[p][metric];
      if (v > bestVal) {
        bestVal = v;
        bestPlayer = p;
      }
    }
    return bestPlayer ? { player: bestPlayer, value: bestVal } : null;
  }

  // best passer (weighted)
  let bestPasser = "";
  let bestPasserRating = -Infinity;
  let bestPasserAtt = 0;

  let teamAtt = 0;
  let teamSum = 0;

  for (const p of players) {
    const t = totals[p];
    if (t.srAttempts > 0) {
      const r = t.srWeightedSum / t.srAttempts;
      if (r > bestPasserRating) {
        bestPasserRating = r;
        bestPasser = p;
        bestPasserAtt = t.srAttempts;
      }
      teamAtt += t.srAttempts;
      teamSum += t.srWeightedSum;
    }
  }

  const teamSrRating = teamAtt > 0 ? teamSum / teamAtt : 0;

  const trouble = Object.keys(oppMatches)
    .map((opp) => ({ opponent: opp, losses: oppLosses[opp] ?? 0, matches: oppMatches[opp] ?? 0, setDiff: oppSetDiff[opp] ?? 0 }))
    .filter((x) => x.losses > 0)
    .sort((a, b) => (b.losses !== a.losses ? b.losses - a.losses : a.setDiff - b.setDiff))
    .slice(0, 8);

  return {
    wins,
    losses,
    trouble,
    leaders: {
      kills: leader("kills"),
      digs: leader("digs"),
      aces: leader("aces"),
      serveErrors: leader("serveErrors"),
    },
    bestPasser: bestPasser ? { player: bestPasser, rating: bestPasserRating, attempts: bestPasserAtt, teamRating: teamSrRating, teamAttempts: teamAtt } : null,
    hasMatches: matches.length > 0,
    hasStats: players.length > 0,
  };
}

/**
 * ROSTER ANSWER (no OpenAI)
 * Priority order:
 * 1) Use player_game_stats.position (because it’s structured)
 * 2) Fall back to rosterChunks text if positions aren't present
 */
function answerRosterPositions(statsRows: StatRow[], rosterChunks: any[]) {
  // Build "player -> set of positions"
  const posMap: Record<string, Record<string, boolean>> = {};

  for (const r of statsRows) {
    const name = (r.player_name ?? "").trim();
    const pos = (r.position ?? "").trim();
    if (!name) continue;
    if (!posMap[name]) posMap[name] = {};
    if (pos) posMap[name][pos] = true;
  }

  const players = Object.keys(posMap).sort((a, b) => a.localeCompare(b));

  // If we got positions from statsRows, use them
  if (players.length) {
    const lines: string[] = [];
    lines.push("Roster & positions");
    for (const p of players) {
      const positions = Object.keys(posMap[p]).sort();
      lines.push(`${p}: ${positions.length ? positions.join(", ") : "Position not set"}`);
    }
    return lines.join("\n");
  }

  // Otherwise, fall back to rosterChunks content (best-effort)
  if (rosterChunks?.length) {
    const lines: string[] = [];
    lines.push("Roster");
    for (const c of rosterChunks) {
      const title = String(c.title ?? "").trim();
      const content = String(c.content ?? "").trim();
      if (title) lines.push(title);
      if (content) lines.push(content);
    }
    return lines.join("\n");
  }

  return "Insufficient data in the current dataset.\nUpload a roster (knowledge_chunks tagged roster) or player_game_stats with position filled in.";
}

/**
 * For BROAD questions only, call OpenAI for narrative.
 * Keep payload compact to reduce latency & noise.
 */
async function callOpenAIForBroad(question: string, season: string, facts: ReturnType<typeof computeFacts>, notes: Array<{ title: string; content: string }>) {
  assertEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";

  const payload = {
    season,
    winLoss: facts.hasMatches ? { wins: facts.wins, losses: facts.losses } : null,
    leaders: facts.hasStats ? facts.leaders : null,
    bestPasser: facts.bestPasser
      ? { player: facts.bestPasser.player, rating: Number(facts.bestPasser.rating.toFixed(2)), attempts: facts.bestPasser.attempts, scale: "0-3" }
      : null,
    troubleOpponents: facts.trouble.slice(0, 5),
    notes: notes.slice(0, 4), // small to keep it snappy
  };

  const system = `
You are "Volleyball Guru" for MVVC 14 Black.

Answer like ChatGPT: helpful, coach-friendly, and practical.
Do NOT dump unrelated stats. Use only what’s in FACTS_JSON.

Output style:
Title line
Then 2-4 short sections with clear spacing.
No hyphen dividers. Avoid noisy labels.
Player names: use **Name**.
`;

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_output_tokens: 700,
      input: [
        { role: "system", content: [{ type: "input_text", text: system }] },
        { role: "user", content: [{ type: "input_text", text: JSON.stringify({ question, FACTS_JSON: payload }) }] },
      ],
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }

  const json = await res.json();

  // Safely extract text from Responses API
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
  return (text || "").trim();
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { question: string };
    const question = String(body.question ?? "").trim();
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    const teamId = TEAM_ID;
    const season = DEFAULT_SEASON;

    // Fetch data once
    const { rosterChunks, notes, matches, statsRows } = await fetchData(teamId, season, question);
    const facts = computeFacts(matches, statsRows);

    // 1) Roster/positions should ALWAYS be answered directly (no OpenAI)
    if (wantsRosterPositions(question)) {
      const answer = answerRosterPositions(statsRows, rosterChunks);
      return NextResponse.json({ answer });
    }

    // 2) Narrow questions: answer directly to avoid noise + hallucinations
    if (wantsPasserRating(question)) {
      if (!facts.bestPasser) {
        return NextResponse.json({
          answer: "Best passer rating\nInsufficient data in the current dataset.\nUpload/confirm serve_receive_attempts and serve_receive_passing_rating in player_game_stats.stats.",
        });
      }
      return NextResponse.json({
        answer: `Best passer rating\n${facts.bestPasser.player} (${facts.bestPasser.rating.toFixed(2)} on ${facts.bestPasser.attempts} attempts, 0–3 scale)`,
      });
    }

    if (wantsKillsLeader(question)) {
      if (!facts.leaders.kills) {
        return NextResponse.json({ answer: "Kills leader\nInsufficient data in the current dataset.\nUpload/confirm attack_kills in player_game_stats.stats." });
      }
      return NextResponse.json({ answer: `Kills leader\n${facts.leaders.kills.player} (${facts.leaders.kills.value})` });
    }

    if (wantsWinLoss(question)) {
      if (!facts.hasMatches) {
        return NextResponse.json({ answer: "Win/Loss record\nInsufficient data in the current dataset.\nUpload/confirm match_results rows for this team." });
      }
      return NextResponse.json({ answer: `Win/Loss record\n${facts.wins}-${facts.losses}` });
    }

    if (wantsToughOpponents(question)) {
      if (!facts.hasMatches || facts.trouble.length === 0) {
        return NextResponse.json({ answer: "Toughest opponents\nInsufficient data in the current dataset.\nUpload/confirm match_results with opponent + result." });
      }
      const top = facts.trouble.slice(0, 6).map((t, i) => `${i + 1}) ${t.opponent} (losses ${t.losses}/${t.matches})`);
      return NextResponse.json({ answer: `Toughest opponents\n${top.join("\n")}` });
    }

    if (wantsLeaders(question)) {
      const lines: string[] = [];
      lines.push("Statistical leaders (season totals)");
      if (facts.leaders.kills) lines.push(`Kills: ${facts.leaders.kills.player} (${facts.leaders.kills.value})`);
      if (facts.leaders.digs) lines.push(`Digs: ${facts.leaders.digs.player} (${facts.leaders.digs.value})`);
      if (facts.leaders.aces) lines.push(`Aces: ${facts.leaders.aces.player} (${facts.leaders.aces.value})`);
      if (facts.leaders.serveErrors) lines.push(`Serve errors: ${facts.leaders.serveErrors.player} (${facts.leaders.serveErrors.value})`);
      if (facts.bestPasser) lines.push(`Best passer rating (0–3): ${facts.bestPasser.player} (${facts.bestPasser.rating.toFixed(2)} on ${facts.bestPasser.attempts})`);
      return NextResponse.json({ answer: lines.join("\n") });
    }

    // 3) Broad questions: use OpenAI for a ChatGPT-like narrative
    if (isBroadQuestion(question)) {
      let answer = "";
      try {
        answer = await callOpenAIForBroad(question, season, facts, notes);
      } catch {
        answer = "";
      }

      // Always return something useful
      if (!answer) {
        const fallback: string[] = [];
        fallback.push("Summary");
        if (facts.hasMatches) fallback.push(`Season record: ${facts.wins}-${facts.losses}`);
        if (facts.bestPasser) fallback.push(`Serve-receive anchor: ${facts.bestPasser.player} (${facts.bestPasser.rating.toFixed(2)} on ${facts.bestPasser.attempts})`);
        if (facts.leaders.kills) fallback.push(`Primary scorer: ${facts.leaders.kills.player} (${facts.leaders.kills.value} kills)`);
        fallback.push("");
        fallback.push("If you want a true narrative, ask one angle: serve-receive, serving risk, sideout, defense, or toughest opponents.");
        answer = fallback.join("\n");
      }

      return NextResponse.json({ answer });
    }

    // 4) Default: short helpful answer (no noise)
    return NextResponse.json({
      answer:
        "I can help. Try one of these:\n" +
        "Who has the best passer rating?\n" +
        "What is our win/loss record?\n" +
        "Show me the statistical leaders across key categories.\n" +
        "Show me the roster and who plays which positions.\n" +
        "Analyze strengths & weaknesses of the team.",
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
