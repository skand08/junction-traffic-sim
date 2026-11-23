import { DELAY_LEGEND, type MapMode, type Selection } from "./MapView";
import { fmt } from "./Results";
import type { Bundle, Comparison, Controller, EdgeProps, Run } from "./types";

export type Side = "base" | "prop";
export type Labels = { before: string; after: string };
export const DEFAULT_LABELS: Labels = { before: "Reference", after: "Scenario" };
export type Expected = { values: NonNullable<Bundle["experiment"]>["values"]; versions?: { app: string; sumo: string }; source: string };

export const CONTROLLERS: { id: Controller; name: string; text: string; experimental?: boolean }[] = [
  { id: "fixed", name: "Fixed timing", text: "Signals repeat the same plan." },
  { id: "actuated", name: "Vehicle-actuated", text: "Greens adjust to waiting cars." },
  { id: "max_pressure", name: "Pressure-based", experimental: true,
    text: "Green goes to the longest queues. Experimental: can jam on busy networks." },
];
export const controllerName = (c?: string) => CONTROLLERS.find((x) => x.id === c)?.name ?? "Fixed timing";

export function when(t?: number) {
  if (!t) return "unknown time";
  return new Date(t * 1000).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function ReproCheck({ expected, runs }: { expected: Expected; runs: Partial<Record<Side, Run>> }) {
  const keys = Object.keys(expected.values);
  let compared = 0, differ = 0;
  for (const k of keys) {
    for (const [side, run] of [["before", runs.base], ["after", runs.prop]] as const) {
      const want = expected.values[k][side], got = run?.aggregate.kpis[k]?.values;
      if (!want || !got) continue;
      want.forEach((w, i) => { compared++; if (w == null ? got[i] != null : got[i] == null || Math.abs(w - got[i]!) > 1e-9) differ++; });
    }
  }
  const v = runs.prop?.versions, ev = expected.versions;
  const verDiff = ev && v && (ev.sumo !== v.sumo || ev.app !== v.app);
  if (!compared) return null;
  return (
    <div className={`banner ${differ ? "q-caution" : "q-good"}`}>
      <p className="banner-title">{differ ? "Reproduction check: results differ from the saved experiment" : "Reproduction check: identical to the saved experiment"}</p>
      <p>{differ ? `${differ} of ${compared} saved per-run values differ.` : `All ${compared} saved per-run values (travel time, delay, trips completed and teleports, both options) match exactly.`}
        {verDiff ? ` The experiment was saved with SUMO ${ev!.sumo} and Junction ${ev!.app}; this run used SUMO ${v!.sumo} and Junction ${v!.app}, which can explain differences.` : ""}</p>
      <p className="tiny">Saved runs: <span className="mono">{expected.source}</span></p>
    </div>
  );
}

export function SelectedCard({ sel, cmp, runs, edgeMap, roadName, signalLabel, onEdit, onClose, labels }: {
  sel: NonNullable<Selection>; cmp: Comparison; runs: Partial<Record<Side, Run>>; edgeMap: Record<string, EdgeProps>; labels: Labels;
  roadName: (id: string) => string; signalLabel: (id: string) => string; onEdit: () => void; onClose: () => void;
}) {
  if (sel.kind === "signal")
    return (
      <div className="selected-card">
        <div className="row spread"><h3>{signalLabel(sel.id)}</h3><button className="btn quiet small" onClick={onClose}>Close</button></div>
        <p className="small muted">Results are measured per road, not per signal; see the roads around it on the map.</p>
        <button className="btn secondary small" onClick={onEdit}>Change its timing</button>
      </div>
    );
  const a = runs.base?.aggregate.edges[sel.id], b = runs.prop?.aggregate.edges[sel.id], c = cmp.edges[sel.id];
  return (
    <div className="selected-card">
      <div className="row spread"><h3>{roadName(sel.id)}</h3><button className="btn quiet small" onClick={onClose}>Close</button></div>
      <table className="compact">
        <thead><tr><th scope="col">Per vehicle on this road</th><th scope="col">{labels.before}</th><th scope="col">{labels.after}</th></tr></thead>
        <tbody>
          <tr><th scope="row">Delay</th><td>{fmt(a?.delay_per_veh_s, "s")}</td><td>{fmt(b?.delay_per_veh_s, "s")}</td></tr>
          <tr><th scope="row">Average speed</th><td>{a?.speed_kmh != null ? `${a.speed_kmh.toFixed(0)} km/h` : "–"}</td><td>{b?.speed_kmh != null ? `${b.speed_kmh.toFixed(0)} km/h` : "–"}</td></tr>
          <tr><th scope="row">Vehicles entering per run</th><td>{fmt(a?.volume, "")}</td><td>{fmt(b?.volume, "")}</td></tr>
        </tbody>
      </table>
      <p className="small muted">
        {c?.change === "better" ? "Less delay in the proposal." : c?.change === "worse" ? "More delay in the proposal." : c?.change === "removed" ? "No traffic on this road in the proposal." : "About the same."}
        {" "}Average of all runs.
      </p>
      <button className="btn secondary small" onClick={onEdit}>Change this road</button>
    </div>
  );
}

export function TopRoads({ cmp, roadName, onZoom, onHover }: { cmp: Comparison; roadName: (id: string) => string; onZoom: (id: string) => void; onHover: (id: string | null) => void }) {
  const rows = Object.entries(cmp.edges)
    .filter(([, e]) => e.delay_change_s != null && (e.change === "better" || e.change === "worse"))
    .sort((a, b) => Math.abs(b[1].delay_change_s!) - Math.abs(a[1].delay_change_s!))
    .slice(0, 8);
  return (
    <div className="top-roads">
      <h4 className="sub">Roads that changed most</h4>
      {!rows.length ? <p className="small muted">No single road changed its delay by at least 3 s and 15%.</p> : (
        <>
          <p className="small muted">Delay per vehicle, proposal minus current, averaged over runs. Select one to see it on the map.</p>
          <ul>
            {rows.map(([id, e]) => {
              const max = Math.abs(rows[0][1].delay_change_s!);
              return (
                <li key={id} onMouseEnter={() => onHover(id)} onMouseLeave={() => onHover(null)}>
                  <button className="link" onClick={() => onZoom(id)}>{roadName(id)}</button>
                  <span className="bar-cell" aria-hidden="true"><i className={e.change} style={{ width: `${(100 * Math.abs(e.delay_change_s!)) / max}%` }} /></span>
                  <span className={`chg ${e.change}`}>{e.delay_change_s! > 0 ? "+" : "−"}{Math.abs(e.delay_change_s!).toFixed(1)} s</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

export function RunFacts({ runs, cmp }: { runs: Partial<Record<Side, Run>>; cmp: Comparison }) {
  const r = runs.prop ?? runs.base;
  if (!r) return null;
  const seeds = cmp.paired_seeds;
  return (
    <details className="facts-box">
      <summary>Run details for reproducing this result</summary>
      <dl className="facts">
        <dt>Network</dt><dd>{r.scenario.base_network}</dd>
        <dt>Seeds</dt><dd>{seeds.length > 6 ? `${seeds[0]} to ${seeds[seeds.length - 1]} (${seeds.length} runs)` : seeds.join(", ")}</dd>
        <dt>Signal control</dt><dd>reference: {controllerName(runs.base?.scenario.controller)}, scenario: {controllerName(runs.prop?.scenario.controller)}</dd>
        <dt>Traffic level</dt><dd>{Math.round(r.scenario.demand_scale * 100)}%</dd>
        <dt>Start-time variation</dt><dd>{r.depart_jitter_s ? `±${r.depart_jitter_s} s per run` : "off"}</dd>
        <dt>Changes</dt><dd>{runs.prop?.scenario.edits.length ?? 0}</dd>
        <dt>Versions</dt><dd>{r.versions ? `Junction ${r.versions.app}, SUMO ${r.versions.sumo}` : "not recorded (older run)"}</dd>
        <dt>Run ids</dt><dd className="mono">{runs.base?.id} / {runs.prop?.id}</dd>
      </dl>
    </details>
  );
}

export function Legend({ mode, delaySide = "prop", setDelaySide, labels = DEFAULT_LABELS }: { mode: MapMode; delaySide?: Side; setDelaySide?: (s: Side) => void; labels?: Labels }) {
  if (mode === "layout")
    return (
      <div className="legend">
        <span><i className="sw road" />Road (width = lanes)</span>
        <span><i className="sw edited" />Changed</span>
        <span><i className="sw closed" />Closed</span>
        <span><i className="dot" />Signal</span>
      </div>
    );
  if (mode === "change")
    return (
      <div className="legend">
        <span><i className="sw better" />Less delay</span>
        <span><i className="sw worse" />More delay</span>
        <span><i className="sw same" />About the same</span>
      </div>
    );
  return (
    <div className="legend">
      <div className="seg">
        <button aria-pressed={delaySide === "base"} onClick={() => setDelaySide?.("base")}>{labels.before}</button>
        <button aria-pressed={delaySide === "prop"} onClick={() => setDelaySide?.("prop")}>{labels.after}</button>
      </div>
      <span className="ramp">
        Delay per vehicle
        {DELAY_LEGEND.map(({ v, c }) => (
          <span key={v} className="stop"><i style={{ background: `rgb(${c[0]},${c[1]},${c[2]})` }} />{v}{v === 100 ? "+ s" : ""}</span>
        ))}
      </span>
    </div>
  );
}
