import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black
const DEFAULT_SEASON = "spring";

/**
 * NOTE:
 * This API route does three things:
 * 1) Detect what the user is asking (narrow vs broad, lineup vs strengths vs opponents, etc.)
 * 2) Pull only the minimum data needed from Supabase (for speed)
 * 3) Return a clean, readable answer. If OpenAI fails, we still answer via a local fallback.
 */

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
function wantsLineup(q: string) {
  const s = q.toLowerCase();
  return (
    s.includes("lineup") ||
    s.includes("starting six") ||
    s.includes("starting 6") ||
    s.includes("projected") ||
    s.includes("rotation") ||
    s.includes("spring lineup")
  );
}

function wantsStrengthWeakness(q: string) {
  const s = q.toLowerCase();
  return s.includes("strength") || s.includes("weakness");
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

function isBroadQuestion(q: string) {
  const s = q.toLowerCase();
  return (
    wantsLineup(q) ||
    wantsStrengthWeakness(q) ||
    s.includes("summarize") ||
    s.includes("season") ||
    s.includes("key moments") ||
    s.includes("improve") ||
    s.includes("regress") ||
    s.includes("plan") ||
    s.includes("strategy")
  );
}

function narrowIntent(q: string) {
  // Narrow = should answer quickly and ONLY what they asked
  return wantsPasserRating(q) || wantsKillsLeader(q) || wantsWinLoss(q) || wantsToughOpponents(q);
}

/** ---------- Data fetch (keep lean / snappy) ---------- */
async function fetchMatches(teamId: string) {
  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("match_results")
    .select("match_date,opponent,result,set_diff")
    .eq("team_id", teamId)
    .order("match_date", { ascending: true })
    .limit(3000);
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
    .limit(8000);
  if (error) throw error;
  return (data ?? []) as StatRow[];
}

/**
 * Optional notes (roster/injuries/etc.) for broad questions.
 * We keep this optional so the app still works even if knowledge_chunks is empty.
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

/** ---------- Aggregation (build useful “season data”) ---------- */
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

type Totals = {
  kills: number;
  digs: number;
  aces: number;
  serveErrors: number;
  srAtt: number;
  srSum: number;
  settingAssists: number;
  blocksTotal: number;
};

function computeSeasonTotals(statsRows: StatRow[]) {
  const totals: Record<string, Totals> = {};

  function ensure(p: string) {
    if (!totals[p]) {
      totals[p] = {
        kills: 0,
        digs: 0,
        aces: 0,
        serveErrors: 0,
        srAtt: 0,
        srSum: 0,
        settingAssists: 0,
        blocksTotal: 0,
      };
    }
    return totals[p];
  }

  for (const row of statsRows) {
    const player = cleanText(row.player_name);
    if (!player) continue;

    const s = parseStats(row.stats);
    const t = ensure(player);

    // Offense/defense
    t.kills += toNum(s.attack_kills);
    t.digs += toNum(s.digs_successful);

    // Serving
    t.aces += toNum(s.serve_aces);
    t.serveErrors += toNum(s.serve_errors);

    // Passing (weighted 0–3)
    const att = toNum(s.serve_receive_attempts);
    const rating = toNum(s.serve_receive_passing_rating);
    if (att > 0) {
      t.srAtt += att;
      t.srSum += rating * att;
    }

    // Setting
    t.settingAssists += toNum(s.setting_assists);

    // Blocking (some files may leave these blank; we still attempt)
    const solo = toNum(s.blocks_solo);
    const ast = toNum(s.blocks_assist);
    t.blocksTotal += solo + ast;
  }

  return totals;
}

function topN(totals: Record<string, Totals>, metric: keyof Totals, n: number) {
  const arr = Object.keys(totals).map((p) => ({ player: p, value: totals[p][metric] }));
  arr.sort((a, b) => b.value - a.value);
  return arr.filter((x) => x.value > 0).slice(0, n);
}

function bestPasserWeighted(totals: Record<string, Totals>, minAttempts = 25) {
  let best: null | { player: string; rating: number; attempts: number } = null;

  let teamAtt = 0;
  let teamSum = 0;

  for (const p of Object.keys(totals)) {
    const t = totals[p];
    if (t.srAtt <= 0) continue;

    teamAtt += t.srAtt;
    teamSum += t.srSum;

    if (t.srAtt < minAttempts) continue; // avoid tiny-sample noise
    const r = t.srSum / t.srAtt;
    if (!best || r > best.rating) best = { player: p, rating: r, attempts: t.srAtt };
  }

  const teamRating = teamAtt > 0 ? teamSum / teamAtt : 0;

  return {
    best: best ? { ...best, rating: Number(best.rating.toFixed(2)) } : null,
    teamWeighted: teamAtt > 0 ? Number(teamRating.toFixed(2)) : null,
    teamAttempts: teamAtt,
  };
}

/** ---------- Narrow answers (fast, no OpenAI, no noise) ---------- */
function answerNarrow(question: string, season: string, matches: MatchRow[] | null, stats: StatRow[] | null) {
  const q = question.trim();

  if (wantsPasserRating(q)) {
    const totals = computeSeasonTotals(stats ?? []);
    const sr = bestPasserWeighted(totals, 25);
    if (!sr.best) {
      return [
        "Best passer rating",
        "Insufficient data in the current dataset.",
        `Track/confirm serve_receive_attempts + serve_receive_passing_rating per player for season "${season}".`,
      ].join("\n");
    }
    return `Best passer rating\n${boldName(sr.best.player)} — ${sr.best.rating} on ${sr.best.attempts} attempts (0–3 scale).`;
  }

  if (wantsKillsLeader(q)) {
    const totals = computeSeasonTotals(stats ?? []);
    const k = topN(totals, "kills", 1)[0];
    if (!k) {
      return ["Kills leader", "Insufficient data in the current dataset.", `Track/confirm attack_kills per player for "${season}".`].join("\n");
    }
    return `Kills leader\n${boldName(k.player)} — ${k.value} kills.`;
  }

  if (wantsWinLoss(q)) {
    if (!matches || matches.length === 0) {
      return ["Win/loss record", "Insufficient data in the current dataset.", "Upload/confirm match_results for this team."].join("\n");
    }
    const { wins, losses } = computeWinLoss(matches);
    return `Win/loss record\n${wins}-${losses}`;
  }

  if (wantsToughOpponents(q)) {
    if (!matches || matches.length === 0) {
      return ["Toughest opponents", "Insufficient data in the current dataset.", "Upload/confirm match_results with opponent + result."].join("\n");
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

/** ---------- Broad fallbacks (always answer the question) ---------- */
function strengthsWeaknessesFallback(season: string, matches: MatchRow[], statsRows: StatRow[]) {
  const wl = computeWinLoss(matches);
  const trouble = computeToughOpponents(matches, 5);
  const totals = computeSeasonTotals(statsRows);
  const sr = bestPasserWeighted(totals, 25);

  const killTop = topN(totals, "kills", 1)[0];
  const digTop = topN(totals, "digs", 1)[0];
  const aceTop = topN(totals, "aces", 1)[0];
  const seTop = topN(totals, "serveErrors", 1)[0];

  if (matches.length === 0 && Object.keys(totals).length === 0) {
    return ["Strengths & weaknesses", "Insufficient data in the current dataset.", `Upload match_results + player_game_stats for season "${season}".`].join("\n");
  }

  const lines: string[] = [];
  lines.push("Strengths & weaknesses");
  if (matches.length) lines.push(`Season record: ${wl.wins}-${wl.losses}`);

  lines.push("");
  lines.push("Strengths");
  if (sr.best) lines.push(`Serve-receive anchor: ${boldName(sr.best.player)} (${sr.best.rating} on ${sr.best.attempts} attempts).`);
  if (killTop) lines.push(`Reliable scoring: ${boldName(killTop.player)} leads with ${killTop.value} kills.`);
  if (aceTop) lines.push(`Serve pressure: ${boldName(aceTop.player)} leads with ${aceTop.value} aces.`);
  if (digTop) lines.push(`Defensive stability: ${boldName(digTop.player)} leads with ${digTop.value} digs.`);

  lines.push("");
  lines.push("Weaknesses / risk areas");
  if (seTop) lines.push(`Serving volatility: ${boldName(seTop.player)} has the most serve errors (${seTop.value}).`);
  if (trouble.length) {
    lines.push("Repeat-problem opponents:");
    for (let i = 0; i < trouble.length; i++) {
      const t = trouble[i];
      lines.push(`${i + 1}) ${cleanText(t.opponent)} — losses ${t.losses}/${t.matches}`);
    }
    lines.push("Pattern to check: serve pressure + getting rotation-stuck in 1–2 rotations.");
  } else {
    lines.push("No repeat-loss opponents identified from match_results (or losses not labeled).");
  }

  lines.push("");
  lines.push("What to do next");
  if (sr.best) lines.push(`Build SR around ${boldName(sr.best.player)} (give him seam reps; simplify responsibilities for others).`);
  if (seTop) lines.push(`Reduce errors without killing aggression: set 2 target zones per match + “net miss is unacceptable” rule.`);
  if (trouble.length) lines.push("For top trouble opponent: pre-write a 3-point plan (serve targets, passing seams, rotation fix/sub plan).");

  return lines.join("\n");
}

function projectedLineupFallback(season: string, matches: MatchRow[], statsRows: StatRow[]) {
  const wl = computeWinLoss(matches);
  const totals = computeSeasonTotals(statsRows);
  const sr = bestPasserWeighted(totals, 25);

  const topKills = topN(totals, "kills", 4);
  const topDigs = topN(totals, "digs", 3);
  const topAces = topN(totals, "aces", 3);
  const topAssists = topN(totals, "settingAssists", 2);
  const topBlocks = topN(totals, "blocksTotal", 2);

  if (matches.length === 0 && Object.keys(totals).length === 0) {
    return [
      "Best projected spring lineup (season-data driven)",
      "Insufficient data in the current dataset.",
      `Upload match_results + player_game_stats for season "${season}".`,
    ].join("\n");
  }

  // Pick 6 unique players by priority:
  // 1) Primary setter candidate (setting assists)
  // 2) Libero/passing anchor (best SR)
  // 3) Top two scorers (kills)
  // 4) Next “impact” (aces / digs)
  // 5) Blocking presence (if tracked)
  const picked = new Set<string>();
  const add = (name?: string) => {
    const n = cleanText(name);
    if (!n) return;
    if (picked.size >= 6) return;
    picked.add(n);
  };

  add(topAssists[0]?.player);
  add(sr.best?.player);
  add(topKills[0]?.player);
  add(topKills[1]?.player);
  add(topAces[0]?.player);
  add(topBlocks[0]?.player);

  // Fill remaining slots from digs/kills/aces (in that order) until we have 6
  for (const x of [...topDigs, ...topKills, ...topAces]) add(x.player);

  const startingSix = Array.from(picked).slice(0, 6);

  // Helpful “role suggestions” based on what we can see in stats:
  const setter = topAssists[0]?.player ? boldName(topAssists[0].player) : "TBD";
  const libero = sr.best?.player ? boldName(sr.best.player) : "TBD";
  const oh1 = topKills[0]?.player ? boldName(topKills[0].player) : "TBD";
  const oh2 = topKills[1]?.player ? boldName(topKills[1].player) : "TBD";

  const lines: string[] = [];
  lines.push("Best projected spring lineup (season-data driven)");
  if (matches.length) lines.push(`Context: season record ${wl.wins}-${wl.losses}`);

  lines.push("");
  lines.push("Projected starting six");
  // No hyphen bullets; just clean lines
  lines.push(`Setter (most setting assists): ${setter}${topAssists[0] ? ` (${topAssists[0].value} assists)` : ""}`);
  lines.push(`Libero / passing anchor (best SR): ${libero}${sr.best ? ` (SR ${sr.best.rating} on ${sr.best.attempts})` : ""}`);
  lines.push(`Primary scorer: ${oh1}${topKills[0] ? ` (${topKills[0].value} kills)` : ""}`);
  lines.push(`Secondary scorer: ${oh2}${topKills[1] ? ` (${topKills[1].value} kills)` : ""}`);
  if (topAces[0]) lines.push(`Serve-pressure slot: ${boldName(topAces[0].player)} (${topAces[0].value} aces)`);
  if (topBlocks[0]) lines.push(`Net presence (blocks tracked): ${boldName(topBlocks[0].player)} (${topBlocks[0].value} total blocks)`);

  lines.push("");
  lines.push("Bench / flex recommendations");
  if (topKills[2]) lines.push(`Next hitter option: ${boldName(topKills[2].player)} (${topKills[2].value} kills)`);
  if (topDigs[0] && cleanText(topDigs[0].player) !== cleanText(sr.best?.player)) {
    lines.push(`Extra defense/DS: ${boldName(topDigs[0].player)} (${topDigs[0].value} digs)`);
  }
  if (topAssists[1]) lines.push(`Backup setter candidate: ${boldName(topAssists[1].player)} (${topAssists[1].value} assists)`);

  lines.push("");
  lines.push("Important note");
  lines.push(
    "This projection uses season totals (kills/digs/aces/SR/assists/blocks). To make it truly “coach-accurate,” we should add: player positions + rotation-by-rotation passing responsibilities + hitting efficiency."
  );

  return lines.join("\n");
}

/** ---------- Optional OpenAI (for richer narrative) ---------- */
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

Answer the user’s question directly with real insight.
No citations. No brackets. No dashed dividers. No hyphen bullets.
Use FACTS_JSON for factual claims.
Use **bold** for player names.
If a fact is missing, say: Insufficient data in the current dataset. Then say what to track.
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

    // 1) Fast path: narrow questions = answer locally with minimal/no noise
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

    // 2) Broad path: fetch what we need (parallel for speed)
    const [matches, statsRows, notes] = await Promise.all([
      fetchMatches(teamId),
      fetchStats(teamId, season),
      // Only fetch notes for broad Qs (keeps latency lower for narrow Qs)
      fetchNotes(teamId, season, question),
    ]);

    // 3) Always build the correct local fallback for THIS question
    let localFallback = "";
    if (wantsLineup(question)) localFallback = projectedLineupFallback(season, matches, statsRows);
    else if (wantsStrengthWeakness(question)) localFallback = strengthsWeaknessesFallback(season, matches, statsRows);
    else {
      // Safe default narrative if question is broad but not recognized
      localFallback = strengthsWeaknessesFallback(season, matches, statsRows);
    }

    // 4) Build compact facts JSON for OpenAI (optional enhancement)
    const wl = computeWinLoss(matches);
    const totals = computeSeasonTotals(statsRows);
    const sr = bestPasserWeighted(totals, 25);

    const factsJson = {
      season,
      record: matches.length ? { wins: wl.wins, losses: wl.losses } : null,
      leadersTopKills: topN(totals, "kills", 6),
      leadersTopDigs: topN(totals, "digs", 6),
      leadersTopAces: topN(totals, "aces", 6),
      leadersTopServeErrors: topN(totals, "serveErrors", 6),
      leadersTopSettingAssists: topN(totals, "settingAssists", 4),
      leadersTopBlocks: topN(totals, "blocksTotal", 4),
      serveReceive: sr.best ? { scale: "0-3", bestPasser: sr.best, teamWeighted: sr.teamWeighted, teamAttempts: sr.teamAttempts } : null,
      toughestOpponents: computeToughOpponents(matches, 6),
      availability: { hasMatches: matches.length > 0, hasStats: Object.keys(totals).length > 0 },
    };

    // 5) Try OpenAI for richer narrative; if it fails or returns empty, use local fallback
    try {
      const ai = await callOpenAI(question, factsJson, notes);
      if (ai) return NextResponse.json({ answer: ai });
      return NextResponse.json({ answer: localFallback });
    } catch {
      return NextResponse.json({ answer: localFallback });
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
