import { useEffect, useMemo, useState } from "react";
import type { Edit, EdgeProps, Feature, Geometry, Scenario, SignalProgram, SignalProps } from "./types";
import { edgeLabel, type Selection } from "./MapView";

type Props = {
  selection: Selection;
  geometry: Geometry | null;       // proposal (edited) network
  baseGeometry: Geometry | null;   // current situation, for original values
  scenario: Scenario;
  signals: Record<string, SignalProgram> | null;
  onEdits: (edits: Edit[]) => void;
  busy: boolean;
  signalTitle?: (id: string) => string;
};

const SPEEDS = [20, 30, 40, 50, 60, 70, 80, 100];

function edgeById(g: Geometry | null, id: string) {
  return g?.features.find((f) => f.properties.kind === "edge" && f.properties.id === id)?.properties as EdgeProps | undefined;
}

export default function EditPanel(props: Props) {
  const { selection } = props;
  if (!selection) {
    return (
      <p className="hint">
        Click a road or a signal (dark dot) on the map, or pick one from the list below.
      </p>
    );
  }
  return selection.kind === "edge" ? <RoadEditor {...props} id={selection.id} /> : <SignalEditor {...props} id={selection.id} />;
}

function RoadEditor({ id, geometry, baseGeometry, scenario, onEdits, busy }: Props & { id: string }) {
  const cur = edgeById(geometry, id);
  const orig = edgeById(baseGeometry, id) ?? cur;
  const edits = scenario.edits;
  const closed = edits.some((e) => e.type === "close_road" && e.edge === id);
  const laneEdit = edits.find((e) => e.type === "set_lanes" && e.edge === id) as Extract<Edit, { type: "set_lanes" }> | undefined;
  const speedEdit = edits.find((e) => e.type === "set_speed" && e.edge === id) as Extract<Edit, { type: "set_speed" }> | undefined;
  const lanes = laneEdit?.lanes ?? orig?.lanes ?? 1;
  const speed = speedEdit?.speed_kmh ?? Math.round(orig?.speed_kmh ?? 50);

  const turns = useMemo(() => {
    if (!cur || !baseGeometry) return [];
    return baseGeometry.features
      .filter((f) => f.properties.kind === "edge")
      .map((f) => f.properties as EdgeProps)
      .filter((p) => p.from_node === cur.to_node && p.to_node !== cur.from_node && p.car_allowed);
  }, [cur?.id, baseGeometry]);

  if (!cur || !orig) return <p className="hint">This road is not in the current network.</p>;

  const without = (pred: (e: Edit) => boolean) => edits.filter((e) => !pred(e));
  const setLanes = (n: number) => {
    const rest = without((e) => e.type === "set_lanes" && e.edge === id);
    onEdits(n === orig.lanes ? rest : [...rest, { type: "set_lanes", edge: id, lanes: n }]);
  };
  const setSpeed = (v: number) => {
    const rest = without((e) => e.type === "set_speed" && e.edge === id);
    onEdits(v === Math.round(orig.speed_kmh) ? rest : [...rest, { type: "set_speed", edge: id, speed_kmh: v }]);
  };
  const toggleClosed = () => {
    const rest = without((e) => "edge" in e && e.edge === id && ["close_road", "set_lanes", "set_speed"].includes(e.type));
    onEdits(closed ? rest : [...rest, { type: "close_road", edge: id }]);
  };
  const banned = (to: string) => edits.some((e) => e.type === "ban_turn" && e.from_edge === id && e.to_edge === to);
  const toggleTurn = (to: string) => {
    const rest = without((e) => e.type === "ban_turn" && e.from_edge === id && e.to_edge === to);
    onEdits(banned(to) ? rest : [...rest, { type: "ban_turn", from_edge: id, to_edge: to }]);
  };
  const changed = edits.some((e) => ("edge" in e && e.edge === id) || ("from_edge" in e && e.from_edge === id));
  const resetRoad = () => onEdits(without((e) => ("edge" in e && e.edge === id) || ("from_edge" in e && e.from_edge === id)));

  return (
    <div className="editor">
      <h3>{edgeLabel(cur)}</h3>
      <p className="meta">
        {orig.road_type ? `${orig.road_type} road, ` : ""}
        {Math.round(orig.length_m)} m, one direction. Originally {orig.lanes} lane{orig.lanes > 1 ? "s" : ""} at{" "}
        {Math.round(orig.speed_kmh)} km/h. <span className="id">id {id}</span>
      </p>

      <div className="field">
        <span className="label">Lanes</span>
        <div className="stepper">
          <button disabled={busy || closed || lanes <= 1} onClick={() => setLanes(lanes - 1)} aria-label="Remove a lane">−</button>
          <output>{lanes}</output>
          <button disabled={busy || closed || lanes >= 6} onClick={() => setLanes(lanes + 1)} aria-label="Add a lane">+</button>
        </div>
        {laneEdit && <span className="was">was {orig.lanes}</span>}
      </div>

      <label className="field">
        <span className="label">Speed limit</span>
        <select value={SPEEDS.includes(speed) ? speed : ""} disabled={busy || closed} onChange={(e) => setSpeed(Number(e.target.value))}>
          {!SPEEDS.includes(speed) && <option value="">{speed} km/h</option>}
          {SPEEDS.map((s) => <option key={s} value={s}>{s} km/h</option>)}
        </select>
      </label>

      <div className="field">
        <span className="label">Road open to cars</span>
        <button className={`toggle ${closed ? "off" : "on"}`} role="switch" aria-checked={!closed} disabled={busy} onClick={toggleClosed}>
          {closed ? "Closed" : "Open"}
        </button>
      </div>

      {turns.length > 0 && !closed && (
        <fieldset className="turns">
          <legend>Turns allowed at the end of this road</legend>
          {turns.map((t) => (
            <label key={t.id} className="check">
              <input type="checkbox" checked={!banned(t.id)} disabled={busy} onChange={() => toggleTurn(t.id)} />
              <span>Onto {edgeLabel(t)}</span>
            </label>
          ))}
        </fieldset>
      )}

      {changed && <button className="link" onClick={resetRoad} disabled={busy}>Undo changes to this road</button>}
    </div>
  );
}

const STATE_CLASS: Record<string, string> = { G: "g", g: "g", y: "y", Y: "y", r: "r", R: "r", u: "y", o: "o", O: "o", s: "r" };

const TURN_ORDER: Record<string, number> = { left: 0, ahead: 1, right: 2, "u-turn": 3 };

/** Plain-language list of the movements that have green in a phase, grouped by approach road. */
function greenMovements(state: string, prog: SignalProgram): { road: string; turns: string[] }[] {
  const by: Record<string, Set<string>> = {};
  for (const li of prog.link_info ?? []) {
    const ch = state[li.index];
    if (ch !== "G" && ch !== "g") continue;
    const road = li.from_label || li.from_edge;
    (by[road] ??= new Set()).add(li.turn);
  }
  return Object.entries(by).map(([road, t]) => ({ road, turns: [...t].sort((a, b) => TURN_ORDER[a] - TURN_ORDER[b]) }));
}

function phaseKind(state: string) {
  if (/[Gg]/.test(state)) return "green";
  if (/[yYu]/.test(state)) return "amber";
  return "red";
}

function SignalEditor({ id, geometry, scenario, signals, onEdits, busy, signalTitle }: Props & { id: string }) {
  const node = geometry?.features.find((f: Feature) => f.properties.kind === "signal" && f.properties.id === id)?.properties as SignalProps | undefined;
  const tid = node?.tls.find((t) => signals?.[t]) ?? node?.tls[0] ?? id;
  const prog = signals?.[tid];
  const edit = scenario.edits.find((e) => e.type === "retime_signal" && e.tls === tid) as Extract<Edit, { type: "retime_signal" }> | undefined;
  const original = prog?.phases.map((p) => p.duration) ?? [];
  const [durs, setDurs] = useState<number[]>(edit?.durations ?? original);
  useEffect(() => setDurs(edit?.durations ?? original), [tid, prog?.cycle_s, edit?.durations?.join(",")]);

  if (!signals) return <p className="hint" role="status">Loading signal plan…</p>;
  if (!prog)
    return (
      <div className="editor">
        <h3>{signalTitle ? signalTitle(id) : `Signal ${id}`}</h3>
        <p className="banner-inline warn">This signal's timing can't be edited here. It is run together with a nearby junction.</p>
      </div>
    );
  const cycle = durs.reduce((a, b) => a + b, 0);
  const dirty = durs.join(",") !== (edit?.durations ?? original).join(",");
  const apply = () => {
    const rest = scenario.edits.filter((e) => !(e.type === "retime_signal" && e.tls === tid));
    const same = durs.join(",") === original.join(",");
    onEdits(same ? rest : [...rest, { type: "retime_signal", tls: tid, durations: durs }]);
  };

  return (
    <div className="editor">
      <h3>{signalTitle ? signalTitle(id) : `Signal ${tid}`}</h3>
      <p className="meta"><span className="id">id {tid}</span></p>
      <p className="meta">
        {prog.phases.length} phases, cycle {Math.round(cycle)} s (originally {Math.round(original.reduce((a, b) => a + b, 0))} s).
        Each row is one phase; the chips show who gets green.
      </p>
      <div className="cycle-bar" aria-hidden="true">
        {durs.map((d, i) => <i key={i} className={phaseKind(prog.phases[i]?.state ?? "")} style={{ flexGrow: d }} />)}
      </div>
      {scenario.controller === "max_pressure" && (
        <p className="note">This proposal uses pressure-based control, which picks phases live and ignores these fixed timings.</p>
      )}
      {scenario.controller === "actuated" && (
        <p className="note">With vehicle-actuated control, these times are the starting greens; each green can stretch or shorten with demand.</p>
      )}
      <ol className="phases">
        {prog.phases.map((p, i) => {
          const kind = phaseKind(p.state);
          const moves = kind === "green" ? greenMovements(p.state, prog) : [];
          return (
          <li key={i} className={`phase ${kind}`}>
            <span className="phase-text">
              <span className="phase-name">Phase {i + 1}{kind !== "green" && <span className="muted">, {kind === "amber" ? "amber (safety time)" : "all red (safety time)"}</span>}</span>
              {moves.length > 0 && (
                <span className="moves">
                  {moves.map((m) => <span key={m.road} className="move">{m.road}: {m.turns.join(", ")}</span>)}
                </span>
              )}
              <span className="state" aria-hidden="true" title="One mark per lane movement: green, amber or red">
                {[...p.state].map((ch, k) => <i key={k} className={STATE_CLASS[ch] ?? "o"} />)}
              </span>
            </span>
            <input
              type="number" min={1} max={180} value={durs[i] ?? p.duration} disabled={busy}
              aria-label={`Phase ${i + 1} duration in seconds`}
              onChange={(e) => setDurs(durs.map((d, k) => (k === i ? Math.max(1, Number(e.target.value) || 1) : d)))}
            />
            <span className="unit">s</span>
          </li>
          );
        })}
      </ol>
      <p className="small muted">Times are whole seconds. Signals are not coordinated with each other.</p>
      <div className="row">
        <button className="primary" disabled={busy || !dirty} onClick={apply}>Apply timing</button>
        {(edit || dirty) && (
          <button className="link" disabled={busy} onClick={() => { setDurs(original); onEdits(scenario.edits.filter((e) => !(e.type === "retime_signal" && e.tls === tid))); }}>
            Restore original timing
          </button>
        )}
      </div>
    </div>
  );
}
