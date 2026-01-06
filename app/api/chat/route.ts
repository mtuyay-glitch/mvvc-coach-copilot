import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

// Remove [K12], [M3], [S5] style tags from output
function stripCitations(text: string) {
  return text
    .replace(/\s*\[(?:K|M|S)\d+\]\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function retrieveContext(teamId: string, season: string, question: string) {
  const supabase = supabaseService();

  // 1) Always fetch roster chunks
  const { data: rosterChunks, error: er } = await supabase
    .from("knowledge_chunks")
    .select("id,title,content,tags")
    .eq("team_id", teamId)
    .contains("tags", ["roster"])
    .limit(5);

  if (er) throw er;

  // 2) Fetch relevant notes/rules by search
  const cleaned = question.replace(/[^a-zA-Z0-9 ]/g, " ");
  const { data: searchChunks, error: e1 } = await supabase
    .from("knowledge_chunks")
    .select("id,title,content,tags")
    .eq("team_id", teamId)
    .eq("season", season)
    .textSearch("tsv", cleaned, { type: "websearch" })
    .limit(6);

  if (e1) throw e1;

  // Merge + dedupe
  const mergedMap = new Map<number, any>();
  (rosterChunks ?? []).forEach((c: any) => mergedMap.set(c.id, c));
  (searchChunks ?? []).forEach((c: any) => mergedMap.set(c.id, c));
  const chunks = Array.from(mergedMap.values());

  // 3) Optional precomputed metrics
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

  // Collect all keys
  const allKeysSet = new Set<string>();
  for (const r of rows) Object.keys(r.stats ?? {}).forEach((k) => allKeysSet.add(k));
  const allKeys = Array.from(allKeysSet);

  function toNum(v: any): number | null {
    const s = String(v ?? "").trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

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

  function isAlwaysSum(statKey: string): boolean {
    return ALWAYS_SUM_PATTERNS.some((re) => re.test(statKey));
  }
  function isAverage(statKey: string): boolean {
    return AVERAGE_PATTERNS.some((re) => re.test(statKey)) && !isAlwaysSum(statKey);
  }

  function weightKeyForStat(statKey: string): string | null {
    const k = statKey.toLowerCase();
    if (k.startsWith("serve_receive_")) return "serve_receive_attempts";
    if (k.startsWith("serve_")) return "serve_attempts";
    if (k.startsWith("attack_")) return "attack_attempts";
    if (k.startsWith("setting_")) return "setting_attempts";
    return null;
  }

  const synonymRules: Array<{ re: RegExp; candidates: string[] }> = [
    // SR rating (0–3)
    { re: /passer rating|passing rating|serve receive rating|sr rating/i, candidates: ["serve_receive_passing_rating"] },

    // SR percentages (stored as 0–1 fractions)
    { re: /perfect pass|perfect %/i, candidates: ["serve_receive_perfect_pass_percentage"] },
    { re: /good pass|good %/i, candidates: ["serve_receive_good_pass_percentage"] },
    { re: /passing percentage|pass percentage|pass %|percentage|%/i, candidates: ["serve_receive_good_pass_percentage", "serve_receive_perfect_pass_percentage"] },

    // Generic SR fallback
    { re: /\bserve receive\b|\bserve-receive\b|\bsr\b/i, candidates: ["serve_receive_passing_rating"] },

    // Common stats
    { re: /kill|kills/i, candidates: ["attack_kills"] },
    { re: /dig|digs/i, candidates: ["digs_successful"] },
    { re: /dig error|dig errors/i, candidates: ["dig_errors"] },
    { re: /ace|aces/i, candidates: ["serve_aces"] },
    { re: /serve error|serve errors/i, candidates: ["serve_errors"] },
    { re: /block|blocks/i, candidates: ["blocks_solo", "blocks_assist"] },
    { re: /attack error|hitting error|hit error/i, candidates: ["attack_errors"] },
    { re: /assist|assists/i, candidates: ["setting_assists"] },
  ];

  const directMatches = allKeys.filter((k) => q.includes(k.toLowerCase()));

  const synonymMatches: string[] = [];
  for (const rule of synonymRules) {
    if (!rule.re.test(question)) continue;
    for (const cand of rule.candidates) {
      const found = allKeys.find((k) => k.toLowerCase() === cand.toLowerCase());
      if (found) synonymMatches.push(found);
    }
  }

  const keySet = new Set<string>([...directMatches, ...synonymMatches]);

  let keys = Array.from(keySet);
  if (keys.length === 0) {
    const prefer = ["attack_kills", "digs_successful", "serve_aces", "serve_errors", "serve_receive_passing_rating"];
    for (const p of prefer) {
      const found = allKeys.find((k) => k.toLowerCase() === p.toLowerCase());
      if (found) keys.push(found);
      if (keys.length >= 6) break;
    }
  }
  keys = keys.slice(0, 6);

  // Detect player mention (optional)
  const uniquePlayers = Array.from(new Set(rows.map((r) => r.player_name)));
  const playerMention = uniquePlayers.find((p) => q.includes(p.toLowerCase())) ?? null;

  type PlayerAgg = { sum?: number; avgNumerator?: number; avgDenominator?: number; count?: number };
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
        byKey[k][player].sum = (byKey[k][player].sum ?? 0) + v;
      } else {
        const wKey = weightKeyForStat(k);
        const w = wKey ? toNum(stats[wKey]) : null;

        if (w !== null && w > 0) {
          byKey[k][player].avgNumerator = (byKey[k][player].avgNumerator ?? 0) + v * w;
          byKey[k][player].avgDenominator = (byKey[k][player].avgDenominator ?? 0) + w;
        } else {
          byKey[k][player].sum = (byKey[k][player].sum ?? 0) + v;
          byKey[k][player].count = (byKey[k][player].count ?? 0) + 1;
        }
      }
    }
  }

  function finalizeValue(statKey: string, agg: PlayerAgg): number {
    if (!isAverage(statKey) || isAlwaysSum(statKey)) return agg.sum ?? 0;
    if ((agg.avgDenominator ?? 0) > 0) return (agg.avgNumerator ?? 0) / (agg.avgDenominator ?? 1);
    const c = agg.count ?? 0;
    return c > 0 ? (agg.sum ?? 0) / c : 0;
  }

  function formatValue(statKey: string, value: number): string {
    const k = statKey.toLowerCase();
    if (k.includes("percentage")) return `${(value * 100).toFixed(1)}%`; // 0–1 -> %
    if (k.endsWith("_rating")) return value.toFixed(2); // e.g., 0–3 ratings
    if (k.includes("efficiency") || k.includes("per_set")) return value.toFixed(2);
    if (Math.abs(value - Math.round(value)) < 1e-9) return String(Math.round(value));
    return value.toFixed(2);
  }

  // Build context facts WITH internal [S#] (model uses these),
  // but we will strip them from the final user answer.
  const lines: string[] = [];
  lines.push(`## Retrieved stats from imported CSV rows (cite by [S#])`);
  lines.push(`[S1] Team=${teamId} Season=${season} Rows=${rows.length}`);
  lines.push(`[S2] Keys selected for this question: ${keys.join(", ") || "(none)"}`);

  let sIndex = 3;

  if (playerMention && keys.length) {
    for (const k of keys) {
      const agg = byKey[k][playerMention];
      if (!agg) continue;
      const val = finalizeValue(k, agg);
      lines.push(`[S${sIndex}] ${playerMention}.${k} = ${formatValue(k, val)}`);
      sIndex++;
    }
  }

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
      const val = (m.metric_value ?? "") !== "" ? String(m.metric_value) : String(m.metric_text ?? "");
      ctx.push(`[M${i + 1}] ${m.player_name}.${m.metric_key} = ${val}`);
    });
  }

  if (statsFacts) ctx.push("\n" + statsFacts);

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
- Use ONLY the retrieved context/metrics/stats facts for factual claims.
- If the data does not contain the needed numbers, say: "Insufficient data in the current dataset."
- Be concise and coach-friendly.
- Distinguish FACT vs PROJECTION.
- IMPORTANT: Do NOT include citation tags like [K1], [M2], [S3] in your final answer. (They are internal.)`,
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
    const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5";
    const DEFAULT_SEASON: "fall" | "spring" | "summer" = "spring"; // change if needed

    const body = (await req.json()) as { question: string };
    const question = (body.question ?? "").trim();
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    const { chunks, metrics } = await retrieveContext(TEAM_ID, DEFAULT_SEASON, question);
    const { statsFacts } = await retrieveStatsFacts(TEAM_ID, DEFAULT_SEASON, question);

    const ctx = formatContext(chunks, metrics, statsFacts);
    const rawAnswer = await callOpenAI(question, ctx);

    // Final safety: strip any leftover [K#]/[M#]/[S#] the model might output
    const answer = stripCitations(rawAnswer);

    return NextResponse.json({ answer });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
