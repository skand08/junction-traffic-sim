import { useEffect, useMemo, useState } from "react";
import PageHead from "../PageHead";
import { api } from "../api";
import MapView, { edgeLabel, featureBBox, type MapMode, type Selection } from "../MapView";
import Results, { fmt, quality } from "../Results";
import { Legend, ReproCheck, RunFacts, SelectedCard, TopRoads, controllerName, listNav, when, type Expected, type Side } from "../shared";
import { signalLabel } from "./NetworkExplorer";
import type { Comparison, EdgeProps, Geometry, Network, ResultSummary, Run, Simulation, SignalProps } from "../types";

type Props = {
  sims: Simulation[];
  networks: Network[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onEditScenario: (id: string) => void;
  onOpenFile: () => void;
  onExperiment: (simId: string) => void;
  fail: (e: unknown) => void;
};

/** Results & Analytics: a table of every finished simulation; picking one opens its comparison. */
export default function ResultsPage(props: Props) {
  const sim = props.sims.find((s) => s.id === props.selected && s.state === "done");
  return sim ? <ResultDetail {...props} sim={sim} /> : <ResultsLibrary {...props} />;
}

function ResultsLibrary({ networks, onSelect, onOpenFile, onExperiment, sims, fail }: Props) {
  const [rows, setRows] = useState<ResultSummary[] | null>(null);
  const [net, setNet] = useState("all");
  const [q, setQ] = useState("");
  const doneCount = sims.filter((s) => s.state === "done").length;
  useEffect(() => { api.results().then(setRows).catch(fail); }, [doneCount]);
  const netName = (id: string) => networks.find((n) => n.id === id)?.name ?? id;
  const shown = (rows ?? []).filter((r) => (net === "all" || r.network === net) &&
    (!q || `${r.name} ${r.reference_name} ${r.alternatives.map((a) => a.scenario_name).join(" ")}`.toLowerCase().includes(q.toLowerCase())));

  return (
    <main className="work page-only">
      <section className="page wide">
        <PageHead title="Results & Analytics" lead="Finished simulations: the change, where it happened and how sure it is."
          actions={<button className="btn secondary small" onClick={onOpenFile}>Open experiment file</button>} />
        <div className="row spread page-tools">
          <div className="row nowrap">
            <input type="search" className="text" value={q} placeholder="Search by scenario name" aria-label="Search results" onChange={(e) => setQ(e.target.value)} />
            <select value={net} onChange={(e) => setNet(e.target.value)} aria-label="Network">
              <option value="all">All networks</option>
              {networks.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </select>
          </div>
        </div>
        {!rows && <p className="status-line" role="status"><span className="spinner" aria-hidden="true" />Loading results…</p>}
        {rows && shown.length === 0 && <p className="small muted">{rows.length ? "No results match." : "No finished simulations yet. Run one in Traffic Simulation."}</p>}
        {shown.length > 0 && (
          <table className="library">
            <thead>
              <tr>
                <th scope="col">Simulation</th>
                <th scope="col">Network</th>
                <th scope="col">Scenario tested</th>
                <th scope="col" className="n-col">Travel time vs reference</th>
                <th scope="col" className="n-col">Runs better</th>
                <th scope="col" className="n-col">Teleports</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody onKeyDown={listNav}>
              {shown.map((r) => r.alternatives.map((a, i) => (
                <tr key={`${r.id}-${a.run_id}`} className={i > 0 ? "cont" : ""}>
                  {i === 0 && (
                    <th scope="rowgroup" rowSpan={r.alternatives.length}>
                      <span className="lib-name">{r.name}</span>
                      <span className="lib-sub">{when(r.created)}, {r.seeds.length} runs{r.depart_jitter_s ? `, starts ±${Math.round(r.depart_jitter_s / 60)} min` : ""}{r.rerun_of ? " · run again" : ""}</span>
                    </th>
                  )}
                  {i === 0 && <td rowSpan={r.alternatives.length}>{netName(r.network)}</td>}
                  <td>{a.scenario_name}<span className="lib-sub">vs {r.reference_name}{a.controller && a.controller !== "fixed" ? `, ${controllerName(a.controller).toLowerCase()}` : ""}</span></td>
                  <td className="n-col">
                    <span className={`chg ${a.verdict === "better" ? "better" : a.verdict === "worse" ? "worse" : "same"}`}>{a.diff_s != null ? fmt(a.diff_s, "s", true) : "–"}</span>
                    {a.pct != null && <span className="muted small"> ({a.pct > 0 ? "+" : "−"}{Math.abs(a.pct).toFixed(1)}%)</span>}
                  </td>
                  <td className="n-col">{a.n ? `${a.better} of ${a.n}` : "–"}</td>
                  <td className="n-col">{a.teleports_after != null ? Math.round(a.teleports_after) : "–"}</td>
                  {i === 0 && (
                    <td rowSpan={r.alternatives.length} className="lib-actions">
                      <button className="btn secondary small" onClick={() => onSelect(r.id)}>Open</button>
                      <button className="btn quiet small" onClick={() => onExperiment(r.id)}>Details</button>
                    </td>
                  )}
                </tr>
              )))}
            </tbody>
          </table>
        )}
        <p className="small muted">Travel time is the average per trip on the trips that finished normally in both scenarios. Teleports are vehicles SUMO removed from a jam (average per run).</p>
      </section>
    </main>
  );
}

type AltResult = { runs: Partial<Record<Side, Run>>; cmp: Comparison };

function ResultDetail({ sims, networks, sim, onSelect, onEditScenario, onExperiment, fail }: Props & { sim: Simulation }) {
  const done = sims.filter((s) => s.state === "done");
  const [results, setResults] = useState<Record<string, AltResult>>({});
  const [alt, setAlt] = useState<string | null>(null);
  const [expected, setExpected] = useState<Record<string, Expected> | null>(null);
  const [geo, setGeo] = useState<Geometry | null>(null);
  const [baseGeo, setBaseGeo] = useState<Geometry | null>(null);
  const [mode, setMode] = useState<MapMode>("change");
  const [delaySide, setDelaySide] = useState<Side>("prop");
  const [sel, setSel] = useState<Selection>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ bbox: [number, number, number, number]; key: number; maxZoom?: number } | null>(null);

  // load the comparison of every alternative with the reference
  useEffect(() => {
    setResults({}); setAlt(null); setExpected(null); setSel(null);
    if (!sim || sim.state !== "done") return;
    let off = false;
    (async () => {
      try {
        const rb = await api.run(sim.reference.run_id);
        const out: Record<string, AltResult> = {};
        for (const a of sim.alternatives) {
          const [rp, c] = await Promise.all([api.run(a.run_id), api.compare(sim.reference.run_id, a.run_id)]);
          out[a.run_id] = { runs: { base: rb, prop: rp }, cmp: c };
        }
        if (off) return;
        setResults(out); setAlt(sim.alternatives[0]?.run_id ?? null);
        if (sim.rerun_of) {
          // reproduction check: the earlier simulation's per-run values, pair by pair
          const orig = await api.simulation(sim.rerun_of);
          const ob = await api.run(orig.reference.run_id);
          const exp: Record<string, Expected> = {};
          for (const [i, a] of sim.alternatives.entries()) {
            const oa = orig.alternatives[i];
            if (!oa) continue;
            const op = await api.run(oa.run_id);
            const keys = ["mean_travel_time_s", "mean_delay_s", "completed_trips", "teleports"];
            exp[a.run_id] = {
              values: Object.fromEntries(keys.map((k) => [k, { before: ob.aggregate.kpis[k]?.values ?? [], after: op.aggregate.kpis[k]?.values ?? [] }])),
              versions: op.versions, source: `${orig.reference.run_id} / ${oa.run_id}`,
            };
          }
          if (!off) setExpected(exp);
        }
      } catch (e) { if (!off) fail(e); }
    })();
    return () => { off = true; };
  }, [sim?.id, sim?.state]);

  const current = alt ? results[alt] : null;
  const part = sim?.alternatives.find((a) => a.run_id === alt);
  useEffect(() => {
    setGeo(null);
    if (!part || !sim) return;
    Promise.all([api.geometry(part.scenario_id).catch(() => api.networkGeometry(sim.network)), api.networkGeometry(sim.network)])
      .then(([g, b]) => { setGeo(g); setBaseGeo(b); }).catch(fail);
  }, [part?.scenario_id]);

  const edges = useMemo(() => {
    const m: Record<string, EdgeProps> = {};
    baseGeo?.features.forEach((f) => { if (f.properties.kind === "edge") m[f.properties.id] = f.properties as EdgeProps; });
    return m;
  }, [baseGeo]);
  const roadName = (id: string) => (edges[id] ? edgeLabel(edges[id]) : `road ${id}`);
  const signalTitle = (id: string) => {
    const p = geo?.features.find((f) => f.properties.kind === "signal" && f.properties.id === id)?.properties as SignalProps | undefined;
    return p ? signalLabel(p, edges) : `Signal ${id}`;
  };
  const zoomTo = (id: string) => {
    const f = geo?.features.find((x) => x.properties.kind === "edge" && x.properties.id === id);
    if (f) setFocus({ bbox: featureBBox(f), key: Date.now() });
  };
  const labels = { before: sim?.reference.scenario_name ?? "Reference", after: part?.scenario_name ?? "Scenario" };
  const netName = (id: string) => networks.find((n) => n.id === id)?.name ?? id;


  return (
    <main className="work">
      <div className="stage">
        {geo ? (
          <>
            <MapView geometry={mode === "results" && delaySide === "base" ? baseGeo : geo} mode={mode} selection={sel} onSelect={setSel}
              hoverId={hoverId} focus={focus} runEdges={current?.runs[delaySide]?.aggregate.edges} cmpEdges={current?.cmp.edges} />
            <div className="map-top">
              <div className="modes" role="tablist" aria-label="Map colouring">
                <button role="tab" aria-selected={mode === "layout"} onClick={() => setMode("layout")}>Layout</button>
                <button role="tab" aria-selected={mode === "results"} onClick={() => setMode("results")}>Delay</button>
                <button role="tab" aria-selected={mode === "change"} onClick={() => setMode("change")}>What changed</button>
              </div>
            </div>
            <Legend mode={mode} delaySide={delaySide} setDelaySide={setDelaySide} labels={labels} />
          </>
        ) : <div className="empty-stage"><p>{sim.state === "done" ? "Loading…" : "This simulation has no results."}</p></div>}
      </div>
      <aside className="panel">
        <div className="panel-body">
          <section className="step">
            <div className="row spread">
              <button className="btn quiet small" onClick={() => onSelect(null)}>← All results</button>
              <button className="btn quiet small" onClick={() => onExperiment(sim.id)}>Experiment details</button>
            </div>
            <h2>Results &amp; Analytics</h2>
            <label className="field block">
              <span className="label">Simulation</span>
              <select value={sim.id} onChange={(e) => onSelect(e.target.value)}>
                {done.map((s) => <option key={s.id} value={s.id}>{s.name}, {when(s.created)}</option>)}
              </select>
            </label>
            <p className="small muted">
              {netName(sim.network)}. {sim.seeds.length} runs each, seeds {sim.seeds[0]}–{sim.seeds[sim.seeds.length - 1]}
              {sim.depart_jitter_s ? `, start times varied by ±${sim.depart_jitter_s} s` : ", no start-time variation"}. Reference: <b>{sim.reference.scenario_name}</b>.
            </p>

            {Object.keys(results).length > 0 && (
              <table className="summary">
                <thead><tr><th scope="col">Scenario</th><th scope="col">Travel time change</th><th scope="col">Runs better</th><th scope="col">Data</th></tr></thead>
                <tbody>
                  {sim.alternatives.map((a) => {
                    const r = results[a.run_id];
                    if (!r) return null;
                    const k = r.cmp.kpis.matched_travel_time_s ?? r.cmp.kpis.mean_travel_time_s;
                    const q = quality(r.cmp, r.runs.base, r.runs.prop);
                    const better = k ? Math.round(k.share_seeds_better * k.n) : 0;
                    return (
                      <tr key={a.run_id} className={alt === a.run_id ? "picked" : ""} onClick={() => { setAlt(a.run_id); setSel(null); }}>
                        <th scope="row"><button className="link" onClick={() => { setAlt(a.run_id); setSel(null); }}>{a.scenario_name}</button></th>
                        <td><span className={`chg ${k?.verdict === "better" ? "better" : k?.verdict === "worse" ? "worse" : "same"}`}>{k ? fmt(k.diff, "s", true) : "–"}</span>
                          {k?.pct_change != null && <span className="muted small"> ({k.pct_change > 0 ? "+" : "−"}{Math.abs(k.pct_change).toFixed(1)}%)</span>}</td>
                        <td>{k ? `${better} of ${k.n}` : "–"}</td>
                        <td><span className={`pill dq-${q.level}`}>{q.level}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {sim.alternatives.length > 1 && <p className="small muted">Select a scenario to see its details and map.</p>}

            {current && part && (
              <>
                <h3>{part.scenario_name} compared with {sim.reference.scenario_name}</h3>
                <p className="small muted">
                  Signal control: {controllerName(current.runs.prop?.scenario.controller)}
                  {current.runs.prop?.scenario.controller === "max_pressure" && <span className="tag-exp">EXPERIMENTAL</span>}
                  {current.runs.prop && current.runs.prop.scenario.demand_scale !== 1 ? `, ${Math.round(current.runs.prop.scenario.demand_scale * 100)}% traffic` : ""}.
                </p>
                <div className="row">
                  <a className="btn secondary small" href={api.bundleUrl(part.scenario_id, { before: sim.reference.run_id, after: part.run_id })} download>Save experiment file</a>
                  <button className="btn quiet small" onClick={() => onEditScenario(part.scenario_id)}>Open scenario</button>
                </div>
                {expected?.[part.run_id] && <ReproCheck expected={expected[part.run_id]} runs={current.runs} />}
                {sel && <SelectedCard sel={sel} cmp={current.cmp} runs={current.runs} edgeMap={edges} roadName={roadName} labels={labels}
                  signalLabel={signalTitle} onEdit={() => onEditScenario(part.scenario_id)} onClose={() => setSel(null)} />}
                <Results cmp={current.cmp} before={current.runs.base} after={current.runs.prop} labels={labels} />
                <TopRoads cmp={current.cmp} roadName={roadName} onHover={setHoverId}
                  onZoom={(id) => { setSel({ kind: "edge", id }); zoomTo(id); setMode("change"); }} />
                <RunFacts runs={current.runs} cmp={current.cmp} />
              </>
            )}
          </section>
        </div>
      </aside>
    </main>
  );
}
