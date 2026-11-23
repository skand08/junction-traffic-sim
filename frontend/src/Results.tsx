import type { Comparison, KpiCmp, Run } from "./types";

const ROWS_MATCHED = ["matched_travel_time_s", "matched_delay_s", "mean_travel_time_s", "mean_delay_s", "mean_stops", "completed_trips"];
const ROWS_OLD = ["mean_travel_time_s", "mean_delay_s", "mean_stops", "completed_trips"];
const ROW_LABEL: Record<string, string> = {
  matched_travel_time_s: "Avg. travel time, same trips",
  matched_delay_s: "Avg. delay, same trips",
};
const ROW_LABEL_SPLIT: Record<string, string> = {
  mean_travel_time_s: "Avg. travel time, each option's own trips",
  mean_delay_s: "Avg. delay, each option's own trips",
};
// Confidence here is about run-to-run variation only; data quality is reported separately.
const CONF_TEXT = {
  high: "Consistent across runs",
  medium: "Fairly consistent across runs",
  low: "Unclear: could be chance",
};

/** Plain statement of the travel-time change, without a judgement word; built from the same KPI values. */
function statement(k: KpiCmp, same: boolean) {
  const tail = same ? " for the same trips in both options" : "";
  if (k.verdict === "no change" || Math.abs(k.diff) < 0.05) return "Average travel time did not change measurably.";
  const dir = k.diff < 0 ? "shorter" : "longer";
  if (Math.abs(k.diff) < 0.5) return `Average travel time changed by less than half a second per trip (${Math.abs(k.diff).toFixed(1)} s ${dir}).`;
  const pct = k.pct_change != null ? ` (${Math.abs(k.pct_change).toFixed(1)}%)` : "";
  return `Average travel time is ${Math.abs(k.diff).toFixed(1)} s ${dir} per trip${pct}${tail}.`;
}

export function fmt(v: number | null | undefined, unit: string, signed = false) {
  if (v == null || Number.isNaN(v)) return "–";
  const digits = unit === "s" ? (Math.abs(v) < 10 ? 1 : 0) : Math.abs(v) < 10 && !Number.isInteger(v) ? 1 : 0;
  const s = Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
  if (Number(s.replace(/,/g, "")) === 0) return "0" + (unit === "s" ? " s" : "");
  const sign = signed ? (v > 0 ? "+" : v < 0 ? "−" : "") : v < 0 ? "−" : "";
  return sign + s + (unit === "s" ? " s" : "");
}

function Change({ k }: { k: KpiCmp }) {
  if (k.verdict === "no change") return <span className="chg same">No change</span>;
  const tiny = k.unit === "s" ? Math.abs(k.diff) < 0.5 : Math.abs(k.diff) < 0.05;
  if (tiny) return <span className="chg same">About the same</span>;
  // percentages of tiny counts (e.g. 0.5 vs 0.7 teleports) mislead, so show them only on meaningful bases
  const showPct = k.pct_change != null && (k.unit === "s" || Math.abs(k.before) >= 10);
  const pct = showPct ? ` (${k.pct_change! > 0 ? "+" : "−"}${Math.abs(k.pct_change!).toFixed(1)}%)` : "";
  return <span className={`chg ${k.verdict}`}>{fmt(k.diff, k.unit, true)}{pct}</span>;
}

function Range({ k }: { k: KpiCmp }) {
  if (k.diff_ci_low == null || k.diff_ci_high == null) return <span className="muted">–</span>;
  return <span className="muted">{fmt(k.diff_ci_low, k.unit, true)} to {fmt(k.diff_ci_high, k.unit, true)}</span>;
}

/** Trips skipped by the build because a closure cut them off: from the run record, else its warnings. */
export function droppedTrips(run?: Run | null): number {
  if (run?.build) return run.build.unroutable_trips;
  for (const w of run?.warnings ?? []) {
    const m = /(\d+) of (\d+) trips can no longer reach/.exec(w);
    if (m) return Number(m[1]);
  }
  return 0;
}

type QRow = { key: string; label: string; explain: string; before: number | null; after: number | null };
export type Quality = { level: "good" | "caution" | "unreliable"; rows: QRow[]; share: number; legacy: boolean };

/** Data-quality status from backend values only. Caution: any affected trip in either option.
 *  Unreliable: more than 1% of an option's trips are affected. */
export function quality(cmp: Comparison, before?: Run | null, after?: Run | null): Quality {
  const k = cmp.kpis;
  const v = (key: string, side: "before" | "after") => (k[key] ? k[key][side] : null);
  const v2 = !!k.teleported_trips;        // measurement version 2: planned-start timing, teleported trips flagged
  const legacy = !v2;
  const rows: QRow[] = [
    v2
      ? { key: "teleported_trips", label: "Teleported", before: v("teleported_trips", "before"), after: v("teleported_trips", "after"),
          explain: "Stuck cars jumped ahead. Left out of travel time." }
      : { key: "teleports", label: "Teleport events", before: v("teleports", "before"), after: v("teleports", "after"),
          explain: "Stuck cars jumped ahead. Makes travel time look better than it is." },
    { key: "removed", label: "Removed by the simulator", before: v("removed", "before"), after: v("removed", "after"),
      explain: "Taken out before arriving." },
    { key: "unfinished_trips", label: "Unfinished", before: v("unfinished_trips", "before"), after: v("unfinished_trips", "after"),
      explain: "Still driving at the end. Not in travel time." },
    { key: "dropped", label: "Skipped because of a closure", before: droppedTrips(before), after: droppedTrips(after),
      explain: "A closed road cut their route." },
    ...(v2 ? [] : [{ key: "late_departures", label: "Started after the demand hour", before: v("late_departures", "before"), after: v("late_departures", "after"),
      explain: "Queued so long they started late. Left out of all results." }]),
    { key: "not_inserted", label: "Never entered the network", before: v("not_inserted", "before"), after: v("not_inserted", "after"),
      explain: "Never got onto the road. Left out of all results." },
  ];
  let share = 0;
  for (const side of ["before", "after"] as const) {
    const trips = (v("completed_trips", side) ?? 0) + (v("unfinished_trips", side) ?? 0) + (side === "before" ? droppedTrips(before) : droppedTrips(after)) || 1;
    const bad = rows.reduce((a, r) => a + (r[side] ?? 0), 0);
    share = Math.max(share, bad / trips);
  }
  const any = rows.some((r) => (r.before ?? 0) > 0 || (r.after ?? 0) > 0);
  const level = !any ? "good" : share > 0.01 ? "unreliable" : "caution";
  return { level, rows, share, legacy };
}

const Q_TITLE = { good: "Data quality: good", caution: "Data quality: caution", unreliable: "Data quality: unreliable" };
const Q_TEXT = {
  good: "Every trip was counted normally.",
  caution: "A few trips (under 1%) were not counted normally. Check below.",
  unreliable: "Over 1% of trips were not counted normally, so the result may be misleading.",
};

export function QualityBanner({ q, n, labels }: { q: Quality; n: number; labels?: { before: string; after: string } }) {
  const shown = q.rows.filter((r) => r.before != null || r.after != null);
  return (
    <div className={`banner q-${q.level}`} role={q.level === "good" ? undefined : "alert"}>
      <p className="banner-title">{Q_TITLE[q.level]}</p>
      <p>{Q_TEXT[q.level]}</p>
      {q.level !== "good" && (
        <table className="q-table">
          <thead><tr><th scope="col">Trips affected, per run</th><th scope="col">{labels?.before ?? "Current"}</th><th scope="col">{labels?.after ?? "Proposal"}</th></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.key} className={(r.before ?? 0) + (r.after ?? 0) > 0 ? "" : "zero"}>
                <th scope="row"><span className="q-label">{r.label}</span><span className="q-explain">{r.explain}</span></th>
                <td>{fmt(r.before, "")}</td><td>{fmt(r.after, "")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {q.legacy && <p className="small">These runs use the old measurement: time spent queuing to enter was not counted. Run again for accurate numbers.</p>}
    </div>
  );
}

/** Paired difference per seed (proposal − current), with the 95% range of the mean difference. */
export function SeedStrip({ k }: { k: KpiCmp }) {
  const pairs = (k.pairs ?? []).filter((p) => p[1] != null && p[2] != null) as [number, number, number][];
  if (pairs.length < 2) return null;
  const d = pairs.map(([s, a, b]) => ({ s, v: b - a }));
  if (d.every((p) => p.v === 0))
    return <p className="small muted">{k.label}: identical in all {d.length} paired runs, so there is no variation to show.</p>;
  const lo = Math.min(0, ...d.map((x) => x.v), k.diff_ci_low ?? 0), hi = Math.max(0, ...d.map((x) => x.v), k.diff_ci_high ?? 0);
  const span = hi - lo || 1;
  const W = 400, H = 64, pad = 18;
  const x = (v: number) => pad + ((v - lo) / span) * (W - 2 * pad);
  const better = (v: number) => (k.lower_is_better ? v < 0 : v > 0);
  const vals = d.map((p) => p.v);
  return (
    <figure className="strip">
      <svg viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`${k.label}: change in each of ${d.length} paired runs, from ${fmt(Math.min(...vals), k.unit, true)} to ${fmt(Math.max(...vals), k.unit, true)}`}>
        {k.diff_ci_low != null && k.diff_ci_high != null && (
          <rect x={x(k.diff_ci_low)} y={12} width={Math.max(1.5, x(k.diff_ci_high) - x(k.diff_ci_low))} height={26} className="ci" />
        )}
        <line x1={x(0)} x2={x(0)} y1={4} y2={44} className="zero" />
        <line x1={x(k.diff)} x2={x(k.diff)} y1={8} y2={42} className="mean" />
        {d.map((p, i) => (
          <circle key={p.s} cx={x(p.v)} cy={25 + ((i % 3) - 1) * 6} r={4} className={p.v === 0 ? "s" : better(p.v) ? "b" : "w"}>
            <title>Run {p.s}: {fmt(p.v, k.unit, true)}</title>
          </circle>
        ))}
        <text x={x(0)} y={58} textAnchor="middle">0</text>
        {x(lo) < x(0) - 30 && <text x={pad} y={58} textAnchor="start">{fmt(lo, k.unit, true)}</text>}
        {x(hi) > x(0) + 30 && <text x={W - pad} y={58} textAnchor="end">{fmt(hi, k.unit, true)}</text>}
      </svg>
      <figcaption>{k.label}: each dot is one run; the line is the average change.</figcaption>
    </figure>
  );
}

export default function Results({ cmp, before, after, labels }: { cmp: Comparison; before?: Run | null; after?: Run | null; labels?: { before: string; after: string } }) {
  const same = !!cmp.kpis.matched_travel_time_s;
  const tt = cmp.kpis.matched_travel_time_s ?? cmp.kpis.mean_travel_time_s;
  const dl = cmp.kpis.matched_delay_s ?? cmp.kpis.mean_delay_s;
  const ROWS = same ? ROWS_MATCHED : ROWS_OLD;
  const q = quality(cmp, before, after);
  const n = tt?.n ?? cmp.paired_seeds.length;
  const wins = tt ? Math.round((tt.verdict === "worse" ? 1 - tt.share_seeds_better - (tt.ties ?? 0) / n : tt.share_seeds_better) * n) : 0;
  return (
    <section className="results" aria-live="polite">
      <QualityBanner q={q} n={n} labels={labels} />

      <p className="headline">{tt ? statement(tt, same) : cmp.headline}</p>
      {cmp.matched && (
        <p className="small muted">
          Compared on the {Math.round(cmp.matched.trips).toLocaleString()} trips per run that finished normally in both
          options ({(100 * cmp.matched.share).toFixed(1)}% of all trips).
        </p>
      )}
      {tt && (
        <div className="verdict">
          {tt.verdict === "no change"
            ? <span className="pill low">No difference between the options</span>
            : <span className={`pill ${tt.confidence}`}>{CONF_TEXT[tt.confidence]}</span>}
          {q.level !== "good" && tt.verdict !== "no change" && <span className={`pill dq-${q.level}`}>Data {q.level}</span>}
          {tt.verdict !== "no change" && (
            <p className="rule">
              {tt.verdict === "better" ? "Shorter" : "Longer"} in {wins} of {n} paired runs; the 95% range of the
              difference {tt.significant ? "does not include" : "includes"} zero.

            </p>
          )}
        </div>
      )}

      <table>
        <thead>
          <tr><th scope="col">Measure</th><th scope="col">{labels?.before ?? "Current"}</th><th scope="col">{labels?.after ?? "Proposal"}</th><th scope="col">Change</th><th scope="col" className="range-col">95% range</th></tr>
        </thead>
        <tbody>
          {ROWS.filter((r) => cmp.kpis[r]).map((r) => {
            const k = cmp.kpis[r];
            return (
              <tr key={r}>
                <th scope="row">{(same && ROW_LABEL_SPLIT[r]) || ROW_LABEL[r] || k.label.replace("Average ", "Avg. ")}</th>
                <td>{fmt(k.before, k.unit)}</td>
                <td>{fmt(k.after, k.unit)}</td>
                <td><Change k={k} /><span className="range-inline"><Range k={k} /></span></td>
                <td className="range-col"><Range k={k} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="small muted">Averages of {n} runs. The 95% range shows how much the change varied.</p>

      <h4 className="sub">Variation across runs</h4>
      {tt && <SeedStrip k={tt} />}
      {dl && <SeedStrip k={dl} />}

      <details>
        <summary>How these numbers and the verdict are worked out</summary>
        <ul>
          <li><b>Travel time</b> runs from when a trip was planned to start to its arrival, so time spent queuing to enter the network counts. It covers trips planned within the demand hour that finished normally (no teleport).</li>
          {same && <li><b>Same trips:</b> in each run, the verdict uses only trips that finished normally in both options. Trips cut off by a closure, teleported, unfinished or removed in either option are left out of both, so the options are compared like for like. The rows marked "each option's own trips" average all of that option's normal trips instead.</li>}
          <li><b>Delay</b> is the extra time compared with driving the same route on empty roads, mostly waiting at signals and in queues.</li>
          <li><b>Paired runs:</b> each option ran {n} times. Run 1 of both options used the same random seed, run 2 the next, and so on, so each pair differs only by your change. Seeds vary driver behaviour and departure order; the trips themselves are the same in every run.</li>
          <li><b>95% range</b> is a t-interval on the {n} paired differences: mean ± t × standard deviation ÷ √{n}. It describes run-to-run variation in this model only; it does not cover errors in the network, demand or signal data.</li>
          <li><b>Consistent across runs</b>: better in at least 90% of paired runs and the 95% range excludes zero. <b>Fairly consistent across runs</b>: the range excludes zero, or better in at least 75% of runs. <b>Unclear</b>: anything else, or fewer than 5 runs. With {n} runs these labels are a rough guide, not proof. They describe only run-to-run variation, not the data-quality issues above: the range is itself uncertain, and changes of a few seconds can flip with more runs.</li>
        </ul>
      </details>
    </section>
  );
}
