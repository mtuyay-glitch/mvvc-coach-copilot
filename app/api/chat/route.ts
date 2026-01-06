import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

type Msg = { role: "user" | "assistant"; content: string };

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5";
const DEFAULT_SEASON: "fall" | "spring" | "summer" = "spring";

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

/* Player names to highlight */
const PLAYER_NAMES = [
  "Eric",
  "Brooks",
  "Cooper",
  "Troy",
  "Jayden",
  "Anson",
  "Bodhi",
  "Allen",
  "Koa",
  "Ryota",
  "Steven",
];

function highlightPlayerNames(text: string) {
  let out = text;

  for (const name of PLAYER_NAMES) {
    // Bold name if it's a standalone word and not already surrounded by *
    const re = new RegExp(`(^|[^*])\\b${name}\\b(?!\\*)`, "g");
    out = out.replace(re, `$1**${name}**`);
  }

  return out;
}

/**
 * Make answers readable:
 * - remove citations like [S3]
 * - enforce clean line breaks and section spacing
 * - normalize headings
 * - convert inline "- " into proper list lines
 * - bold player names (UI will render this)
 */
function formatForChat(raw: string) {
  let t = raw || "";

  // Remove citation noise
  t = t.replace(/\s*\[(?:K|M|S)\d+\]\s*/g, " ");

  // Normalize common headings / labels
  t = t
    .replace(/\bShort answer\b\s*:?/gi, "Short answer")
    .replace(/\bFACT\b\s*:?/g, "FACT:")
    .replace(/\bPROJECTION\b\s*:?/g, "PROJECTION:")
    .replace(/\bNext steps\b\s*:?\s*\.?/gi, "Next steps:");

  // Ensure headings start on their own lines
  t = t
    .replace(/(^|\n)\s*FACT:\s*/g, "\nFACT:\n")
    .replace(/(^|\n)\s*PROJECTION:\s*/g, "\nPROJECTION:\n")
    .replace(/(^|\n)\s*Next steps:\s*/gi, "\nNext steps:\n");

  // Ensure common section titles get space above them
  const sectionTitles = [
    "Short answer",
    "Roster snapshot",
    "Strengths",
    "Improvement areas",
    "Actionable Next steps",
    "What I cannot provide",
  ];
  for (const s of sectionTitles) {
    const re = new RegExp(`(^|\\n)\\s*${s}\\s*\\n?`, "gi");
    t = t.replace(re, `\n${s}\n`);
  }

  // Force bullets onto their own lines (handles " ... - item - item ")
  t = t.replace(/\s-\s/g, "\n- ");

  // Collapse weird spacing
  t = t
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Highlight names
  t = highlightPlayerNames(t);

  return t;
}

/* Optional positions context */
const PLAYER_POSITIONS: Record<string, string[]> = {
  Eric: ["MB", "RS"],
  Brooks: ["MB", "RS"],
  Cooper: ["MB", "S"],
  Troy: ["MB", "OH"],
  Jayden: ["OH"],
  Anson: ["OH"],
  Bodhi: ["OPP", "DS"],
  Allen: ["OPP"],
  Koa: ["S", "L", "DS"],
  Ryota: ["DS", "L"],
  Steven: ["S"],
};

async function retrieveContext(question: string) {
  const supabase = supabaseService();

  const { data: rosterChunks } = await supabase
    .from("knowledge_chunks")
    .select("title,content")
    .eq("team_id", TEAM_ID)
    .contains("tags", ["roster"])
    .limit(5);

  const cleaned = question.replace(/[^a-zA-Z0-9 ]/g, " ");
  const { data: searchChunks } = await supabase
    .from("knowledge_chunks")
    .select("title,content")
    .eq("team_id", TEAM_ID)
    .eq("season", DEFAULT_SEASON)
    .textSearch("tsv", cleaned, { type: "websearch" })
    .limit(6);

  return [...(rosterChunks ?? []), ...(searchChunks ?? [])];
}

async function retrieveStatsFacts(question: string) {
  const supabase = supabaseService();

  const { data, error } = await supabase
    .from("player_game_stats")
    .select("player_name, stats")
    .eq("team_id", TEAM_ID)
    .eq("season", DEFAULT_SEASON);

  if (error || !data || data.length === 0) return "";

  const rows = data as Array<{ player_name: string; stats: Record<string, any> }>;
  const q = question.toLowerCase();

  const toNum = (v: any) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const rules: Array<{ re: RegExp; key: string; label: string }> = [
    { re: /passer rating|serve receive rating|sr rating/i, key: "serve_receive_passing_rating", label: "Serve-receive passing rating (0–3) — totals" },
    { re: /\bkills?\b/i, key: "attack_kills", label: "Kills — totals" },
    { re: /\bdigs?\b/i, key: "digs_successful", label: "Digs — totals" },
    { re: /\baces?\b/i, key: "serve_aces", label: "Serve aces — totals" },
    { re: /serve errors?/i, key: "serve_errors", label: "Serve errors — totals" },
  ];

  const match = rules.find((r) => r.re.test(q));
  if (!match) return "";

  const totals: Record<string, number> = {};
  for (const row of rows) {
    const v = toNum(row.stats?.[match.key]);
    if (v === null) continue;
    totals[row.player_name] = (totals[row.player_name] ?? 0) + v;
  }

  const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (ranked.length === 0) return "";

  let out = `FACT — ${match.label}\n`;
  for (const [player, value] of ranked) out += `- ${player}: ${value}\n`;
  return out.trim();
}

async function callOpenAI(question: string, messages: Msg[] | undefined, context: string) {
  assertEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";

  const recent = (messages ?? []).slice(-10);

  const systemText = `
You are the Coaching Assistant for MVVC 14 Black.

Rules:
- Use ONLY the provided context and stats facts.
- If data is insufficient, say so clearly.
- Write for coaches: structured, readable, and actionable.
- Use headings and bullet points. Keep paragraphs short.
- DO NOT include citation references like [S3] or [K2].
- When you name a player, keep the name in plain text (we will highlight in UI).
`.trim();

  // Responses API: user=input_text, assistant=output_text for history
  const history = recent.map((m) => ({
    role: m.role,
    content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }],
  }));

  const input = [
    { role: "system", content: [{ type: "input_text", text: systemText }] },
    ...history,
    {
      role: "user",
      content: [{ type: "input_text", text: `Question: ${question}\n\nContext:\n${context}` }],
    },
  ];

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }

  const json = await res.json();

  let text = "";
  for (const item of json.output ?? []) {
    for (const c of item.content ?? []) {
      if (c.type === "output_text" && typeof c.text === "string") text += c.text;
    }
  }

  return text.trim() || "No answer generated.";
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { question: string; messages?: Msg[] };
    const question = (body.question ?? "").trim();
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    const chunks = await retrieveContext(question);
    const statsFacts = await retrieveStatsFacts(question);

    let context = "";

    if (chunks.length) {
      context += "Notes / roster context:\n";
      for (const c of chunks) context += `- ${c.title}: ${c.content}\n`;
      context += "\n";
    }

    if (statsFacts) {
      context += `${statsFacts}\n\n`;
    }

    context += "Player positions:\n";
    for (const [p, pos] of Object.entries(PLAYER_POSITIONS)) {
      context += `- ${p}: ${pos.join(", ")}\n`;
    }

    const raw = await callOpenAI(question, body.messages, context);
    const answer = formatForChat(raw);

    return NextResponse.json({ answer });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
