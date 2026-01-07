import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

/**
 * MVVC Coach Copilot - Chat API (2025–26 window)
 *
 * What this route does:
 * 1) Accepts { question, thread_id? } from the frontend.
 * 2) Creates a new thread if thread_id is missing.
 * 3) Loads recent message history for that thread (so it behaves like ChatGPT).
 * 4) Loads Supabase data (matches + player stats) as the ONLY factual source.
 * 5) Builds a question-specific FACTS_JSON (prevents noise / irrelevant dumps).
 * 6) Calls OpenAI and returns { answer, thread_id }.
 * 7) Saves user + assistant messages back to Supabase.
 *
 * Performance goals:
 * - Skip DB entirely for pure definition questions (ex: "what is a 6-2 offense").
 * - Parallelize DB calls.
 * - Only fetch last N chat messages (default 18).
 * - Keep token budgets smaller for narrow questions.
 */

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black
const SEASON_START = "2025-08-01";
const SEASON_END_EXCLUSIVE = "2026-08-01";
const PERSONA = "Volleyball Guru";

// Keep history short so responses are fast & relevant
const HISTORY_LIMIT = 18;

// ---------- Types ----------
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
  stats: any; // jsonb (object or stringified JSON)
};

type ChatMessageRow = {
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

// ---------- Small utils ----------
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
  // "2025-11-09" -> "2025-11"
  return isoDate.slice(0, 7);
}

function s(q: string) {
  return (q || "").toLowerCase().trim();
}

function fmtName(name: string) {
  return `**${name}**`;
}

// ---------- Bold highlighting without “favoritism” ----------
function escapeRegExp(x: string) {
  return x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Bold every player name that appears in the answer, but try hard not to double-bold
 * or break markdown.
 */
function highlightAllPlayerNames(answer: string, playerNames: string[]) {
  if (!answer) return answer;

  const unique = Array.from(new Set((playerNames || []).map((n) => (n || "").trim()).filter(Boolean)));
  // Longest-first avoids partial matches inside longer names
  unique.sort((a, b) => b.length - a.length);

  let out = answer;

  for (const name of unique) {
    const esc = escapeRegExp(name);

    // Only match when not already inside **...**
    // This isn’t perfect markdown parsing, but prevents most double-bolding.
    const re = new RegExp(`(?<!\\*)\\b${esc}\\b(?!\\*)`, "g");
    out = out.replace(re, `**${name}**`);
  }

  return out;
}

// ---------- Intent detection (drives “ChatGPT-like” behavior) ----------
function isPromptsQuestion(q: string) {
  const t = s(q);
  return t.includes("suggested prompt") || t.includes("suggest prompts") || t.includes("example prompt");
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
  return (
    t.includes("leaders") ||
    t.includes("top 5") ||
    t.includes("top five") ||
    t.includes("top 3") ||
    t.includes("top three")
  );
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
  return (
    broadSignals.some((k) => t.includes(k)) ||
    isLineupQuestion(q) ||
    isMonthByMonthQuestion(q) ||
    isLeadersQuestion(q)
  );
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

// ---------- Supabase chat memory (threads + messages) ----------
async function getOrCreateThreadId(supabase: ReturnType<typeof supabaseService>, threadId: string | null) {
  // If caller provided a thread_id, trust it (frontend owns the lifecycle).
  if (threadId) return threadId;

  // Otherwise create a new thread row
  const { data, error } = await supabase
    .from("chat_threads")
    .insert({ team_id: TEAM_ID })
    .select("id")
    .single();

  if (error) throw error;
  return data.id as string;
}

async function appendMessage(
  supabase: ReturnType<typeof supabaseService>,
  threadId: string,
  role: "user" | "assistant",
  content: string
) {
  // Keep content non-empty
  const text = (content || "").trim();
  if (!text) return;

  const { error } = await supabase.from("chat_messages").insert({
    thread_id: threadId,
    role,
    content: text,
  });

  if (error) throw error;
}

async function fetchRecentMessages(
  supabase: ReturnType<typeof supabaseService>,
  threadId: string,
  limit: number
): Promise<ChatMessageRow[]> {
  const { data, error } = await supabase
    .from("chat_messages")
    .select("role,content,created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  // Reverse so earliest -> latest
  return (data ?? []).reverse() as ChatMessageRow[];
}

// ---------- Supabase data fetching (parallel) ----------
async function retrieveData(teamId: string, question: string) {
  const supabase = supabaseService();
  const broad = isBroadQuestion(question) || isRosterQuestion(question);

  // Notes/roster only help for broad/roster/lineup, and they can be “expensive”
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

  const [rosterRes, notesRes, matchesRes, statsRes] = await Promise.all([
    rosterPromise,
    notesPromise,
    matchesPromise,
    statsPromise,
  ]);

  if (rosterRes.error) throw rosterRes.error;
  if (notesRes.error) throw notesRes.error;
  if (matchesRes.error) throw matchesRes.error;
  if (statsRes.error) throw statsRes.error;

  // Merge + dedupe chunks
  const merged = new Map<number, any>();
  (rosterRes.data ?? []).forEach((c: any) => merged.set(c.id, c));
  (notesRes.data ?? []).forEach((c: any) => merged.set(c.id, c));
  const chunks = Array.from(merged.values());

  return {
    chunks,
    matches: (matchesRes.data ?? []) as MatchRow[],
    statsRows: (statsRes.data ?? []) as Statoj,
  };
}

// TS fix helper (some editors get weird when pasting long files)
type StatRows = StatRow[];

// ---------- Aggregations (supports “any column”, month-over-month, top N, etc.) ----------
function computeAggregates(matches: MatchRow[], statsRows: StatRows) {
  // Win/Loss and opponent trouble
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

  // Player totals across all numeric keys
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

    // Important: we only use ISO game_date for month bucketing (YYYY-MM-DD)
    const iso = (row.game_date ?? "").toString().trim();
    const mk = iso && iso.includes("-") ? monthKey(iso) : "";

    if (!byPlayer[player]) byPlayer[player] = { position: pos, totals: {}, srAttempts: 0, srWeightedSum: 0 };
    if (!byPlayer[player].position && pos) byPlayer[player].position = pos;

    // Sum every numeric-ish field in stats (so any CSV column becomes queryable)
    for (const key of Object.keys(stats)) {
      // Skip obvious identifiers (not “stats”)
      if (key === "player_name" || key === "position" || key === "opponent" || key === "match_date" || key === "source_file") continue;

      const n = toNum(stats[key]);
      if (n === 0) continue;

      byPlayer[player].totals[key] = (byPlayer[player].totals[key] ?? 0) + n;

      if (mk) {
        teamByMonth[mk] = teamByMonth[mk] ?? {};
        teamByMonth[mk][key] = (teamByMonth[mk][key] ?? 0) + n;
      }
    }

    // Serve receive weighted rating support
    const srAtt = toNum(stats.serve_receive_attempts);
    const srRating = toNum(stats.serve_receive_passing_rating); // 0–3 scale
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

  // Team SR overall
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

// ---------- Leaderboards helpers ----------
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

// ---------- Notes from knowledge_chunks ----------
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

// ---------- Facts payload (question-specific; prevents noise) ----------
function buildFactsPayload(question: string, agg: ReturnType<typeof computeAggregates>, notes: string) {
  const q = question.trim().toLowerCase();

  const base = {
    window: { start: SEASON_START, endExclusive: SEASON_END_EXCLUSIVE },
    winLoss: agg.hasMatches ? { wins: agg.wins, losses: agg.losses } : null,
    teamServeReceive: agg.teamSr.attempts > 0 ? { scale: "0-3", rating: Number(agg.teamSr.rating.toFixed(2)), attempts: agg.teamSr.attempts } : null,
    troubleOpponents: agg.troubleOpponents.slice(0, 6),
  };

  if (isDefinitionQuestion(question)) return { type: "definition" };

  if (isRosterQuestion(question)) return { type: "roster", ...base, notes };

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

    const positions: Record<string, string | null> = {};
    for (const p of Object.keys(agg.byPlayer)) positions[p] = agg.byPlayer[p].position ?? null;

    return { type: "lineup", ...base, candidates, positions, notes };
  }

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

// ---------- OpenAI helpers ----------
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

/**
 * Calls OpenAI with conversation history + facts JSON.
 * This is the key “behave like ChatGPT” change.
 */
async function callOpenAI(params: {
  question: string;
  history: ChatMessageRow[];
  factsPayload: any | null;
}) {
  assertEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";

  const { question, history, factsPayload } = params;

  const broad = isBroadQuestion(question);
  const askedForPrompts = isPromptsQuestion(question);

  // Faster + less rambling
  const maxTokens = broad ? 950 : 320;

  const system = `
You are "${PERSONA}" for MVVC 14 Black boys volleyball.

Answer like ChatGPT: directly answer the user's question.

Hard rules:
• Do NOT echo the question.
• Do NOT dump unrelated stats.
• Do NOT output "Try these prompts" unless the user asked for prompts.
• No hyphen dividers like "-----" and no hyphen bullets. Use • bullets or numbered lists.

Facts policy:
• FACTS_JSON (if provided) is the ONLY source of factual claims about MVVC performance.
• If a needed fact is missing, say what's missing — but still give best-effort coaching guidance.

Type behavior:
• If this is a definition question, answer ONLY the definition (no season recap).
• If this is a lineup question (including 6–2), you MUST output a lineup (best-effort).
• If broad coaching question, write a real narrative with practical next steps.
`;

  // Build a “chat-style” input:
  // - system
  // - prior user/assistant turns
  // - current user with facts attached
  const input: any[] = [{ role: "system", content: [{ type: "input_text", text: system }] }];

  // Add message history (short window)
  for (const m of history) {
    input.push({
      role: m.role,
      content: [{ type: "input_text", text: m.content }],
    });
  }

  // Final user message: include facts JSON (so model can use it, but won't spam it)
  const userPayload = factsPayload
    ? { question, FACTS_JSON: factsPayload }
    : { question };

  input.push({
    role: "user",
    content: [{ type: "input_text", text: JSON.stringify(userPayload) }],
  });

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_output_tokens: maxTokens,
      input,
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }

  const json = await res.json();
  const answer = safeExtractOutputText(json);

  // Prevent prompt-dumping unless asked (soft guard)
  if (!askedForPrompts && answer.toLowerCase().includes("try:")) return answer;

  return answer;
}

// ---------- Deterministic fallback (so it always answers) ----------
function fallbackDefinition(q: string) {
  // Keep it clean and short.
  return [
    "6-2 offense",
    "A 6-2 means you use two setters and whoever is in the back row sets.",
    "That keeps three front-row attackers available most of the time, but it depends on clean serve-receive and organized substitutions.",
  ].join("\n");
}

function fallbackAnswer(question: string, factsPayload: any) {
  // Keep your existing good fallback logic — but ensure it answers the asked intent.
  if (isDefinitionQuestion(question)) return fallbackDefinition(question);

  // If we can't do better, at least say why.
  return "I couldn’t generate a response from the current data.";
}

// ---------- Route ----------
export async function POST(req: Request) {
  try {
    const supabase = supabaseService();

    // Frontend contract: { question, thread_id? }
    const body = (await req.json()) as { question: string; thread_id?: string | null };
    const question = String(body?.question ?? "").trim();
    const incomingThreadId = body?.thread_id ? String(body.thread_id) : null;

    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    // 0) Create/reuse a thread
    const thread_id = await getOrCreateThreadId(supabase, incomingThreadId);

    // 1) Save the user message immediately (so history is consistent even if OpenAI fails)
    await appendMessage(supabase, thread_id, "user", question);

    // 2) Pull recent messages (excluding none; includes the question we just inserted)
    const history = await fetchRecentMessages(supabase, thread_id, HISTORY_LIMIT);

    // 3) Definition questions should be instant (no DB)
    if (isDefinitionQuestion(question)) {
      const answer = fallbackDefinition(question);
      await appendMessage(supabase, thread_id, "assistant", answer);
      return NextResponse.json({ answer, thread_id });
    }

    // 4) Pull volleyball data + compute aggregates
    const { chunks, matches, statsRows } = await retrieveData(TEAM_ID, question);

    const agg = computeAggregates(matches, statsRows as any);

    // Notes only when useful (keeps narrow Qs fast and clean)
    const notes =
      isBroadQuestion(question) || isRosterQuestion(question) || isLineupQuestion(question)
        ? buildNotes(chunks)
        : "";

    const factsPayload = buildFactsPayload(question, agg, notes);

    // 5) OpenAI answer (ChatGPT-style, with memory)
    let answer = "";
    try {
      answer = await callOpenAI({
        question,
        history,
        factsPayload,
      });
    } catch (err: any) {
      console.error("[OpenAI]", err?.message ?? String(err));
      answer = "";
    }

    if (!answer) {
      answer = fallbackAnswer(question, factsPayload);
    }

    // 6) Bold all player names (prevents “favoritism” look)
    const playerNames = Object.keys(agg.byPlayer || {});
    answer = highlightAllPlayerNames(answer, playerNames);

    // 7) Save assistant message
    await appendMessage(supabase, thread_id, "assistant", answer);

    return NextResponse.json({ answer, thread_id });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
