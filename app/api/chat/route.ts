import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black
const DEFAULT_SEASON = "spring";

/** ---------- Types (subset we read) ---------- */
type MatchRow = {
  match_date: string | null;
  opponent: string | null;
  result: string | null; // "W"/"L" or "Won"/"Lost"
  set_diff: number | null;
};

type StatRow = {
  player_name: string | null;
  stats: any; // jsonb (object or string)
};

/** ---------- Small helpers ---------- */
function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

function cleanText(s: any) {
  return String(s ?? "").trim().replace(/\s+/g, " ");
}

function boldName(name: string) {
  const n = cleanText(name);
  return n ? `**${n}**` : "";
}

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

function normalizeWL(result: string | null): "W" | "L" | null {
  if (!result) return null;
  const r = result.toLowerCase();
  if (r === "w" || r.includes("won") || r.includes("win")) return "W";
  if (r === "l" || r.includes("lost") || r.includes("loss")) return "L";
  return null;
}

/** ---------- Intent detection ---------- */
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

function narrowIntent(q: string) {
  return wantsPasserRating(q) || wantsKillsLeader(q) || wantsWinLoss(q) || wantsToughOpponents(q);
}

/** ---------- Data fetch (keep lean) ---------- */
async function fetchMatches(teamId: string) {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("match_results")
    .select("match_date,opponent,result,set_diff")
    .eq("team_id", teamId)
    .order("match_date", { ascending: true })
    .limit(2000);
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
    .limit(6000);
  if (error) throw error;
  return (data ?? []) as StatRow[];
}

/**
 * Notes are only used to enrich broad narrative questions.
 * Not required for the “strengths & weaknesses” answer to work.
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

  const [{ data: rosterChunks }, { data: searchChunks }] = await Promise.all([rosterReq, searchReq]);

  const byId: Record<string, any> = {};
  (rosterChunks ?? []).forEach((c: any) => (byId[String(c.id)] = c));
  (searchChunks ?? []).forEach((c: any) => (byId[String(c.id)] = c));

  return Object.values(byId)
    .slice(0, 6)
    .map((c: any) => {
      const t = cleanText(c.title ?? "");
      const x = cleanText(c.content ?? "");
      if (!t && !x) return "";
      return t && x ? `${t}\n${x}` : t || x;
    })
    .filter(Boolean)
    .join("\n\n");
}

/** ---------- Stats aggregation (more complete) ---------- */
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

function computeLeaders(statsRows: StatRow[]) {
  type Tot = { kills: number; digs: number; aces: number; serveErrors: number; srAtt: number; srSum: number };
  const totals: Record<string, Tot> = {};

  function ensure(p: string) {
    if (!totals[p]) totals[p] = { kills: 0, digs: 0, aces: 0, serveErrors: 0, srAtt: 0, srSum: 0 };
    return totals[p];
  }

  for (const row of statsRows) {
    const player = cleanText(row.player_name);
    if (!player) continue;

    const s = parseStats(row.stats);
    const t = ensure(player);

    // Common fields from your CSV->json
    t.kills += toNum(s.attack_kills);
    t.digs += toNum(s.digs_successful);
    t.aces += toNum(s.serve_aces);
    t.serveErrors += toNum(s.serve_errors);

    const att = toNum(s.serve_receive_attempts);
    const rating = toNum(s.serve_receive_passing_rating); // 0–3
    if (att > 0) {
      t.srAtt += att;
      t.srSum += rating * att;
    }
  }

  const players = Object.keys(totals);

  function leader(metric: keyof Tot) {
    let bestPlayer = "";
    let bestVal = -Infinity;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const v = totals[p][metric];
      if (v > bestVal) {
        bestVal = v;
        bestPlayer = p;
      }
    }
    if (!bestPlayer || bestVal <= 0) return null;
    return { player: bestPlayer, value: bestVal };
  }

  // Best passer (weighted)
  let bestPasser: null | { player: string; rating: number; attempts: number } = null;
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
    leaders: {
      kills: leader("kills"),
      digs: leader("digs"),
      aces: leader("aces"),
      serveErrors: leader("serveErrors"),
    },
    bestPasser: bestPasser ? { ...bestPasser, rating: Number(bestPasser.rating.toFixed(2)) } : null,
    teamSr: teamAtt > 0 ? Number(teamRating.toFixed(2)) : null,
    teamSrAttempts: teamAtt,
  };
}

/** ---------- Narrow answers (fast, no OpenAI) ---------- */
function answerNarrow(question: string, season: string, matches: MatchRow[] | null, stats: StatRow[] | null) {
  const q = question.trim();

  if (wantsPasserRating(q)) {
    const c = computeLeaders(stats ?? []);
    if (!c.bestPasser) {
      return `Best passer rating\nInsufficient data in the current dataset.\nUpload/confirm serve_receive_attempts and serve_receive_passing_rating per player for season "${season}".`;
    }
    return `Best passer rating\n${boldName(c.bestPasser.player)} — ${c.bestPasser.rating} on ${c.bestPasser.attempts} attempts (0–3 scale).`;
  }

  if (wantsKillsLeader(q)) {
    const c = computeLeaders(stats ?? []);
    if (!c.leaders.kills) {
      return `Kills leader\nInsufficient data in the current dataset.\nUpload/confirm attack_kills per player for season "${season}".`;
    }
    return `Kills leader\n${boldName(c.leaders.kills.player)} — ${c.leaders.kills.value} kills.`;
  }

  if (wantsWinLoss(q)) {
    if (!matches || matches.length === 0) {
      return `Win/loss record\nInsufficient data in the current dataset.\nUpload/confirm match_results for this team.`;
    }
    const { wins, losses } = computeWinLoss(matches);
    return `Win/loss record\n${wins}-${losses}`;
  }

  if (wantsToughOpponents(q)) {
    if (!matches || matches.length === 0) {
      return `Toughest opponents\nInsufficient data in the current dataset.\nUpload/confirm match_results with opponent and result.`;
    }
    const trouble = computeToughOpponents(matches, 5);
    if (trouble.length === 0) return `Toughest opponents\nNo losses found (or results are not labeled W/L).`;

    const lines: string[] = [];
    lines.push("Toughest opponents (based on losses)");
    for (let i = 0; i < trouble.length; i++) {
      const t = trouble[i];
      lines.push(`${i + 1}) ${cleanText(t.opponent)} — losses ${t.losses}/${t.matches}`);
    }
    return lines.join("\n");
  }

  return null;
}

/** ---------- Broad: deterministic strengths/weakness narrative (no OpenAI needed) ---------- */
function strengthsWeaknessesFallback(season: string, matches: MatchRow[], statsRows: StatRow[]) {
  const wl = computeWinLoss(matches);
  const trouble = computeToughOpponents(matches, 5);
  const c = computeLeaders(statsRows);

  // If nothing exists, say so clearly
  if (matches.length === 0 && !c.hasStats) {
    return [
      "Strengths & weaknesses",
      "Insufficient data in the current dataset.",
      `Upload match_results and player_game_stats for season "${season}".`,
    ].join("\n");
  }

  const lines: string[] = [];
  lines.push("Strengths & weaknesses");

  // Facts we can safely state
  if (matches.length) lines.push(`Season record: ${wl.wins}-${wl.losses}`);

  // Strengths (inferred from facts but still grounded)
  lines.push("");
  lines.push("Strengths");
  if (wl.wins || wl.losses) {
    lines.push(
      `1) Winning foundation: a ${wl.wins}-${wl.losses} record suggests you’re consistently doing the basics (serving in, passing well enough, and converting swings).`
    );
  }
  if (c.bestPasser) {
    lines.push(
      `2) Serve-receive anchor: ${boldName(c.bestPasser.player)} leads SR at ${c.bestPasser.rating} on ${c.bestPasser.attempts} attempts (0–3 scale).`
    );
  }
  if (c.leaders.kills) {
    lines.push(`3) Reliable scoring: ${boldName(c.leaders.kills.player)} leads with ${c.leaders.kills.value} kills.`);
  }
  if (c.leaders.aces) {
    lines.push(`4) Point pressure from the line: ${boldName(c.leaders.aces.player)} leads with ${c.leaders.aces.value} aces.`);
  }
  if (c.leaders.digs) {
    lines.push(`5) Defensive stability: ${boldName(c.leaders.digs.player)} leads with ${c.leaders.digs.value} digs.`);
  }

  // Weaknesses (also grounded)
  lines.push("");
  lines.push("Weaknesses / risk areas");
  if (c.leaders.serveErrors) {
    lines.push(
      `1) Serving volatility: ${boldName(c.leaders.serveErrors.player)} has the most serve errors (${c.leaders.serveErrors.value}). That usually points to risk/reward swings in close sets.`
    );
  } else {
    lines.push("1) Serving volatility: serve error totals aren’t available in the loaded stats, so I can’t pinpoint who is driving miss-rate.");
  }

  if (trouble.length) {
    lines.push("2) Repeat-problem opponents:");
    for (let i = 0; i < trouble.length; i++) {
      const t = trouble[i];
      lines.push(`   ${i + 1}. ${cleanText(t.opponent)} — losses ${t.losses}/${t.matches}`);
    }
    lines.push("   This usually means either (a) their serve pressure breaks your system or (b) you get rotation-stuck in 1–2 spots.");
  } else {
    lines.push("2) Repeat-problem opponents: none identified from match_results (or losses not labeled).");
  }

  // Practical next steps (coaching insight)
  lines.push("");
  lines.push("What to do next (coach-useful)");
  if (c.bestPasser) {
    lines.push(
      `1) Build your primary serve-receive shape around ${boldName(c.bestPasser.player)} (give him the seam reps and let others pass “clean zones”).`
    );
  } else {
    lines.push("1) If passing is a focus, make sure SR attempts + SR rating are recorded for all passers.");
  }
  if (c.leaders.serveErrors) {
    lines.push(
      `2) For your top serve-error player(s), set a simple rule: “miss long is OK, miss into net is not” + use 2 target zones per match instead of 5.`
    );
  } else {
    lines.push("2) Track serve errors per player so we can decide who should be aggressive vs. who should be in-play focused.");
  }
  if (trouble.length) {
    lines.push("3) For the top 1–2 trouble opponents, write a 3-point plan:");
    lines.push("   a) Serve targets (who/where).");
    lines.push("   b) Passing seam responsibilities (who owns middle seam).");
    lines.push("   c) Rotation fixes (which rotation bled points and what sub/serve-target changes fix it).");
  }

  return lines.join("\n");
}

/** ---------- OpenAI (optional for broad; fallback already answers) ---------- */
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

async function callOpenAI(question: string, factsJson: any, notes: string) {
  assertEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";

  const system = `
You are "Volleyball Guru" for MVVC 14 Black.

Answer directly and coach-friendly with real insight.
No citations. No brackets. No dashed dividers. No hyphen bullets.

Use FACTS_JSON for factual claims.
If a fact is missing, say: Insufficient data in the current dataset. Then say what to track.
Use **bold** for player names.
Keep broad answers ~10–18 lines, with clean spacing.
`;

  const payload = { question, FACTS_JSON: factsJson, TEAM_NOTES_OPTIONAL: notes || null };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_output_tokens: 650,
      input: [
        { role: "system", content: [{ type: "input_text", text: system }] },
        { role: "user", content: [{ type: "input_text", text: JSON.stringify(payload) }] },
      ],
    }),
  });

  if (!res.ok) throw new Error(await res.text());
  return safeExtractText(await res.json());
}

/** ---------- Route handler ---------- */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { question: string };
    const question = cleanText(body.question ?? "");
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    const teamId = TEAM_ID;
    const season = DEFAULT_SEASON;

    // Fast path: narrow questions avoid OpenAI
    if (narrowIntent(question)) {
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

    // Broad path: fetch what we need (parallel)
    const [matches, statsRows, notes] = await Promise.all([
      fetchMatches(teamId),
      fetchStats(teamId, season),
      fetchNotes(teamId, season, question),
    ]);

    // Always compute a strong local answer so broad questions never “fail”
    const localNarrative =
      question.toLowerCase().includes("strength") || question.toLowerCase().includes("weakness")
        ? strengthsWeaknessesFallback(season, matches, statsRows)
        : strengthsWeaknessesFallback(season, matches, statsRows); // safe default narrative

    // Build compact facts JSON for OpenAI (optional enhancer)
    const wl = computeWinLoss(matches);
    const trouble = computeToughOpponents(matches, 6);
    const c = computeLeaders(statsRows);

    const factsJson = {
      season,
      record: matches.length ? { wins: wl.wins, losses: wl.losses } : null,
      leaders: {
        kills: c.leaders.kills,
        digs: c.leaders.digs,
        aces: c.leaders.aces,
        serveErrors: c.leaders.serveErrors,
      },
      serveReceive: c.bestPasser
        ? { scale: "0-3", bestPasser: c.bestPasser, teamWeightedRating: c.teamSr, teamAttempts: c.teamSrAttempts }
        : null,
      toughestOpponents: trouble,
      availability: { hasMatches: matches.length > 0, hasStats: c.hasStats },
    };

    // Try OpenAI to refine narrative; if it fails, return the local narrative (which already answers)
    try {
      const ai = await callOpenAI(question, factsJson, notes);
      if (ai) return NextResponse.json({ answer: ai });
      return NextResponse.json({ answer: localNarrative });
    } catch {
      return NextResponse.json({ answer: localNarrative });
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
