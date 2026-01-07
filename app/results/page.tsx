// app/results/page.tsx
import { supabaseService } from "../../lib/supabaseServer";

const TEAM_ID = "7d5c9d23-e78c-4b08-8869-64cece1acee5"; // MVVC 14 Black

type MatchRow = {
  match_date: string | null; // date
  tournament: string | null;
  opponent: string | null;
  result: "W" | "L" | null;
  score: string | null;
  round: string | null;
  sets_won: number | null;
  sets_lost: number | null;
  set_diff: number | null;
};

function fmtDate(d: string | null) {
  if (!d) return "";
  // d is expected "YYYY-MM-DD"
  const [y, m, day] = d.split("-");
  if (!y || !m || !day) return d;
  return `${m}/${day}/${y.slice(2)}`;
}

export const dynamic = "force-dynamic"; // always fresh

export default async function ResultsPage() {
  const supabase = supabaseService();

  const { data, error } = await supabase
    .from("match_results")
    .select("match_date,tournament,opponent,result,score,round,sets_won,sets_lost,set_diff")
    .eq("team_id", TEAM_ID)
    .order("match_date", { ascending: false })
    .limit(300);

  if (error) {
    return (
      <main style={styles.page}>
        <h1 style={styles.h1}>Results</h1>
        <p style={styles.error}>Error loading match_results: {error.message}</p>
      </main>
    );
  }

  const matches: MatchRow[] = (data ?? []) as any;

  // Overall record
  let wins = 0;
  let losses = 0;
  let setsWon = 0;
  let setsLost = 0;

  for (const m of matches) {
    if (m.result === "W") wins += 1;
    if (m.result === "L") losses += 1;
    if (typeof m.sets_won === "number") setsWon += m.sets_won;
    if (typeof m.sets_lost === "number") setsLost += m.sets_lost;
  }

  const totalMatches = wins + losses;
  const matchWinPct = totalMatches ? (wins / totalMatches) * 100 : 0;
  const totalSets = setsWon + setsLost;
  const setWinPct = totalSets ? (setsWon / totalSets) * 100 : 0;

  // Group by tournament
  const byTournament = new Map<
    string,
    { tournament: string; w: number; l: number; sw: number; sl: number; lastDate: string | null }
  >();

  for (const m of matches) {
    const t = (m.tournament ?? "Unknown Tournament").trim() || "Unknown Tournament";
    const cur = byTournament.get(t) ?? { tournament: t, w: 0, l: 0, sw: 0, sl: 0, lastDate: null };

    if (m.result === "W") cur.w += 1;
    if (m.result === "L") cur.l += 1;
    if (typeof m.sets_won === "number") cur.sw += m.sets_won;
    if (typeof m.sets_lost === "number") cur.sl += m.sets_lost;

    // latest date (matches are already sorted desc, but be safe)
    if (!cur.lastDate || (m.match_date && m.match_date > cur.lastDate)) cur.lastDate = m.match_date;

    byTournament.set(t, cur);
  }

  const tournamentRows = Array.from(byTournament.values()).sort((a, b) => {
    const ad = a.lastDate ?? "";
    const bd = b.lastDate ?? "";
    return bd.localeCompare(ad);
  });

  // Recent matches (top 12)
  const recent = matches.slice(0, 12);

  return (
    <main style={styles.page}>
      <header style={styles.header}>
        <div>
          <div style={styles.kicker}>MVVC 14 Black</div>
          <h1 style={styles.h1}>Results Dashboard</h1>
        </div>
      </header>

      {/* Summary cards */}
      <section style={styles.grid}>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Overall record</div>
          <div style={styles.bigStat}>
            {wins}-{losses}
          </div>
          <div style={styles.subStat}>{matchWinPct.toFixed(1)}% match win</div>
        </div>

        <div style={styles.card}>
          <div style={styles.cardLabel}>Sets</div>
          <div style={styles.bigStat}>
            {setsWon}-{setsLost}
          </div>
          <div style={styles.subStat}>{setWinPct.toFixed(1)}% set win</div>
        </div>

        <div style={styles.card}>
          <div style={styles.cardLabel}>Matches logged</div>
          <div style={styles.bigStat}>{matches.length}</div>
          <div style={styles.subStat}>pulled from match_results</div>
        </div>
      </section>

      {/* Tournament table */}
      <section style={styles.section}>
        <h2 style={styles.h2}>Tournaments</h2>
        <div style={styles.underline} />
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Tournament</th>
                <th style={styles.thCenter}>W-L</th>
                <th style={styles.thCenter}>Sets</th>
                <th style={styles.thCenter}>Last</th>
              </tr>
            </thead>
            <tbody>
              {tournamentRows.map((t) => {
                const total = t.w + t.l;
                const pct = total ? (t.w / total) * 100 : 0;
                return (
                  <tr key={t.tournament}>
                    <td style={styles.td}>
                      <div style={styles.tournamentName}>{t.tournament}</div>
                      <div style={styles.smallMuted}>{pct.toFixed(1)}% match win</div>
                    </td>
                    <td style={styles.tdCenter}>
                      <span style={styles.pill}>
                        {t.w}-{t.l}
                      </span>
                    </td>
                    <td style={styles.tdCenter}>
                      <span style={styles.pill}>
                        {t.sw}-{t.sl}
                      </span>
                    </td>
                    <td style={styles.tdCenter}>{fmtDate(t.lastDate)}</td>
                  </tr>
                );
              })}
              {tournamentRows.length === 0 && (
                <tr>
                  <td style={styles.td} colSpan={4}>
                    No tournaments found yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Recent matches */}
      <section style={styles.section}>
        <h2 style={styles.h2}>Recent matches</h2>
        <div style={styles.underline} />

        <div style={styles.list}>
          {recent.map((m, idx) => {
            const res = m.result ?? "";
            const isWin = res === "W";
            return (
              <div key={`${m.match_date}-${m.opponent}-${idx}`} style={styles.matchRow}>
                <div style={styles.matchLeft}>
                  <div style={styles.matchTop}>
                    <span style={{ ...styles.resultDot, ...(isWin ? styles.dotWin : styles.dotLoss) }} />
                    <span style={styles.matchTitle}>
                      {res ? (isWin ? "Win" : "Loss") : "—"} vs {m.opponent ?? "Unknown"}
                    </span>
                  </div>
                  <div style={styles.smallMuted}>
                    {fmtDate(m.match_date)} • {m.tournament ?? "Unknown Tournament"}
                    {m.round ? ` • ${m.round}` : ""}
                  </div>
                </div>

                <div style={styles.matchRight}>
                  <div style={styles.score}>{m.score ?? ""}</div>
                  {typeof m.sets_won === "number" && typeof m.sets_lost === "number" ? (
                    <div style={styles.smallMuted}>
                      Sets {m.sets_won}-{m.sets_lost}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}

          {recent.length === 0 && <div style={styles.smallMuted}>No matches found yet.</div>}
        </div>
      </section>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    padding: 18,
    maxWidth: 980,
    margin: "0 auto",
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
    color: "#111827",
  },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12, marginBottom: 16 },
  kicker: { fontSize: 13, color: "#6b7280", fontWeight: 600, letterSpacing: 0.2 },
  h1: { fontSize: 26, margin: "4px 0 0", lineHeight: 1.15 },
  h2: { fontSize: 18, margin: "0 0 8px", lineHeight: 1.2 },
  underline: { height: 2, width: 56, background: "#111827", opacity: 0.12, borderRadius: 99, marginBottom: 12 },

  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(12, 1fr)",
    gap: 12,
    marginBottom: 18,
  },
  card: {
    gridColumn: "span 12",
    border: "1px solid rgba(17,24,39,0.10)",
    borderRadius: 14,
    padding: 14,
    background: "white",
    boxShadow: "0 1px 10px rgba(17,24,39,0.04)",
  },
  cardLabel: { fontSize: 13, color: "#6b7280", fontWeight: 600, marginBottom: 6 },
  bigStat: { fontSize: 28, fontWeight: 800, letterSpacing: -0.5 },
  subStat: { fontSize: 13, color: "#6b7280", marginTop: 4 },

  section: { marginTop: 18 },

  tableWrap: {
    border: "1px solid rgba(17,24,39,0.10)",
    borderRadius: 14,
    overflow: "hidden",
    background: "white",
    boxShadow: "0 1px 10px rgba(17,24,39,0.04)",
  },
  table: { width: "100%", borderCollapse: "separate", borderSpacing: 0 },
  th: {
    textAlign: "left",
    fontSize: 12,
    color: "#6b7280",
    fontWeight: 700,
    padding: "12px 12px",
    background: "rgba(17,24,39,0.02)",
    borderBottom: "1px solid rgba(17,24,39,0.08)",
  },
  thCenter: {
    textAlign: "center",
    fontSize: 12,
    color: "#6b7280",
    fontWeight: 700,
    padding: "12px 12px",
    background: "rgba(17,24,39,0.02)",
    borderBottom: "1px solid rgba(17,24,39,0.08)",
    width: 90,
  },
  td: { padding: "12px 12px", borderBottom: "1px solid rgba(17,24,39,0.06)", verticalAlign: "top" },
  tdCenter: {
    padding: "12px 12px",
    borderBottom: "1px solid rgba(17,24,39,0.06)",
    textAlign: "center",
    verticalAlign: "top",
  },
  tournamentName: { fontWeight: 750, fontSize: 14, marginBottom: 2 },
  smallMuted: { fontSize: 12, color: "#6b7280" },
  pill: {
    display: "inline-block",
    padding: "4px 10px",
    borderRadius: 999,
    border: "1px solid rgba(17,24,39,0.10)",
    background: "rgba(17,24,39,0.02)",
    fontSize: 12,
    fontWeight: 700,
  },

  list: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    border: "1px solid rgba(17,24,39,0.10)",
    borderRadius: 14,
    padding: 12,
    background: "white",
    boxShadow: "0 1px 10px rgba(17,24,39,0.04)",
  },
  matchRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    padding: 10,
    borderRadius: 12,
    border: "1px solid rgba(17,24,39,0.06)",
  },
  matchLeft: { minWidth: 0, flex: 1 },
  matchRight: { textAlign: "right", minWidth: 120 },
  matchTop: { display: "flex", alignItems: "center", gap: 8, marginBottom: 4 },
  matchTitle: { fontWeight: 750, fontSize: 14, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis" },
  score: { fontWeight: 800, fontSize: 13, marginBottom: 4 },
  resultDot: { width: 10, height: 10, borderRadius: 999, display: "inline-block" },
  dotWin: { background: "#22c55e" },
  dotLoss: { background: "#ef4444" },

  error: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    border: "1px solid rgba(239,68,68,0.25)",
    background: "rgba(239,68,68,0.06)",
    color: "#991b1b",
    fontSize: 13,
  },
};

// Basic responsive tweak: on wider screens, show 3 summary cards in a row
// (Inline styles can't do media queries, but this still looks good on mobile.
// If you want, I can add a tiny globals.css with media queries safely.)
