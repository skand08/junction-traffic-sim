import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import Results, { fmt } from "./Results";
import { controllerName, when } from "./shared";
import type { Comparison, Network, Run, RunSummary, Simulation } from "./types";

/** Pair each proposal run with the run of its parent scenario that used the same seeds and started closest
 *  in time. Used only for runs made before simulations were stored (older versions of the app). */
export function pairRuns(runs: RunSummary[]) {
  const used = new Set<string>();
  const experiments: { id: string; before: RunSummary; after: RunSummary }[] = [];
  const byTime = [...runs].sort((a, b) => (b.started ?? 0) - (a.started ?? 0));
  for (const r of byTime) {
    if (!r.parent_id || used.has(r.id)) continue;
    const cands = byTime.filter((x) => !used.has(x.id) && x.id !== r.id && x.scenario_id === r.parent_id && JSON.stringify(x.seeds) === JSON.stringify(r.seeds));
    if (!cands.length) continue;
    const best = cands.reduce((a, b) => (Math.abs((a.started ?? 0) - (r.started ?? 0)) <= Math.abs((b.started ?? 0) - (r.started ?? 0)) ? a : b));
    if (Math.abs((best.started ?? 0) - (r.started ?? 0)) > 600) continue;
    used.add(r.id); used.add(best.id);
    experiments.push({ id: r.id, before: best, after: r });
  }
  return { experiments, singles: byTime.filter((r) => !used.has(r.id)) };
}

type Props = {
  sims: Simulation[]; networks: Network[];
  onOpen: (simId: string) => void; onChanged: () => void; onOpenFile: () => void; fail: (e: unknown) => void;
};

export default function Experiments({ sims, networks, onOpen, onChanged, onOpenFile, fail }: Props) {
  const [tab, setTab] = useState<"sims" | "runs">("sims");
  const [net, setNet] = useState("all");
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [pick, setPick] = useState<{ a: string | null; b: string | null }>({ a: null, b: null });
  const [pair, setPair] = useState<{ cmp: Comparison; a: Run; b: Run } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  useEffect(() => { if (tab === "runs" && !runs) api.runs().then(setRuns).catch(fail); }, [tab]);

  const netName = (id?: string) => networks.find((n) => n.id === id)?.name ?? id ?? "unknown network";
  const shown = sims.filter((s) => net === "all" || s.network === net);
  const finished = useMemo(() => (runs ?? []).filter((r) => r.state === "done" && (net === "all" || r.base_network === net)), [runs, net]);
  const A = finished.find((r) => r.id === pick.a), B = finished.find((r) => r.id === pick.b);

  async function compare() {
    if (!A || !B) return;
    try {
      const [c, ra, rb] = await Promise.all([api.compare(A.id, B.id), api.run(A.id), api.run(B.id)]);
      setPair({ cmp: c, a: ra, b: rb });
    } catch (e) { fail(e); }
  }

  return (
    <main className="work page-only">
      <section className="page">
        <div className="page-head">
          <h1>Experiments &amp; History</h1>
          <p className="lead">Every simulation you ran. Open its results, run it again to check the numbers reproduce, or compare any two runs.</p>
        </div>
        <div className="row spread page-tools">
          <div className="seg" role="tablist" aria-label="View">
            <button role="tab" aria-selected={tab === "sims"} onClick={() => setTab("sims")}>Simulations</button>
            <button role="tab" aria-selected={tab === "runs"} onClick={() => setTab("runs")}>Compare two runs</button>
          </div>
          <select value={net} onChange={(e) => setNet(e.target.value)} aria-label="Network">
            <option value="all">All networks</option>
            {networks.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
          </select>
        </div>

        {tab === "sims" && (
          <>
            {shown.length === 0 && <p className="small muted">No simulations yet. Run one in Traffic Simulation.</p>}
            <ul className="exp-list">
              {shown.map((s) => (
                <li key={s.id} className="exp">
                  <div className="exp-top">
                    <span className="exp-when">{when(s.created)}{s.rerun_of && " · run again"}</span>
                    {s.state !== "done" && <span className={`status ${s.state}`}>{{ running: "Running", failed: "Failed", cancelled: "Cancelled", missing: "Unavailable", done: "" }[s.state]}</span>}
                  </div>
                  <p className="exp-title">{s.name}</p>
                  <p className="small">{netName(s.network)}. Reference: {s.reference.scenario_name}. Tested: {s.alternatives.map((a) => a.scenario_name).join(", ")}.</p>
                  <p className="small muted">{s.seeds.length} runs each{s.depart_jitter_s ? `, start times ±${s.depart_jitter_s} s` : ""}.</p>
                  <div className="row">
                    {s.state === "done" && <button className="btn secondary small" onClick={() => onOpen(s.id)}>Open results</button>}
                    {s.state === "done" && <button className="btn quiet small" onClick={async () => { try { await api.rerunSimulation(s.id); onChanged(); } catch (e) { fail(e); } }}>Run again</button>}
                    {s.state !== "running" && confirm !== s.id && <button className="btn quiet small" onClick={() => setConfirm(s.id)}>Remove</button>}
                    {confirm === s.id && (
                      <>
                        <span className="small">Remove from the list? Its runs stay on disk.</span>
                        <button className="btn danger small" onClick={async () => { try { await api.deleteSimulation(s.id); setConfirm(null); onChanged(); } catch (e) { fail(e); } }}>Remove</button>
                        <button className="btn quiet small" onClick={() => setConfirm(null)}>Keep</button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        {tab === "runs" && (
          <>
            <p className="small muted">Pick run A as the reference and run B to compare with it. Both must be on the same network and share seeds. This also covers runs made before simulations were saved.</p>
            {!runs && <p className="status-line"><span className="spinner" aria-hidden="true" />Loading runs…</p>}
            {runs && (
              <table className="run-pick">
                <thead><tr><th scope="col">A</th><th scope="col">B</th><th scope="col">Run</th><th scope="col">Avg. travel time</th></tr></thead>
                <tbody>
                  {finished.map((r) => (
                    <tr key={r.id} className={pick.a === r.id || pick.b === r.id ? "picked" : ""}>
                      <td><input type="radio" name="runA" aria-label={`Use ${r.scenario_name} as A`} checked={pick.a === r.id} onChange={() => { setPick({ ...pick, a: r.id }); setPair(null); }} /></td>
                      <td><input type="radio" name="runB" aria-label={`Use ${r.scenario_name} as B`} checked={pick.b === r.id} onChange={() => { setPick({ ...pick, b: r.id }); setPair(null); }} /></td>
                      <th scope="row">
                        <span className="q-label">{r.scenario_name}, {when(r.started)}</span>
                        <span className="q-explain">{netName(r.base_network)}; {controllerName(r.controller)}; {r.edits ?? 0} changes; {r.seeds.length} runs{r.versions ? `; Junction ${r.versions.app}` : ""}</span>
                      </th>
                      <td>{fmt(r.mean_travel_time_s, "s")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {A && B && A.base_network !== B.base_network && <p className="banner-inline warn">A and B are on different networks.</p>}
            <button className="primary wide" disabled={!A || !B || A.id === B.id || A.base_network !== B.base_network} onClick={compare}>Compare B with A</button>
            {pair && (
              <div className="card">
                <h2>{B?.scenario_name} compared with {A?.scenario_name}</h2>
                <Results cmp={pair.cmp} before={pair.a} after={pair.b} labels={{ before: `A: ${A?.scenario_name}`, after: `B: ${B?.scenario_name}` }} />
              </div>
            )}
          </>
        )}

        <hr />
        <button className="btn secondary small" onClick={onOpenFile}>Open a saved experiment or scenario file</button>
      </section>
    </main>
  );
}
