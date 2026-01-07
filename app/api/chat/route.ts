import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black
const DEFAULT_SEASON: "fall" | "spring" | "summer" = "fall";

function isResultsQuestion(q: string) {
  const s = q.toLowerCase();
  return (
    s.includes("win") ||
    s.includes("loss") ||
    s.includes("record") ||
    s.includes("results") ||
    s.includes("score") ||
    s.includes("tournament") ||
    s.includes("pool") ||
    s.includes("bracket")
  );
}

function isRosterQuestion(q: string) {
  const s = q.toLowerCase();
  return s.includes("roster") || s.includes("on the team") || s.includes("players");
}

async function retrieveContext(teamId: string, season: string, question: string) {
  const supabase = supabaseService();

  // --- A) Roster notes always (small + useful)
  const { data: rosterChunks, error: er } = await supabase
    .from("knowledge_chunks")
    .select("id,title,content,tags")
    .eq("team_id", teamId)
    .contains("tags", ["roster"])
    .limit(5);
  if (er) throw er;

  // --- B) Season-specific notes by search (only if it’s not purely roster/results)
  let searchChunks: any[] = [];
  const cleaned = question.replace(/[^a-zA-Z0-9 ]/g, " ").trim();

  if (cleaned && !isRosterQuestion(question)) {
    const { data, error: e1 } = await supabase
      .from("knowledge_chunks")
      .select("id,title,content,tags")
      .eq("team_id", teamId)
      .eq("season", season)
      .textSearch("tsv", cleaned, { type: "websearch" })
      .limit(6);
    if (e1) throw e1;
    searchChunks = data ?? [];
  }

  // Merge + dedupe
  const mergedMap = new Map<number, any>();
  (rosterChunks ?? []).forEach((c: any) => mergedMap.set(c.id, c));
  (searchChunks ?? []).forEach((c: any) => mergedMap.set(c.id, c));
  const chunks = Array.from(mergedMap.values());

  // --- C) Match results (always load; small table, high value)
  const { data: matches, error: em } = await supabase
    .from("match_results")
    .select("match_date,tournament,opponent,result,score,round,sets_won,sets_lost,set_diff")
    .eq("team_id", teamId)
    .order("match_date", { ascending: true })
    .limit(400);
  if (em) throw em;

  // --- D) Player stats: ONLY load when question seems stats-related (keeps it fast)
  // If the question is about win/loss/record/results, skip big stats payload.
  let statsRows: any[] = [];
  if (!isResultsQuestion(question)) {
    const { data, error: es } = await supabase
      .from("player_game_stats")
      .select("player_name,position,game_date,opponent,stats")
      .eq("team_id", teamId)
      .eq("season", season)
      .order("game_date", { ascending: false })
      .limit(180);
    if (es) throw es;
    statsRows = data ?? [];
  }

  return { chunks: chunks ?? [], matches: matches ?? [], statsRows: statsRows ?? [] };
}

function prettyContext(chunks: any[], matches: any[], statsRows: any[]) {
  const parts: string[] = [];

  if (chunks.length) {
    parts.push("=== TEAM NOTES / ROSTER ===");
    for (const c of chunks) {
      parts.push(`- ${c.title}\n${c.content}`);
    }
  }

  if (matches.length) {
    parts.push("\n=== MATCH RESULTS (WIN/LOSS) ===");
    for (const m of matches) {
      const d = m.match_date ? String(m.match_date) : "";
      const t = m.tournament ?? "";
      const r = m.result ?? "";
      const opp = m.opponent ?? "";
      const sc = m.score ? ` | ${m.score}` : "";
      const rd = m.round ? ` | ${m.round}` : "";
      parts.push(`- ${d} | ${t}${rd} | ${r} vs ${opp}${sc}`);
    }
  }

  if (statsRows.length) {
    parts.push("\n=== PLAYER GAME STATS (ROWS) ===");
    for (const s of statsRows) {
      const d = s.game_date ? String(s.game_date) : "";
      const opp = s.opponent ?? "";
      const name = s.player_name ?? "";
      const pos = s.position ? ` (${s.position})` : "";
      // Keep JSON compact
      const statsJson = JSON.stringify(s.stats ?? {});
      parts.push(`- ${d} vs ${opp} | ${name}${pos} | stats: ${statsJson}`);
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
      max_output_tokens: 750,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: `
You are a volleyball Coaching Assistant for MVVC 14 Black.

Formatting requirements:
- Use clear section headers with spacing.
- Underline each header with dashes on the next line.
- Use short bullets (avoid dense paragraphs).
- Make player names stand out by wrapping them like: **Anson** (bold).
- Do NOT show citations like S3/K2/etc.

Data rules:
- Use ONLY the provided CONTEXT for facts.
- You MAY do simple arithmetic / aggregation on the provided match_results and stats:
  - count wins/losses
  - sum sets won/lost
  - compute win % or set win %
- Do NOT invent matches, scores, or stats.
- If the context truly lacks needed data, say exactly: "Insufficient data in the current dataset."
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

  // Robust extraction (handles output_text and refusal)
  const out = json.output ?? [];
  let text = "";

  for (const item of out) {
    const content = item.content ?? [];
    for (const c of content) {
      if (c.type === "output_text" && typeof c.text === "string") text += c.text;
      if (c.type === "refusal" && typeof c.refusal === "string") text += c.refusal;
    }
  }

  const cleaned = (text || "").trim();

  // Fallback to avoid "No answer generated."
  return cleaned.length ? cleaned : "Insufficient data in the current dataset.";
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
