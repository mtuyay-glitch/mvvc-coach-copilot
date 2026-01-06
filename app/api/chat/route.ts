import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

async function retrieveContext(teamId: string, season: string, question: string) {
  const supabase = supabaseService();

  // 1) Always fetch roster chunks (so roster questions work)
  const { data: rosterChunks, error: er } = await supabase
    .from("knowledge_chunks")
    .select("id,title,content,tags")
    .eq("team_id", teamId)
    .contains("tags", ["roster"])
    .limit(5);

  if (er) throw er;

  // 2) Fetch relevant notes/rules by search (season-specific)
  const cleaned = question.replace(/[^a-zA-Z0-9 ]/g, " ");
  const { data: searchChunks, error: e1 } = await supabase
    .from("knowledge_chunks")
    .select("id,title,content,tags")
    .eq("team_id", teamId)
    .eq("season", season)
    .textSearch("tsv", cleaned, { type: "websearch" })
    .limit(6);

  if (e1) throw e1;

  // Merge + dedupe (by id)
  const mergedMap = new Map<number, any>();
  (rosterChunks ?? []).forEach((c: any) => mergedMap.set(c.id, c));
  (searchChunks ?? []).forEach((c: any) => mergedMap.set(c.id, c));
  const chunks = Array.from(mergedMap.values());

  // 3) Metrics (precomputed)
  const nameCandidates = Array.from(
    new Set((question.match(/\b[A-Z][a-z]+\b/g) ?? []).slice(0, 6))
  );
  const playerNames = nameCandidates.length ? nameCandidates : [];

  const { data: metrics, error: e2 } = await supabase
    .from("player_metrics")
    .select("player_name,metric_key,metric_value,metric_text")
    .eq("team_id", teamId)
    .eq("season", season)
    .in("player_name", ["__TEAM__", ...playerNames])
    .limit(200);

  if (e2) throw e2;

  return { chunks: chunks ?? [], metrics: metrics ?? [] };
}

/**
 * Pull stats from imported CSV rows in player_game_stats and summarize into compact "facts".
 * Works for ANY question by:
 * - detecting relevant stat keys from the question (and common synonyms)
 * - aggregating totals by player for those keys
 * - returning top leaderboards
 */
async function retrieveStatsFacts(teamId: string, season: string, question: string) {
  const supabase = supabaseService();

  const { data, error } = await supabase
    .from("player_game_stats")
    .select("player_name, stats")
    .eq("team_id", teamId)
    .eq("season", season)
    .limit(100000);

  if (error) throw error;

  const rows = data ?? [];
  if (!rows.length) {
    return { statsFacts: "", hasStats: false };
  }

  // Collect all stat keys seen in the JSON stats
  const allKeysSet = new Set<string>();
  for (const r of rows) {
    const stats = (r as any).stats ?? {};
    for (const k of Object.keys(stats)) allKeysSet.add(k);
  }
  const allKeys = Array.from(allKeysSet);

  const q = question.toLowerCase();

  // Synonyms -> likely key name fragments
  const synonymRules: Array<{ re: RegExp; candidates: string[] }> = [
    { re: /kill|kills|hitting|hit/i, candidates: ["kills", "kill", "k"] },
    { re: /ace|aces|serve/i, candidates: ["aces", "ace"] },
    { re: /block|blocks/i, candidates: ["blocks", "block"] },
    { re: /dig|digs/i, candidates: ["digs", "dig"] },
    { re: /assist|assists|set/i, candidates: ["assists", "assist", "ast"] },
    { re: /error|errors/i, candidates: ["errors", "error", "err"] },
    { re: /attempt|attempts|att/i, candidates: ["attempt", "attempts", "att"] },
    { re: /pass|passing|serve receive|sr/i, candidates: ["pass", "passing", "serve receive", "sr"] },
    { re: /rating|grade/i, candidates: ["rating", "grade"] },
  ];

  // Pick relevant keys:
  // 1) direct substring match from question
  const directMatches = allKeys.filter((k) => q.includes(k.toLowerCase()));

  // 2) synonym match: if question matches a concept, include keys containing those fragments
  const synonymMatches: string[] = [];
  for (const rule of synonymRules) {
    if (!rule.re.test(question)) continue;
    for (const frag of rule.candidates) {
      for (const k of allKeys) {
        if (k.toLowerCase().includes(frag)) synonymMatches.push(k);
      }
    }
  }

  // Combine + dedupe
  const keySet = new Set<string>([...directMatches, ...synonymMatches]);

  // If still nothing, choose up to 6 numeric-looking keys by sampling
  let keys = Array.from(keySet);
  if (keys.length === 0) {
    const numericKeys: string[] = [];
    for (const k of allKeys) {
      let hits = 0;
      for (const r of rows) {
        const stats = (r as any).stats ?? {};
        const raw = stats[k];
        const s = String(raw ?? "").trim();
        if (!s) continue;
        const n = Number(s);
        if (Number.isFinite(n)) hits++;
        if (hits >= 4) break;
      }
      if (hits >= 3) numericKeys.push(k);
      if (numericKeys.length >= 6) break;
    }
    keys = numericKeys;
  }

  // Cap keys so we don't overload context
  keys = keys.slice(0, 6);

  if (keys.length === 0) {
    return { statsFacts: "", hasStats: true };
  }

  // Aggregate totals per player for selected keys
  const totalsByPlayer: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const player = (r as any).player_name as string;
    const stats = ((r as any).stats ?? {}) as Record<string, any>;
    totalsByPlayer[player] ??= {};

    for (const k of keys) {
      const raw = stats[k];
      const s = String(raw ?? "").trim();
      if (!s) continue;
      const n = Number(s);
      if (!Number.isFinite(n)) continue;
      totalsByPlayer[player][k] = (totalsByPlayer[player][k] ?? 0) + n;
    }
  }

  // Build compact facts with [S#] citations
  const lines: string[] = [];
  lines.push(`## Retrieved stats from imported CSV rows (cite by [S#])`);
  lines.push(`[S1] Team=${teamId} Season=${season} Rows=${rows.length}`);
  lines.push(`[S2] Keys selected for this question: ${keys.join(", ")}`);

  let sIndex = 3;
  for (const k of keys) {
    const leaderboard = Object.entries(totalsByPlayer)
      .map(([player_name, obj]) => ({ player_name, value: obj[k] ?? 0 }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);

    const formatted = leaderboard.map((x) => `${x.player_name}=${x.value}`).join(" | ");
    lines.push(`[S${sIndex}] Top ${k}: ${formatted}`);
    sIndex++;
  }

  return { statsFacts: lines.join("\n"), hasStats: true };
}

function formatContext(chunks: any[], metrics: any[], statsFacts: string) {
  const ctx: string[] = [];

  if (chunks.length) {
    ctx.push("## Retrieved coaching notes / rules (cite by [K#])");
    chunks.forEach((c, i) => {
      ctx.push(`[K${i + 1}] ${c.title}\n${c.content}`);
    });
  }

  if (metrics.length) {
    ctx.push("\n## Retrieved metrics (cite by [M#])");
    metrics.forEach((m, i) => {
      const val =
        (m.metric_value ?? "") !== ""
          ? String(m.metric_value)
          : String(m.metric_text ?? "");
      ctx.push(`[M${i + 1}] ${m.player_name}.${m.metric_key} = ${val}`);
    });
  }

  if (statsFacts) {
    ctx.push("\n" + statsFacts);
  }

  return ctx.join("\n\n");
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
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: `You are a team-private volleyball analytics assistant for coaches.
Rules:
- Use ONLY the provided Retrieved context + metrics + stats facts for factual claims.
- If the context does not contain the needed numbers, say: "Insufficient data in the current dataset."
- Always back decisions with numbers and cite them using [K#] or [M#] or [S#].
- Be concise and coach-friendly.
- Distinguish FACT (supported by [K#]/[M#]/[S#]) vs PROJECTION (your inference).`,
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: `Question: ${question}\n\n${context}` }],
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
  return text.trim() || "No answer generated.";
}

export async function POST(req: Request) {
  try {
    // Hard-coded team + season for your service
    const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5";
    const DEFAULT_SEASON = "spring"; // change to "fall" if you want Fall data by default

    const body = (await req.json()) as { question: string };
    const question = (body.question ?? "").trim();

    if (!question) {
      return NextResponse.json({ error: "question is required" }, { status: 400 });
    }

    const teamId = TEAM_ID;
    const season = DEFAULT_SEASON;

    const { chunks, metrics } = await retrieveContext(teamId, season, question);
    const { statsFacts } = await retrieveStatsFacts(teamId, season, question);

    const ctx = formatContext(chunks, metrics, statsFacts);

    const answer = await callOpenAI(question, ctx);

    return NextResponse.json({ answer });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
