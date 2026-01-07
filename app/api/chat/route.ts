import { NextResponse } from "next/server";
import { supabaseService } from "../../../lib/supabaseServer";

function assertEnv(name: string) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black
const DEFAULT_SEASON: "fall" | "spring" | "summer" = "fall";

type MatchRow = {
  match_date: string | null;
  tournament: string | null;
  opponent: string | null;
  result: string | null;
  score: string | null; // e.g. "25-19, 15-25, 15-13"
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

function safeText(v: any, fallback = ""): string {
  const s = String(v ?? "").trim();
  return s || fallback;
}

function normResult(r: string | null): "W" | "L" | "U" {
  const x = (r ?? "").toLowerCase();
  if (x.includes("won") || x === "w") return "W";
  if (x.includes("lost") || x === "l") return "L";
  return "U";
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

function isSeasonNarrativeQuestion(q: string) {
  const x = q.toLowerCase();
  return (
    x.includes("key moments") ||
    x.includes("summarize the season") ||
    x.includes("season summary") ||
    x.includes("strength") ||
    x.includes("weakness") ||
    x.includes("improvement areas") ||
    x.includes("what happened") ||
    x.includes("how did we do") ||
    x.includes("biggest win") ||
    x.includes("toughest match")
  );
}

function emphasizeNames(text: string) {
  const names = ["Eric","Brooks","Cooper","Troy","Jayden","Bodhi","Anson","Koa","Allen","Ryota","Steven"];
  let out = text;
  for (const n of names) out = out.replace(new RegExp(`\\b${n}\\b`, "g"), `**${n}**`);
  return out;
}

function computeMatchSummaries(matches: MatchRow[]) {
  let w = 0, l = 0, u = 0;
  let setsWon = 0, setsLost = 0;

  const byOpponent: Record<
    string,
    { w: number; l: number; setsWon: number; setsLost: number; closeSets: number; matches: number }
  > = {};

  const closeMatches: Array<{ match_date: string; opponent: string; result: "W" | "L" | "U"; score: string; tournament: string }> = [];

  for (const m of matches) {
    const r = normResult(m.result);
    if (r === "W") w++;
    else if (r === "L") l++;
    else u++;

    setsWon += toNum(m.sets_won);
    setsLost += toNum(m.sets_lost);

    const opp = safeText(m.opponent, "Unknown");
    if (!byOpponent[opp]) byOpponent[opp] = { w: 0, l: 0, setsWon: 0, setsLost: 0, closeSets: 0, matches: 0 };
    byOpponent[opp].matches += 1;
    if (r === "W") byOpponent[opp].w += 1;
    if (r === "L") byOpponent[opp].l += 1;
    byOpponent[opp].setsWon += toNum(m.sets_won);
    byOpponent[opp].setsLost += toNum(m.sets_lost);

    const deltas = parseSetDeltas(m.score);
    const closeSetCount = deltas.filter((d) => d <= 2).length;
    byOpponent[opp].closeSets += closeSetCount;

    // If any set was close (<=2), treat as a “close match” moment
    if (closeSetCount > 0) {
      closeMatches.push({
        match_date: safeText(m.match_date, ""),
        opponent: opp,
        result: r,
        score: safeText(m.score, ""),
        tournament: safeText(m.tournament, ""),
      });
    }
  }

  const troubleOpponents = Object.entries(byOpponent)
    .map(([opponent, v]) => ({ opponent, ...v, setDiff: v.setsWon - v.setsLost }))
    .sort((a, b) =>
      (b.l - a.l) ||
      (a.setDiff - b.setDiff) ||
      (b.closeSets - a.closeSets) ||
      (b.matches - a.matches)
    )
    .slice(0, 8);

  // Sort close matches newest last by default (string date is fine for your format, but ok)
  closeMatches.sort((a, b) => (a.match_date > b.match_date ? 1 : -1));

  return {
    record: { w, l, u, setsWon, setsLost, setDiff: setsWon - setsLost },
    troubleOpponents,
    closeMatches: closeMatches.slice(-10), // last 10 “close moments”
  };
}

function computePlayerTotals(statsRows: StatRow[]) {
  const totals: Record<string, Record<string, number>> = {};

  for (const row of statsRows) {
    const name = safeText(row.player_name, "Unknown");
    if (!totals[name]) totals[name] = {};

    const s = row.stats ?? {};

    totals[name]["attack_kills"] = (totals[name]["attack_kills"] ?? 0) + toNum(s["attack_kills"]);
    totals[name]["digs_successful"] = (totals[name]["digs_successful"] ?? 0) + toNum(s["digs_successful"]);
    totals[name]["serve_aces"] = (totals[name]["serve_aces"] ?? 0) + toNum(s["serve_aces"]);
    totals[name]["serve_errors"] = (totals[name]["serve_errors"] ?? 0) + toNum(s["serve_errors"]);

    const srAtt = toNum(s["serve_receive_attempts"]);
    const srRating = toNum(s["serve_receive_passing_rating"]); // 0–3 in your CSV
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

  const players = Object.keys(totals).map((player) => ({ player, t: totals[player] }));

  const topBy = (key: string, n = 6) =>
    [...players]
      .sort((a, b) => (b.t[key] ?? 0) - (a.t[key] ?? 0))
      .slice(0, n)
      .map((x) => ({ player: x.player, value: x.t[key] ?? 0 }));

  const srRatings = players
    .map((x) => {
      const att = x.t["_sr_attempts"] ?? 0;
      const sum = x.t["_sr_rating_sum"] ?? 0;
      return { player: x.player, sr_attempts: att, sr_rating: att > 0 ? sum / att : 0 };
    })
    .filter((x) => x.sr_attempts > 0)
    .sort((a, b) => b.sr_rating - a.sr_rating)
    .slice(0, 8);

  return {
    rowsCount: statsRows.length,
    topKills: topBy("attack_kills", 8),
    topDigs: topBy("digs_successful", 8),
    topAces: topBy("serve_aces", 8),
    topServeErrors: topBy("serve_errors", 8),
    srRatings,
  };
}

async function retrieveData(teamId: string, season: string) {
  const supabase = supabaseService();

  const { data: matches, error: em } = await supabase
    .from("match_results")
    .select("match_date,tournament,opponent,result,score,round,sets_won,sets_lost,set_diff")
    .eq("team_id", teamId)
    .order("match_date", { ascending: true })
    .limit(800);
  if (em) throw em;

  const { data: statsRows, error: es } = await supabase
    .from("player_game_stats")
    .select("player_name,position,game_date,opponent,stats")
    .eq("team_id", teamId)
    .eq("season", season)
    .limit(5000);
  if (es) throw es;

  return { matches: (matches ?? []) as MatchRow[], statsRows: (statsRows ?? []) as StatRow[] };
}

function seasonNarrativeAnswer(matches: MatchRow[], statsRows: StatRow[]) {
  const m = computeMatchSummaries(matches);
  const p = computePlayerTotals(statsRows);

  const lines: string[] = [];

  lines.push(underline("Data-Backed (Facts)"));

  if (!matches.length) {
    lines.push("- No `match_results` found, so I can’t summarize season outcomes (wins/losses, close matches).");
  } else {
    lines.push(`- Overall record: ${m.record.w}-${m.record.l}${m.record.u ? `-${m.record.u}` : ""}`);
    lines.push(`- Sets: ${m.record.setsWon}-${m.record.setsLost} (set diff ${m.record.setDiff})`);

    if (m.troubleOpponents.length) {
      lines.push("");
      lines.push(underline("Opponents That Caused Trouble (Facts)"));
      for (const t of m.troubleOpponents.slice(0, 5)) {
        lines.push(`- ${t.opponent}: ${t.w}-${t.l} | sets ${t.setsWon}-${t.setsLost} | close sets (<=2 pts): ${t.closeSets}`);
      }
    }

    if (m.closeMatches.length) {
      lines.push("");
      lines.push(underline("Close-Match “Moments” (Facts)"));
      for (const cm of m.closeMatches) {
        const r = cm.result === "W" ? "Win" : cm.result === "L" ? "Loss" : "Result?";
        const meta = [cm.match_date, cm.tournament].filter(Boolean).join(" • ");
        lines.push(`- ${r} vs ${cm.opponent} (${meta}) — ${cm.score}`);
      }
    }
  }

  if (!statsRows.length) {
    lines.push("");
    lines.push("- No `player_game_stats` found for this season, so I can’t summarize individual leaders (kills/digs/aces/passing).");
  } else {
    lines.push("");
    lines.push(underline("Stat Leaders (Facts)"));
    if (p.topKills.length) lines.push(`- Kills: ${p.topKills.slice(0, 4).map(x => `${x.player} (${x.value})`).join(", ")}`);
    if (p.topDigs.length) lines.push(`- Digs: ${p.topDigs.slice(0, 4).map(x => `${x.player} (${x.value})`).join(", ")}`);
    if (p.topAces.length) lines.push(`- Aces: ${p.topAces.slice(0, 4).map(x => `${x.player} (${x.value})`).join(", ")}`);

    if (p.srRatings.length) {
      lines.push("");
      lines.push(underline("Serve-Receive Passing (0–3 Rating) (Facts)"));
      lines.push(`- Top SR rating: ${p.srRatings[0].player} — ${p.srRatings[0].sr_rating.toFixed(2)} (attempts ${p.srRatings[0].sr_attempts})`);
    }
  }

  lines.push("");
  lines.push(underline("Coaching Insight (Inference)"));

  if (matches.length && m.troubleOpponents.length) {
    lines.push("- The opponents with losses and negative set-diff are your best “scouting priorities” (serve targets, sideout patterns, blocking matchups).");
  }
  if (matches.length && m.closeMatches.length) {
    lines.push("- The close-set matches are the most actionable “moments” to review on film: late-set serve selection, free-ball conversion, and first-ball sideout discipline.");
  }
  if (statsRows.length) {
    lines.push("- Use your leaders as anchors: build serve-receive formations around top passers, and design first-ball options around your top kill producers.");
    lines.push("- If a player shows high aces *and* high serve errors, tighten risk: pick 1–2 “pressure serves” and default to a higher-in ball elsewhere.");
  } else {
    lines.push("- Once player stats are loaded, I can turn this into a practice focus plan (serve/receive, sideout, transition, endgame).");
  }

  return emphasizeNames(lines.join("\n"));
}

async function callOpenAI(question: string, compactContext: string) {
  assertEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";

  const system = `
You are the MVVC volleyball Coaching Assistant.

You MUST respond using this exact structure:

Data-Backed (Facts)
-------------------
- Only include items directly supported by CONTEXT.

Coaching Insight (Inference)
----------------------------
- Provide coaching interpretation based on the facts above.
- Do NOT invent numbers or match events.

Style:
- Short bullets, generous spacing.
- Bold player names.
- Underline sub-sections with dashed lines.
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
        { role: "user", content: [{ type: "input_text", text: `Question: ${question}\n\nCONTEXT:\n${compactContext}` }] },
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
        if ((c.type === "output_text" || c.type === "summary_text") && typeof c.text === "string") text += c.text;
      }
    }
  }

  text = (text || "").trim();
  if (!text) {
    // Don’t ever return “No answer generated” again
    return "Data-Backed (Facts)\n-------------------\n- I couldn’t produce a response from the model.\n\nCoaching Insight (Inference)\n----------------------------\n- Try again, or ask for a specific stat (win/loss, kills, digs, aces, passing).";
  }

  return emphasizeNames(text);
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { question?: string };
    const question = safeText(body.question, "");
    if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

    const { matches, statsRows } = await retrieveData(TEAM_ID, DEFAULT_SEASON);

    // ✅ Option 1: deterministic “season summary / key moments” (no OpenAI needed)
    if (isSeasonNarrativeQuestion(question)) {
      const answer = seasonNarrativeAnswer(matches, statsRows);
      return NextResponse.json({ answer });
    }

    // For other questions: send compact context (summaries only, not giant raw JSON rows)
    const m = computeMatchSummaries(matches);
    const p = computePlayerTotals(statsRows);

    const compactContext = [
      underline("MATCH SUMMARY (FACT SOURCE)"),
      `Record: ${m.record.w}-${m.record.l}${m.record.u ? `-${m.record.u}` : ""}`,
      `Sets: ${m.record.setsWon}-${m.record.setsLost} (diff ${m.record.setDiff})`,
      "",
      underline("TROUBLE OPPONENTS (FACT SOURCE)"),
      ...m.troubleOpponents.slice(0, 8).map(
        (t) => `- ${t.opponent}: ${t.w}-${t.l} | sets ${t.setsWon}-${t.setsLost} | close sets ${t.closeSets}`
      ),
      "",
      underline("PLAYER LEADERS (FACT SOURCE)"),
      `Kills: ${p.topKills.slice(0, 8).map((x) => `${x.player}=${x.value}`).join(" | ")}`,
      `Digs: ${p.topDigs.slice(0, 8).map((x) => `${x.player}=${x.value}`).join(" | ")}`,
      `Aces: ${p.topAces.slice(0, 8).map((x) => `${x.player}=${x.value}`).join(" | ")}`,
      `Serve Errors: ${p.topServeErrors.slice(0, 8).map((x) => `${x.player}=${x.value}`).join(" | ")}`,
      "",
      underline("SERVE-RECEIVE RATING (0–3 WEIGHTED) (FACT SOURCE)"),
      ...p.srRatings.slice(0, 8).map((x) => `- ${x.player}: ${x.sr_rating.toFixed(2)} (att ${x.sr_attempts})`),
    ].join("\n");

    const answer = await callOpenAI(question, compactContext);
    return NextResponse.json({ answer });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
