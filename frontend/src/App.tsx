import { useEffect, useMemo, useRef, useState } from "react";
import { api, isLost } from "./api";
import MapView, { DELAY_LEGEND, edgeLabel, featureBBox, type MapMode, type Selection } from "./MapView";
import EditPanel from "./EditPanel";
import Results, { fmt, quality } from "./Results";
import FindList, { type Item } from "./FindList";
import { JobRow } from "./RunMonitor";
import { explainWarning, relatedEdits } from "./warnings";
import Experiments, { pairRuns } from "./Experiments";
import type {
  Bundle, Comparison, Controller, Edit, EdgeProps, Experiment, Feature, Geometry, Health, Job, Network, Run, RunSummary, Scenario,
  SignalProgram, SignalProps,
} from "./types";

type Labels = { before: string; after: string };
const DEFAULT_LABELS: Labels = { before: "Current", after: "Proposal" };
type Expected = { values: NonNullable<Bundle["experiment"]>["values"]; versions?: { app: string; sumo: string }; source: string };

const CONTROLLERS: { id: Controller; name: string; text: string; experimental?: boolean }[] = [
  { id: "fixed", name: "Fixed timing", text: "Signals repeat the same plan." },
  { id: "actuated", name: "Vehicle-actuated", text: "Greens adjust to waiting cars." },
  { id: "max_pressure", name: "Pressure-based", experimental: true,
    text: "Green goes to the longest queues. Experimental: can jam on busy networks." },
];
const REPEATS = [5, 10, 20];

type Side = "base" | "prop";
type Section = "overview" | "network" | "scenario" | "simulation" | "results" | "experiments";
const SECTIONS: { id: Section; name: string; short: string; icon: string }[] = [
  { id: "overview", name: "Overview", short: "Overview", icon: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" },
  { id: "network", name: "Network Explorer", short: "Network", icon: "M9 4l-6 2v14l6-2 6 2 6-2V4l-6 2-6-2zm0 0v14m6-12v14" },
  { id: "scenario", name: "Scenario Builder", short: "Changes", icon: "M4 20h4L19 9l-4-4L4 16v4zm11-15l4 4" },
  { id: "simulation", name: "Traffic Simulation", short: "Simulate", icon: "M7 4l12 8-12 8V4z" },
  { id: "results", name: "Results & Analytics", short: "Results", icon: "M4 20V10m6 10V4m6 16v-7m6 7H2" },
  { id: "experiments", name: "Experiments & History", short: "History", icon: "M12 7v5l3 2m6-2a9 9 0 1 1-3-6.7M21 4v5h-5" },
];
const MAP_SECTIONS: Section[] = ["network", "scenario", "simulation", "results"];
const isLive = (j?: Job) => !!j && !["done", "failed", "cancelled"].includes(j.state);

// ---- URL hash: lets a reload or a later visit resume the same scenarios, jobs and results ----
function readHash() {
  const h = new URLSearchParams(window.location.hash.slice(1));
  return { b: h.get("b"), p: h.get("p"), jb: h.get("jb"), jp: h.get("jp") };
}
function writeHash(v: { b?: string | null; p?: string | null; jb?: string | null; jp?: string | null }) {
  const h = new URLSearchParams();
  Object.entries(v).forEach(([k, x]) => x && h.set(k, x));
  const s = h.toString();
  window.history.replaceState(null, "", s ? `#${s}` : window.location.pathname);
}

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [networks, setNetworks] = useState<Network[]>([]);
  const [netId, setNetId] = useState<string | null>(null);
  const [pendingNet, setPendingNet] = useState<string | null>(null);
  const [showNets, setShowNets] = useState(true);
  const [base, setBase] = useState<Scenario | null>(null);
  const [prop, setProp] = useState<Scenario | null>(null);
  const [baseGeo, setBaseGeo] = useState<Geometry | null>(null);
  const [propGeo, setPropGeo] = useState<Geometry | null>(null);
  const [signals, setSignals] = useState<Record<string, SignalProgram> | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ bbox: [number, number, number, number]; key: number; maxZoom?: number } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingNet, setLoadingNet] = useState(false);
  const [section, setSection] = useState<Section>("overview");
  const [mode, setMode] = useState<MapMode>("layout");
  const [delaySide, setDelaySide] = useState<Side>("prop");
  const [repeats, setRepeats] = useState(10);
  const [firstSeed, setFirstSeed] = useState(1);
  const [jobs, setJobs] = useState<Partial<Record<Side, Job>>>({});
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [runs, setRuns] = useState<Partial<Record<Side, Run>>>({});
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [stale, setStale] = useState(false);
  const [demandDraft, setDemandDraft] = useState<number | null>(null);
  const [expKey, setExpKey] = useState(0);
  const [labels, setLabels] = useState<Labels>(DEFAULT_LABELS);
  const [seedOverride, setSeedOverride] = useState<number[] | null>(null);
  const [expected, setExpected] = useState<Expected | null>(null);
  const [recent, setRecent] = useState<Experiment[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const polling = useRef(false);

  /** Report an error; a missing scenario or run means the server no longer has this session. */
  function fail(e: any, prefix = "") {
    if (isLost(e)) { setLost(true); setError(null); return; }
    setError(prefix + (e?.message ?? String(e)));
  }

  // ---------- start-up: networks, versions, and resume from the URL ----------
  useEffect(() => {
    api.networks().then(setNetworks).catch((e) => fail(e));
    api.health().then(setHealth).catch(() => {});
    const h = readHash();
    if (h.b && h.p) resume(h.b, h.p, h.jb, h.jp);
  }, []);
  useEffect(() => {
    if (section === "overview") api.runs().then((r) => setRecent(pairRuns(r).experiments.slice(0, 3))).catch(() => {});
  }, [section, expKey]);

  async function resume(b: string, p: string, jb: string | null, jp: string | null) {
    setLoadingNet(true);
    try {
      const [rb, rp] = await Promise.all([api.scenario(b), api.scenario(p)]);
      setNetId(rb.scenario.base_network); setBase(rb.scenario); setProp(rp.scenario); setWarnings(rp.warnings); setShowNets(false);
      await Promise.all([loadSide(rb.scenario, "base"), loadSide(rp.scenario, "prop")]);
      if (jb && jp) {
        const [a, c] = await Promise.all([api.job(jb), api.job(jp)]);
        setJobs({ base: a, prop: c });
        if (a.created) setStartedAt(a.created * 1000);
        setSection(a.state === "done" && c.state === "done" ? "results" : "simulation");
      }
    } catch (e: any) {
      writeHash({});
      if (isLost(e)) setError("The last session could not be reopened because the server no longer has it. Pick a network to start again.");
      else fail(e);
    } finally { setLoadingNet(false); }
  }

  /** Forget the current session and go back to choosing a network. */
  function startOver(to: Section = "network") {
    writeHash({});
    setNetId(null); setBase(null); setProp(null); setBaseGeo(null); setPropGeo(null); setSignals(null);
    setSelection(null); setWarnings([]); setJobs({}); setRuns({}); setCmp(null); setStale(false); setMode("layout");
    setLabels(DEFAULT_LABELS); setSeedOverride(null); setExpected(null); setLost(false); setError(null); setPendingNet(null);
    setShowNets(true); setSection(to);
  }

  // ---------- derived lookups ----------
  const edgeMap = useMemo(() => {
    const m: Record<string, EdgeProps> = {};
    baseGeo?.features.forEach((f) => { if (f.properties.kind === "edge") m[f.properties.id] = f.properties as EdgeProps; });
    return m;
  }, [baseGeo]);
  const roadName = (id: string) => (edgeMap[id] ? edgeLabel(edgeMap[id]) : `road ${id}`);
  const signalName = (s: SignalProps) => {
    const names = [...new Set(s.incoming.map((e) => edgeMap[e]?.name).filter(Boolean))];
    return names.length ? `Signal at ${names.slice(0, 2).join(" / ")}` : `Signal ${s.id.length > 18 ? s.id.slice(0, 16) + "…" : s.id}`;
  };
  const signalTitle = (id: string) => {
    const f = propGeo?.features.find((x) => x.properties.kind === "signal" && x.properties.id === id);
    return f ? signalName(f.properties as SignalProps) : `Signal ${id}`;
  };
  const items: Item[] = useMemo(() => {
    if (!propGeo) return [];
    const edited = propGeo.edited ?? {};
    return propGeo.features.map((f) => {
      if (f.properties.kind === "edge") {
        const p = f.properties as EdgeProps;
        return { kind: "edge" as const, id: p.id, label: edgeLabel(p), changed: !!edited[p.id],
          sub: `${p.car_allowed ? `${p.lanes} lane${p.lanes === 1 ? "" : "s"}, ${Math.round(p.speed_kmh)} km/h` : "closed"}, ${Math.round(p.length_m)} m` };
      }
      const s = f.properties as SignalProps;
      return { kind: "signal" as const, id: s.id, label: signalName(s), sub: `${s.incoming.length} approaches`,
        changed: !!prop?.edits.some((e) => e.type === "retime_signal" && s.tls.includes(e.tls)) };
    }).sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === "signal" ? -1 : 1));
  }, [propGeo, edgeMap, prop?.edits]);

  // ---------- scenario actions ----------
  async function loadSide(s: Scenario, side: Side) {
    const g = await api.geometry(s.id);
    if (side === "base") setBaseGeo(g);
    else { setPropGeo(g); setSignals(await api.signals(s.id)); }
  }

  function requestNetwork(id: string) {
    if (id === netId && !lost) { setShowNets(false); return; }
    if (prop && !lost && (prop.edits.length || cmp || prop.controller !== "fixed")) setPendingNet(id);
    else chooseNetwork(id);
  }

  async function chooseNetwork(id: string, importedProposal?: Scenario, keepSeeds = false): Promise<{ b: Scenario; p: Scenario } | null> {
    setPendingNet(null); setLoadingNet(true); setError(null); setLost(false); setNetId(id); setSelection(null); setWarnings([]);
    setJobs({}); setRuns({}); setCmp(null); setStale(false); setMode("layout"); setBaseGeo(null); setPropGeo(null);
    setLabels(DEFAULT_LABELS);
    if (!keepSeeds) { setSeedOverride(null); setExpected(null); }
    try {
      const b = await api.createScenario(id, "Current situation");
      let p = await api.copyScenario(b.id, "Proposal");
      if (importedProposal) {
        const r = await api.updateScenario(p.id, { edits: importedProposal.edits, controller: importedProposal.controller, demand_scale: importedProposal.demand_scale });
        p = r.scenario; setWarnings(r.warnings);
        if (importedProposal.demand_scale !== 1) await api.updateScenario(b.id, { demand_scale: importedProposal.demand_scale });
      }
      setBase(b); setProp(p);
      writeHash({ b: b.id, p: p.id });
      await Promise.all([loadSide(b, "base"), loadSide(p, "prop")]);
      setShowNets(false);
      return { b, p };
    } catch (e: any) { fail(e); return null; } finally { setLoadingNet(false); }
  }

  async function updateProp(body: Partial<{ edits: Edit[]; controller: Controller }>) {
    if (!prop) return;
    setBusy(true); setError(null);
    try {
      const r = await api.updateScenario(prop.id, body);
      setProp(r.scenario); setWarnings(r.warnings);
      await loadSide(r.scenario, "prop");
      if (cmp) setStale(true);
    } catch (e: any) { fail(e); } finally { setBusy(false); }
  }

  async function setDemand(scale: number) {
    if (!base || !prop) return;
    setBusy(true); setError(null);
    try {
      const [a, b] = await Promise.all([
        api.updateScenario(base.id, { demand_scale: scale }), api.updateScenario(prop.id, { demand_scale: scale })]);
      setBase(a.scenario); setProp(b.scenario);
      if (cmp) setStale(true);
    } catch (e: any) { fail(e); } finally { setBusy(false); setDemandDraft(null); }
  }

  // ---------- runs ----------
  const seedList = seedOverride ?? Array.from({ length: repeats }, (_, i) => firstSeed + i);
  async function startJobs(b: Scenario, p: Scenario, seeds: number[]) {
    setError(null); setCmp(null); setRuns({}); setStale(false); setLabels(DEFAULT_LABELS);
    try {
      const [jb, jp] = await Promise.all([api.startRun(b.id, seeds), api.startRun(p.id, seeds)]);
      setJobs({ base: jb, prop: jp }); setStartedAt(Date.now()); setSection("simulation");
      writeHash({ b: b.id, p: p.id, jb: jb.id, jp: jp.id });
    } catch (e: any) { fail(e); }
  }
  async function runComparison() {
    if (base && prop) await startJobs(base, prop, seedList);
  }

  async function cancelRuns() {
    try {
      const out = await Promise.all((["base", "prop"] as Side[]).map((s) => (isLive(jobs[s]) ? api.cancel(jobs[s]!.id) : Promise.resolve(jobs[s]!))));
      setJobs({ base: out[0], prop: out[1] });
    } catch (e: any) { fail(e, "Could not cancel: "); }
  }

  useEffect(() => {
    const active = (Object.values(jobs) as Job[]).filter(isLive);
    const bothDone = jobs.base?.state === "done" && jobs.prop?.state === "done";
    if (!active.length && !(bothDone && !cmp)) return;
    let cancelled = false;
    const tick = async () => {
      if (polling.current) return;          // never overlap requests
      polling.current = true;
      try {
        const next: Partial<Record<Side, Job>> = { ...jobs };
        for (const side of ["base", "prop"] as Side[]) {
          const j = jobs[side];
          if (isLive(j)) next[side] = await api.job(j!.id);
        }
        if (cancelled) return;
        if (next.base?.state === "done" && next.prop?.state === "done") {
          const [rb, rp] = await Promise.all([api.run(next.base.run_id), api.run(next.prop.run_id)]);
          const c = await api.compare(next.base.run_id, next.prop.run_id);
          if (cancelled) return;
          setRuns({ base: rb, prop: rp }); setCmp(c); setMode("change"); setSection("results");
        }
        if (next.base?.state === "done" || next.prop?.state === "done") setExpKey((k) => k + 1);
        if (bothDone && !active.length) return;   // nothing changed; avoid a re-render loop
        setJobs(next);
      } catch (e: any) {
        if (!cancelled) fail(e);
      } finally {
        polling.current = false;
      }
    };
    if (bothDone && !active.length) { tick(); return () => { cancelled = true; }; }
    const t = setInterval(tick, 800);
    return () => { cancelled = true; clearInterval(t); };
  }, [jobs]);

  // ---------- experiments: open, compare any two runs, reproduce ----------
  async function showRuns(aRun: string, bRun: string, aScen: string, bScen: string, lab: Labels) {
    setLoadingNet(true); setError(null); setSelection(null);
    try {
      const [sa, sb] = await Promise.all([api.scenario(aScen), api.scenario(bScen)]);
      const [ra, rb] = await Promise.all([api.run(aRun), api.run(bRun)]);
      const c = await api.compare(aRun, bRun);
      setNetId(sb.scenario.base_network); setBase(sa.scenario); setProp(sb.scenario); setWarnings(sb.warnings); setShowNets(false);
      await Promise.all([loadSide(sa.scenario, "base"), loadSide(sb.scenario, "prop")]);
      const [ja, jb] = await Promise.all([api.job(aRun), api.job(bRun)]);
      setJobs({ base: ja, prop: jb }); setRuns({ base: ra, prop: rb }); setCmp(c); setLabels(lab); setLost(false);
      const same = (x: Scenario, y: Scenario) => JSON.stringify([x.edits, x.controller, x.demand_scale]) === JSON.stringify([y.edits, y.controller, y.demand_scale]);
      setStale(!same(rb.scenario, sb.scenario) || !same(ra.scenario, sa.scenario));
      setMode("change"); setSection("results"); setSeedOverride(null); setExpected(null);
      writeHash({ b: sa.scenario.id, p: sb.scenario.id, jb: aRun, jp: bRun });
    } catch (e: any) { setError(`Could not open these results: ${e.message}`); } finally { setLoadingNet(false); }
  }
  const openExperiment = (e: Experiment) => showRuns(e.before.id, e.after.id, e.before.scenario_id, e.after.scenario_id, DEFAULT_LABELS);
  const compareAny = (a: RunSummary, b: RunSummary) =>
    showRuns(a.id, b.id, a.scenario_id, b.scenario_id, { before: `A: ${a.scenario_name}`, after: `B: ${b.scenario_name}` });

  async function startFromBundle(bundle: Bundle, autoRun: boolean) {
    const s = bundle.scenario;
    if (!s?.base_network) throw new Error("This file is not a saved experiment.");
    const seeds = bundle.experiment?.seeds ?? bundle.run?.seeds ?? null;
    setSeedOverride(seeds);
    setExpected(bundle.experiment ? { values: bundle.experiment.values, versions: bundle.experiment.versions, source: `${bundle.experiment.before_run} / ${bundle.experiment.after_run}` } : null);
    const ids = await chooseNetwork(s.base_network, s, true);
    if (!ids) return;
    if (autoRun && seeds) await startJobs(ids.b, ids.p, seeds);
    else setSection("simulation");
  }
  async function reproduce(e: Experiment) {
    try { await startFromBundle(await api.bundle(e.after.scenario_id, e.before.id, e.after.id), true); }
    catch (err: any) { setError(`Could not run it again: ${err.message}`); }
  }
  async function importBundle(file: File) {
    try { await startFromBundle(JSON.parse(await file.text()), false); }
    catch (e: any) { setError(`Could not open the file: ${e.message}`); }
    if (fileRef.current) fileRef.current.value = "";
  }

  // ---------- selection: the panel follows the map ----------
  function select(s: Selection) {
    setSelection(s);
    if (s && section === "simulation") setSection("scenario");
  }
  function zoomTo(kind: "edge" | "signal", id: string) {
    const f = propGeo?.features.find((x: Feature) => x.properties.kind === kind && x.properties.id === id);
    if (f) setFocus({ bbox: featureBBox(f), key: Date.now(), maxZoom: kind === "signal" ? 17 : 17.5 });
  }
  function go(s: Section) {
    setSection(s);
    window.scrollTo(0, 0);
    if (s === "network" && !prop) setShowNets(true);
  }

  const running = isLive(jobs.base) || isLive(jobs.prop);
  const net = networks.find((n) => n.id === netId);
  const identical = !!prop && !!base && prop.edits.length === 0 && prop.controller === base.controller;
  const q = cmp ? quality(cmp, runs.base, runs.prop) : null;

  const describe = (e: Edit) => {
    switch (e.type) {
      case "set_lanes": return `${roadName(e.edge)}: ${e.lanes} lanes (was ${edgeMap[e.edge]?.lanes ?? "?"})`;
      case "set_speed": return `${roadName(e.edge)}: ${e.speed_kmh} km/h (was ${Math.round(edgeMap[e.edge]?.speed_kmh ?? 0)})`;
      case "close_road": return `${roadName(e.edge)}: closed`;
      case "ban_turn": return `No turn from ${roadName(e.from_edge)} onto ${roadName(e.to_edge)}`;
      case "retime_signal": {
        const f = propGeo?.features.find((x) => x.properties.kind === "signal" && (x.properties as SignalProps).tls.includes(e.tls));
        return `${f ? signalName(f.properties as SignalProps) : `Signal ${e.tls}`}: new timing, ${Math.round(e.durations.reduce((a, b) => a + b, 0))} s cycle`;
      }
    }
  };
  const selectFromEdit = (e: Edit) => {
    const s: NonNullable<Selection> = e.type === "retime_signal"
      ? { kind: "signal", id: propGeo?.features.find((f) => f.properties.kind === "signal" && (f.properties as SignalProps).tls.includes(e.tls))?.properties.id ?? e.tls }
      : { kind: "edge", id: "edge" in e ? e.edge : e.from_edge };
    setSelection(s); zoomTo(s.kind, s.id);
  };

  const explained = warnings.map(explainWarning);
  const warnFor = (i: number) => explained.filter((x) => prop && relatedEdits(x, prop.edits, propGeo).includes(i));
  const looseWarnings = explained.filter((x) => !prop || relatedEdits(x, prop.edits, propGeo).length === 0);

  const enabled = (s: Section) => s === "overview" || s === "network" || s === "experiments" || (!!prop && !lost && (s !== "results" || !!cmp));
  const versionText = health ? `Junction ${health.versions.app}, SUMO ${health.versions.sumo}` : "";
  const showMap = MAP_SECTIONS.includes(section);

  const networkCards = (
    <div className="nets" role="radiogroup" aria-label="Networks">
      {networks.map((n) => (
        <button key={n.id} role="radio" aria-checked={n.id === netId} className="net" disabled={loadingNet || running}
          onClick={() => requestNetwork(n.id)}>
          <span className="net-name">{n.name}{n.id === netId && <span className="chip">in use</span>}</span>
          <span className="net-desc">{n.description}</span>
          {n.edges != null && <span className="net-stats">{n.signals} signals, {n.edges} roads, {n.trips?.toLocaleString()} trips</span>}
          {n.note && <span className="net-note">{n.note}</span>}
        </button>
      ))}
    </div>
  );

  return (
    <div className="app">
      <header className="bar">
        <div className="brand"><span className="mark" aria-hidden="true" />Junction</div>
        {net ? <p className="tag"><span className="tag-net">{net.name}</span></p> : <p className="tag">Test a street change before you build it.</p>}
        <div className="bar-actions">
          {prop && !lost && (cmp && runs.base && runs.prop
            ? <a className="ghost" href={api.bundleUrl(prop.id, { before: runs.base.id, after: runs.prop.id })} download>Save experiment</a>
            : <a className="ghost" href={api.bundleUrl(prop.id, { seeds: seedList.length, first: seedList[0] })} download>Save proposal</a>)}
          <button className="ghost" onClick={() => startOver("network")}>New</button>
        </div>
        <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && importBundle(e.target.files[0])} />
      </header>

      <div className="shell">
        <nav className="side" aria-label="Sections">
          {SECTIONS.map((s) => (
            <button key={s.id} className="side-item" aria-current={section === s.id ? "page" : undefined} disabled={!enabled(s.id)}
              onClick={() => go(s.id)} aria-label={s.name} title={!enabled(s.id) ? (s.id === "results" ? "Run a simulation first" : "Pick a network first") : undefined}>
              <Icon d={s.icon} />
              <span className="side-name">{s.name}</span><span className="side-short" aria-hidden="true">{s.short}</span>
              {s.id === "scenario" && prop && prop.edits.length > 0 && <span className="count">{prop.edits.length}</span>}
              {s.id === "simulation" && running && <span className="spinner" aria-label="running" />}
              {s.id === "results" && q && q.level !== "good" && <span className={`dot-q ${q.level}`} aria-label={`data ${q.level}`} />}
            </button>
          ))}
        </nav>

        <main className={`${showMap ? "work" : "work page-only"}${propGeo || loadingNet ? "" : " no-map"}`}>
          {showMap && (
            <div className="stage">
              {propGeo ? (
                <>
                  <MapView
                    geometry={mode === "results" && delaySide === "base" ? baseGeo : propGeo}
                    mode={mode} selection={selection} onSelect={select} hoverId={hoverId} focus={focus}
                    runEdges={runs[delaySide]?.aggregate.edges} cmpEdges={cmp?.edges}
                  />
                  <div className="map-top">
                    <FindList variant="dropdown" items={items} onPick={(s) => { if (s) { select(s); zoomTo(s.kind, s.id); } }} onHover={setHoverId} />
                    <div className="modes" role="tablist" aria-label="Map colouring">
                      <button role="tab" aria-selected={mode === "layout"} onClick={() => setMode("layout")}>Layout</button>
                      <button role="tab" aria-selected={mode === "results"} disabled={!runs.prop} title={!runs.prop ? "Available after a run" : undefined} onClick={() => setMode("results")}>Delay</button>
                      <button role="tab" aria-selected={mode === "change"} disabled={!cmp} title={!cmp ? "Available after a run" : undefined} onClick={() => setMode("change")}>What changed</button>
                    </div>
                  </div>
                  <Legend mode={mode} delaySide={delaySide} setDelaySide={setDelaySide} />
                </>
              ) : (
                <div className="empty-stage"><p>{loadingNet ? "Loading the network…" : "Pick a network to see its map."}</p></div>
              )}
            </div>
          )}

          <div className={showMap ? "panel" : "page-wrap"}>
            <div className="panel-body">
              {lost && (
                <div className="banner q-error" role="alert">
                  <p className="banner-title">This session is no longer on the server</p>
                  <p>The server was probably restarted with different data. Your saved experiment files still work.</p>
                  <div className="row">
                    <button className="btn secondary small" onClick={() => startOver("network")}>Start again</button>
                    <button className="btn quiet small" onClick={() => fileRef.current?.click()}>Open a saved file</button>
                  </div>
                </div>
              )}
              {error && (
                <div className="banner q-error sticky" role="alert">
                  <p className="banner-title">Something went wrong</p>
                  <p>{error}</p>
                  <button className="btn quiet small" onClick={() => setError(null)}>Dismiss</button>
                </div>
              )}

              {/* ---------------- Overview ---------------- */}
              {section === "overview" && (
                <section className="page">
                  <div className="page-head">
                    <h1>Overview</h1>
                    <p className="lead">Change a street, simulate the traffic, and see what happens.</p>
                  </div>
                  {prop && net && !lost ? (
                    <div className="card session">
                      <h2>Current work</h2>
                      <p className="big">{net.name}</p>
                      <p className="small">
                        Proposal: {prop.edits.length} change{prop.edits.length === 1 ? "" : "s"}, {CONTROLLERS.find((c) => c.id === prop.controller)?.name.toLowerCase()}
                        {prop.demand_scale !== 1 ? `, ${Math.round(prop.demand_scale * 100)}% traffic` : ""}.
                      </p>
                      {running && <p className="status-line"><span className="spinner" aria-hidden="true" />Simulation running</p>}
                      {cmp && q && (
                        <p className="small">
                          Last result: average travel time {fmt(cmp.kpis.mean_travel_time_s?.before, "s")} → {fmt(cmp.kpis.mean_travel_time_s?.after, "s")}.{" "}
                          <span className={`pill dq-${q.level === "good" ? "good" : q.level}`}>Data {q.level}</span>
                        </p>
                      )}
                      <div className="row">
                        <button className="primary" onClick={() => go(cmp ? "results" : "scenario")}>{cmp ? "View results" : "Continue editing"}</button>
                        <button className="btn secondary" onClick={() => startOver("network")}>Start with a new network</button>
                      </div>
                    </div>
                  ) : (
                    <div className="card">
                      <h2>Get started</h2>
                      <ol className="steps">
                        <li><b>Pick a network</b> in Network Explorer.</li>
                        <li><b>Make changes</b> in Scenario Builder: lanes, speed, closures, turns or signal timing.</li>
                        <li><b>Run the simulation</b> and compare your proposal with today.</li>
                      </ol>
                      <div className="row">
                        <button className="primary" onClick={() => startOver("network")}>Choose a network</button>
                        <button className="btn secondary" onClick={() => fileRef.current?.click()}>Open a saved experiment</button>
                      </div>
                    </div>
                  )}
                  {recent.length > 0 && (
                    <div className="card">
                      <h2>Recent experiments</h2>
                      <ul className="recent">
                        {recent.map((e) => (
                          <li key={e.id}>
                            <span>
                              <b>{networks.find((n) => n.id === e.after.base_network)?.name ?? e.after.base_network}</b>
                              <span className="small muted"> {e.after.edits ?? 0} change{e.after.edits === 1 ? "" : "s"}, {fmt(e.before.mean_travel_time_s, "s")} → {fmt(e.after.mean_travel_time_s, "s")}</span>
                            </span>
                            <button className="btn quiet small" onClick={() => openExperiment(e)}>Open</button>
                          </li>
                        ))}
                      </ul>
                      <button className="btn quiet small" onClick={() => go("experiments")}>See all experiments</button>
                    </div>
                  )}
                </section>
              )}

              {/* ---------------- Network Explorer ---------------- */}
              {section === "network" && (
                <section className="step">
                  <h2>Network Explorer</h2>
                  {(showNets || !net || lost) ? (
                    <>
                      <p className="lead">Pick a road network. Each comes with one hour of traffic.</p>
                      {networkCards}
                      {pendingNet && (
                        <div className="banner q-caution" role="alertdialog" aria-label="Switch network">
                          <p className="banner-title">Switch to {networks.find((n) => n.id === pendingNet)?.name}?</p>
                          <p>This starts a new proposal. Save the current one first if you want to keep it.</p>
                          <div className="row">
                            <button className="btn secondary small" onClick={() => chooseNetwork(pendingNet)}>Switch</button>
                            {prop && <a className="btn quiet small" href={api.bundleUrl(prop.id)} download>Save first</a>}
                            <button className="btn quiet small" onClick={() => setPendingNet(null)}>Cancel</button>
                          </div>
                        </div>
                      )}
                      {loadingNet && <p className="status-line" role="status"><span className="spinner" aria-hidden="true" />Loading the network…</p>}
                      {net && !loadingNet && !lost && <button className="btn quiet small" onClick={() => setShowNets(false)}>Back to {net.name}</button>}
                    </>
                  ) : (
                    <>
                      <div className="card net-current">
                        <p className="big">{net.name}</p>
                        <p className="small">{net.description}</p>
                        {net.edges != null && <p className="small"><b>{net.signals}</b> signals, <b>{net.edges}</b> roads, <b>{net.trips?.toLocaleString()}</b> trips in one hour</p>}
                        {net.note && <p className="net-note">{net.note}</p>}
                        <div className="row">
                          <button className="btn secondary small" onClick={() => setShowNets(true)}>Change network</button>
                          <button className="btn quiet small" onClick={() => go("scenario")}>Make changes →</button>
                        </div>
                      </div>
                      {selection ? (
                        <Inspector sel={selection} edgeMap={edgeMap} signals={signals} propGeo={propGeo} signalTitle={signalTitle}
                          onEdit={() => go("scenario")} onClose={() => setSelection(null)} />
                      ) : (
                        <p className="small muted">Click a road or signal on the map, or browse the list.</p>
                      )}
                      <div className="browse">
                        <h3>Roads and signals</h3>
                        <FindList variant="list" items={items} selectedId={selection?.id ?? null} onHover={setHoverId}
                          onPick={(s) => { if (s) { setSelection(s); zoomTo(s.kind, s.id); } }} />
                      </div>
                      {net.license && <p className="credit">Data: {net.license}.{net.id.startsWith("ingolstadt") && " Street names © OpenStreetMap contributors."}</p>}
                    </>
                  )}
                </section>
              )}

              {/* ---------------- Scenario Builder ---------------- */}
              {section === "scenario" && prop && base && (
                <section className="step">
                  <h2>Scenario Builder</h2>
                  <p className="lead">Your changes go into the proposal. Today's network stays as it is.</p>
                  {selection && <button className="btn quiet small back" onClick={() => setSelection(null)}>← All roads and signals</button>}
                  <EditPanel selection={selection} geometry={propGeo} baseGeometry={baseGeo} scenario={prop}
                    signals={signals} onEdits={(edits) => updateProp({ edits })} busy={busy || running} signalTitle={signalTitle} />
                  {busy && <p className="status-line" role="status"><span className="spinner" aria-hidden="true" />Updating the network…</p>}

                  <div className="changes">
                    <h3>Your changes ({prop.edits.length})</h3>
                    {prop.edits.length === 0 && <p className="small muted">No changes yet.</p>}
                    <ul>
                      {prop.edits.map((e, i) => (
                        <li key={i}>
                          <div className="change-row">
                            <button className="link" onClick={() => selectFromEdit(e)}>{describe(e)}</button>
                            <button className="btn danger small" aria-label={`Undo: ${describe(e)}`} disabled={busy || running}
                              onClick={() => updateProp({ edits: prop.edits.filter((_, k) => k !== i) })}>Undo</button>
                          </div>
                          {warnFor(i).map((x, k) => (
                            <div key={k} className="side-effect">
                              <p><b>Note:</b> {x.text}</p>
                              {x.impact && <p className="muted">{x.impact}</p>}
                            </div>
                          ))}
                        </li>
                      ))}
                    </ul>
                    {looseWarnings.length > 0 && (
                      <div className="banner q-caution">
                        <p className="banner-title">Side effects of your changes</p>
                        <ul>{looseWarnings.map((x, i) => <li key={i}>{x.text} {x.impact}</li>)}</ul>
                      </div>
                    )}
                  </div>

                  {!selection && (
                    <div className="browse">
                      <h3>Roads and signals</h3>
                      <FindList variant="list" items={items} selectedId={null} onHover={setHoverId}
                        onPick={(s) => { if (s) { setSelection(s); zoomTo(s.kind, s.id); } }} />
                    </div>
                  )}
                  <button className="primary wide next" disabled={busy} onClick={() => go("simulation")}>Next: run the simulation</button>
                </section>
              )}

              {/* ---------------- Traffic Simulation ---------------- */}
              {section === "simulation" && prop && base && (
                <section className="step">
                  <h2>Traffic Simulation</h2>
                  <p className="lead">Today's network and your proposal run with the same traffic, {seedList.length} times each.</p>

                  <fieldset className="field block" disabled={busy || running}>
                    <legend className="label">Signal control in the proposal</legend>
                    <div className="seg wide" role="radiogroup" aria-label="Signal control">
                      {CONTROLLERS.map((c) => (
                        <button key={c.id} role="radio" aria-checked={prop.controller === c.id}
                          onClick={() => prop.controller !== c.id && updateProp({ controller: c.id })}>
                          {c.name}{c.experimental && <span className="tag-exp">EXPERIMENTAL</span>}
                        </button>
                      ))}
                    </div>
                    <p className="small muted">{CONTROLLERS.find((c) => c.id === prop.controller)?.text}</p>
                  </fieldset>

                  <label className="field block">
                    <span className="label">Amount of traffic: {Math.round((demandDraft ?? prop.demand_scale) * 100)}%</span>
                    <input type="range" min={0.5} max={1.5} step={0.05} value={demandDraft ?? prop.demand_scale} disabled={busy || running}
                      onChange={(e) => setDemandDraft(Number(e.target.value))}
                      onPointerUp={(e) => setDemand(Number((e.target as HTMLInputElement).value))}
                      onKeyUp={(e) => setDemand(Number((e.target as HTMLInputElement).value))} />
                  </label>

                  {seedOverride && (
                    <div className="banner-inline warn">
                      Using the saved experiment's {seedOverride.length} runs{expected ? "; results will be checked against it" : ""}.{" "}
                      <button className="btn quiet small" disabled={running} onClick={() => { setSeedOverride(null); setExpected(null); }}>Use my own settings</button>
                    </div>
                  )}
                  <fieldset className="field block" disabled={running || !!seedOverride}>
                    <legend className="label">Number of runs</legend>
                    <div className="seg" role="radiogroup" aria-label="Number of runs">
                      {REPEATS.map((r) => (
                        <button key={r} role="radio" aria-checked={repeats === r} onClick={() => setRepeats(r)}>{r}</button>
                      ))}
                    </div>
                    <p className="small muted">Traffic is random, so each option runs several times. More runs: more reliable, but slower.</p>
                  </fieldset>

                  <details className="advanced">
                    <summary>Advanced settings</summary>
                    <label className="field">
                      <span className="label">First random seed</span>
                      <input type="number" min={1} max={100000} value={firstSeed} disabled={running || !!seedOverride}
                        onChange={(e) => setFirstSeed(Math.max(1, Math.floor(Number(e.target.value) || 1)))} />
                    </label>
                    <p className="small muted">Seeds {seedList[0]} to {seedList[seedList.length - 1]}. Same seeds give the same results.</p>
                    {health && (
                      <dl className="facts">
                        <dt>Stuck car is moved ahead after</dt><dd>{health.settings.time_to_teleport_s} s</dd>
                        <dt>Blocked junction is ignored after</dt><dd>{health.settings.ignore_junction_blocker_s} s</dd>
                        <dt>Simulation step</dt><dd>{health.settings.step_length_s} s</dd>
                        <dt>Extra time for trips to finish</dt><dd>{Math.round(health.settings.drain_s / 60)} min</dd>
                        <dt>Versions</dt><dd>{versionText}</dd>
                      </dl>
                    )}
                  </details>

                  {identical && !running && (
                    <p className="banner-inline warn">The proposal is the same as today, so the results will show no difference.</p>
                  )}
                  {!running && (
                    <button className="primary wide" disabled={busy} onClick={runComparison}>
                      {cmp || jobs.base ? `Run again (${seedList.length} runs each)` : `Run simulation (${seedList.length} runs each)`}
                    </button>
                  )}

                  {(jobs.base || jobs.prop) && (
                    <div className="monitor" aria-live="polite">
                      <h3>Progress</h3>
                      {jobs.base && <JobRow label={labels.before === "Current" ? "Today" : labels.before} job={jobs.base} startedAt={startedAt} onRetry={runComparison} versions={versionText} />}
                      {jobs.prop && <JobRow label={labels.after} job={jobs.prop} startedAt={startedAt} onRetry={runComparison}
                        onShowChange={() => go("scenario")} versions={versionText} />}
                      {running && <button className="btn secondary" onClick={cancelRuns}>Cancel</button>}
                      {(jobs.base?.state === "cancelled" || jobs.prop?.state === "cancelled") && <p className="small muted">Cancelled. Nothing was saved.</p>}
                      {jobs.base?.state === "done" && jobs.prop?.state === "done" && !cmp && (
                        <p className="status-line" role="status"><span className="spinner" aria-hidden="true" />Comparing the results…</p>
                      )}
                      {running && <p className="small muted">You can leave this page; it picks up again when you come back.</p>}
                    </div>
                  )}
                </section>
              )}

              {/* ---------------- Results & Analytics ---------------- */}
              {section === "results" && cmp && (
                <section className="step">
                  <h2>Results &amp; Analytics</h2>
                  <p className="lead">
                    {cmp.paired_seeds.length} runs, {CONTROLLERS.find((c) => c.id === runs.prop?.scenario.controller)?.name.toLowerCase() ?? "fixed timing"} in
                    the proposal{runs.prop && runs.prop.scenario.demand_scale !== 1 ? `, ${Math.round(runs.prop.scenario.demand_scale * 100)}% traffic` : ""}.
                    {runs.prop?.scenario.controller === "max_pressure" && <span className="tag-exp">EXPERIMENTAL</span>}
                  </p>
                  {labels !== DEFAULT_LABELS && <p className="banner-inline warn">Comparing two chosen runs: {labels.after} against {labels.before}.</p>}
                  {stale && <p className="banner-inline warn">The scenario changed after this run. Run again to update.</p>}
                  {expected && runs.base && runs.prop && <ReproCheck expected={expected} runs={runs} />}
                  {selection && <SelectedCard sel={selection} cmp={cmp} runs={runs} edgeMap={edgeMap} roadName={roadName} labels={labels}
                    signalLabel={signalTitle} onEdit={() => go("scenario")} onClose={() => setSelection(null)} />}
                  <Results cmp={cmp} before={runs.base} after={runs.prop} labels={labels} />
                  <TopRoads cmp={cmp} roadName={roadName} onZoom={(id) => { setSelection({ kind: "edge", id }); zoomTo("edge", id); setMode("change"); }} onHover={setHoverId} />
                  <RunFacts runs={runs} cmp={cmp} />
                </section>
              )}

              {/* ---------------- Experiments & History ---------------- */}
              {section === "experiments" && (
                <Experiments open networks={networks} currentNet={netId} refreshKey={expKey}
                  onOpen={openExperiment} onCompare={compareAny} onReproduce={reproduce} onOpenFile={() => fileRef.current?.click()} />
              )}

              {showMap && net?.license && section !== "network" && <p className="credit">Data: {net.license}. Map © OpenStreetMap contributors, OpenFreeMap.</p>}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

/** Read-only details of a road or signal, for Network Explorer. */
function Inspector({ sel, edgeMap, signals, propGeo, signalTitle, onEdit, onClose }: {
  sel: NonNullable<Selection>; edgeMap: Record<string, EdgeProps>; signals: Record<string, SignalProgram> | null; propGeo: Geometry | null;
  signalTitle: (id: string) => string; onEdit: () => void; onClose: () => void;
}) {
  if (sel.kind === "edge") {
    const e = edgeMap[sel.id];
    if (!e) return null;
    return (
      <div className="selected-card">
        <div className="row spread"><h3>{edgeLabel(e)}</h3><button className="btn quiet small" onClick={onClose}>Close</button></div>
        <dl className="facts">
          <dt>Lanes</dt><dd>{e.car_allowed ? e.lanes : "closed to cars"}</dd>
          <dt>Speed limit</dt><dd>{Math.round(e.speed_kmh)} km/h</dd>
          <dt>Length</dt><dd>{Math.round(e.length_m)} m</dd>
          {e.road_type && <><dt>Type</dt><dd>{e.road_type.replace(/_/g, " ")}</dd></>}
        </dl>
        <button className="btn secondary small" onClick={onEdit}>Change this road</button>
      </div>
    );
  }
  const node = propGeo?.features.find((f) => f.properties.kind === "signal" && f.properties.id === sel.id)?.properties as SignalProps | undefined;
  const prog = node?.tls.map((t) => signals?.[t]).find(Boolean);
  return (
    <div className="selected-card">
      <div className="row spread"><h3>{signalTitle(sel.id)}</h3><button className="btn quiet small" onClick={onClose}>Close</button></div>
      <dl className="facts">
        <dt>Approaches</dt><dd>{node?.incoming.length ?? "?"}</dd>
        <dt>Cycle</dt><dd>{prog ? `${Math.round(prog.cycle_s)} s, ${prog.phases.length} phases` : "not editable"}</dd>
      </dl>
      {prog && <button className="btn secondary small" onClick={onEdit}>Change its timing</button>}
    </div>
  );
}

function ReproCheck({ expected, runs }: { expected: Expected; runs: Partial<Record<Side, Run>> }) {
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

function SelectedCard({ sel, cmp, runs, edgeMap, roadName, signalLabel, onEdit, onClose, labels }: {
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

function TopRoads({ cmp, roadName, onZoom, onHover }: { cmp: Comparison; roadName: (id: string) => string; onZoom: (id: string) => void; onHover: (id: string | null) => void }) {
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

function RunFacts({ runs, cmp }: { runs: Partial<Record<Side, Run>>; cmp: Comparison }) {
  const r = runs.prop ?? runs.base;
  if (!r) return null;
  const seeds = cmp.paired_seeds;
  return (
    <details className="facts-box">
      <summary>Run details for reproducing this result</summary>
      <dl className="facts">
        <dt>Network</dt><dd>{r.scenario.base_network}</dd>
        <dt>Seeds</dt><dd>{seeds.length > 6 ? `${seeds[0]} to ${seeds[seeds.length - 1]} (${seeds.length} runs)` : seeds.join(", ")}</dd>
        <dt>Signal control</dt><dd>current: {runs.base?.scenario.controller}, proposal: {runs.prop?.scenario.controller}</dd>
        <dt>Traffic level</dt><dd>{Math.round(r.scenario.demand_scale * 100)}%</dd>
        <dt>Changes</dt><dd>{runs.prop?.scenario.edits.length ?? 0}</dd>
        <dt>Versions</dt><dd>{r.versions ? `Junction ${r.versions.app}, SUMO ${r.versions.sumo}` : "not recorded (older run)"}</dd>
        <dt>Run ids</dt><dd className="mono">{runs.base?.id} / {runs.prop?.id}</dd>
      </dl>
    </details>
  );
}

function Legend({ mode, delaySide, setDelaySide }: { mode: MapMode; delaySide: Side; setDelaySide: (s: Side) => void }) {
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
        <button aria-pressed={delaySide === "base"} onClick={() => setDelaySide("base")}>Current</button>
        <button aria-pressed={delaySide === "prop"} onClick={() => setDelaySide("prop")}>Proposal</button>
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
