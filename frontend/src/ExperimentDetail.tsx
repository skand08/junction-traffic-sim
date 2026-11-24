import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { edgeLabel } from "./MapView";
import { fmt } from "./Results";
import { JobRow } from "./RunMonitor";
import { controllerName, when } from "./shared";
import { ROAD_TYPES, type Edit, type EdgeProps, type Geometry, type Network, type ResultSummary, type Run, type SimPart, type Simulation } from "./types";

type Props = {
  sim: Simulation; sims: Simulation[]; networks: Network[];
  onBack: () => void; onResults: (simId: string) => void; onScenario: (scenarioId: string) => void;
  onOpenExperiment: (simId: string) => void; onChanged: () => void; fail: (e: unknown) => void;
};

/** Everything about one experiment: what was compared, how it was run, what came out, and whether it reproduces. */
export default function ExperimentDetail({ sim, sims, networks, onBack, onResults, onScenario, onOpenExperiment, onChanged, fail }: Props) {
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [summary, setSummary] = useState<ResultSummary[] | null>(null);
  const [geo, setGeo] = useState<Geometry | null>(null);
  const [confirm, setConfirm] = useState(false);
  const parts: (SimPart & { role: string })[] = [{ ...sim.reference, role: "Reference" }, ...sim.alternatives.map((a) => ({ ...a, role: "Tested" }))];

  useEffect(() => {
    let off = false;
    setRuns({});
    Promise.all(parts.map((p) => api.run(p.run_id).catch(() => null))).then((rs) => {
      if (off) return;
      const m: Record<string, Run> = {};
      rs.forEach((r, i) => { if (r) m[parts[i].run_id] = r; });
      setRuns(m);
    });
    api.networkGeometry(sim.network).then((g) => !off && setGeo(g)).catch(() => {});
    return () => { off = true; };
  }, [sim.id, sim.state]);
  useEffect(() => { api.results().then(setSummary).catch(() => setSummary([])); }, [sim.id, sim.state]);

  const edges = useMemo(() => {
    const m: Record<string, EdgeProps> = {};
    geo?.features.forEach((f) => { if (f.properties.kind === "edge") m[f.properties.id] = f.properties as EdgeProps; });
    return m;
  }, [geo]);
  const road = (id: string) => (edges[id] ? edgeLabel(edges[id]) : id);
  const describe = (e: Edit) => {
    switch (e.type) {
      case "set_lanes": return `${road(e.edge)}: ${e.lanes} lanes`;
      case "set_speed": return `${road(e.edge)}: ${e.speed_kmh} km/h`;
      case "close_road": return `${road(e.edge)}: closed`;
      case "ban_turn": return `No turn from ${road(e.from_edge)} onto ${road(e.to_edge)}`;
      case "retime_signal": return `Signal ${e.tls}: retimed, ${Math.round(e.durations.reduce((a, b) => a + b, 0))} s cycle`;
      case "add_signal": return `New signal at junction ${e.node}`;
      case "remove_signal": return `Signal removed at junction ${e.node}`;
      case "set_lane_width": return `${road(e.edge)}: lanes ${e.width_m} m wide`;
      case "set_road_type": return `${road(e.edge)}: ${ROAD_TYPES.find((r) => r.id === e.road_type)?.label.toLowerCase()}`;
    }
  };

  const netName = networks.find((n) => n.id === sim.network)?.name ?? sim.network;
  const mine = summary?.find((r) => r.id === sim.id);
  const original = sim.rerun_of ? sims.find((s) => s.id === sim.rerun_of) : null;
  const reruns = (summary ?? []).filter((r) => r.rerun_of === sim.id);
  const sameHeadline = (r: ResultSummary) => mine && r.alternatives.length === mine.alternatives.length &&
    r.alternatives.every((a, i) => a.diff_s === mine.alternatives[i].diff_s && a.after_s === mine.alternatives[i].after_s);
  const ref = runs[sim.reference.run_id];
  const first = Math.min(...Object.values(runs).map((r) => r.started ?? Infinity));
  const last = Math.max(...Object.values(runs).map((r) => r.finished ?? 0));
  const versions = ref?.versions;
  const warnings = parts.flatMap((p) => (runs[p.run_id]?.warnings ?? []).map((w) => `${p.scenario_name}: ${w}`));

  return (
    <main className="work page-only">
      <section className="page wide">
        <button className="btn quiet small" onClick={onBack}>← All experiments</button>
        <div className="page-head">
          <h1>{sim.name}</h1>
          <p className="lead">
            {netName}. Started {when(sim.created)}.{" "}
            {sim.state === "done" ? "Finished." : sim.state === "running" ? "Still running." : sim.state === "failed" ? "Failed." : sim.state === "cancelled" ? "Cancelled." : "Its runs are no longer available."}
          </p>
          <div className="row">
            {sim.state === "done" && <button className="primary" onClick={() => onResults(sim.id)}>Open in Results &amp; Analytics</button>}
            {sim.state !== "running" && <button className="btn secondary small" onClick={async () => { try { await api.rerunSimulation(sim.id); onChanged(); } catch (e) { fail(e); } }}>Run again</button>}
            {sim.state !== "running" && !confirm && <button className="btn quiet small" onClick={() => setConfirm(true)}>Remove</button>}
            {confirm && (
              <>
                <span className="small">Remove from the list? Its runs stay on disk.</span>
                <button className="btn danger small" onClick={async () => { try { await api.deleteSimulation(sim.id); onChanged(); onBack(); } catch (e) { fail(e); } }}>Remove</button>
                <button className="btn quiet small" onClick={() => setConfirm(false)}>Keep</button>
              </>
            )}
          </div>
        </div>

        <h2>Scenarios compared</h2>
        <table className="library">
          <thead><tr><th scope="col">Role</th><th scope="col">Scenario</th><th scope="col">Signal control</th><th scope="col" className="n-col">Traffic</th><th scope="col">Changes from the network as it is</th></tr></thead>
          <tbody>
            {parts.map((p) => {
              const sc = runs[p.run_id]?.scenario;
              return (
                <tr key={p.run_id}>
                  <td>{p.role}</td>
                  <th scope="row"><button className="link" onClick={() => onScenario(p.scenario_id)}>{p.scenario_name}</button>
                    <span className="lib-sub">as it was when run</span></th>
                  <td>{sc ? controllerName(sc.controller) : "…"}</td>
                  <td className="n-col">{sc ? `${Math.round(sc.demand_scale * 100)}%` : "…"}</td>
                  <td>{!sc ? "…" : sc.edits.length === 0 ? <span className="muted">None</span> : (
                    <ul className="plain">{sc.edits.map((e, i) => <li key={i}>{describe(e)}</li>)}</ul>
                  )}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <h2>How it was run</h2>
        <dl className="facts wide">
          <dt>Runs per scenario</dt><dd>{sim.seeds.length} (random seeds {sim.seeds.join(", ")})</dd>
          <dt>Start-time variation</dt><dd>{sim.depart_jitter_s ? `Each trip's start shifted by up to ±${sim.depart_jitter_s} s per run, the same for every scenario` : "None"}</dd>
          <dt>Simulated traffic</dt><dd>{ref?.build ? `${ref.build.total_trips.toLocaleString()} trips` : "…"}</dd>
          <dt>Run time</dt><dd>{isFinite(first) && last ? `${when(first)} to ${when(last)} (${Math.max(1, Math.round((last - first) / 60))} min)` : "…"}</dd>
          <dt>Software</dt><dd>{versions ? `Junction ${versions.app}, SUMO ${versions.sumo}${versions.python ? `, Python ${versions.python}` : ""}` : "…"}</dd>
          <dt>Ids</dt><dd className="mono small">simulation {sim.id}; runs {parts.map((p) => p.run_id).join(", ")}</dd>
        </dl>

        {sim.state !== "done" && (
          <>
            <h2>Status</h2>
            {parts.map((p) => <JobRow key={p.run_id} label={`${p.scenario_name}${p.role === "Reference" ? " (reference)" : ""}`} job={p.job} startedAt={null} />)}
          </>
        )}

        {sim.state === "done" && (
          <>
            <h2>Results</h2>
            {!mine && <p className="status-line" role="status"><span className="spinner" aria-hidden="true" />Loading…</p>}
            {mine && (
              <table className="library">
                <thead><tr><th scope="col">Scenario tested</th><th scope="col" className="n-col">Travel time, reference</th><th scope="col" className="n-col">Travel time, tested</th><th scope="col" className="n-col">Change</th><th scope="col" className="n-col">Runs better</th><th scope="col" className="n-col">Teleports</th></tr></thead>
                <tbody>
                  {mine.alternatives.map((a) => (
                    <tr key={a.run_id}>
                      <th scope="row">{a.scenario_name}</th>
                      <td className="n-col">{fmt(a.before_s, "s")}</td>
                      <td className="n-col">{fmt(a.after_s, "s")}</td>
                      <td className="n-col"><span className={`chg ${a.verdict === "better" ? "better" : a.verdict === "worse" ? "worse" : "same"}`}>{a.diff_s != null ? fmt(a.diff_s, "s", true) : "–"}</span>
                        {a.pct != null && <span className="muted small"> ({a.pct > 0 ? "+" : "−"}{Math.abs(a.pct).toFixed(1)}%)</span>}</td>
                      <td className="n-col">{a.n ? `${a.better} of ${a.n}` : "–"}</td>
                      <td className="n-col">{a.teleports_before != null ? `${Math.round(a.teleports_before)} → ${Math.round(a.teleports_after ?? 0)}` : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="small muted">Average travel time per trip on the trips that finished normally in both scenarios, over all runs. The map, every measure and the roads that changed most are in Results &amp; Analytics.</p>
          </>
        )}

        <h2>Reproducibility</h2>
        {original && <p>This is a repeat of <button className="link" onClick={() => onOpenExperiment(original.id)}>{original.name}, {when(original.created)}</button>. Results &amp; Analytics checks every per-run value against it.</p>}
        {reruns.length === 0 && !original && <p className="small muted">Not repeated yet. Use Run again to check that the same scenarios and seeds give the same numbers.</p>}
        {reruns.length > 0 && (
          <ul className="plain">
            {reruns.map((r) => (
              <li key={r.id}>
                <button className="link" onClick={() => onOpenExperiment(r.id)}>Repeated {when(r.created)}</button>{" "}
                {sameHeadline(r) ? <span className="pill dq-good">same results</span> : <span className="pill dq-caution">results differ</span>}
                {r.versions && versions && (r.versions.app !== versions.app || r.versions.sumo !== versions.sumo) && <span className="small muted"> (different software: Junction {r.versions.app}, SUMO {r.versions.sumo})</span>}
              </li>
            ))}
          </ul>
        )}

        {warnings.length > 0 && (
          <>
            <h2>Build notes</h2>
            <ul className="plain small">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </>
        )}

        {sim.state === "done" && (
          <>
            <h2>Files</h2>
            <p className="small muted">An experiment file holds the scenario, its seeds and every per-run value, so anyone with Junction can open it and check the numbers.</p>
            <div className="row">
              {sim.alternatives.map((a) => (
                <a key={a.run_id} className="btn secondary small" download
                  href={api.bundleUrl(a.scenario_id, { before: sim.reference.run_id, after: a.run_id })}>
                  {sim.alternatives.length > 1 ? `${a.scenario_name}: experiment file` : "Download experiment file"}
                </a>
              ))}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
