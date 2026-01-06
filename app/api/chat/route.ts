import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

/* ============================
   Types
============================ */
type Msg = {
  role: "user" | "assistant";
  content: string;
};

/* ============================
   Constants (hard-coded team)
============================ */
const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5";
const DEFAULT_SEASON: "fall" | "spring" | "summer" = "spring";

/* ============================
   Utilities
============================ */
function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

/**
 * Player name highlighting (subtle)
 * - wraps known player names in **bold**
 * - avoids double-bolding
 */
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
  let result = text;

  for (const name of PLAYER_NAMES) {
    // Full word match; avoid re-wrapping if already bolded.
    // This is intentionally simple and reliable.
    const re = new RegExp(`\\b${name}\\b`, "g");
    result = result.replace(re, (match, offset) => {
      const before = result.slice(Math.max(0, offset - 2), offset);
      const after = result.slice(offset + match.length, offset + match.length + 2);
      if (before === "**" && after === "**") return match; // already bolded
      return `**${match}**`;
    });
  }

  return result;
}

/**
 * Final formatting pass for readability:
 * - removes citation noise
 * - adds spacing between sections
 * - ensures bullets render cleanly
 * - highlights player names
 */
function formatForChat(text: string) {
  const cleaned = text
    .replace(/\s*\[(?:K|M|S)\d+\]\s*/g, " ")
    .replace(/\bFACT:\b/g, "\nFACT:\n")
    .replace(/\bPROJECTION:\b/g, "\nPROJECTION:\n")
    .replace(/\bNext steps\b/gi, "\nNext steps:\n")
    .replace(/FACT\s+—/g, "\nFACT —")
    .replace(/PROJECTION\s+—/g, "\nPROJECTION —")
    .replace(/\s-\s/g, "\n- ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return highlightPlayerNames(cleaned);
}

/* ============================
   Position awareness (coach context)
============================ */
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

/* ============================
   Context retrieval (notes + rules)
============================ */
async function retrieveContext(question: string) {
  const supabase = supabaseService();

  // Always include roster chunks
  const { data: rosterChunks } = await supabase
    .from("knowledge_chunks")
    .select("title,content")
    .eq("team_id", TEAM_ID)
    .contains("tags", ["roster"])
    .limit(5);

  // Season-specific search
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

/* ============================
   Stats aggregation (CSV-backed)
============================ */
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

  // Map common questions to keys in stats JSON
  const synonymRules: Array<{ re: RegExp; key: string; label: string }> = [
    {
      re: /passer rating|serve receive rating|sr rating/i,
      key: "serve_receive_passing_rating",
      label: "Serve-receive passing rating (0–3)",
    },
    { re: /\bkills?\b/i, key: "attack_kills", label: "Kills" },
    { re: /\bdigs?\b/i, key: "digs_successful", label: "Digs" },
    { re: /\baces?\b/i, key: "serve_aces", label: "Serve aces" },
    { re: /serve errors?/i, key: "serve_errors", label: "Serve errors" },
    { re: /blocks?\b/i, key: "blocks_solo", label: "Blocks (solo, if present)" },
  ];

  const match = synonymRules.find((r) => r.re.test(q));
  if (!match) return "";

  const totals: Record<string, number> = {};
  for (const row of rows) {
    const v = toNum(row.stats?.[match.key]);
    if (v === null) continue;
    totals[row.player_name] = (totals[row.player_name] ?? 0) + v;
  }

  const ranked = Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (ranked.length === 0) return "";

  let out = `FACT — ${match.label} leaders (season total)\n`;
  for (const [player, value] of ranked) out += `- ${player}: ${value}\n`;
  return out;
}

/* ============================
   OpenAI call (Responses API)
============================ */
async function callOpenAI(question: string, messages: Msg[] | undefined, context: string) {
  assertEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";

  const recent = (messages ?? []).slice(-10);

  const systemText = `
You are the Coaching Assistant for MVVC 14 Black.

Rules:
- Use ONLY the provided context and stats facts.
- If data is insufficient, say so clearly.
- Be concise, coach-friendly, and structured.
- Use clear sections and bullet points.
- DO NOT include citation references like [S3] or [K2].

Stat semantics:
- serve_receive_passing_rating is a 0–3 scale.
- Percentage fields may be stored as 0–1; if you see those, report as percentages.
`.trim();

  // IMPORTANT: In Responses API history:
  // user => input_text
  // assistant => output_text
  const history = recent.map((m) => ({
    role: m.role,
    content: [
      {
        type: m.role === "assistant" ? "output_text" : "input_text",
        text: m.content,
      },
    ],
  }));

  const input = [
    {
      role: "system",
      content: [{ type: "input_text", text: systemText }],
    },
    ...history,
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: `Question: ${question}\n\nContext:\n${context}`,
        },
      ],
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

/* ============================
   API handler
============================ */
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
    }

    if (statsFacts) {
      context += `\n${statsFacts}\n`;
    }

    context += "\nPlayer positions:\n";
    for (const [p, pos] of Object.entries(PLAYER_POSITIONS)) {
      context += `- ${p}: ${pos.join(", ")}\n`;
    }

    const rawAnswer = await callOpenAI(question, body.messages, context);
    const answer = formatForChat(rawAnswer);

    return NextResponse.json({ answer });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
