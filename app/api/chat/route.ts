import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

/**
 * Team + season defaults for your service.
 * You can later make these dynamic by passing from the UI.
 */
const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black
const DEFAULT_SEASON = "spring";

/**
 * Basic Supabase row types (subset of columns we read)
 */
type MatchRow = {
  match_date: string | null;
  opponent: string | null;
  result: string | null; // "W"/"L" or "Won"/"Lost"
  set_diff: number | null;
};

type StatRow = {
  player_name: string | null;
  stats: any; // jsonb from supabase (object or string)
};

/**
 * ---------
 * Utilities
 * ---------
 */

/** Ensure env exists (used only when we call OpenAI) */
function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

/** Convert unknown value to a safe number */
function toNum(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).trim();
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** Parse stats json that might arrive as object OR as a JSON string */
function parseStats(stats: any): Record<string, any> {
  if (!stats) return {};
  if (typeof stats === "object") return stats;
  try {
    return JSON.parse(stats);
  } catch {
    return {};
  }
}

/** Normalize W/L strings into "W" or "L" */
function normalizeWL(result: string | null): "W" | "L" | null {
  if (!result) return null;
  const r = result.toLowerCase();
  if (r === "w" || r.includes("won") || r.includes("win")) return "W";
  if (r === "l" || r.includes("lost") || r.includes("loss")) return "L";
  return null;
}

/** Clean spacing in names/team strings */
function cleanText(s: string) {
  return String(s || "").trim().replace(/\s+/g, " ");
}

/** Subtle highlight for player names (markdown bold) */
function boldName(name: string) {
  const n = cleanText(name);
  return n ? `**${n}**` : "";
}

/**
 * ------------------------
 * Question intent detection
 * ------------------------
 * We use this to:
 * - minimize Supabase reads (only fetch what we need)
 * - skip OpenAI for narrow questions (fastest path)
 */

function isBroadQuestion(q: string) {
  const s = q.toLowerCase();
  return (
    s.includes("summarize") ||
    s.includes("season") ||
    s.includes("key moments") ||
    s.includes("strength") ||
    s.includes("weakness") ||
    s.includes("improve") ||
    s.includes("regress") ||
    s.includes("plan") ||
    s.includes("lineup") ||
    s.includes("starting") ||
    s.includes("rotation") ||
    s.includes("strategy")
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

function wantsWinLoss(q: string) {
  const s = q.toLowerCase();
  return s.includes("record") || (s.includes("win") && s.includes("loss"));
}

function wantsToughOpponents(q: string) {
  const s = q.toLowerCase();
  return (
    s.includes("tough") ||
    s.includes("trouble") ||
    s.includes("hardest") ||
    s.includes("which opponents") ||
    s.includes("worst opponent")
  );
}

/**
 * ------------------------
 * Data fetching (optimized)
 * ------------------------
 * The #1 latency killer is fetching huge datasets.
 * So we fetch only what we need based on the question.
 */
async function fetchMatches(teamId: string) {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("match_results")
    .select("match_date,opponent,result,set_diff")
    .eq("team_id", teamId)
    .order("match_date", { ascending: true })
    .limit(1200);
  if (error) throw error;
  return (data ?? []) as MatchRow[];
}

async function fetchStats(teamId: string, season: string) {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("player_game_stats")
    .select("player_name,stats")
    .eq("team_id", teamId)
    .eq("season", season)
    .order("game_date", { ascending: false })
    .limit(4000);
  if (error) throw error;
  return (data ?? []) as StatRow[];
}

/**
 * Notes are only needed for broad / narrative questions.
 * We keep this optional to reduce query overhead for narrow questions.
 */
async function fetchNotes(teamId: string, season: string, question: string) {
  const supabase = supabaseService();
  const cleaned = question.replace(/[^a-zA-Z0-9 ]/g, " ");

  const rosterReq = supabase
    .from("knowledge_chunks")
    .select("id,title,content,tags")
    .eq("team_id", teamId)
    .contains("tags", ["roster"])
    .limit(5);

  const searchReq = supabase
    .from("knowledge_chunks")
    .select("id,title,content,tags")
    .eq("team_id", teamId)
    .eq("season", season)
    .textSearch("tsv", cleaned, { type: "websearch" })
    .limit(6);

  // Parallelize these requests for speed
  const [{ data: rosterChunks }, { data: searchChunks }] = await Promise.all([rosterReq, searchReq]);

  // Dedupe by id (avoid repeats)
  const byId: Record<string, any> = {};
  (rosterChunks ?? []).forEach((c: any) => (byId[String(c.id)] = c));
  (searchChunks ?? []).forEach((c: any) => (byId[String(c.id)] = c));

  const chunks = Object.values(byId);

  return chunks
    .slice(0, 6)
    .map((c: any) => {
      const t = cleanText(c.title ?? "");
      const x = cleanText(c.content ?? "");
      if (!t && !x) return "";
      if (t && x) return `${t}\n${x}`;
      return t || x;
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * -------------------------
 * Fast fact computations
 * -------------------------
 * These run in memory and are very fast compared to network calls.
 */

function computeWinLoss(matches: MatchRow[]) {
  let wins = 0;
  let losses = 0;
  for (const m of matches) {
    const wl = normalizeWL(m.result);
    if (wl === "W") wins++;
    if (wl === "L") losses++;
  }
  return { wins, losses };
}

/**
 * “Toughest opponents” = opponents you lost to most often
 * tie-breaker = lower (worse) cumulative set_diff.
 */
function computeToughOpponents(matches: MatchRow[], limit = 5) {
  const oppMatches: Record<string, number> = {};
  const oppLosses: Record<string, number> = {};
  const oppSetDiff: Record<string, number> = {};

  for (const m of matches) {
    const opp = cleanText(m.opponent || "Unknown Opponent");
    oppMatches[opp] = (oppMatches[opp] ?? 0) + 1;

    const wl = normalizeWL(m.result);
    if (wl === "L") oppLosses[opp] = (oppLosses[opp] ?? 0) + 1;

    oppSetDiff[opp] = (oppSetDiff[opp] ?? 0) + toNum(m.set_diff);
  }

  return Object.keys(oppMatches)
    .map((opp) => ({
      opponent: opp,
      losses: oppLosses[opp] ?? 0,
      matches: oppMatches[opp] ?? 0,
      setDiff: oppSetDiff[opp] ?? 0,
    }))
    .filter((x) => x.losses > 0)
    .sort((a, b) => (b.losses !== a.losses ? b.losses - a.losses : a.setDiff - b.setDiff))
    .slice(0, limit);
}

/**
 * Compute:
 * - kills leader
 * - passer rating leader (weighted SR rating: sum(rating*attempts) / sum(attempts))
 */
function computeLeadersAndPassing(statsRows: StatRow[]) {
  type Tot = { kills: number; srAtt: number; srSum: number };
  const totals: Record<string, Tot> = {};

  function ensure(player: string) {
    if (!totals[player]) totals[player] = { kills: 0, srAtt: 0, srSum: 0 };
    return totals[player];
  }

  for (const row of statsRows) {
    const player = cleanText(row.player_name ?? "");
    if (!player) continue;
    const s = parseStats(row.stats);
    const t = ensure(player);

    // Kills
    t.kills += toNum(s.attack_kills);

    // Serve-receive weighted rating (0–3 scale)
    const att = toNum(s.serve_receive_attempts);
    const rating = toNum(s.serve_receive_passing_rating);
    if (att > 0) {
      t.srAtt += att;
      t.srSum += rating * att;
    }
  }

  const players = Object.keys(totals);

  // Kills leader
  let killsLeader = null as null | { player: string; kills: number };
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const k = totals[p].kills;
    if (!killsLeader || k > killsLeader.kills) killsLeader = { player: p, kills: k };
  }

  // Best passer (weighted)
  let bestPasser = null as null | { player: string; rating: number; attempts: number };
  let teamAtt = 0;
  let teamSum = 0;

  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const t = totals[p];
    if (t.srAtt <= 0) continue;

    const r = t.srSum / t.srAtt;
    if (!bestPasser || r > bestPasser.rating) bestPasser = { player: p, rating: r, attempts: t.srAtt };

    teamAtt += t.srAtt;
    teamSum += t.srSum;
  }

  const teamRating = teamAtt > 0 ? teamSum / teamAtt : 0;

  return {
    hasStats: players.length > 0,
    killsLeader: killsLeader && killsLeader.kills > 0 ? killsLeader : null,
    bestPasser: bestPasser ? { ...bestPasser, rating: Number(bestPasser.rating.toFixed(2)) } : null,
    teamSr: teamAtt > 0 ? Number(teamRating.toFixed(2)) : null,
  };
}

/**
 * -------------------------------
 * Super-fast answers (no OpenAI)
 * -------------------------------
 * This eliminates OpenAI latency for common narrow questions.
 */
function answerNarrow(question: string, season: string, matches: MatchRow[] | null, statsRows: StatRow[] | null) {
  const q = question.trim();

  // Best passer rating
  if (wantsPasserRating(q)) {
    const computed = computeLeadersAndPassing(statsRows ?? []);
    if (!computed.bestPasser) {
      return `Best passer rating\nInsufficient data in the current dataset.\nUpload/confirm serve_receive_attempts and serve_receive_passing_rating per player for season "${season}".`;
    }
    return `Best passer rating\n${boldName(computed.bestPasser.player)} has the top serve-receive rating: ${computed.bestPasser.rating} on ${computed.bestPasser.attempts} attempts (0–3 scale).`;
  }

  // Kills leader
  if (wantsKillsLeader(q)) {
    const computed = computeLeadersAndPassing(statsRows ?? []);
    if (!computed.killsLeader) {
      return `Kills leader\nInsufficient data in the current dataset.\nUpload/confirm attack_kills per player for season "${season}".`;
    }
    return `Kills leader\n${boldName(computed.killsLeader.player)} leads the team with ${computed.killsLeader.kills} kills.`;
  }

  // Win/Loss record
  if (wantsWinLoss(q)) {
    if (!matches || matches.length === 0) {
      return `Win/loss record\nInsufficient data in the current dataset.\nUpload/confirm match_results for this team.`;
    }
    const { wins, losses } = computeWinLoss(matches);
    return `Win/loss record\n${wins}-${losses}`;
  }

  // Tough opponents
  if (wantsToughOpponents(q)) {
    if (!matches || matches.length === 0) {
      return `Toughest opponents\nInsufficient data in the current dataset.\nUpload/confirm match_results with opponent and result.`;
    }
    const trouble = computeToughOpponents(matches, 5);
    if (trouble.length === 0) {
      return `Toughest opponents\nNo losses found in match_results for this team (or results are not labeled W/L).`;
    }

    const lines: string[] = [];
    lines.push("Toughest opponents (based on losses)");
    for (let i = 0; i < trouble.length; i++) {
      const t = trouble[i];
      lines.push(`${i + 1}) ${cleanText(t.opponent)} losses ${t.losses}/${t.matches}`);
    }
    return lines.join("\n");
  }

  // Not narrow
  return null;
}

/**
 * --------------------------
 * OpenAI (broad questions)
 * --------------------------
 * We only call OpenAI when we want narrative + coaching insight.
 */

function safeExtractText(json: any): string {
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

async function callOpenAI(question: string, facts: any, notes: string) {
  assertEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";

  /**
   * Important: keep the prompt small and structured.
   * Smaller prompts = faster model time + less chance of “noise”.
   */
  const system = `
You are "Volleyball Guru" for MVVC 14 Black.

Goal
Answer like ChatGPT: helpful, coach-friendly, and not overly long.

Hard rules
Use FACTS_JSON for all factual claims.
If facts are missing, say: Insufficient data in the current dataset. Then say exactly what to upload/track.
Use **bold** for player names.
No citations. No brackets. No dashed dividers. No hyphen bullets.

Output shape
Start with a short title.
Then write a clear narrative:
If the question is broad, 10–18 lines total.
Use short paragraphs and occasional short lists with numbers or dots if needed (but no hyphen bullets).
`;

  const payload = {
    question,
    FACTS_JSON: facts,
    TEAM_NOTES_OPTIONAL: notes || null,
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      // Keep output modest for speed. Broad answers should still fit.
      max_output_tokens: 650,
      input: [
        { role: "system", content: [{ type: "input_text", text: system }] },
        { role: "user", content: [{ type: "input_text", text: JSON.stringify(payload) }] },
      ],
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }

  return safeExtractText(await res.json());
}

/**
 * Build a compact facts packet for broad questions.
 * This prevents the model from dumping unrelated stats,
 * but still gives enough to write a real narrative.
 */
function buildBroadFacts(season: string, matches: MatchRow[], statsRows: StatRow[]) {
  const { wins, losses } = computeWinLoss(matches);
  const trouble = computeToughOpponents(matches, 6);
  const computed = computeLeadersAndPassing(statsRows);

  return {
    season,
    record: matches.length ? { wins, losses } : null,
    bestPasser: computed.bestPasser
      ? { player: computed.bestPasser.player, rating: computed.bestPasser.rating, attempts: computed.bestPasser.attempts, scale: "0-3" }
      : null,
    teamServeReceive: computed.teamSr !== null ? { teamWeightedRating: computed.teamSr, scale: "0-3" } : null,
    killsLeader: computed.killsLeader ? { player: computed.killsLeader.player, kills: computed.killsLeader.kills } : null,
    toughestOpponents: trouble,
    availability: { hasMatches: matches.length > 0, hasStats: computed.hasStats },
  };
}

/**
 * --------------------------
 * Main route handler (POST)
 * --------------------------
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { question: string };
    const question = cleanText(body.question ?? "");
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    const teamId = TEAM_ID;
    const season = DEFAULT_SEASON;

    /**
     * Decide whether to treat it as "narrow".
     * If narrow, we can skip OpenAI entirely (fastest possible).
     */
    const narrowIntent =
      wantsPasserRating(question) || wantsKillsLeader(question) || wantsWinLoss(question) || wantsToughOpponents(question);

    if (narrowIntent) {
      /**
       * For narrow questions, fetch only the table we need.
       * This saves network time and reduces Supabase latency.
       */
      if (wantsWinLoss(question) || wantsToughOpponents(question)) {
        const matches = await fetchMatches(teamId);
        const ans = answerNarrow(question, season, matches, null);
        return NextResponse.json({ answer: ans ?? "Insufficient data in the current dataset." });
      } else {
        const stats = await fetchStats(teamId, season);
        const ans = answerNarrow(question, season, null, stats);
        return NextResponse.json({ answer: ans ?? "Insufficient data in the current dataset." });
      }
    }

    /**
     * Broad questions:
     * We need both matches + stats (for meaningful narrative),
     * and optionally notes (roster/injuries/constraints) to improve the coaching insight.
     *
     * Use Promise.all to run in parallel (faster).
     */
    const [matches, statsRows, notes] = await Promise.all([
      fetchMatches(teamId),
      fetchStats(teamId, season),
      fetchNotes(teamId, season, question),
    ]);

    const facts = buildBroadFacts(season, matches, statsRows);

    // Call OpenAI only here
    let answer = "";
    try {
      answer = await callOpenAI(question, facts, notes);
    } catch {
      answer = "";
    }

    /**
     * Safety fallback: never return “No answer generated”
     */
    if (!answer) {
      const lines: string[] = [];
      lines.push("Answer");
      if (!facts.availability.hasMatches && !facts.availability.hasStats) {
        lines.push("Insufficient data in the current dataset.");
        lines.push("Upload match_results and player_game_stats for this season.");
      } else {
        if (facts.record) lines.push(`Season record: ${facts.record.wins}-${facts.record.losses}`);
        if (facts.bestPasser) lines.push(`Best passer: ${boldName(facts.bestPasser.player)} (${facts.bestPasser.rating} on ${facts.bestPasser.attempts} attempts)`);
        if (facts.killsLeader) lines.push(`Kills leader: ${boldName(facts.killsLeader.player)} (${facts.killsLeader.kills})`);
        lines.push("Ask: strengths/weaknesses, best lineup, or toughest opponents, and I’ll give a tighter plan.");
      }
      answer = lines.join("\n");
    }

    return NextResponse.json({ answer });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
