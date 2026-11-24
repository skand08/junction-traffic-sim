import { useEffect, useMemo, useState } from "react";
import { ROAD_TYPES, type Edit, type EdgeProps, type Feature, type Geometry, type JunctionProps, type RoadType, type Scenario, type SignalProgram, type SignalProps } from "./types";
import { edgeLabel, type Selection } from "./MapView";
import FlyoverEditor from "./FlyoverEditor";

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
        Click a road, a signal (dark dot) or a junction (ring, when zoomed in) on the map, or pick one from the list below.
      </p>
    );
  }
  if (selection.kind === "edge") {
    const p = edgeById(props.geometry, selection.id);
    const fly = props.scenario.edits.find((e) => e.type === "add_flyover" &&
      (p?.flyover === e.node || [`${e.from_edge}_atgrade`, `${e.to_edge}_atgrade`].includes(selection.id))) as Extract<Edit, { type: "add_flyover" }> | undefined;
    if (fly) return (
      <div className="editor">
        <h3>{p ? edgeLabel(p) : selection.id}</h3>
        <p className="meta">{p?.flyover ? `Flyover deck: ${p.lanes} lane${p.lanes === 1 ? "" : "s"}, ${Math.round(p.speed_kmh)} km/h, ${Math.round(p.length_m)} m.`
          : "Street-level piece between the flyover ramp and the junction, used by turning traffic."}</p>
        <p className="small muted">This is part of the flyover at {props.signalTitle ? props.signalTitle(fly.node) : `junction ${fly.node}`}. Change or remove it from that junction.</p>
      </div>
    );
    return <RoadEditor {...props} id={selection.id} />;
  }
  if (selection.kind === "junction") return <JunctionEditor {...props} id={selection.id} />;
  return <SignalEditor {...props} id={selection.id} />;
}

/** A junction without a signal: add one (or undo a removal made in this scenario). */
function JunctionEditor({ id, geometry, baseGeometry, scenario, onEdits, busy, signalTitle }: Props & { id: string }) {
  const j = geometry?.features.find((f) => f.properties.kind === "junction" && f.properties.id === id)?.properties as JunctionProps | undefined;
  const removedHere = scenario.edits.some((e) => e.type === "remove_signal" && e.node === id);
  const rest = scenario.edits.filter((e) => !((e.type === "add_signal" || e.type === "remove_signal") && e.node === id));
  if (!j) return <p className="hint">This junction is not in the current network.</p>;
  return (
    <div className="editor">
      <h3>{signalTitle ? signalTitle(id) : `Junction ${id}`}</h3>
      <p className="meta">
        No signal: {j.control === "priority" ? "the main road has right of way" : j.control === "right_before_left" ? "traffic from the right goes first" : j.control.replace(/_/g, " ")}.
        {" "}{j.incoming.length} roads in. <span className="id">id {id}</span>
      </p>
      {removedHere ? (
        <>
          <p className="note">This scenario removed the signal here.</p>
          <button className="btn secondary" disabled={busy} onClick={() => onEdits(rest)}>Put the signal back</button>
        </>
      ) : (
        <>
          <button className="primary" disabled={busy} onClick={() => onEdits([...rest, { type: "add_signal", node: id }])}>Add a traffic signal</button>
          <p className="small muted">SUMO gives it a standard fixed plan. You can retime it afterwards.</p>
        </>
      )}
      <FlyoverEditor node={id} scenario={scenario} baseGeometry={baseGeometry} onEdits={onEdits} busy={busy} />
    </div>
  );
}

function RoadEditor({ id, geometry, baseGeometry, scenario, onEdits, busy }: Props & { id: string }) {
  const cur = edgeById(geometry, id);
  const orig = edgeById(baseGeometry, id) ?? cur;
  const edits = scenario.edits;
  const closed = edits.some((e) => e.type === "close_road" && e.edge === id);
  const laneEdit = edits.find((e) => e.type === "set_lanes" && e.edge === id) as Extract<Edit, { type: "set_lanes" }> | undefined;
  const speedEdit = edits.find((e) => e.type === "set_speed" && e.edge === id) as Extract<Edit, { type: "set_speed" }> | undefined;
  const widthEdit = edits.find((e) => e.type === "set_lane_width" && e.edge === id) as Extract<Edit, { type: "set_lane_width" }> | undefined;
  const typeEdit = edits.find((e) => e.type === "set_road_type" && e.edge === id) as Extract<Edit, { type: "set_road_type" }> | undefined;
  const lanes = laneEdit?.lanes ?? orig?.lanes ?? 1;
  const roadPreset = typeEdit ? ROAD_TYPES.find((r) => r.id === typeEdit.road_type) : undefined;
  const speed = speedEdit?.speed_kmh ?? roadPreset?.speed_kmh ?? Math.round(orig?.speed_kmh ?? 50);
  const width = widthEdit?.width_m ?? orig?.lane_width_m ?? 3.2;

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
  const setWidth = (w: number) => {
    const rest = without((e) => e.type === "set_lane_width" && e.edge === id);
    onEdits(Math.abs(w - (orig.lane_width_m ?? 0)) < 0.01 ? rest : [...rest, { type: "set_lane_width", edge: id, width_m: w }]);
  };
  const setType = (t: RoadType | "") => {
    // a road class sets the speed limit itself, so it replaces a separate speed change
    const rest = without((e) => (e.type === "set_road_type" || e.type === "set_speed") && "edge" in e && e.edge === id);
    onEdits(t ? [...rest, { type: "set_road_type", edge: id, road_type: t }] : rest);
  };
  const toggleClosed = () => {
    const rest = without((e) => "edge" in e && e.edge === id && ["close_road", "set_lanes", "set_speed", "set_lane_width", "set_road_type"].includes(e.type));
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

      <label className="field">
        <span className="label">Road type</span>
        <select value={typeEdit?.road_type ?? ""} disabled={busy || closed} onChange={(e) => setType(e.target.value as RoadType | "")}>
          <option value="">{orig.road_type ? `As it is (${orig.road_type.replace(/_/g, " ")})` : "As it is"}</option>
          {ROAD_TYPES.map((r) => <option key={r.id} value={r.id}>{r.label}: {r.speed_kmh} km/h</option>)}
        </select>
      </label>
      {typeEdit && <p className="small muted field-note">Sets the speed limit and who has right of way at junctions without signals.</p>}

      <div className="field">
        <span className="label">Lane width</span>
        <div className="stepper">
          <button disabled={busy || closed || width <= 2.5} onClick={() => setWidth(Math.round((width - 0.25) * 100) / 100)} aria-label="Narrower lanes">−</button>
          <output>{width.toFixed(2)} m</output>
          <button disabled={busy || closed || width >= 4.5} onClick={() => setWidth(Math.round((width + 0.25) * 100) / 100)} aria-label="Wider lanes">+</button>
        </div>
        {widthEdit && <span className="was">was {orig.lane_width_m} m</span>}
      </div>
      {widthEdit && <p className="small muted field-note">Recorded in the network, but SUMO's standard driving model does not change speed or capacity with lane width, so expect little effect on results.</p>}

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

/** Text alternative for the per-movement marks, e.g. "4 green, 8 red". */
function stateSummary(state: string) {
  const n: Record<string, number> = {};
  for (const ch of state) { const k = STATE_CLASS[ch] ?? "o"; n[k] = (n[k] ?? 0) + 1; }
  const name: Record<string, string> = { g: "green", y: "amber", r: "red", o: "off" };
  return "Movements: " + ["g", "y", "r", "o"].filter((k) => n[k]).map((k) => `${n[k]} ${name[k]}`).join(", ");
}

function phaseKind(state: string) {
  if (/[Gg]/.test(state)) return "green";
  if (/[yYu]/.test(state)) return "amber";
  return "red";
}

function SignalEditor({ id, geometry, baseGeometry, scenario, signals, onEdits, busy, signalTitle }: Props & { id: string }) {
  const node = geometry?.features.find((f: Feature) => f.properties.kind === "signal" && f.properties.id === id)?.properties as SignalProps | undefined;
  const tid = node?.tls.find((t) => signals?.[t]) ?? node?.tls[0] ?? id;
  const prog = signals?.[tid];
  const edit = scenario.edits.find((e) => e.type === "retime_signal" && e.tls === tid) as Extract<Edit, { type: "retime_signal" }> | undefined;
  const original = prog?.phases.map((p) => p.duration) ?? [];
  const [durs, setDurs] = useState<number[]>(edit?.durations ?? original);
  useEffect(() => setDurs(edit?.durations ?? original), [tid, prog?.cycle_s, edit?.durations?.join(",")]);

  const addedHere = scenario.edits.some((e) => e.type === "add_signal" && e.node === id);
  const removeSignal = () => {
    const rest = scenario.edits.filter((e) => !(e.type === "retime_signal" && e.tls === tid) && !((e.type === "add_signal" || e.type === "remove_signal") && e.node === id));
    onEdits(addedHere ? rest : [...rest, { type: "remove_signal", node: id }]);
  };
  const removeButton = (
    <div className="danger-zone">
      <button className="btn quiet small" disabled={busy} onClick={removeSignal}>
        {addedHere ? "Undo: take this new signal out" : "Remove this signal"}
      </button>
      {!addedHere && <span className="small muted">It becomes a junction where the main road has right of way.</span>}
    </div>
  );
  if (!signals) return <p className="hint" role="status">Loading signal plan…</p>;
  if (!prog)
    return (
      <div className="editor">
        <h3>{signalTitle ? signalTitle(id) : `Signal ${id}`}</h3>
        <p className="banner-inline warn">This signal's timing can't be edited here. It is run together with a nearby junction.</p>
        {removeButton}
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
      <p className="sig-key" aria-hidden="true">
        <span><i className="g" />Green</span>
        <span><i className="y" />Amber (striped)</span>
        <span><i className="r" />Red (short)</span>
        <span><i className="o" />Off</span>
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
              <span className="state" role="img" aria-label={stateSummary(p.state)} title="One mark per lane movement: green is a full bar, amber is striped, red is a short bar">
                {[...p.state].map((ch, k) => <i key={k} className={STATE_CLASS[ch] ?? "o"} />)}
              </span>
            </span>
            <input
              type="number" min={1} max={180} step={0.5} value={durs[i] ?? p.duration} disabled={busy}
              aria-label={`Phase ${i + 1} duration in seconds`}
              onChange={(e) => setDurs(durs.map((d, k) => (k === i ? Math.max(1, Math.round((Number(e.target.value) || 1) * 10) / 10) : d)))}
            />
            <span className="unit">s</span>
          </li>
          );
        })}
      </ol>
      <p className="small muted">Times are in seconds (0.1 s steps). The signal keeps its original offset to its neighbours.</p>
      <div className="row">
        <button className="primary" disabled={busy || !dirty} onClick={apply}>Apply timing</button>
        {(edit || dirty) && (
          <button className="link" disabled={busy} onClick={() => { setDurs(original); onEdits(scenario.edits.filter((e) => !(e.type === "retime_signal" && e.tls === tid))); }}>
            Restore original timing
          </button>
        )}
      </div>
      {addedHere && <p className="note">This signal is new in this scenario.</p>}
      <FlyoverEditor node={id} scenario={scenario} baseGeometry={baseGeometry} onEdits={onEdits} busy={busy} />
      {removeButton}
    </div>
  );
}
