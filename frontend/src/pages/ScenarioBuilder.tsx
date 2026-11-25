import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import TrafficCounts from "../TrafficCounts";
import PageHead from "../PageHead";
import MapView, { edgeLabel, featureBBox, type Selection } from "../MapView";
import EditPanel from "../EditPanel";
import FindList from "../FindList";
import { CONTROLLERS, Legend, when, listNav } from "../shared";
import { explainWarning, relatedEdits } from "../warnings";
import { itemsFor, junctionLabel, signalLabel } from "./NetworkExplorer";
import { ROAD_TYPES, type Controller, type Edit, type EdgeProps, type Geometry, type JunctionProps, type Network, type Scenario, type SignalProgram, type SignalProps } from "../types";

type Props = {
  networks: Network[];
  scenarios: Scenario[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChanged: () => Promise<void> | void;
  presetNetwork: string | null;
  onSimulate: (s: Scenario) => void;
  onOpenFile: () => void;
  fail: (e: unknown) => void;
};

export default function ScenarioBuilder({ networks, scenarios, selected, onSelect, onChanged, presetNetwork, onSimulate, onOpenFile, fail }: Props) {
  const [creating, setCreating] = useState<string | null>(presetNetwork);   // network id for a new scenario
  const [filter, setFilter] = useState<string>("all");
  useEffect(() => { if (presetNetwork) { setCreating(presetNetwork); onSelect(null); } }, [presetNetwork]);

  const scen = scenarios.find((s) => s.id === selected) ?? null;
  const netName = (id: string) => networks.find((n) => n.id === id)?.name ?? id;
  const groups = useMemo(() => {
    const g: Record<string, Scenario[]> = {};
    scenarios.filter((s) => filter === "all" || s.base_network === filter)
      .sort((a, b) => (a.baseline === b.baseline ? (b.created ?? 0) - (a.created ?? 0) : a.baseline ? -1 : 1))
      .forEach((s) => (g[s.base_network] ??= []).push(s));
    return g;
  }, [scenarios, filter]);

  if (scen) return <Editor key={scen.id} scen={scen} networks={networks} onBack={() => onSelect(null)} onChanged={onChanged}
    onSimulate={onSimulate} onDuplicate={async (s) => {
      try { const c = await api.copyScenario(s.id, `${s.name} (copy)`); await onChanged(); onSelect(c.id); } catch (e) { fail(e); }
    }} onDeleted={async () => { onSelect(null); await onChanged(); }} fail={fail} />;

  return (
    <main className="work page-only">
      <section className="page">
        <PageHead title="Scenario Builder" lead="Each scenario is one version of a network: road and signal changes, control and traffic level."
          actions={<>
            <button className="btn secondary small" onClick={onOpenFile}>Open file</button>
            <select value={creating ?? ""} onChange={(e) => setCreating(e.target.value || null)} aria-label="Network for a new scenario">
              <option value="">New scenario on…</option>
              {networks.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </select>
          </>} />
        {creating && (
          <div className="card new-scen">
            <h2>New scenario on {netName(creating)}</h2>
            <NewScenario nid={creating} onCreated={async (s) => { await onChanged(); setCreating(null); onSelect(s.id); }} fail={fail} />
          </div>
        )}

        <div className="row spread page-tools">
          <h2 className="section-title">Your scenarios ({scenarios.length})</h2>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Show scenarios for">
            <option value="all">All networks</option>
            {networks.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
          </select>
        </div>
        {Object.keys(groups).length === 0 && <p className="empty">No scenarios yet. Use “New scenario on…” above.</p>}
        {Object.entries(groups).map(([nid, list]) => (
          <div key={nid} className="scen-group">
            <h3>{netName(nid)}</h3>
            <ul className="scen-list" onKeyDown={listNav}>
              {list.map((s) => (
                <li key={s.id}>
                  <button className="scen-item" onClick={() => onSelect(s.id)}>
                    <span className="scen-name">{s.name}{s.baseline && <span className="chip">as it is</span>}</span>
                    <span className="small muted">
                      {s.baseline ? "No changes" : `${s.edits.length} change${s.edits.length === 1 ? "" : "s"}`}, {CONTROLLERS.find((c) => c.id === s.controller)?.name.toLowerCase()}
                      {s.demand_scale !== 1 ? `, ${Math.round(s.demand_scale * 100)}% traffic` : ""}. Created {when(s.created)}.
                    </span>
                    {s.description && <span className="small">{s.description}</span>}
                  </button>
                  <button className="btn secondary small" onClick={() => onSimulate(s)}>Simulate</button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </main>
  );
}

function NewScenario({ nid, onCreated, fail }: { nid: string; onCreated: (s: Scenario) => void; fail: (e: unknown) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    try {
      const base = await api.baseline(nid);                     // every scenario starts from the network as it is
      const s = await api.copyScenario(base.id, name.trim() || "New scenario");
      onCreated(s);
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  return (
    <>
      <input type="text" className="text grow" value={name} placeholder="Scenario name, e.g. Extra lane on Main Rd" aria-label="Scenario name"
        onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
      <button className="primary" disabled={busy} onClick={create}>{busy ? "Creating…" : "Create"}</button>
    </>
  );
}

function Editor({ scen, networks, onBack, onChanged, onSimulate, onDuplicate, onDeleted, fail }: {
  scen: Scenario; networks: Network[]; onBack: () => void; onChanged: () => Promise<void> | void; onSimulate: (s: Scenario) => void;
  onDuplicate: (s: Scenario) => void; onDeleted: () => void; fail: (e: unknown) => void;
}) {
  const [s, setS] = useState<Scenario>(scen);
  const [geo, setGeo] = useState<Geometry | null>(null);
  const [baseGeo, setBaseGeo] = useState<Geometry | null>(null);
  const [signals, setSignals] = useState<Record<string, SignalProgram> | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<Selection>(null);
  // adding or removing a signal turns a junction into a signal (or back): keep the same place selected
  useEffect(() => {
    if (!geo || !sel || sel.kind === "edge") return;
    const now = geo.features.find((f) => f.properties.kind !== "edge" && f.properties.id === sel.id)?.properties.kind;
    if (now && now !== sel.kind) setSel({ kind: now as "signal" | "junction", id: sel.id });
  }, [geo]);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ bbox: [number, number, number, number]; key: number; maxZoom?: number } | null>(null);
  const [demandDraft, setDemandDraft] = useState<number | null>(null);
  const [name, setName] = useState(scen.name);
  const [desc, setDesc] = useState(scen.description ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const net = networks.find((n) => n.id === s.base_network);
  const locked = !!s.baseline;

  async function load(x: Scenario) {
    const [g, sig] = await Promise.all([api.geometry(x.id), api.signals(x.id)]);
    setGeo(g); setSignals(sig);
  }
  useEffect(() => {
    api.scenario(scen.id).then((r) => setWarnings(r.warnings)).catch(fail);
    Promise.all([load(scen), api.networkGeometry(scen.base_network).then(setBaseGeo)]).catch(fail);
  }, [scen.id]);

  async function update(body: Partial<{ edits: Edit[]; controller: Controller; demand_scale: number; name: string; description: string }>) {
    setBusy(true);
    try {
      const r = await api.updateScenario(s.id, body);
      setS(r.scenario); setWarnings(r.warnings);
      if (body.edits) await load(r.scenario);
      await onChanged();
    } catch (e) { fail(e); } finally { setBusy(false); setDemandDraft(null); }
  }

  const edges = useMemo(() => {
    const m: Record<string, EdgeProps> = {};
    baseGeo?.features.forEach((f) => { if (f.properties.kind === "edge") m[f.properties.id] = f.properties as EdgeProps; });
    return m;
  }, [baseGeo]);
  const items = useMemo(() => itemsFor(geo), [geo]);
  const roadName = (id: string) => (edges[id] ? edgeLabel(edges[id]) : `road ${id}`);
  const sigFeature = (pred: (p: SignalProps) => boolean) => geo?.features.find((f) => f.properties.kind === "signal" && pred(f.properties as SignalProps))?.properties as SignalProps | undefined;
  const nodeName = (id: string) => {
    const f = (baseGeo ?? geo)?.features.find((x) => x.properties.kind !== "edge" && x.properties.id === id)?.properties as SignalProps | JunctionProps | undefined;
    if (!f) return `Junction ${id}`;
    return f.kind === "signal" ? signalLabel(f, edges) : junctionLabel(f, edges);
  };
  const signalTitle = (id: string) => { const p = sigFeature((x) => x.id === id); return p ? signalLabel(p, edges) : nodeName(id); };
  const describe = (e: Edit) => {
    switch (e.type) {
      case "set_lanes": return `${roadName(e.edge)}: ${e.lanes} lanes (was ${edges[e.edge]?.lanes ?? "?"})`;
      case "set_speed": return `${roadName(e.edge)}: ${e.speed_kmh} km/h (was ${Math.round(edges[e.edge]?.speed_kmh ?? 0)})`;
      case "close_road": return `${roadName(e.edge)}: closed`;
      case "ban_turn": return `No turn from ${roadName(e.from_edge)} onto ${roadName(e.to_edge)}`;
      case "retime_signal": { const p = sigFeature((x) => x.tls.includes(e.tls)); return `${p ? signalLabel(p, edges) : `Signal ${e.tls}`}: new timing, ${Math.round(e.durations.reduce((a, b) => a + b, 0))} s cycle`; }
      case "add_signal": return `${nodeName(e.node)}: new traffic signal`;
      case "remove_signal": return `${nodeName(e.node)}: signal removed (priority junction)`;
      case "set_lane_width": return `${roadName(e.edge)}: lanes ${e.width_m} m wide (was ${edges[e.edge]?.lane_width_m ?? "?"} m)`;
      case "set_road_type": { const t = ROAD_TYPES.find((r) => r.id === e.road_type); return `${roadName(e.edge)}: ${t?.label.toLowerCase()} (${t?.speed_kmh} km/h)`; }
    }
  };
  const zoomTo = (kind: "edge" | "signal" | "junction", id: string) => {
    const f = geo?.features.find((x) => x.properties.kind === kind && x.properties.id === id);
    if (f) setFocus({ bbox: featureBBox(f), key: Date.now(), maxZoom: kind === "edge" ? 17.5 : 17 });
  };
  const selectFromEdit = (e: Edit) => {
    const sel2: NonNullable<Selection> = e.type === "retime_signal"
      ? { kind: "signal", id: sigFeature((x) => x.tls.includes(e.tls))?.id ?? e.tls }
      : e.type === "add_signal" ? { kind: "signal", id: e.node }
      : e.type === "remove_signal" ? { kind: "junction", id: e.node }
      : { kind: "edge", id: "edge" in e ? e.edge : e.from_edge };
    setSel(sel2); zoomTo(sel2.kind, sel2.id);
  };
  const explained = warnings.map(explainWarning);
  const warnFor = (i: number) => explained.filter((x) => relatedEdits(x, s.edits, geo).includes(i));
  const loose = explained.filter((x) => relatedEdits(x, s.edits, geo).length === 0);

  return (
    <main className="work">
      <div className="stage">
        {geo ? (
          <>
            <MapView geometry={geo} mode="layout" selection={sel} onSelect={setSel} hoverId={hoverId} focus={focus} />
            <div className="map-top">
              <FindList variant="dropdown" items={items} onPick={(x) => { if (x) { setSel(x); zoomTo(x.kind, x.id); } }} onHover={setHoverId} />
            </div>
            <Legend mode="layout" />
          </>
        ) : <div className="empty-stage"><p>Loading the scenario…</p></div>}
      </div>
      <aside className="panel">
        <div className="panel-body">
          <section className="step">
            <button className="btn quiet small back" onClick={onBack}>← All scenarios</button>
            <input className="title-input" value={name} aria-label="Scenario name" disabled={locked}
              onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== s.name && update({ name: name.trim() })} />
            <p className="small muted">{net?.name}{locked && ", the network as it is"}</p>
            <textarea className="text" rows={2} value={desc} placeholder="What does this scenario test? (optional)" aria-label="Description" disabled={locked}
              onChange={(e) => setDesc(e.target.value)} onBlur={() => desc !== (s.description ?? "") && update({ description: desc })} />
            <div className="row">
              <button className="primary" disabled={busy} onClick={() => onSimulate(s)}>Simulate this scenario</button>
              <button className="btn secondary small" onClick={() => onDuplicate(s)}>Duplicate</button>
              <a className="btn quiet small" href={api.bundleUrl(s.id)} download>Save file</a>
              {!locked && !confirmDelete && <button className="btn danger small" onClick={() => setConfirmDelete(true)}>Delete</button>}
            </div>
            {confirmDelete && (
              <div className="banner q-caution">
                <p>Delete “{s.name}”? Past simulation results keep their own copy of it.</p>
                <div className="row">
                  <button className="btn secondary small" onClick={async () => { try { await api.deleteScenario(s.id); onDeleted(); } catch (e) { fail(e); } }}>Delete</button>
                  <button className="btn quiet small" onClick={() => setConfirmDelete(false)}>Cancel</button>
                </div>
              </div>
            )}

            {locked ? (
              <p className="banner-inline warn">This is the network as it is, used as the reference in simulations. Duplicate it to make changes.</p>
            ) : (
              <>
                <h3>Settings</h3>
                <fieldset className="field block" disabled={busy}>
                  <legend className="label">Signal control</legend>
                  <div className="seg wide" role="radiogroup" aria-label="Signal control">
                    {CONTROLLERS.map((c) => (
                      <button key={c.id} role="radio" aria-checked={s.controller === c.id} onClick={() => s.controller !== c.id && update({ controller: c.id })}>
                        {c.name}{c.experimental && <span className="tag-exp">EXPERIMENTAL</span>}
                      </button>
                    ))}
                  </div>
                  <p className="small muted">{CONTROLLERS.find((c) => c.id === s.controller)?.text}</p>
                </fieldset>
                <label className="field block">
                  <span className="label">Amount of traffic: {Math.round((demandDraft ?? s.demand_scale) * 100)}%</span>
                  <input type="range" min={0.5} max={1.5} step={0.05} value={demandDraft ?? s.demand_scale} disabled={busy}
                    onChange={(e) => setDemandDraft(Number(e.target.value))}
                    onPointerUp={(e) => update({ demand_scale: Number((e.target as HTMLInputElement).value) })}
                    onKeyUp={(e) => update({ demand_scale: Number((e.target as HTMLInputElement).value) })} />
                </label>
                <TrafficCounts s={s} roadName={roadName} fail={fail} onScenario={async (x) => { setS(x); await onChanged(); }} />

                <h3>Road and signal changes</h3>
                {sel && <button className="btn quiet small back" onClick={() => setSel(null)}>← All roads and signals</button>}
                <EditPanel selection={sel} geometry={geo} baseGeometry={baseGeo} scenario={s} signals={signals}
                  onEdits={(edits) => update({ edits })} busy={busy} signalTitle={signalTitle} />
                {busy && <p className="status-line" role="status"><span className="spinner" aria-hidden="true" />Saving…</p>}
              </>
            )}

            <div className="changes">
              <h3>Changes ({s.edits.length})</h3>
              {s.edits.length === 0 && <p className="small muted">No changes{locked ? "." : " yet. Pick a road or signal on the map or in the list."}</p>}
              <ul>
                {s.edits.map((e, i) => (
                  <li key={i}>
                    <div className="change-row">
                      <button className="link" onClick={() => selectFromEdit(e)}>{describe(e)}</button>
                      {!locked && <button className="btn danger small" disabled={busy} onClick={() => update({ edits: s.edits.filter((_, k) => k !== i) })}>Undo</button>}
                    </div>
                    {warnFor(i).map((x, k) => (
                      <div key={k} className="side-effect"><p><b>Note:</b> {x.text}</p>{x.impact && <p className="muted">{x.impact}</p>}</div>
                    ))}
                  </li>
                ))}
              </ul>
              {loose.length > 0 && (
                <div className="banner q-caution">
                  <p className="banner-title">Side effects of the changes</p>
                  <ul>{loose.map((x, i) => <li key={i}>{x.text} {x.impact}</li>)}</ul>
                </div>
              )}
            </div>

            {!sel && !locked && (
              <div className="browse">
                <h3>Roads and signals</h3>
                <FindList variant="list" items={items} selectedId={null} onHover={setHoverId}
                  onPick={(x) => { if (x) { setSel(x); zoomTo(x.kind, x.id); } }} />
              </div>
            )}
          </section>
        </div>
      </aside>
    </main>
  );
}
