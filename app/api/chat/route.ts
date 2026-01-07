import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

/**
 * MVVC Coach Copilot - Chat API (2025–26)
 * Goal:
 * - Answer like ChatGPT: directly answer the question asked.
 * - Broad questions => narrative.
 * - Narrow questions => short, minimal noise.
 * - Facts MUST come only from Supabase-derived FACTS_JSON.
 */

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black
const SEASON_START = "2025-08-01";
const SEASON_END_EXCLUSIVE = "2026-08-01";
const PERSONA = "Volleyball Guru";

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

function monthKey(isoDate: string) {
  return isoDate.slice(0, 7);
}

function fmtName(name: string) {
  return `**${name}**`;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightAllPlayerNames(answer: string, playerNames: string[]) {
  if (!answer) return answer;
  const names = Array.from(new Set((playerNames || []).map((n) => (n || "").trim()).filter(Boolean))).sort(
    (a, b) => b.length - a.length
  );

  let out = answer;
  for (const name of names) {
    const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, "g");
    out = out.replace(re, `**${name}**`);
  }
  return out;
}

/** ---------------------- Intent detection ---------------------- **/

function s(q: string) {
  return (q || "").toLowerCase().trim();
}

function isPromptsQuestion(q: string) {
  const t = s(q);
  return t.includes("suggested prompt") || t.includes("suggest prompts") || t.includes("example prompt");
}

function isLineupQuestion(q: string) {
  const t = s(q);
  return (
    t.includes("6-2") ||
    t.includes("6 2") ||
    t.includes("lineup") ||
    t.includes("starting six") ||
    t.includes("starting 6") ||
    t.includes("rotation") ||
    t.includes("projected") ||
    t.includes("who should start")
  );
}

function isDefinitionQuestion(q: string) {
  const t = s(q);
  return (
    t.startsWith("what is ") ||
    t.startsWith("what’s ") ||
    t.startsWith("whats ") ||
    t.startsWith("define ") ||
    t.includes("what is a 6-2") ||
    t.includes("what is 6-2") ||
    t.includes("what is a 6 2")
  );
}

function isRosterQuestion(q: string) {
  const t = s(q);
  return t.includes("roster") || t.includes("who plays which") || t.includes("positions");
}

function isMonthByMonthQuestion(q: string) {
  const t = s(q);
  return t.includes("month") || t.includes("month over month") || t.includes("mom") || t.includes("trend");
}

function isPassingQuestion(q: string) {
  const t = s(q);
  return t.includes("pass") || t.includes("serve receive") || t.includes("serve-receive") || t.includes("sr");
}

function isLeadersQuestion(q: string) {
  const t = s(q);
  return t.includes("leaders") || t.includes("top 5") || t.includes("top five") || t.includes("top 3") || t.includes("top three");
}

function isBroadQuestion(q: string) {
  const t = s(q);
  const broadSignals = [
    "recap",
    "summarize",
    "season",
    "so far",
    "strength",
    "weakness",
    "improve",
    "improvement",
    "recommend",
    "development",
    "tactics",
    "game plan",
    "beat",
    "how do we",
    "position battle",
    "optimal position",
    "switch position",
    "move to",
    "gaps",
    "add players",
    "recruit",
    "what type of players",
    "who should we add",
  ];
  return broadSignals.some((k) => t.includes(k)) || isLineupQuestion(q) || isMonthByMonthQuestion(q) || isLeadersQuestion(q);
}

function inferStatKeyFromQuestion(q: string): string {
  const t = s(q);
  const map: Array<{ includes: string[]; key: string }> = [
    { includes: ["kill", "kills"], key: "attack_kills" },
    { includes: ["dig", "digs"], key: "digs_successful" },
    { includes: ["ace", "aces"], key: "serve_aces" },
    { includes: ["serve error", "serve errors"], key: "serve_errors" },
    { includes: ["assist", "assists", "setting assists"], key: "setting_assists" },
    { includes: ["setting error", "setting errors"], key: "setting_errors" },
    { includes: ["block", "blocks", "solo block", "solo blocks"], key: "blocks_solo" },
    { includes: ["block assist", "block assists"], key: "blocks_assist" },
    { includes: ["attack error", "attack errors"], key: "attack_errors" },
    { includes: ["attack attempts", "attempts"], key: "attack_attempts" },
  ];
  for (const m of map) {
    if (m.includes.some((w) => t.includes(w))) return m.key;
  }
  return "";
}

/** ---------------------- Fetching (parallel) ---------------------- **/

async function retrieveData(teamId: string, question: string) {
  const supabase = supabaseService();
  const broad = isBroadQuestion(question) || isRosterQuestion(question);

  const cleaned = question.replace(/[^a-zA-Z0-9 ]/g, " ");

  const rosterPromise = broad
    ? supabase
        .from("knowledge_chunks")
        .select("id,title,content,tags")
        .eq("team_id", teamId)
        .contains("tags", ["roster"])
        .limit(10)
    : Promise.resolve({ data: [] as any[], error: null as any });

  const notesPromise = broad
    ? supabase
        .from("knowledge_chunks")
        .select("id,title,content,tags")
        .eq("team_id", teamId)
        .textSearch("tsv", cleaned, { type: "websearch" })
        .limit(10)
    : Promise.resolve({ data: [] as any[], error: null as any });

  const matchesPromise = supabase
    .from("match_results")
    .select("match_date,tournament,opponent,result,score,round,sets_won,sets_lost,set_diff")
    .eq("team_id", teamId)
    .gte("match_date", SEASON_START)
    .lt("match_date", SEASON_END_EXCLUSIVE)
    .order("match_date", { ascending: true })
    .limit(3000);

  const statsPromise = supabase
    .from("player_game_stats")
    .select("player_name,position,game_date,opponent,stats")
    .eq("team_id", teamId)
    .gte("game_date", SEASON_START)
    .lt("game_date", SEASON_END_EXCLUSIVE)
    .order("game_date", { ascending: false })
    .limit(8000);

  const [rosterRes, notesRes, matchesRes, statsRes] = await Promise.all([rosterPromise, notesPromise, matchesPromise, statsPromise]);

  if (rosterRes.error) throw rosterRes.error;
  if (notesRes.error) throw notesRes.error;
  if (matchesRes.error) throw matchesRes.error;
  if (statsRes.error) throw statsRes.error;

  const merged = new Map<number, any>();
  (rosterRes.data ?? []).forEach((c: any) => merged.set(c.id, c));
  (notesRes.data ?? []).forEach((c: any) => merged.set(c.id, c));
  const chunks = Array.from(merged.values());

  return {
    chunks,
    matches: (matchesRes.data ?? []) as MatchRow[],
    statsRows: (statsRes.data ?? []) as StatRow[],
  };
}

/** ---------------------- Aggregations ---------------------- **/

function computeAggregates(matches: MatchRow[], statsRows: StatRow[]) {
  let wins = 0;
  let losses = 0;

  const oppLosses: Record<string, number> = {};
  const oppMatches: Record<string, number> = {};
  const oppSetDiff: Record<string, number> = {};

  for (const m of matches) {
    const wl = normalizeWinLoss(m.result);
    const opp = (m.opponent ?? "").trim() || "Unknown Opponent";

    oppMatches[opp] = (oppMatches[opp] ?? 0) + 1;
    oppSetDiff[opp] = (oppSetDiff[opp] ?? 0) + toNum(m.set_diff);

    if (wl === "W") wins++;
    if (wl === "L") {
      losses++;
      oppLosses[opp] = (oppLosses[opp] ?? 0) + 1;
    }
  }

  type PlayerAgg = {
    position: string | null;
    totals: Record<string, number>;
    srAttempts: number;
    srWeightedSum: number;
  };

  const byPlayer: Record<string, PlayerAgg> = {};
  const teamByMonth: Record<string, Record<string, number>> = {};
  const srByMonth: Record<string, { attempts: number; weightedSum: number }> = {};
  const passerByMonth: Record<string, Record<string, { attempts: number; weightedSum: number }>> = {};

  for (const row of statsRows) {
    const player = (row.player_name ?? "").trim();
    if (!player) continue;

    const stats = parseStats(row.stats);
    const pos = (row.position ?? stats.position ?? null) as string | null;

    const iso = (row.game_date ?? "").toString().trim();
    const mk = iso && iso.includes("-") ? monthKey(iso) : "";

    if (!byPlayer[player]) byPlayer[player] = { position: pos, totals: {}, srAttempts: 0, srWeightedSum: 0 };
    if (!byPlayer[player].position && pos) byPlayer[player].position = pos;

    for (const key of Object.keys(stats)) {
      if (key === "player_name" || key === "position" || key === "opponent" || key === "match_date" || key === "source_file") continue;
      const n = toNum(stats[key]);
      if (n === 0) continue;

      byPlayer[player].totals[key] = (byPlayer[player].totals[key] ?? 0) + n;

      if (mk) {
        teamByMonth[mk] = teamByMonth[mk] ?? {};
        teamByMonth[mk][key] = (teamByMonth[mk][key] ?? 0) + n;
      }
    }

    const srAtt = toNum(stats.serve_receive_attempts);
    const srRating = toNum(stats.serve_receive_passing_rating);
    if (srAtt > 0) {
      byPlayer[player].srAttempts += srAtt;
      byPlayer[player].srWeightedSum += srRating * srAtt;

      if (mk) {
        srByMonth[mk] = srByMonth[mk] ?? { attempts: 0, weightedSum: 0 };
        srByMonth[mk].attempts += srAtt;
        srByMonth[mk].weightedSum += srRating * srAtt;

        passerByMonth[mk] = passerByMonth[mk] ?? {};
        passerByMonth[mk][player] = passerByMonth[mk][player] ?? { attempts: 0, weightedSum: 0 };
        passerByMonth[mk][player].attempts += srAtt;
        passerByMonth[mk][player].weightedSum += srRating * srAtt;
      }
    }
  }

  let teamSrAttempts = 0;
  let teamSrWeightedSum = 0;
  for (const p of Object.keys(byPlayer)) {
    teamSrAttempts += byPlayer[p].srAttempts;
    teamSrWeightedSum += byPlayer[p].srWeightedSum;
  }
  const teamSrRating = teamSrAttempts > 0 ? teamSrWeightedSum / teamSrAttempts : 0;

  const troubleOpponents = Object.keys(oppMatches)
    .map((opp) => ({ opponent: opp, losses: oppLosses[opp] ?? 0, matches: oppMatches[opp] ?? 0, setDiff: oppSetDiff[opp] ?? 0 }))
    .filter((x) => x.losses > 0)
    .sort((a, b) => (b.losses !== a.losses ? b.losses - a.losses : a.setDiff - b.setDiff))
    .slice(0, 10);

  return {
    wins,
    losses,
    hasMatches: matches.length > 0,
    hasStats: Object.keys(byPlayer).length > 0,
    byPlayer,
    teamByMonth,
    srByMonth,
    passerByMonth,
    teamSr: { rating: teamSrRating, attempts: teamSrAttempts },
    troubleOpponents,
  };
}

/** ---------------------- Leaderboards ---------------------- **/

function topNForKey(byPlayer: Record<string, { totals: Record<string, number> }>, key: string, n: number) {
  return Object.keys(byPlayer)
    .map((p) => ({ player: p, value: toNum(byPlayer[p].totals[key]) }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}

function topNPassersOverall(byPlayer: Record<string, { srAttempts: number; srWeightedSum: number }>, n: number) {
  return Object.keys(byPlayer)
    .map((p) => {
      const att = byPlayer[p].srAttempts;
      const sum = byPlayer[p].srWeightedSum;
      const r = att > 0 ? sum / att : 0;
      return { player: p, rating: r, attempts: att };
    })
    .filter((x) => x.attempts > 0)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, n);
}

function topNPassersEachMonth(passerByMonth: Record<string, Record<string, { attempts: number; weightedSum: number }>>, n: number) {
  const out: Array<{ month: string; rows: Array<{ player: string; rating: number; attempts: number }> }> = [];
  const months = Object.keys(passerByMonth).sort();

  for (const m of months) {
    const players = passerByMonth[m];
    const rows = Object.keys(players)
      .map((p) => {
        const att = players[p].attempts;
        const r = att > 0 ? players[p].weightedSum / att : 0;
        return { player: p, rating: r, attempts: att };
      })
      .filter((x) => x.attempts > 0)
      .sort((a, b) => b.rating - a.rating)
      .slice(0, n);

    out.push({ month: m, rows });
  }

  return out;
}

/** ---------------------- Notes ---------------------- **/

function buildNotes(chunks: any[]) {
  if (!chunks?.length) return "";
  const parts: string[] = [];

  for (const c of chunks.slice(0, 10)) {
    const title = String(c.title ?? "").trim();
    const content = String(c.content ?? "").trim();
    if (!title && !content) continue;
    if (title) parts.push(title);
    if (content) parts.push(content);
    parts.push("");
  }

  return parts.join("\n").trim();
}

/** ---------------------- Facts payload (question-specific) ---------------------- **/

function buildFactsPayload(question: string, agg: ReturnType<typeof computeAggregates>, notes: string) {
  const q = question.trim().toLowerCase();

  const base = {
    window: { start: SEASON_START, endExclusive: SEASON_END_EXCLUSIVE },
    winLoss: agg.hasMatches ? { wins: agg.wins, losses: agg.losses } : null,
    teamServeReceive: agg.teamSr.attempts > 0 ? { scale: "0-3", rating: Number(agg.teamSr.rating.toFixed(2)), attempts: agg.teamSr.attempts } : null,
    troubleOpponents: agg.troubleOpponents.slice(0, 6),
  };

  if (isDefinitionQuestion(question)) return { type: "definition", ...base };

  if (isRosterQuestion(question)) return { type: "roster", ...base, notes };

  // LINEUP: include the best available lineup-relevant stats so the model can answer with a lineup.
  if (isLineupQuestion(question)) {
    const candidates = {
      settersByAssists: topNForKey(agg.byPlayer as any, "setting_assists", 6),
      hittersByKills: topNForKey(agg.byPlayer as any, "attack_kills", 10),
      passersBySR: topNPassersOverall(agg.byPlayer, 8).map((r) => ({
        player: r.player,
        rating: Number(r.rating.toFixed(2)),
        attempts: r.attempts,
      })),
      blockersBySolo: topNForKey(agg.byPlayer as any, "blocks_solo", 8),
      blockersByAssist: topNForKey(agg.byPlayer as any, "blocks_assist", 8),
    };

    // Positions if present in the stats table (helpful but not required)
    const positions: Record<string, string | null> = {};
    for (const p of Object.keys(agg.byPlayer)) positions[p] = agg.byPlayer[p].position ?? null;

    return { type: "lineup", ...base, candidates, positions, notes };
  }

  // PASSING: top N or each month
  if (isPassingQuestion(question)) {
    const wantsTop3 = q.includes("top 3") || q.includes("top three");
    const wantsTop5 = q.includes("top 5") || q.includes("top five");
    const n = wantsTop5 ? 5 : wantsTop3 ? 3 : 1;

    const wantsEachMonth = q.includes("each month") || q.includes("per month") || q.includes("month");
    const overallTop = topNPassersOverall(agg.byPlayer, Math.max(n, 5)).map((r) => ({
      player: r.player,
      rating: Number(r.rating.toFixed(2)),
      attempts: r.attempts,
    }));
    const byMonthTop5 = wantsEachMonth ? topNPassersEachMonth(agg.passerByMonth, 5) : null;

    return { type: "serve_receive", ...base, requested: { topN: n, eachMonth: wantsEachMonth }, overallTop, byMonthTop5 };
  }

  // LEADERS: top 5 across common keys
  if (isLeadersQuestion(question)) {
    const commonKeys = [
      "attack_kills",
      "digs_successful",
      "serve_aces",
      "serve_errors",
      "setting_assists",
      "setting_errors",
      "blocks_solo",
      "blocks_assist",
      "attack_errors",
      "attack_attempts",
    ];

    const leaderboards: Record<string, Array<{ player: string; value: number }>> = {};
    for (const key of commonKeys) {
      const rows = topNForKey(agg.byPlayer as any, key, 5);
      if (rows.length) leaderboards[key] = rows;
    }

    return { type: "leaderboards", ...base, leaderboards };
  }

  // MONTH BY MONTH: for any inferred stat key + always SR by month if present
  if (isMonthByMonthQuestion(question)) {
    const key = inferStatKeyFromQuestion(question);

    const teamServeReceiveByMonth = Object.keys(agg.srByMonth)
      .sort()
      .map((m) => {
        const x = agg.srByMonth[m];
        const r = x.attempts > 0 ? x.weightedSum / x.attempts : 0;
        return { month: m, scale: "0-3", rating: Number(r.toFixed(2)), attempts: x.attempts };
      });

    const statByMonth =
      key && Object.keys(agg.teamByMonth).length
        ? Object.keys(agg.teamByMonth)
            .sort()
            .map((m) => ({ month: m, key, value: toNum(agg.teamByMonth[m]?.[key]) }))
        : null;

    return { type: "month_over_month", ...base, inferredKey: key || null, statByMonth, teamServeReceiveByMonth };
  }

  // BROAD: narrative snapshot
  if (isBroadQuestion(question)) {
    const snapshot = {
      killsTop5: topNForKey(agg.byPlayer as any, "attack_kills", 5),
      digsTop5: topNForKey(agg.byPlayer as any, "digs_successful", 5),
      acesTop5: topNForKey(agg.byPlayer as any, "serve_aces", 5),
      serveErrorsTop5: topNForKey(agg.byPlayer as any, "serve_errors", 5),
      assistsTop5: topNForKey(agg.byPlayer as any, "setting_assists", 5),
      settingErrorsTop5: topNForKey(agg.byPlayer as any, "setting_errors", 5),
      blocksSoloTop5: topNForKey(agg.byPlayer as any, "blocks_solo", 5),
      blocksAssistTop5: topNForKey(agg.byPlayer as any, "blocks_assist", 5),
      bestPassersTop5: topNPassersOverall(agg.byPlayer, 5).map((r) => ({
        player: r.player,
        rating: Number(r.rating.toFixed(2)),
        attempts: r.attempts,
      })),
    };

    return { type: "broad_coaching", ...base, snapshot, notes };
  }

  return { type: "minimal", ...base };
}

/** ---------------------- OpenAI call ---------------------- **/

function safeExtractOutputText(json: any): string {
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

async function callOpenAI(question: string, factsPayload: any) {
  assertEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";

  const broad = isBroadQuestion(question);
  const askedForPrompts = isPromptsQuestion(question);

  // Snappier: smaller token budgets (still enough for narrative)
  const maxTokens = broad ? 950 : 350;

  const system = `
You are "${PERSONA}" for MVVC 14 Black boys volleyball.

Answer like ChatGPT: directly answer the question asked.

Hard rules:
- Do NOT echo the question.
- Do NOT dump unrelated stats.
- Do NOT output "Try these prompts" unless the user asked for prompts.
- No hyphen dividers like "-----" and no hyphen bullets.
  Use short headings and numbered lists or • bullets.

Facts:
- FACTS_JSON is the ONLY source of factual claims.
- If a specific fact is missing, say what's missing, but STILL give a best-effort coaching answer using what you do have.

Type-specific behavior:
- type="definition": give a clean definition (no season recap).
- type="lineup": answer as a lineup, especially for 6-2.
  Use available facts: setting_assists, attack_kills, SR rating, blocks. If positions are unclear, state assumptions and provide 2 lineup options.
- type="broad_coaching": write a real narrative (12–30 lines) with practical next steps.
- type="serve_receive": if asked top 3/5, list top 3/5. If by month, show month blocks.
- type="leaderboards": show top 5 by category.
- type="month_over_month": show month-by-month for inferred stat; if none inferred, ask what stat and suggest 3 examples.

Also: mention what is data-backed vs coaching inference in natural language (no separate sections required).
`;

  const userObj = { question, FACTS_JSON: factsPayload };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_output_tokens: maxTokens,
      input: [
        { role: "system", content: [{ type: "input_text", text: system }] },
        { role: "user", content: [{ type: "input_text", text: JSON.stringify(userObj) }] },
      ],
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }

  const json = await res.json();
  const answer = safeExtractOutputText(json);

  // Don’t allow prompt-dumping unless asked
  if (!askedForPrompts && answer.toLowerCase().includes("try:")) return answer;

  return answer;
}

/** ---------------------- Fallback (must still answer well) ---------------------- **/

function fallbackAnswer(question: string, factsPayload: any) {
  const t = s(question);
  const lines: string[] = [];

  if (factsPayload?.type === "definition") {
    lines.push("6-2 offense (simple definition)");
    lines.push("A 6-2 means you use two setters, and whoever is in the back row sets.");
    lines.push("That keeps three front-row attackers available, but it requires subs and consistent serve-receive to run cleanly.");
    return lines.join("\n");
  }

  // IMPORTANT FIX: lineup fallback MUST actually give a lineup, even with imperfect data.
  if (factsPayload?.type === "lineup") {
    const wl = factsPayload?.winLoss;
    const teamSR = factsPayload?.teamServeReceive;
    const c = factsPayload?.candidates ?? {};

    const setters = (c.settersByAssists ?? []).slice(0, 4);
    const passers = (c.passersBySR ?? []).slice(0, 5);
    const hitters = (c.hittersByKills ?? []).slice(0, 8);
    const blockersSolo = (c.blockersBySolo ?? []).slice(0, 6);
    const blockersAssist = (c.blockersByAssist ?? []).slice(0, 6);

    lines.push("Projected 6-2 lineup (best-effort from available stats)");

    if (wl) lines.push(`Data-backed context: record ${wl.wins}-${wl.losses}`);
    if (teamSR) lines.push(`Data-backed context: team SR ${teamSR.rating.toFixed(2)} (0–3) across ${teamSR.attempts} attempts`);

    // Choose 2 setters by assists
    if (setters.length >= 2) {
      lines.push("");
      lines.push("Setters (2)");
      lines.push(`1) ${fmtName(setters[0].player)}  assists ${setters[0].value}`);
      lines.push(`2) ${fmtName(setters[1].player)}  assists ${setters[1].value}`);
    } else {
      lines.push("");
      lines.push("Setters (2)");
      lines.push("Insufficient setting_assists data to confidently pick two setters.");
    }

    // Choose passers/DS by SR
    if (passers.length) {
      lines.push("");
      lines.push("Primary passers / DS core (stability for sideout)");
      const top = passers.slice(0, 3);
      for (let i = 0; i < top.length; i++) {
        const p = top[i];
        lines.push(`${i + 1}) ${fmtName(p.player)}  SR ${Number(p.rating).toFixed(2)} on ${p.attempts}`);
      }
    }

    // Choose attackers by kills
    if (hitters.length) {
      lines.push("");
      lines.push("Attackers to build around (kills)");
      const top = hitters.slice(0, 4);
      for (let i = 0; i < top.length; i++) {
        const h = top[i];
        lines.push(`${i + 1}) ${fmtName(h.player)}  kills ${h.value}`);
      }
    }

    // Net presence if blocks exist
    const net = [...blockersSolo, ...blockersAssist]
      .reduce<Record<string, number>>((acc, r) => {
        acc[r.player] = (acc[r.player] ?? 0) + (r.value ?? 0);
        return acc;
      }, {});
    const netRows = Object.keys(net)
      .map((p) => ({ player: p, value: net[p] }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 3);

    if (netRows.length) {
      lines.push("");
      lines.push("Net presence (blocks proxy)");
      for (let i = 0; i < netRows.length; i++) {
        lines.push(`${i + 1}) ${fmtName(netRows[i].player)}  blocks ${netRows[i].value}`);
      }
    }

    lines.push("");
    lines.push("How to run the 6-2 (coaching inference)");
    lines.push("Use your two highest-assist players as setters; have them set from the back row only.");
    lines.push("Make your top 2–3 SR players the backbone of serve-receive so your offense stays in-system.");
    lines.push("Opposite selection: use your highest-kill attackers who are NOT one of the two setters (if you confirm positions, I’ll lock this precisely).");

    lines.push("");
    lines.push("What I still need to make this rotation-by-rotation accurate");
    lines.push("Confirm each player’s primary position (S/OH/OPP/MB/L/DS) and who you want as the two setters.");

    return lines.join("\n");
  }

  // IMPORTANT FIX: broad recap must actually recap using snapshot
  if (factsPayload?.type === "broad_coaching") {
    const wl = factsPayload?.winLoss;
    const teamSR = factsPayload?.teamServeReceive;
    const snap = factsPayload?.snapshot ?? {};
    const trouble = factsPayload?.troubleOpponents ?? [];

    lines.push("Season recap (data-backed + coaching read)");

    if (wl) lines.push(`Data-backed: record ${wl.wins}-${wl.losses}`);
    if (teamSR) lines.push(`Data-backed: team SR ${teamSR.rating.toFixed(2)} (0–3) across ${teamSR.attempts} attempts`);

    const killsL = snap?.killsTop5?.[0];
    const digsL = snap?.digsTop5?.[0];
    const acesL = snap?.acesTop5?.[0];
    const serveErrL = snap?.serveErrorsTop5?.[0];
    const bestP = snap?.bestPassersTop5?.[0];

    lines.push("");
    lines.push("What the numbers say you are");
    if (killsL) lines.push(`Your primary finisher: ${fmtName(killsL.player)} leads kills (${killsL.value}).`);
    if (digsL) lines.push(`Your highest dig production: ${fmtName(digsL.player)} leads digs (${digsL.value}).`);
    if (acesL) lines.push(`Your top point pressure from the line: ${fmtName(acesL.player)} leads aces (${acesL.value}).`);
    if (bestP) lines.push(`Your most stable passer (SR): ${fmtName(bestP.player)} at ${bestP.rating.toFixed(2)} on ${bestP.attempts} attempts.`);
    if (serveErrL) lines.push(`Your biggest volatility flag: ${fmtName(serveErrL.player)} has the most serve errors (${serveErrL.value}).`);

    if (Array.isArray(trouble) && trouble.length) {
      lines.push("");
      lines.push("Where you’ve struggled most (data-backed)");
      const top = trouble.slice(0, 3);
      for (let i = 0; i < top.length; i++) {
        lines.push(`${i + 1}) ${top[i].opponent}  losses ${top[i].losses}/${top[i].matches}`);
      }
      lines.push("Coaching inference: those opponents likely win the serve/pass battle or trap you in a rotation.");
    }

    lines.push("");
    lines.push("Practical next steps (coaching inference)");
    lines.push("1) Serve-receive: build your primary pattern around the top 2–3 passers and simplify seam responsibilities.");
    lines.push("2) Serving: keep aggression but reduce free points—pick 2 target zones per match and track net vs long vs wide misses.");
    lines.push("3) Against trouble opponents: pre-write a plan—serve targets, SR seam ownership, and a rotation escape plan.");

    return lines.join("\n");
  }

  // Minimal
  return "I couldn’t generate a response from the current data.";
}

/** ---------------------- Route ---------------------- **/

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { question: string };
    const question = String(body?.question ?? "").trim();
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    // 1) Fetch
    const { chunks, matches, statsRows } = await retrieveData(TEAM_ID, question);

    // 2) Aggregate once
    const agg = computeAggregates(matches, statsRows);

    // 3) Notes only when helpful
    const notes = (isBroadQuestion(question) || isRosterQuestion(question) || isLineupQuestion(question)) ? buildNotes(chunks) : "";

    // 4) Facts payload tuned to the question (prevents “noise”)
    const factsPayload = buildFactsPayload(question, agg, notes);

    // 5) OpenAI (or fallback). Log failures so you can debug Vercel.
    let answer = "";
    try {
      answer = await callOpenAI(question, factsPayload);
    } catch (err: any) {
      console.error("[OpenAI]", err?.message ?? String(err));
      answer = "";
    }

    if (!answer) answer = fallbackAnswer(question, factsPayload);

    // 6) Always highlight ALL player names we know about
    const playerNames = Object.keys(agg.byPlayer || {});
    answer = highlightAllPlayerNames(answer, playerNames);

    return NextResponse.json({ answer });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
