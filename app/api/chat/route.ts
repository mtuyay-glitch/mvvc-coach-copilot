import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

type Req = { teamId: string; season: "fall" | "spring" | "summer"; question: string };

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

async function retrieveContext(teamId: string, season: string, question: string) {
  const supabase = supabaseService();

  // 1) Knowledge chunks (narrative + rules)
  const { data: chunks, error: e1 } = await supabase
    .from("knowledge_chunks")
    .select("id,title,content,tags")
    .eq("team_id", teamId)
    .eq("season", season)
    .textSearch("tsv", question.replace(/[^a-zA-Z0-9 ]/g, " "), { type: "websearch" })
    .limit(6);

  if (e1) throw e1;

  // 2) Metrics (numbers)
  // Simple heuristic: pull metrics for any mentioned player names (capitalized words),
  // plus team-wide metrics (player_name = '__TEAM__').
  const nameCandidates = Array.from(new Set((question.match(/\b[A-Z][a-z]+\b/g) ?? []).slice(0, 6)));
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

function formatContext(chunks: any[], metrics: any[]) {
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
  return ctx.join("\n\n");
}

async function callOpenAI(question: string, context: string) {
  assertEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";

  // OpenAI Responses API
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "text",
              text:
`You are a team-private volleyball analytics assistant for coaches.
Rules:
- Use ONLY the provided Retrieved context + metrics for factual claims.
- If the context does not contain the needed numbers, say: "Insufficient data in the current dataset."
- Always back decisions with numbers and cite them using [K#] or [M#].
- Be concise and coach-friendly.
- Distinguish FACT (supported by [K#]/[M#]) vs PROJECTION (your inference).`
            }
          ]
        },
        {
          role: "user",
          content: [
            { type: "text", text: `Question: ${question}\n\n${context}` }
          ]
        }
      ]
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }
  const json = await res.json();

  // Responses API returns output in `output` array; pull text safely.
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
    const body = (await req.json()) as Req;
    const teamId = (body.teamId ?? "").trim();
    const season = body.season;
    const question = (body.question ?? "").trim();

    if (!teamId) return NextResponse.json({ error: "teamId is required" }, { status: 400 });
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    const { chunks, metrics } = await retrieveContext(teamId, season, question);
    const ctx = formatContext(chunks, metrics);

    const answer = await callOpenAI(question, ctx);

    return NextResponse.json({ answer });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
