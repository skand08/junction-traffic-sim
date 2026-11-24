import { useEffect, useState } from "react";
import { api } from "./api";
import { edgeLabel } from "./MapView";
import type { Edit, EdgeProps, FlyoverOption, Geometry, Scenario } from "./types";

type Fly = Extract<Edit, { type: "add_flyover" }>;
const AXIS: Record<string, string> = { north: "north–south", south: "north–south", east: "east–west", west: "east–west",
  northeast: "northeast–southwest", southwest: "northeast–southwest", northwest: "northwest–southeast", southeast: "northwest–southeast" };

/** Carry one road straight over this junction on a flyover; the cross street and turns stay at street level. */
export default function FlyoverEditor({ node, scenario, baseGeometry, onEdits, busy }: {
  node: string; scenario: Scenario; baseGeometry: Geometry | null; onEdits: (edits: Edit[]) => void; busy: boolean;
}) {
  const [opts, setOpts] = useState<FlyoverOption[] | null>(null);
  const [pick, setPick] = useState<FlyoverOption | null>(null);
  const [lanes, setLanes] = useState(2);
  const [speed, setSpeed] = useState(60);
  const [ramp, setRamp] = useState(100);
  const [both, setBoth] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setOpts(null); setPick(null); setErr(null);
    api.flyoverOptions(scenario.id, node).then((r) => setOpts(r.options)).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [node, scenario.id]);
  const existing = scenario.edits.filter((e): e is Fly => e.type === "add_flyover" && e.node === node);
  const road = (id: string) => {
    const p = baseGeometry?.features.find((f) => f.properties.kind === "edge" && f.properties.id === id)?.properties as EdgeProps | undefined;
    return p ? edgeLabel(p).replace(/, \w+bound$/, "") : id;
  };
  const choose = (o: FlyoverOption) => {
    setPick(o); setLanes(Math.max(1, Math.min(o.lanes, 3))); setBoth(!!o.reverse);
    setRamp(Math.min(100, Math.max(30, o.max_ramp_m)));
  };
  const add = () => pick && onEdits([...scenario.edits, { type: "add_flyover", node, from_edge: pick.from_edge, to_edge: pick.to_edge,
    lanes, speed_kmh: speed, ramp_m: ramp, both_ways: both && !!pick.reverse }]);

  return (
    <section className="flyover-ed">
      <h4>Flyover</h4>
      {existing.map((f, i) => (
        <div key={i} className="fly-existing">
          <p className="small"><b>{road(f.from_edge)}</b> passes over this junction{f.both_ways ? " in both directions" : ""}: {f.lanes} lane{f.lanes > 1 ? "s" : ""}, {f.speed_kmh} km/h, ramps {f.ramp_m} m.</p>
          <button className="btn quiet small" disabled={busy} onClick={() => onEdits(scenario.edits.filter((e) => e !== f))}>Remove flyover</button>
        </div>
      ))}
      {existing.length === 0 && (<>
        <p className="small muted">Lift one road over the junction. Turning traffic and the cross street keep using it at street level.</p>
        {err && <p className="small warn-text">{err}</p>}
        {opts && opts.length === 0 && <p className="small muted">No road goes straight through this junction.</p>}
        {opts && opts.length > 0 && (
          <div className="choice-cards fly-axes" role="radiogroup" aria-label="Road to carry over the junction">
            {opts.map((o) => (
              <button key={o.from_edge} role="radio" aria-checked={pick?.from_edge === o.from_edge} className="choice-card" onClick={() => choose(o)}>
                <b>{road(o.from_edge)}</b><span>{o.reverse ? AXIS[o.heading] ?? "both ways" : `${o.heading}bound only`}</span>
              </button>
            ))}
          </div>
        )}
        {pick && (
          <div className="fly-form">
            <label className="field"><span className="label">Lanes on the flyover</span>
              <select value={lanes} onChange={(e) => setLanes(Number(e.target.value))}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
            <label className="field"><span className="label">Speed limit</span>
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>{[40, 50, 60, 70, 80].map((n) => <option key={n} value={n}>{n} km/h</option>)}</select></label>
            <label className="field"><span className="label">Ramp length <span className="small muted">up to {pick.max_ramp_m} m</span></span>
              <input type="number" min={30} max={pick.max_ramp_m} step={10} value={ramp} onChange={(e) => setRamp(Math.max(30, Math.min(pick.max_ramp_m, Number(e.target.value) || 30)))} /></label>
            {pick.reverse && <label className="check field-check"><input type="checkbox" checked={both} onChange={(e) => setBoth(e.target.checked)} /><span>Both directions</span></label>}
            <button className="primary" disabled={busy} onClick={add}>Build flyover</button>
          </div>
        )}
      </>)}
    </section>
  );
}
