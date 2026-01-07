import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black
const DEFAULT_SEASON = "fall";

type StatRow = {
  player_name: string;
  position: string | null;
  game_date: string | null;
  opponent: string | null;
  stats: Record<string, any> | null;
};

type MatchRow = {
  match_date: string | null;
  tournament: string | null;
  opponent: string | null;
  result: string | null; // "Won" / "Lost" (or "W"/"L")
  score: string | null;  // "25-17, 25-15" etc
  round: string | null;
  sets_won: number | null;
  sets_lost: number | null;
  set_diff: number | null;
};

function toNum(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const x = parseFloat(v.trim());
    return Number.isFinite(x) ? x : 0;
  }
  return 0;
}

function normResult(r: string | null): "W" | "L" | "" {
  const s = String(r ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s.startsWith("w")) return "W";
  if (s.startsWith("l")) return "L";
  return "";
}

function parseSetsFromScore(score: string | null): { setsWon: number; setsLost: number; pointsDiff: number } | null {
  if (!score) return null;
  const raw = score.trim();
  if (!raw) return null;

  // Example: "25-19, 15-25, 15-13"
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  let setsWon = 0;
  let setsLost = 0;
  let pointsDiff = 0;

  for (const p of parts) {
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!m) continue;
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;

    // Assume left side is MVVC score (as stored in your CSV).
    if (a > b) setsWon += 1;
    else if (b > a) setsLost += 1;

    pointsDiff += (a - b);
  }

  // If we couldn't parse any set scores, return null
  if (setsWon === 0 && setsLost === 0 && pointsDiff === 0) return null;

  return { setsWon, setsLost, pointsDiff };
}

function computeOpponentSummary(matches: MatchRow[]) {
  const byOpp = new Map<string, {
    opponent: string;
    matches: number;
    wins: number;
    losses: number;
    setsWon: number;
    setsLost: number;
    setDiff: number;
    pointsDiff: number;
    lastDate: string;
  }>();

  for (const m of matches) {
    const opp = String(m.opponent ?? "").trim();
    if (!opp) continue;

    if (!byOpp.has(opp)) {
      byOpp.set(opp, {
        opponent: opp,
        matches: 0,
        wins: 0,
        losses: 0,
        setsWon: 0,
        setsLost: 0,
        setDiff: 0,
        pointsDiff: 0,
        lastDate: "",
      });
    }

    const row = byOpp.get(opp)!;
    row.matches += 1;

    const r = normResult(m.result);
    if (r === "W") row.wins += 1;
    if (r === "L") row.losses += 1;

    // Prefer explicit fields if present; else parse score string
    let sw = toNum(m.sets_won);
    let sl = toNum(m.sets_lost);
    let sd = toNum(m.set_diff);

    if ((sw === 0 && sl === 0) || (sd === 0 && m.score)) {
      const parsed = parseSetsFromScore(m.score);
      if (parsed) {
        sw = parsed.setsWon;
        sl = parsed.setsLost;
        sd = parsed.setsWon - parsed.setsLost;
        row.pointsDiff += parsed.pointsDiff;
      }
    }

    row.setsWon += sw;
    row.setsLost += sl;
    row.setDiff += sd;

    const d = String(m.match_date ?? "").trim();
    if (d && d > row.lastDate) row.lastDate = d;
  }

  const list = Array.from(byOpp.values());

  // “Most trouble” = most losses, then worst setDiff, then worst pointsDiff, then most matches
  list.sort((a, b) => {
    if (b.losses !== a.losses) return b.losses - a.losses;
    if (a.setDiff !== b.setDiff) return a.setDiff - b.setDiff; // more negative first
    if (a.pointsDiff !== b.pointsDiff) return a.pointsDiff - b.pointsDiff; // more negative first
    return b.matches - a.matches;
  });

  return list;
}

function computePlayerTotals(statsRows: StatRow[]) {
  const totals = new Map<string, Record<string, number>>();

  const keysWeCareAbout = [
    "attack_kills",
    "attack_errors",
    "attack_attempts",
    "serve_aces",
    "serve_errors",
    "serve_attempts",
    "digs_successful",
    "dig_errors",
    "blocks_solo",
    "blocks_assist",
    "serve_receive_attempts",
    "serve_receive_passing_rating",
    "setting_assists",
    "setting_attempts",
    "setting_errors",
  ];

  for (const r of statsRows) {
    const name = (r.player_name || "").trim();
    if (!name) continue;

    if (!totals.has(name)) totals.set(name, {});
    const t = totals.get(name)!;

    const s = r.stats || {};
    for (const k of keysWeCareAbout) {
      t[k] = (t[k] ?? 0) + toNum(s[k]);
    }

    // Weighted SR rating
    const srAtt = toNum(s["serve_receive_attempts"]);
    const srRating = toNum(s["serve_receive_passing_rating"]);
    t["_sr_attempts"] = (t["_sr_attempts"] ?? 0) + srAtt;
    t["_sr_rating_sum"] = (t["_sr_rating_sum"] ?? 0) + srRating * srAtt;
  }

  const out: Array<{ player: string; totals: Record<string, number> }> = [];
  for (const [player, t] of Array.from(totals.entries())) {
    const srAtt = t["_sr_attempts"] ?? 0;
    const srSum = t["_sr_rating_sum"] ?? 0;
    const srRating = srAtt > 0 ? srSum / srAtt : toNum(t["serve_receive_passing_rating"]);
    t["serve_receive_passing_rating_weighted"] = srRating;
    t["blocks_total"] = (t["blocks_solo"] ?? 0) + (t["blocks_assist"] ?? 0);
    out.push({ player, totals: t });
  }

  return out;
}

function topN(
  computed: Array<{ player: string; totals: Record<string, number> }>,
  key: string,
  n = 6
) {
  return computed
    .map((x) => ({ player: x.player, value: x.totals[key] ?? 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}

async function retrieveContext(teamId: string, season: string, question: string) {
  const supabase = supabaseService();

  // A) Roster notes always
  const { data: rosterChunks, error: er } = await supabase
    .from("knowledge_chunks")
    .select("id,title,content,tags")
    .eq("team_id", teamId)
    .contains("tags", ["roster"])
    .limit(10);
  if (er) throw er;

  // B) Season-specific notes by search (safe if it errors)
  const cleaned = question.replace(/[^a-zA-Z0-9 ]/g, " ");
  const { data: searchChunks, error: e1 } = await supabase
    .from("knowledge_chunks")
    .select("id,title,content,tags")
    .eq("team_id", teamId)
    .eq("season", season)
    .textSearch("tsv", cleaned, { type: "websearch" })
    .limit(10);

  const safeSearchChunks = e1 ? [] : searchChunks ?? [];

  // Merge + dedupe
  const mergedMap = new Map<number, any>();
  (rosterChunks ?? []).forEach((c: any) => mergedMap.set(c.id, c));
  (safeSearchChunks ?? []).forEach((c: any) => mergedMap.set(c.id, c));
  const chunks = Array.from(mergedMap.values());

  // C) Match results
  const { data: matches, error: em } = await supabase
    .from("match_results")
    .select("match_date,tournament,opponent,result,score,round,sets_won,sets_lost,set_diff")
    .eq("team_id", teamId)
    .order("match_date", { ascending: true })
    .limit(2000);
  if (em) throw em;

  // D) Player stats
  let { data: statsRows, error: es } = await supabase
    .from("player_game_stats")
    .select("player_name,position,game_date,opponent,stats")
    .eq("team_id", teamId)
    .eq("season", season)
    .limit(10000);
  if (es) throw es;

  if (!statsRows || statsRows.length === 0) {
    const fallback = await supabase
      .from("player_game_stats")
      .select("player_name,position,game_date,opponent,stats")
      .eq("team_id", teamId)
      .limit(10000);
    if (fallback.error) throw fallback.error;
    statsRows = fallback.data ?? [];
  }

  return { chunks, matches: (matches ?? []) as MatchRow[], statsRows: (statsRows ?? []) as StatRow[] };
}

function prettyContext(chunks: any[], matches: MatchRow[], statsRows: StatRow[]) {
  const parts: string[] = [];

  if (chunks.length) {
    parts.push("TEAM NOTES / ROSTER");
    parts.push("-------------------");
    chunks.forEach((c) => {
      parts.push(`${c.title}\n${c.content}`);
      parts.push("");
    });
  }

  if (matches.length) {
    const wins = matches.filter((m) => normResult(m.result) === "W").length;
    const losses = matches.filter((m) => normResult(m.result) === "L").length;

    parts.push("MATCH RESULTS (RAW)");
    parts.push("-------------------");
    for (const m of matches) {
      const d = m.match_date ? String(m.match_date) : "";
      const t = m.tournament ?? "";
      const r = m.result ?? "";
      const opp = m.opponent ?? "";
      const sc = m.score ? ` | ${m.score}` : "";
      parts.push(`- ${d} | ${t} | ${r} vs ${opp}${sc}`);
    }
    parts.push("");
    parts.push(`Overall record (from match_results): ${wins}-${losses}`);
    parts.push("");

    const oppSummary = computeOpponentSummary(matches);
    parts.push("OPPONENT SUMMARY (DERIVED)");
    parts.push("--------------------------");
    parts.push("Each row: Opponent | Matches | W-L | SetDiff | PointsDiff");
    for (const o of oppSummary.slice(0, 15)) {
      parts.push(
        `- ${o.opponent} | ${o.matches} | ${o.wins}-${o.losses} | ${o.setDiff} | ${o.pointsDiff}`
      );
    }
    parts.push("");
  }

  if (statsRows.length) {
    const computed = computePlayerTotals(statsRows);

    parts.push("PLAYER TOTALS (DERIVED FROM player_game_stats)");
    parts.push("---------------------------------------------");

    const killsTop = topN(computed, "attack_kills", 8);
    const blocksTop = topN(computed, "blocks_total", 8);
    const digsTop = topN(computed, "digs_successful", 8);

    parts.push("Top kills:");
    killsTop.forEach((x, i) => parts.push(`- ${i + 1}. ${x.player}: ${x.value}`));
    parts.push("");

    parts.push("Top blocks (solo+assist):");
    blocksTop.forEach((x, i) => parts.push(`- ${i + 1}. ${x.player}: ${x.value}`));
    parts.push("");

    parts.push("Top digs:");
    digsTop.forEach((x, i) => parts.push(`- ${i + 1}. ${x.player}: ${x.value}`));
    parts.push("");

    const sr = computed
      .map((x) => ({
        player: x.player,
        rating: x.totals["serve_receive_passing_rating_weighted"] ?? 0,
        attempts: x.totals["_sr_attempts"] ?? 0,
      }))
      .filter((x) => x.attempts > 0)
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 8);

    if (sr.length) {
      parts.push("Serve-receive passing rating (weighted, scale should match your CSV):");
      sr.forEach((x, i) =>
        parts.push(`- ${i + 1}. ${x.player}: ${x.rating.toFixed(2)} (attempts: ${x.attempts})`)
      );
      parts.push("");
    }
  }

  return parts.join("\n");
}

function extractResponseText(json: any): string {
  if (typeof json?.output_text === "string" && json.output_text.trim()) {
    return json.output_text.trim();
  }

  let text = "";
  const out = json?.output ?? [];
  for (const item of out) {
    if (item?.type === "output_text" && typeof item?.text === "string") {
      text += item.text;
      continue;
    }
    const content = item?.content ?? [];
    for (const c of content) {
      if (c?.type === "output_text" && typeof c?.text === "string") text += c.text;
      if (c?.type === "refusal" && typeof c?.refusal === "string") text += c.refusal;
    }
  }

  return (text || "").trim();
}

function fallbackAnswer(question: string, matches: MatchRow[], statsRows: StatRow[]) {
  const q = question.toLowerCase();

  // Opponents trouble
  if (q.includes("opponent") && (q.includes("trouble") || q.includes("hard") || q.includes("tough"))) {
    if (!matches.length) return "Insufficient data in the current dataset.";

    const opp = computeOpponentSummary(matches);
    const worst = opp.slice(0, 5);

    const lines: string[] = [];
    lines.push("Opponents that caused the most trouble");
    lines.push("-------------------------------------");
    lines.push("- Interpreted as: most losses first, then worst set differential.");
    lines.push("");

    worst.forEach((o) => {
      lines.push(`- **${o.opponent}** — ${o.wins}-${o.losses} (matches: ${o.matches}), SetDiff: ${o.setDiff}`);
    });

    return lines.join("\n");
  }

  // Spring lineup (best-effort heuristic from derived totals)
  if (q.includes("spring") && (q.includes("lineup") || q.includes("starting") || q.includes("best projected"))) {
    if (!statsRows.length) return "Insufficient data in the current dataset.";

    const totals = computePlayerTotals(statsRows);

    // Heuristics:
    // - Pick top attackers for pins (kills)
    // - Pick top blockers for MB
    // - Pick best SR rating for libero/primary passer
    const kills = topN(totals, "attack_kills", 8);
    const blocks = topN(totals, "blocks_total", 8);

    const sr = totals
      .map((x) => ({
        player: x.player,
        rating: x.totals["serve_receive_passing_rating_weighted"] ?? 0,
        attempts: x.totals["_sr_attempts"] ?? 0,
      }))
      .filter((x) => x.attempts > 0)
      .sort((a, b) => b.rating - a.rating);

    const libero = sr.length ? sr[0].player : (totals[0]?.player ?? "");
    const mb1 = blocks[0]?.player ?? "";
    const mb2 = blocks[1]?.player ?? "";
    const pin1 = kills[0]?.player ?? "";
    const pin2 = kills[1]?.player ?? "";
    const opp = kills[2]?.player ?? "";

    const lines: string[] = [];
    lines.push("Best projected spring lineup (data-driven starting point)");
    lines.push("--------------------------------------------------------");
    lines.push("- This is a best-effort projection using season totals (kills/blocks/SR).");
    lines.push("");

    lines.push("Suggested roles");
    lines.push("---------------");
    lines.push(`- **Libero / Primary passer:** **${libero}**`);
    lines.push(`- **Middles (blocking priority):** **${mb1}**, **${mb2}**`);
    lines.push(`- **Pins (kills priority):** **${pin1}**, **${pin2}**`);
    lines.push(`- **Opposite (next-best attacker):** **${opp}**`);
    lines.push("");
    lines.push("If you want, tell me who is setting in spring (Koa vs Steven/Cooper) and I’ll lock rotations + subs.");

    return lines.join("\n");
  }

  return "";
}

async function callOpenAI(question: string, context: string) {
  assertEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";

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

Formatting rules:
- Use clear section headers and spacing.
- Underline headers with dashes.
- Make player names stand out using **Name** (bold).
- Do NOT show citations like S3/K2/etc.

Answering rules:
- Use ONLY the provided CONTEXT to state facts.
- If the CONTEXT lacks needed numbers, say: "Insufficient data in the current dataset."
- If the question is ambiguous (ex: "most trouble"), define a concrete interpretation using the derived tables provided (Opponent Summary, Player Totals).
- Always produce an answer (never return blank).
`,
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: `Question: ${question}\n\nCONTEXT:\n${context}` }],
        },
      ],
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }

  const json = await res.json();
  return extractResponseText(json);
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { question: string };
    const question = String(body.question ?? "").trim();
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    const teamId = TEAM_ID;
    const season = DEFAULT_SEASON;

    const { chunks, matches, statsRows } = await retrieveContext(teamId, season, question);
    const ctx = prettyContext(chunks, matches, statsRows);

    // 1) Try deterministic fallback for fuzzy questions first (fast + reliable)
    const fb = fallbackAnswer(question, matches, statsRows);
    if (fb) return NextResponse.json({ answer: fb });

    // 2) Otherwise ask OpenAI with strong derived context
    const answer = await callOpenAI(question, ctx);

    // 3) Last resort: if OpenAI returns empty, return a helpful computed summary
    if (!answer || !answer.trim()) {
      const wins = matches.filter((m) => normResult(m.result) === "W").length;
      const losses = matches.filter((m) => normResult(m.result) === "L").length;
      return NextResponse.json({
        answer:
          `Answer\n------\nI couldn’t generate a narrative answer, but your data is loaded.\n\n` +
          `Win/Loss (match_results): ${wins}-${losses}\n` +
          `Player stat rows loaded: ${statsRows.length}\n` +
          `Try: "Who leads in attack_kills?" or "Show top 5 blocks_total."`,
      });
    }

    return NextResponse.json({ answer });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
