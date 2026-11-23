import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { fmt } from "./Results";
import type { Experiment, Network, RunSummary } from "./types";

const CTRL: Record<string, string> = { fixed: "fixed timing", actuated: "vehicle-actuated", max_pressure: "pressure-based (experimental)" };

/** Pair each proposal run with the run of its parent scenario ("current situation") that used the same
 *  seeds and started closest in time. Uses only GET /runs; nothing is stored in the browser. */
export function pairRuns(runs: RunSummary[]): { experiments: Experiment[]; singles: RunSummary[] } {
  const used = new Set<string>();
  const experiments: Experiment[] = [];
  const byTime = [...runs].sort((a, b) => (b.started ?? 0) - (a.started ?? 0));
  for (const r of byTime) {
    if (!r.parent_id || used.has(r.id)) continue;
    const cands = byTime.filter((x) => !used.has(x.id) && x.id !== r.id && x.scenario_id === r.parent_id
      && JSON.stringify(x.seeds) === JSON.stringify(r.seeds));
    if (!cands.length) continue;
    const best = cands.reduce((a, b) => (Math.abs((a.started ?? 0) - (r.started ?? 0)) <= Math.abs((b.started ?? 0) - (r.started ?? 0)) ? a : b));
    if (Math.abs((best.started ?? 0) - (r.started ?? 0)) > 600) continue;   // started within 10 minutes of each other
    used.add(r.id); used.add(best.id);
    experiments.push({ id: r.id, before: best, after: r });
  }
  return { experiments, singles: byTime.filter((r) => !used.has(r.id)) };
}

function when(t?: number) {
  if (!t) return "unknown time";
  return new Date(t * 1000).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
function seedText(s: number[]) {
  return s.length > 3 && s[s.length - 1] - s[0] === s.length - 1 ? `seeds ${s[0]}–${s[s.length - 1]}` : `seeds ${s.join(", ")}`;
}

type Props = {
  open: boolean; onClose?: () => void; networks: Network[]; currentNet: string | null; refreshKey: number;
  onOpen: (e: Experiment) => void; onCompare: (a: RunSummary, b: RunSummary) => void; onReproduce: (e: Experiment) => void;
  onOpenFile: () => void;
};

export default function Experiments({ open, onClose, networks, currentNet, refreshKey, onOpen, onCompare, onReproduce, onOpenFile }: Props) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"exp" | "runs">("exp");
  const [onlyHere, setOnlyHere] = useState(true);
  const [pick, setPick] = useState<{ a: string | null; b: string | null }>({ a: null, b: null });

  useEffect(() => {
    if (!open) return;
    setErr(null); setTab("exp");
    api.runs().then(setRuns).catch((e) => setErr(e.message));
  }, [open, refreshKey]);
  useEffect(() => { setOnlyHere(!!currentNet); }, [currentNet]);

  const netName = (id?: string) => networks.find((n) => n.id === id)?.name ?? id ?? "unknown network";
  const shown = useMemo(() => (runs ?? []).filter((r) => !onlyHere || !currentNet || r.base_network === currentNet), [runs, onlyHere, currentNet]);
  const { experiments, singles } = useMemo(() => pairRuns(shown), [shown]);
  const finished = shown.filter((r) => r.state === "done");
  const A = finished.find((r) => r.id === pick.a), B = finished.find((r) => r.id === pick.b);
  const sameNet = A && B && A.base_network === B.base_network;

  if (!open) return null;
  return (
    <section className="page" aria-label="Experiments and history">
        <div className="page-head">
          <h1>Experiments &amp; History</h1>
          <p className="lead">Every comparison you ran. Open one to see its results, save it as a file, or run it again to check it gives the same numbers.</p>
        </div>
        <div className="row spread page-tools">
          <div className="seg" role="tablist" aria-label="View">
            <button role="tab" aria-selected={tab === "exp"} aria-pressed={tab === "exp"} onClick={() => setTab("exp")}>Comparisons</button>
            <button role="tab" aria-selected={tab === "runs"} aria-pressed={tab === "runs"} onClick={() => setTab("runs")}>Compare two runs</button>
          </div>
          {currentNet && (
            <label className="check small"><input type="checkbox" checked={onlyHere} onChange={(e) => setOnlyHere(e.target.checked)} />This network only</label>
          )}
        </div>
        {err && <p className="banner q-error">{err}</p>}
        {!runs && !err && <p className="status-line"><span className="spinner" aria-hidden="true" />Loading past runs…</p>}

        {runs && tab === "exp" && (
          <>
            {experiments.length === 0 && <p className="small muted">No comparisons {onlyHere && currentNet ? "on this network " : ""}yet. Run one in Traffic Simulation.</p>}
            <ul className="exp-list">
              {experiments.map((e) => {
                const ok = e.before.state === "done" && e.after.state === "done";
                const tel = e.after.teleports ?? 0;
                return (
                  <li key={e.id} className="exp">
                    <div className="exp-top">
                      <span className="exp-when">{when(e.after.started)}</span>
                      {!ok && <span className={`status ${e.after.state === "failed" || e.before.state === "failed" ? "failed" : "cancelled"}`}>
                        {e.after.state === "failed" || e.before.state === "failed" ? "Failed" : e.after.state === "cancelled" || e.before.state === "cancelled" ? "Cancelled" : "Running"}</span>}
                    </div>
                    <p className="exp-title">{netName(e.after.base_network)}</p>
                    <p className="small">
                      Proposal: {e.after.edits ?? 0} change{e.after.edits === 1 ? "" : "s"}, {CTRL[e.after.controller ?? "fixed"]}
                      {e.after.demand_scale != null && e.after.demand_scale !== 1 ? `, ${Math.round(e.after.demand_scale * 100)}% traffic` : ""}. {e.after.seeds.length} runs, {seedText(e.after.seeds)}.
                    </p>
                    {ok && (
                      <p className="small">
                        Avg. travel time {fmt(e.before.mean_travel_time_s, "s")} → {fmt(e.after.mean_travel_time_s, "s")}
                        {tel > 0 && <span className="chip warn">{fmt(tel, "")} teleports per run</span>}
                      </p>
                    )}
                    {e.after.versions && <p className="tiny muted">SUMO {e.after.versions.sumo}, Junction {e.after.versions.app}</p>}
                    <div className="row">
                      {ok && <button className="btn secondary small" onClick={() => onOpen(e)}>Open results</button>}
                      {ok && <a className="btn quiet small" href={api.bundleUrl(e.after.scenario_id, { before: e.before.id, after: e.after.id })} download>Save experiment</a>}
                      {ok && <button className="btn quiet small" onClick={() => onReproduce(e)}>Reproduce</button>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {runs && tab === "runs" && (
          <>
            <p className="small muted">Pick run A as the reference and run B to compare with it. Both must be on the same network.</p>
            <table className="run-pick">
              <thead><tr><th scope="col">A</th><th scope="col">B</th><th scope="col">Run</th><th scope="col">Avg. travel time</th></tr></thead>
              <tbody>
                {finished.map((r) => (
                  <tr key={r.id} className={pick.a === r.id || pick.b === r.id ? "picked" : ""}>
                    <td><input type="radio" name="runA" aria-label={`Use ${r.scenario_name} ${when(r.started)} as A`} checked={pick.a === r.id} onChange={() => setPick({ ...pick, a: r.id })} /></td>
                    <td><input type="radio" name="runB" aria-label={`Use ${r.scenario_name} ${when(r.started)} as B`} checked={pick.b === r.id} onChange={() => setPick({ ...pick, b: r.id })} /></td>
                    <th scope="row">
                      <span className="q-label">{r.scenario_name}, {when(r.started)}</span>
                      <span className="q-explain">{netName(r.base_network)}; {CTRL[r.controller ?? "fixed"]}; {r.edits ?? 0} changes; {r.seeds.length} runs</span>
                    </th>
                    <td>{fmt(r.mean_travel_time_s, "s")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {singles.length > 0 && <p className="tiny muted">{singles.length} run{singles.length === 1 ? "" : "s"} are not part of a paired comparison.</p>}
            {A && B && !sameNet && <p className="banner-inline warn">A and B are on different networks, so they cannot be compared.</p>}
            <button className="primary wide" disabled={!A || !B || A.id === B.id || !sameNet} onClick={() => A && B && onCompare(A, B)}>Compare B with A</button>
          </>
        )}

        <hr />
        <button className="btn secondary small" onClick={onOpenFile}>Open a saved experiment file</button>
    </section>
  );
}
