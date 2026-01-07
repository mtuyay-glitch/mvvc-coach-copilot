import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black
const DEFAULT_SEASON = "spring"; // change if you want

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

function fmtName(name: string) {
  // subtle standout without weird brackets
  return `**${name}**`;
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

function wantsWinLoss(q: string) {
  const s = q.toLowerCase();
  return s.includes("win") || s.includes("loss") || s.includes("record");
}

function wantsToughOpponents(q: string) {
  const s = q.toLowerCase();
  return (
    s.includes("tough") ||
    s.includes("trouble") ||
    s.includes("hardest") ||
    s.includes("worst opponent") ||
    s.includes("which opponents")
  );
}

function wantsPasserRating(q: string) {
  const s = q.toLowerCase();
  return (
    s.includes("passer rating") ||
    s.includes("passing rating") ||
    s.includes("serve receive") ||
    s.includes("serve-receive") ||
    s.includes("sr rating")
  );
}

function wantsKillsLeader(q: string) {
  const s = q.toLowerCase();
  return s.includes("kills") && (s.includes("lead") || s.includes("leader") || s.includes("most") || s.includes("top"));
}

async function retrieveData(teamId: string, season: string, question: string) {
  const supabase = supabaseService();

  // Always keep this light and fast: only fetch what we need.
  // Notes/roster can be useful for broad questions or player membership.
  const cleaned = question.replace(/[^a-zA-Z0-9 ]/g, " ");

  const { data: rosterChunks } = await supabase
    .from("knowledge_chunks")
    .select("id,title,content,tags")
    .eq("team_id", teamId)
    .contains("tags", ["roster"])
    .limit(5);

  const { data: searchChunks } = await supabase
    .from("knowledge_chunks")
    .select("id,title,content,tags")
    .eq("team_id", teamId)
    .eq("season", season)
    .textSearch("tsv", cleaned, { type: "websearch" })
    .limit(6);

  // Match results (for record / opponents)
  const { data: matches, error: em } = await supabase
    .from("match_results")
    .select("match_date,tournament,opponent,result,score,round,sets_won,sets_lost,set_diff")
    .eq("team_id", teamId)
    .order("match_date", { ascending: true })
    .limit(600);
  if (em) throw em;

  // Player stats (for leaders / passer rating)
  const { data: statsRows, error: es } = await supabase
    .from("player_game_stats")
    .select("player_name,position,game_date,opponent,stats")
    .eq("team_id", teamId)
    .eq("season", season)
    .order("game_date", { ascending: false })
    .limit(2000);
  if (es) throw es;

  // Merge + dedupe notes
  const merged = new Map<number, any>();
  (rosterChunks ?? []).forEach((c: any) => merged.set(c.id, c));
  (searchChunks ?? []).forEach((c: any) => merged.set(c.id, c));
  const chunks = Array.from(merged.values());

  return {
    chunks,
    matches: (matches ?? []) as MatchRow[],
    statsRows: (statsRows ?? []) as StatRow[],
  };
}

function computeCoreFacts(matches: MatchRow[], statsRows: StatRow[]) {
  // Win/Loss
  let wins = 0;
  let losses = 0;

  // Opponent aggregates
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

  // Player totals + weighted SR
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

  // Best passer rating (weighted)
  let bestPasser = "";
  let bestPasserRating = -Infinity;
  let bestPasserAtt = 0;

  let teamSrAtt = 0;
  let teamSrSum = 0;

  for (const p of players) {
    const t = totals[p];
    if (t.srAttempts > 0) {
      const r = t.srWeightedSum / t.srAttempts;
      if (r > bestPasserRating) {
        bestPasserRating = r;
        bestPasser = p;
        bestPasserAtt = t.srAttempts;
      }
      teamSrAtt += t.srAttempts;
      teamSrSum += t.srWeightedSum;
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
    .slice(0, 8);

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
      ? { player: bestPasser, rating: bestPasserRating, attempts: bestPasserAtt, teamRating: teamSrRating, teamAttempts: teamSrAtt }
      : null,
    trouble,
    hasMatches: matches.length > 0,
    hasStats: players.length > 0,
  };
}

function buildNotesForLLM(chunks: any[]) {
  if (!chunks?.length) return "";
  const lines: string[] = [];
  for (const c of chunks) {
    const title = (c.title ?? "").toString().trim();
    const content = (c.content ?? "").toString().trim();
    if (!title && !content) continue;
    lines.push(`${title}\n${content}`);
  }
  return lines.slice(0, 6).join("\n\n");
}

/**
 * Build a small, question-specific facts payload.
 * This is the key change that removes “noise”.
 */
function buildFactsForQuestion(question: string, season: string, facts: ReturnType<typeof computeCoreFacts>) {
  const q = question.trim();

  const payload: any = {
    season,
    question: q,
  };

  // Always include minimal “availability flags”
  payload.dataAvailability = {
    hasMatchResults: facts.hasMatches,
    hasPlayerStats: facts.hasStats,
  };

  if (wantsPasserRating(q)) {
    payload.serveReceive = {
      scale: "0-3",
      bestPasser: facts.bestPasser
        ? { player: facts.bestPasser.player, rating: Number(facts.bestPasser.rating.toFixed(2)), attempts: facts.bestPasser.attempts }
        : null,
      teamWeightedRating: facts.bestPasser ? Number(facts.bestPasser.teamRating.toFixed(2)) : null,
      teamAttempts: facts.bestPasser ? facts.bestPasser.teamAttempts : null,
    };
    return payload;
  }

  if (wantsKillsLeader(q)) {
    payload.leaders = {
      kills: facts.leaders.kills ? { player: facts.leaders.kills.player, total: facts.leaders.kills.value } : null,
    };
    return payload;
  }

  if (wantsWinLoss(q)) {
    payload.winLoss = facts.hasMatches ? { wins: facts.wins, losses: facts.losses } : null;
    return payload;
  }

  if (wantsToughOpponents(q)) {
    payload.troubleOpponents = facts.trouble;
    return payload;
  }

  // Broad questions get a compact “season snapshot” (still not a giant dump)
  if (isBroadQuestion(q)) {
    payload.snapshot = {
      winLoss: facts.hasMatches ? { wins: facts.wins, losses: facts.losses } : null,
      leaders: {
        kills: facts.leaders.kills,
        digs: facts.leaders.digs,
        aces: facts.leaders.aces,
        serveErrors: facts.leaders.serveErrors,
      },
      serveReceive: facts.bestPasser
        ? {
            scale: "0-3",
            bestPasser: { player: facts.bestPasser.player, rating: Number(facts.bestPasser.rating.toFixed(2)), attempts: facts.bestPasser.attempts },
            teamWeightedRating: Number(facts.bestPasser.teamRating.toFixed(2)),
          }
        : null,
      troubleOpponents: facts.trouble.slice(0, 5),
    };
    return payload;
  }

  // Default: minimal info so the model answers directly without dumping stats
  payload.minimal = {
    winLoss: facts.hasMatches ? { wins: facts.wins, losses: facts.losses } : null,
  };
  return payload;
}

function safeExtractOutputText(json: any): string {
  // Responses API can return different shapes across models.
  // Try common safe paths.
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

  // Fallback for some variants
  if (!text && typeof json?.output_text === "string") text = json.output_text;
  if (!text && typeof json?.text === "string") text = json.text;

  return (text || "").trim();
}

async function callOpenAI(question: string, season: string, factsPayload: any, notes: string) {
  assertEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";

  const system = `
You are "Volleyball Guru" for the MVVC 14 Black boys volleyball team.

Goal: Answer the user’s question directly, with minimal noise.

Formatting rules:
1) Start with a short title line (plain text).
2) Then give the answer in 1–6 short lines max for narrow questions.
3) Use player names with subtle emphasis: **Name**.
4) Do not use hyphen dividers (no "-----") and do not dump unrelated stats.
5) Only include extra facts if they are necessary to interpret the answer.

Accuracy rules:
- Facts MUST come only from FACTS_JSON.
- If FACTS_JSON does not contain what’s needed, say: "Insufficient data in the current dataset." and then ONE line: what to upload/track.
- Coaching insight: If the question is broad, add a short “Coaching insight:” paragraph (2–5 lines). If the question is narrow, coaching insight is optional (1–2 lines max).
`;

  const user = {
    question,
    FACTS_JSON: factsPayload,
    TEAM_NOTES_OPTIONAL: notes ? notes : null,
  };

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
        { role: "user", content: [{ type: "input_text", text: JSON.stringify(user) }] },
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

function fallbackAnswer(question: string, season: string, facts: ReturnType<typeof computeCoreFacts>) {
  const q = question.trim();
  const lines: string[] = [];

  // Narrow Q fallbacks
  if (wantsPasserRating(q)) {
    lines.push("Best passer rating");
    if (!facts.bestPasser) {
      lines.push("Insufficient data in the current dataset.");
      lines.push("Upload/confirm serve-receive attempts + rating per player.");
      return lines.join("\n");
    }
    lines.push(`${fmtName(facts.bestPasser.player)} — ${facts.bestPasser.rating.toFixed(2)} (0–3) on ${facts.bestPasser.attempts} attempts`);
    return lines.join("\n");
  }

  if (wantsKillsLeader(q)) {
    lines.push("Team kills leader");
    if (!facts.leaders.kills) {
      lines.push("Insufficient data in the current dataset.");
      lines.push("Upload/confirm attack_kills per player.");
      return lines.join("\n");
    }
    lines.push(`${fmtName(facts.leaders.kills.player)} — ${facts.leaders.kills.value} kills`);
    return lines.join("\n");
  }

  if (wantsWinLoss(q)) {
    lines.push("Win/Loss record");
    if (!facts.hasMatches) {
      lines.push("Insufficient data in the current dataset.");
      lines.push("Upload/confirm match_results for the season.");
      return lines.join("\n");
    }
    lines.push(`${facts.wins}-${facts.losses}`);
    return lines.join("\n");
  }

  if (wantsToughOpponents(q)) {
    lines.push("Toughest opponents (based on losses)");
    if (!facts.hasMatches || facts.trouble.length === 0) {
      lines.push("Insufficient data in the current dataset.");
      lines.push("Upload/confirm match_results with opponent + result.");
      return lines.join("\n");
    }
    const top = facts.trouble.slice(0, 5);
    for (let i = 0; i < top.length; i++) {
      const t = top[i];
      lines.push(`${i + 1}) ${t.opponent} (losses ${t.losses}/${t.matches})`);
    }
    return lines.join("\n");
  }

  // Broad / default fallback
  lines.push("Answer");
  if (!facts.hasMatches && !facts.hasStats) {
    lines.push("Insufficient data in the current dataset.");
    lines.push("Upload match_results and player_game_stats for this season.");
    return lines.join("\n");
  }

  if (facts.hasMatches) lines.push(`Season record: ${facts.wins}-${facts.losses}`);
  if (facts.bestPasser) lines.push(`Best passer: ${fmtName(facts.bestPasser.player)} (${facts.bestPasser.rating.toFixed(2)} on ${facts.bestPasser.attempts} attempts)`);

  const k = facts.leaders.kills;
  if (k) lines.push(`Kills leader: ${fmtName(k.player)} (${k.value})`);

  lines.push("Coaching insight: Ask one angle (serve-receive, serving risk, sideout, defense) and I’ll give a tight plan.");
  return lines.join("\n");
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { question: string };
    const question = String(body.question ?? "").trim();
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    const teamId = TEAM_ID;
    const season = DEFAULT_SEASON;

    const { chunks, matches, statsRows } = await retrieveData(teamId, season, question);
    const facts = computeCoreFacts(matches, statsRows);

    const factsPayload = buildFactsForQuestion(question, season, facts);
    const notes = isBroadQuestion(question) ? buildNotesForLLM(chunks) : ""; // only include notes when broad

    let answer = "";
    try {
      answer = await callOpenAI(question, season, factsPayload, notes);
    } catch {
      answer = "";
    }

    if (!answer) {
      answer = fallbackAnswer(question, season, facts);
    }

    return NextResponse.json({ answer });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
