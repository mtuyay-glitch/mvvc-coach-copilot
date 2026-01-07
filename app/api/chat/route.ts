import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black
const DEFAULT_SEASON = "fall"; // change if you want, but code will fallback if season mismatch

type StatRow = {
  player_name: string;
  position: string | null;
  game_date: string | null;
  opponent: string | null;
  stats: Record<string, any> | null;
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

function computeTotals(statsRows: StatRow[]) {
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

    // For weighted SR rating
    const srAtt = toNum(s["serve_receive_attempts"]);
    const srRating = toNum(s["serve_receive_passing_rating"]);
    t["_sr_attempts"] = (t["_sr_attempts"] ?? 0) + srAtt;
    t["_sr_rating_sum"] = (t["_sr_rating_sum"] ?? 0) + srRating * srAtt;
  }

  const out: Array<{ player: string; totals: Record<string, number> }> = [];

  // ✅ FIX: convert iterator to array for older TS targets
  for (const [player, t] of Array.from(totals.entries())) {
    const srAtt = t["_sr_attempts"] ?? 0;
    const srSum = t["_sr_rating_sum"] ?? 0;
    const srRating = srAtt > 0 ? srSum / srAtt : toNum(t["serve_receive_passing_rating"]);
    t["serve_receive_passing_rating_weighted"] = srRating;
    out.push({ player, totals: t });
  }

  return out;
}

function topN(
  computed: Array<{ player: string; totals: Record<string, number> }>,
  key: string,
  n = 5
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
    .limit(5);
  if (er) throw er;

  // B) Season-specific notes by search
  const cleaned = question.replace(/[^a-zA-Z0-9 ]/g, " ");
  const { data: searchChunks, error: e1 } = await supabase
    .from("knowledge_chunks")
    .select("id,title,content,tags")
    .eq("team_id", teamId)
    .eq("season", season)
    .textSearch("tsv", cleaned, { type: "websearch" })
    .limit(6);

  // Don’t hard fail if search has no matches / errors
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
    .limit(500);
  if (em) throw em;

  // D) Player stats (try season filter, fallback to no-season if 0 rows)
  let { data: statsRows, error: es } = await supabase
    .from("player_game_stats")
    .select("player_name,position,game_date,opponent,stats")
    .eq("team_id", teamId)
    .eq("season", season)
    .limit(5000);

  if (es) throw es;

  if (!statsRows || statsRows.length === 0) {
    const fallback = await supabase
      .from("player_game_stats")
      .select("player_name,position,game_date,opponent,stats")
      .eq("team_id", teamId)
      .limit(5000);

    if (fallback.error) throw fallback.error;
    statsRows = fallback.data ?? [];
  }

  return { chunks: chunks ?? [], matches: matches ?? [], statsRows: (statsRows ?? []) as StatRow[] };
}

function prettyContext(chunks: any[], matches: any[], statsRows: StatRow[]) {
  const parts: string[] = [];

  if (chunks.length) {
    parts.push("TEAM NOTES / ROSTER\n-------------------");
    chunks.forEach((c) => {
      parts.push(`${c.title}\n${c.content}`);
    });
  }

  if (matches.length) {
    parts.push("\nMATCH RESULTS (WIN/LOSS)\n------------------------");
    for (const m of matches) {
      const d = m.match_date ? String(m.match_date) : "";
      const t = m.tournament ?? "";
      const r = m.result ?? "";
      const opp = m.opponent ?? "";
      const sc = m.score ? ` | ${m.score}` : "";
      parts.push(`- ${d} | ${t} | ${r} vs ${opp}${sc}`);
    }

    const wins = matches.filter((m) => String(m.result || "").toLowerCase().startsWith("w")).length;
    const losses = matches.filter((m) => String(m.result || "").toLowerCase().startsWith("l")).length;
    parts.push(`\nOverall record (from match_results): ${wins}-${losses}`);
  }

  if (statsRows.length) {
    const computed = computeTotals(statsRows);

    parts.push("\nSEASON TOTALS (computed from player_game_stats)\n----------------------------------------------");

    const killsTop = topN(computed, "attack_kills", 8);
    const digsTop = topN(computed, "digs_successful", 8);
    const acesTop = topN(computed, "serve_aces", 8);
    const seTop = topN(computed, "serve_errors", 8);

    parts.push("Top kills (attack_kills):");
    killsTop.forEach((x, i) => parts.push(`- ${i + 1}. ${x.player}: ${x.value}`));

    parts.push("\nTop digs (digs_successful):");
    digsTop.forEach((x, i) => parts.push(`- ${i + 1}. ${x.player}: ${x.value}`));

    parts.push("\nTop aces (serve_aces):");
    acesTop.forEach((x, i) => parts.push(`- ${i + 1}. ${x.player}: ${x.value}`));

    parts.push("\nMost serve errors (serve_errors):");
    seTop.forEach((x, i) => parts.push(`- ${i + 1}. ${x.player}: ${x.value}`));

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
      parts.push("\nTop serve-receive passing rating (weighted by attempts):");
      sr.forEach((x, i) =>
        parts.push(`- ${i + 1}. ${x.player}: ${x.rating.toFixed(2)} (attempts: ${x.attempts})`)
      );
    }
  }

  return parts.join("\n");
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
      max_output_tokens: 700,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: `
You are a volleyball Coaching Assistant for MVVC 14 Black.

Formatting:
- Use clear section headers and spacing.
- Underline headers with dashes.
- Make player names stand out using **Name** (bold).
- Do NOT show citations like S3/K2/etc.

Rules:
- Use ONLY the provided CONTEXT to state facts.
- If the CONTEXT lacks the needed numbers, say: "Insufficient data in the current dataset."
- Prefer short bullets over long paragraphs.
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
  const out = json.output ?? [];
  let text = "";

  for (const item of out) {
    const content = item.content ?? [];
    for (const c of content) {
      if (c.type === "output_text" && typeof c.text === "string") text += c.text;
    }
  }

  return (text || "").trim() || "No answer generated.";
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

    const answer = await callOpenAI(question, ctx);
    return NextResponse.json({ answer });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
