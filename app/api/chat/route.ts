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

  // 3) Precomputed metrics (optional)
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
 * Stats retrieval from player_game_stats.stats JSON:
 * - Automatically selects relevant keys for ANY question
 * - Sums count stats
 * - Computes weighted averages for ratings/percentages when possible
 * - Formats % fields stored as 0–1 into 0–100%
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

  const rows = (data ?? []) as Array<{ player_name: string; stats: Record<string, any> }>;
  if (!rows.length) return { statsFacts: "", hasStats: false };

  const q = question.toLowerCase();

  // Collect all stat keys present
  const allKeysSet = new Set<string>();
  for (const r of rows) {
    const stats = r.stats ?? {};
    Object.keys(stats).forEach((k) => allKeysSet.add(k));
  }
  const allKeys = Array.from(allKeysSet);

  // Helper: parse numbers safely (stats are often strings)
  function toNum(v: any): number | null {
    const s = String(v ?? "").trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
    }

  // Which stats are "sum" (counts) vs "average"
  const ALWAYS_SUM_PATTERNS: RegExp[] = [
    /_kills$/i,
    /_errors$/i,
    /_aces$/i,
    /_attempts$/i,
    /_successful$/i,
    /_solo$/i,
    /_assist$/i,
    /_count$/i,
    /points_plus_minus/i,
  ];

  // Ratings & percentages to average (not sum)
  const AVERAGE_PATTERNS: RegExp[] = [
    /_rating$/i,
    /_percentage$/i,
    /_in_percentage$/i,
    /_kill_percentage$/i,
    /_error_percentage$/i,
    /_efficiency$/i,
    /_percentage_transition$/i,
    /_percentage_first_ball_sideout$/i,
  ];

  // Weighting rules (key -> weight key)
  function weightKeyForStat(statKey: string): string | null {
    const k = statKey.toLowerCase();
    if (k.startsWith("serve_receive_")) return "serve_receive_attempts";
    if (k.startsWith("serve_")) return "serve_attempts";
    if (k.startsWith("attack_")) return "attack_attempts";
    if (k.startsWith("setting_")) return "setting_attempts";
    return null;
  }

  // A volleyball-aware synonym map so we pick the right keys.
  // IMPORTANT: "passer rating" MUST map to serve_receive_passing_rating (0–3 scale).
  const synonymRules: Array<{ re: RegExp; candidates: string[] }> = [
    { re: /passer rating|passing rating|serve receive rating|sr rating/i, candidates: ["serve_receive_passing_rating"] },

    // Percent questions (your CSV stores these as 0–1 fractions)
    { re: /perfect pass|perfect %/i, candidates: ["serve_receive_perfect_pass_percentage"] },
    { re: /good pass|good %/i, candidates: ["serve_receive_good_pass_percentage"] },
    { re: /passing percentage|pass percentage|pass %|percentage|%/i, candidates: ["serve_receive_good_pass_percentage", "serve_receive_perfect_pass_percentage"] },

    // Generic SR fallback
    { re: /\bserve receive\b|\bserve-receive\b|\bsr\b/i, candidates: ["serve_receive_passing_rating"] },

    // Common team questions
    { re: /kill|kills/i, candidates: ["attack_kills"] },
    { re: /dig|digs/i, candidates: ["digs_successful"] },
    { re: /dig error|dig errors/i, candidates: ["dig_errors"] },
    { re: /ace|aces/i, candidates: ["serve_aces"] },
    { re: /serve error|serve errors/i, candidates: ["serve_errors"] },
    { re: /block|blocks/i, candidates: ["blocks_solo", "blocks_assist"] },
    { re: /attack error|hitting error|hit error/i, candidates: ["attack_errors"] },
    { re: /assist|assists/i, candidates: ["setting_assists"] },
  ];

  // 1) Direct key substring matches
  const directMatches = allKeys.filter((k) => q.includes(k.toLowerCase()));

  // 2) Synonym matches
  const synonymMatches: string[] = [];
  for (const rule of synonymRules) {
    if (!rule.re.test(question)) continue;
    for (const cand of rule.candidates) {
      for (const realKey of allKeys) {
        if (realKey.toLowerCase() === cand.toLowerCase()) synonymMatches.push(realKey);
      }
    }
  }

  // Combine + dedupe
  const keySet = new Set<string>([...directMatches, ...synonymMatches]);

  // If nothing matched, pick a few “useful” keys by heuristic (limit to keep context small)
  let keys = Array.from(keySet);
  if (keys.length === 0) {
    const prefer = [
      "attack_kills",
      "attack_errors",
      "digs_successful",
      "serve_aces",
      "serve_errors",
      "serve_receive_passing_rating",
    ];
    for (const p of prefer) {
      const found = allKeys.find((k) => k.toLowerCase() === p.toLowerCase());
      if (found) keys.push(found);
      if (keys.length >= 6) break;
    }
  }

  keys = keys.slice(0, 6);

  // Try to detect a specific player mentioned
  const uniquePlayers = Array.from(new Set(rows.map((r) => r.player_name)));
  const playerMention =
    uniquePlayers.find((p) => q.includes(p.toLowerCase())) ??
    null;

  // Aggregators:
  // - SUM: per player sum
  // - AVG: per player weighted avg if weight exists, else simple avg across rows with values
  type PlayerAgg = {
    sum?: number;
    avgNumerator?: number;
    avgDenominator?: number;
    count?: number; // for unweighted avg
  };

  function isAlwaysSum(statKey: string): boolean {
    return ALWAYS_SUM_PATTERNS.some((re) => re.test(statKey));
  }
  function isAverage(statKey: string): boolean {
    return AVERAGE_PATTERNS.some((re) => re.test(statKey)) && !isAlwaysSum(statKey);
  }

  // Compute per-player aggregations for each key
  const byKey: Record<string, Record<string, PlayerAgg>> = {};
  for (const k of keys) byKey[k] = {};

  for (const r of rows) {
    const player = r.player_name;
    const stats = r.stats ?? {};

    for (const k of keys) {
      const v = toNum(stats[k]);
      if (v === null) continue;

      byKey[k][player] ??= {};

      if (!isAverage(k) || isAlwaysSum(k)) {
        // SUM behavior
        byKey[k][player].sum = (byKey[k][player].sum ?? 0) + v;
      } else {
        // AVG behavior (weighted if possible)
        const wKey = weightKeyForStat(k);
        const w = wKey ? toNum(stats[wKey]) : null;

        if (w !== null && w > 0) {
          byKey[k][player].avgNumerator = (byKey[k][player].avgNumerator ?? 0) + v * w;
          byKey[k][player].avgDenominator = (byKey[k][player].avgDenominator ?? 0) + w;
        } else {
          // fallback: simple average
          byKey[k][player].sum = (byKey[k][player].sum ?? 0) + v;
          byKey[k][player].count = (byKey[k][player].count ?? 0) + 1;
        }
      }
    }
  }

  function finalizeValue(statKey: string, agg: PlayerAgg): number {
    if (!isAverage(statKey) || isAlwaysSum(statKey)) {
      return agg.sum ?? 0;
    }
    if ((agg.avgDenominator ?? 0) > 0) {
      return (agg.avgNumerator ?? 0) / (agg.avgDenominator ?? 1);
    }
    const c = agg.count ?? 0;
    return c > 0 ? (agg.sum ?? 0) / c : 0;
  }

  function formatValue(statKey: string, value: number): string {
    const k = statKey.toLowerCase();

    // percentages stored as fractions (0–1) in your CSV
    if (k.endsWith("_percentage") || k.includes("percentage")) {
      const pct = value * 100;
      return `${pct.toFixed(1)}%`;
    }

    // ratings (0–3, or similar) should show 2 decimals
    if (k.endsWith("_rating")) return value.toFixed(2);

    // efficiencies & ratios: 2 decimals
    if (k.includes("efficiency") || k.includes("per_set") || k.includes("percentage_transition")) {
      return value.toFixed(2);
    }

    // default: integer-ish for sums
    if (Math.abs(value - Math.round(value)) < 1e-9) return String(Math.round(value));
    return value.toFixed(2);
  }

  // Build compact facts with [S#]
  const lines: string[] = [];
  lines.push(`## Retrieved stats from imported CSV rows (cite by [S#])`);
  lines.push(`[S1] Team=${teamId} Season=${season} Rows=${rows.length}`);
  lines.push(`[S2] Keys selected for this question: ${keys.join(", ") || "(none)"}`);

  let sIndex = 3;

  // If player mentioned, include that player's values first
  if (playerMention && keys.length) {
    for (const k of keys) {
      const agg = byKey[k][playerMention];
      if (!agg) continue;
      const val = finalizeValue(k, agg);
      lines.push(`[S${sIndex}] ${playerMention}.${k} = ${formatValue(k, val)}`);
      sIndex++;
    }
  }

  // Leaderboards (top 6) for each selected key
  for (const k of keys) {
    const entries = Object.entries(byKey[k])
      .map(([player, agg]) => ({ player, value: finalizeValue(k, agg) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);

    if (!entries.length) continue;

    const formatted = entries.map((e) => `${e.player}=${formatValue(k, e.value)}`).join(" | ");
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
- Distinguish FACT (supported by [K#]/[M#]/[S#]) vs PROJECTION (your inference).
Important stat semantics:
- serve_receive_passing_rating is a 0–3 scale rating (average, not %).
- *_percentage fields are stored as 0–1 fractions; report them as 0–100%.`,
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

    // IMPORTANT: set this to the season your latest import used
    // If you imported as "spring", keep "spring". If you imported as "fall", use "fall".
    const DEFAULT_SEASON: "fall" | "spring" | "summer" = "spring";

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
