import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black
const DEFAULT_SEASON: "fall" | "spring" | "summer" = "fall"; // change if needed

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
  stats: Record<string, any> | null;
};

function toNum(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).trim();
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function normResult(r: string | null): "W" | "L" | "U" {
  const x = (r ?? "").toLowerCase();
  if (x.includes("won") || x === "w") return "W";
  if (x.includes("lost") || x === "l") return "L";
  return "U";
}

function safeName(s: any): string {
  const x = String(s ?? "").trim();
  return x || "Unknown";
}

function underline(title: string) {
  return `${title}\n${"-".repeat(Math.max(8, title.length))}`;
}

function parseSetDeltas(score: string | null): number[] {
  const text = (score ?? "").trim();
  if (!text) return [];
  const sets = text.split(",").map((x) => x.trim()).filter(Boolean);

  const deltas: number[] = [];
  for (const s of sets) {
    const m = s.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) deltas.push(Math.abs(a - b));
  }
  return deltas;
}

function computeMatchSummaries(matches: MatchRow[]) {
  let w = 0, l = 0, u = 0;
  let setsWon = 0, setsLost = 0;

  const byOpponent: Record<
    string,
    { w: number; l: number; setsWon: number; setsLost: number; closeSets: number; matches: number }
  > = {};
  const byTournament: Record<string, { w: number; l: number; matches: number }> = {};

  for (const m of matches) {
    const r = normResult(m.result);
    if (r === "W") w++;
    else if (r === "L") l++;
    else u++;

    setsWon += toNum(m.sets_won);
    setsLost += toNum(m.sets_lost);

    const opp = safeName(m.opponent);
    if (!byOpponent[opp]) byOpponent[opp] = { w: 0, l: 0, setsWon: 0, setsLost: 0, closeSets: 0, matches: 0 };
    byOpponent[opp].matches += 1;
    if (r === "W") byOpponent[opp].w += 1;
    if (r === "L") byOpponent[opp].l += 1;
    byOpponent[opp].setsWon += toNum(m.sets_won);
    byOpponent[opp].setsLost += toNum(m.sets_lost);

    const deltas = parseSetDeltas(m.score);
    byOpponent[opp].closeSets += deltas.filter((d) => d <= 2).length;

    const t = safeName(m.tournament);
    if (!byTournament[t]) byTournament[t] = { w: 0, l: 0, matches: 0 };
    byTournament[t].matches += 1;
    if (r === "W") byTournament[t].w += 1;
    if (r === "L") byTournament[t].l += 1;
  }

  const troubleOpponents = Object.entries(byOpponent)
    .map(([opponent, v]) => ({
      opponent,
      ...v,
      setDiff: v.setsWon - v.setsLost,
    }))
    .sort((a, b) =>
      (b.l - a.l) ||
      (a.setDiff - b.setDiff) ||
      (b.closeSets - a.closeSets) ||
      (b.matches - a.matches)
    )
    .slice(0, 8);

  const tournamentSummary = Object.entries(byTournament)
    .map(([tournament, v]) => ({ tournament, ...v }))
    .sort((a, b) => b.matches - a.matches);

  return {
    record: { w, l, u, setsWon, setsLost, setDiff: setsWon - setsLost },
    troubleOpponents,
    tournamentSummary,
  };
}

function computePlayerTotals(statsRows: StatRow[]) {
  const totals: Record<string, Record<string, number>> = {};

  for (const row of statsRows) {
    const name = safeName(row.player_name);
    if (!totals[name]) totals[name] = {};

    const s = row.stats ?? {};

    const kills = toNum(s["attack_kills"]);
    const digs = toNum(s["digs_successful"]);
    const aces = toNum(s["serve_aces"]);
    const srvErr = toNum(s["serve_errors"]);

    totals[name]["attack_kills"] = (totals[name]["attack_kills"] ?? 0) + kills;
    totals[name]["digs_successful"] = (totals[name]["digs_successful"] ?? 0) + digs;
    totals[name]["serve_aces"] = (totals[name]["serve_aces"] ?? 0) + aces;
    totals[name]["serve_errors"] = (totals[name]["serve_errors"] ?? 0) + srvErr;

    const srAtt = toNum(s["serve_receive_attempts"]);
    const srRating = toNum(s["serve_receive_passing_rating"]);

    if (srAtt > 0 && srRating > 0) {
      totals[name]["_sr_attempts"] = (totals[name]["_sr_attempts"] ?? 0) + srAtt;
      totals[name]["_sr_rating_sum"] = (totals[name]["_sr_rating_sum"] ?? 0) + srRating * srAtt;
    } else {
      const c0 = toNum(s["serve_receive_rating_0_count"]);
      const c1 = toNum(s["serve_receive_rating_1_count"]);
      const c2 = toNum(s["serve_receive_rating_2_count"]);
      const c3 = toNum(s["serve_receive_rating_3_count"]);
      const total = c0 + c1 + c2 + c3;
      if (total > 0) {
        totals[name]["_sr_attempts"] = (totals[name]["_sr_attempts"] ?? 0) + total;
        totals[name]["_sr_rating_sum"] =
          (totals[name]["_sr_rating_sum"] ?? 0) + (0 * c0 + 1 * c1 + 2 * c2 + 3 * c3);
      }
    }
  }

  const out: Array<{ player: string; totals: Record<string, number> }> = [];
  for (const player of Object.keys(totals)) out.push({ player, totals: totals[player] });

  function topBy(key: string, n = 6) {
    return [...out]
      .sort((a, b) => (b.totals[key] ?? 0) - (a.totals[key] ?? 0))
      .slice(0, n)
      .map((x) => ({ player: x.player, value: x.totals[key] ?? 0 }));
  }

  const srRatings = out
    .map((x) => {
      const att = x.totals["_sr_attempts"] ?? 0;
      const sum = x.totals["_sr_rating_sum"] ?? 0;
      return { player: x.player, sr_attempts: att, sr_rating: att > 0 ? sum / att : 0 };
    })
    .filter((x) => x.sr_attempts > 0)
    .sort((a, b) => b.sr_rating - a.sr_rating)
    .slice(0, 8);

  return {
    topKills: topBy("attack_kills", 8),
    topDigs: topBy("digs_successful", 8),
    topAces: topBy("serve_aces", 8),
    topServeErrors: topBy("serve_errors", 8),
    srRatings,
    rowsCount: statsRows.length,
  };
}

async function retrieveData(teamId: string, season: string, question: string) {
  const supabase = supabaseService();

  const { data: rosterChunks, error: er } = await supabase
    .from("knowledge_chunks")
    .select("id,title,content,tags")
    .eq("team_id", teamId)
    .contains("tags", ["roster"])
    .limit(5);
  if (er) throw er;

  const cleaned = question.replace(/[^a-zA-Z0-9 ]/g, " ");
  const { data: searchChunks, error: e1 } = await supabase
    .from("knowledge_chunks")
    .select("id,title,content,tags")
    .eq("team_id", teamId)
    .eq("season", season)
    .textSearch("tsv", cleaned, { type: "websearch" })
    .limit(6);
  if (e1) throw e1;

  const merged: Record<string, any> = {};
  (rosterChunks ?? []).forEach((c: any) => (merged[String(c.id)] = c));
  (searchChunks ?? []).forEach((c: any) => (merged[String(c.id)] = c));
  const chunks = Object.values(merged);

  const { data: matches, error: em } = await supabase
    .from("match_results")
    .select("match_date,tournament,opponent,result,score,round,sets_won,sets_lost,set_diff")
    .eq("team_id", teamId)
    .order("match_date", { ascending: true })
    .limit(600);
  if (em) throw em;

  const { data: statsRows, error: es } = await supabase
    .from("player_game_stats")
    .select("player_name,position,game_date,opponent,stats")
    .eq("team_id", teamId)
    .eq("season", season)
    .limit(2000);
  if (es) throw es;

  return { chunks, matches: (matches ?? []) as MatchRow[], statsRows: (statsRows ?? []) as StatRow[] };
}

function buildContext(chunks: any[], matches: MatchRow[], statsRows: StatRow[]) {
  const parts: string[] = [];

  if (chunks.length) {
    parts.push(underline("TEAM NOTES / ROSTER (FACT SOURCE)"));
    for (const c of chunks) parts.push(`• ${c.title}\n${c.content}`);
    parts.push("");
  }

  if (matches.length) {
    const m = computeMatchSummaries(matches);

    parts.push(underline("MATCH RESULTS (FACT SOURCE)"));
    parts.push(`Overall record: ${m.record.w}-${m.record.l}${m.record.u ? `-${m.record.u}` : ""}`);
    parts.push(`Sets: ${m.record.setsWon}-${m.record.setsLost} (diff ${m.record.setDiff})`);
    parts.push("");

    parts.push(underline("OPPONENTS THAT CAUSED TROUBLE (FACT SOURCE)"));
    for (const t of m.troubleOpponents) {
      parts.push(`• ${t.opponent}: ${t.w}-${t.l} | sets ${t.setsWon}-${t.setsLost} | close sets (<=2 pts): ${t.closeSets}`);
    }
    parts.push("");

    parts.push(underline("TOURNAMENT RECORDS (FACT SOURCE)"));
    for (const t of m.tournamentSummary) {
      parts.push(`• ${t.tournament}: ${t.w}-${t.l} (matches ${t.matches})`);
    }
    parts.push("");
  } else {
    parts.push(underline("MATCH RESULTS (FACT SOURCE)"));
    parts.push("No match_results rows found for this team.");
    parts.push("");
  }

  if (statsRows.length) {
    const p = computePlayerTotals(statsRows);

    parts.push(underline("PLAYER STATS (FACT SOURCE)"));
    parts.push(`Rows loaded: ${p.rowsCount}`);
    parts.push("");

    parts.push(underline("LEADERS (FACT SOURCE)"));
    parts.push("Kills: " + p.topKills.map((x) => `${x.player} ${x.value}`).join(" | "));
    parts.push("Digs: " + p.topDigs.map((x) => `${x.player} ${x.value}`).join(" | "));
    parts.push("Aces: " + p.topAces.map((x) => `${x.player} ${x.value}`).join(" | "));
    parts.push("Serve Errors: " + p.topServeErrors.map((x) => `${x.player} ${x.value}`).join(" | "));
    parts.push("");

    parts.push(underline("SERVE-RECEIVE RATING (0–3 WEIGHTED) (FACT SOURCE)"));
    if (p.srRatings.length) {
      parts.push(
        p.srRatings
          .map((x) => `• ${x.player}: ${x.sr_rating.toFixed(2)} (attempts ${x.sr_attempts})`)
          .join("\n")
      );
    } else {
      parts.push("No serve-receive rating data found.");
    }
    parts.push("");
  } else {
    parts.push(underline("PLAYER STATS (FACT SOURCE)"));
    parts.push("No player_game_stats rows found for this team/season.");
    parts.push("");
  }

  return parts.join("\n");
}

function emphasizeNames(text: string) {
  const names = ["Eric","Brooks","Cooper","Troy","Jayden","Bodhi","Anson","Koa","Allen","Ryota","Steven"];
  let out = text;
  for (const n of names) out = out.replace(new RegExp(`\\b${n}\\b`, "g"), `**${n}**`);
  return out;
}

async function callOpenAI(question: string, context: string) {
  assertEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";

  const system = `
You are the MVVC volleyball Coaching Assistant.

You MUST respond using this exact structure:

Data-Backed (Facts)
-------------------
- Only include items that are directly supported by CONTEXT.
- If the context does not support the requested facts, say so plainly.

Coaching Insight (Inference)
----------------------------
- Provide coaching interpretation / recommendations based on the facts above.
- Do NOT invent numbers here.
- Do NOT claim events ("key moments") unless explicitly present in CONTEXT.

Hard rule:
- Never mix facts and inference in the same bullet.
- If a bullet contains a number/stat, it MUST be in Data-Backed (Facts).

Style:
- Short bullets, generous spacing.
- Bold player names.
- No citations like S3/K2.
`;

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
        { role: "system", content: [{ type: "input_text", text: system }] },
        { role: "user", content: [{ type: "input_text", text: `Question: ${question}\n\nCONTEXT:\n${context}` }] },
      ],
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }

  const json = await res.json();

  let text = "";
  if (typeof json.output_text === "string" && json.output_text.trim()) {
    text = json.output_text;
  } else {
    const out = json.output ?? [];
    for (const item of out) {
      const content = item.content ?? [];
      for (const c of content) {
        if ((c.type === "output_text" || c.type === "summary_text") && typeof c.text === "string") {
          text += c.text;
        }
      }
    }
  }

  text = (text || "").trim();
  if (!text) {
    return "Data-Backed (Facts)\n-------------------\n- I couldn’t generate a response even though data is loaded.\n\nCoaching Insight (Inference)\n----------------------------\n- Try asking a more specific question (kills, digs, passing, win/loss, or a specific opponent).";
  }

  return emphasizeNames(text);
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { question?: string };
    const question = String(body.question ?? "").trim();
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    const { chunks, matches, statsRows } = await retrieveData(TEAM_ID, DEFAULT_SEASON, question);
    const ctx = buildContext(chunks, matches, statsRows);

    const answer = await callOpenAI(question, ctx);
    return NextResponse.json({ answer });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
