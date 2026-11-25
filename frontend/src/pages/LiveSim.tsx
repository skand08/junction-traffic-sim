import NetworkPick from "../NetworkPick";
import { useEffect, useMemo, useRef, useState } from "react";
import { PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { api } from "../api";
import MapView, { C, delayColor, edgeLabel, featureBBox, type RGBA, type Selection } from "../MapView";
import { CONTROLLERS } from "../shared";
import FindList from "../FindList";
import { itemsFor, junctionLabel, signalLabel } from "./NetworkExplorer";
import ExternalPicker, { rememberController, savedControllers } from "../ExternalPicker";
import type {
  AgentInfo, Controller, EdgeProps, ExternalCfg, Feature, Geometry, JunctionProps, LiveFrame, LiveInfo, LiveRoute, LiveSetup, LiveStatic,
  LiveVehicle, Network, Scenario, SignalProps,
} from "../types";

type Props = {
  networks: Network[]; scenarios: Scenario[]; preset: { network: string; scenario?: string } | null;
  onChanged: () => Promise<void> | void; fail: (e: unknown) => void; tabs: React.ReactNode;
  /** Research mode: start with this trained agent in control */
  presetAgent?: string | null;
  sessionKey?: string;
};

type ColorLayer = "congestion" | "delay" | "changed" | null;
type Layers = { flow: boolean; signals: boolean; queues: boolean; color: ColorLayer };

const SPEEDS: [number, string][] = [[1, "1×"], [2, "2×"], [5, "5×"], [10, "10×"], [30, "30×"], [0, "Max"]];
const INTENSITY: [LiveSetup["intensity"], string][] = [["low", "Low"], ["medium", "Medium"], ["high", "High"]];
const PROFILE: [LiveSetup["profile"], string][] = [["normal", "Normal"], ["morning", "Morning peak"], ["evening", "Evening peak"]];
const MIX: [LiveSetup["mix"], string, string][] = [
  ["data", "As in the network's data", ""], ["cars", "Cars only", "100% cars"],
  ["mixed", "Mixed city traffic", "70% cars, 15% two-wheelers, 5% buses, 10% trucks"],
  ["two_wheelers", "Two-wheeler heavy", "40% cars, 50% two-wheelers, 5% buses, 5% trucks"],
];
const DURATIONS = [15, 30, 60];
const TYPE_NAME = ["car", "two-wheeler", "bus", "truck"];
// vehicle sizes in metres (length, width) by type, as in the simulation's vehicle types
const DIMS: [number, number][] = [[4.5, 1.8], [2.2, 0.8], [12, 2.5], [10, 2.5]];
const TYPE_COLOR: RGBA[] = [[38, 43, 48, 255], [47, 109, 181, 255], [15, 91, 69, 255], [110, 36, 104, 255]];
const STOPPED: RGBA = [200, 98, 42, 255];
const SIGNAL_COLOR: Record<string, RGBA> = {
  G: [46, 139, 87, 255], g: [46, 139, 87, 255], y: [214, 160, 0, 255], Y: [214, 160, 0, 255], u: [214, 160, 0, 255],
  r: [200, 70, 58, 255], R: [200, 70, 58, 255], s: [200, 70, 58, 255], o: [150, 158, 154, 255], O: [150, 158, 154, 255],
};
const SESSION_KEY = "junction.live";
export const ALG_NAME: Record<string, string> = { dqn: "DQN", double_dqn: "Double DQN", ppo: "PPO" };

function clock(t: number) {
  const s = Math.max(0, Math.round(t)) % 86400;
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** The last `metres` of a path, measured back from its end: where a queue at the stop line sits. */
function tail(coords: [number, number][], metres: number): [number, number][] {
  if (coords.length < 2) return coords;
  const lat = coords[0][1] * Math.PI / 180, mx = 111320 * Math.cos(lat), my = 110540;
  const out: [number, number][] = [coords[coords.length - 1]];
  let left = metres;
  for (let i = coords.length - 1; i > 0 && left > 0; i--) {
    const [x1, y1] = coords[i], [x0, y0] = coords[i - 1];
    const d = Math.hypot((x1 - x0) * mx, (y1 - y0) * my);
    if (d >= left) { const f = left / d; out.push([x1 + (x0 - x1) * f, y1 + (y0 - y1) * f]); left = 0; }
    else { out.push([x0, y0]); left -= d; }
  }
  return out.reverse();
}

/** A vehicle as a rectangle of its real size, pointing the way it drives (SUMO angle: 0 = north, clockwise). */
function rect(v: LiveVehicle, lon: number, lat: number): [number, number][] {
  const [len, wid] = DIMS[v[5]] ?? DIMS[0];
  const a = (v[3] * Math.PI) / 180, fx = Math.sin(a), fy = Math.cos(a);   // forward
  const mx = 111320 * Math.cos((lat * Math.PI) / 180), my = 110540;
  const pts: [number, number][] = [[0, 0], [-len, 0], [-len, 0], [0, 0]];
  const side = [wid / 2, wid / 2, -wid / 2, -wid / 2];
  // SUMO reports the front bumper position; the body extends backwards
  return pts.map(([f], i) => [lon + (f * fx + side[i] * fy) / mx, lat + (f * fy - side[i] * fx) / my] as [number, number]);
}

export default function LiveSim({ networks, scenarios, preset, onChanged, fail, tabs, presetAgent, sessionKey }: Props) {
  const SESSION = sessionKey ?? SESSION_KEY;
  // ---------- setup ----------
  const [nid, setNid] = useState(preset?.network ?? "");
  const [sid, setSid] = useState(preset?.scenario ?? "");
  const [controller, setController] = useState<Controller | "rl" | "external" | "">(presetAgent ? "rl" : "");
  const [ext, setExt] = useState<ExternalCfg>(() => savedControllers()[0] ?? { url: "http://localhost:9000/", name: "My controller" });
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [rlAgent, setRlAgent] = useState<string>(presetAgent ?? "");
  const [rlCkpt, setRlCkpt] = useState("final");
  useEffect(() => { api.agents().then((a) => setAgents(a.filter((x) => x.has_model))).catch(() => {}); }, []);
  useEffect(() => {
    if (!presetAgent) return;
    setController("rl"); setRlAgent(presetAgent);
    const a = agents.find((x) => x.id === presetAgent);
    const s0 = a && scenarios.find((s) => s.id === a.config.scenario_id);
    if (s0) { setNid(s0.base_network); setSid(s0.id); }
  }, [presetAgent, agents.length]);
  const agent = agents.find((a) => a.id === rlAgent);
  const [intensity, setIntensity] = useState<LiveSetup["intensity"]>("medium");
  const [profile, setProfile] = useState<LiveSetup["profile"]>("normal");
  const [mix, setMix] = useState<LiveSetup["mix"]>("data");
  const [duration, setDuration] = useState(30);
  const [routes, setRoutes] = useState<LiveRoute[]>([]);
  const [pick, setPick] = useState<null | { stage: "entry" | "dest"; from?: string }>(null);
  const [busy, setBusy] = useState(false);

  const onNet = useMemo(() => scenarios.filter((s) => s.base_network === nid), [scenarios, nid]);
  const scenario = scenarios.find((s) => s.id === sid);
  useEffect(() => {
    if (!nid) return;
    if (sid && onNet.some((s) => s.id === sid)) return;
    const b = onNet.find((s) => s.baseline);
    if (b) setSid(b.id);
    else api.baseline(nid).then(async (s) => { await onChanged(); setSid(s.id); }).catch(fail);
  }, [nid, onNet.length]);
  useEffect(() => { if (preset) { setNid(preset.network); if (preset.scenario) setSid(preset.scenario); } }, [preset]);

  // ---------- session and frames ----------
  const [info, setInfo] = useState<LiveInfo | null>(null);
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const prev = useRef<{ f: LiveFrame | null; at: number; dt: number }>({ f: null, at: 0, dt: 250 });
  const [geo, setGeo] = useState<Geometry | null>(null);
  const [stat, setStat] = useState<LiveStatic | null>(null);
  const [sel, setSel] = useState<Selection>(null);
  const [layers, setLayers] = useState<Layers>({ flow: true, signals: true, queues: true, color: "congestion" });
  const [zoom, setZoom] = useState(15);
  const [tick, setTick] = useState(0);
  const [focus, setFocus] = useState<{ bbox: [number, number, number, number]; key: number; maxZoom?: number } | null>(null);
  /** select from the panel (list or search): also bring it into view */
  const selectAndShow = (s: NonNullable<Selection>) => {
    setSel(s);
    const f = geo?.features.find((x) => x.properties.kind === s.kind && x.properties.id === s.id);
    if (f) setFocus({ bbox: featureBBox(f), key: Date.now(), maxZoom: s.kind === "edge" ? 17.5 : 17.5 });
  };

  // reattach to a session left running (e.g. after visiting another section)
  useEffect(() => {
    const id = sessionStorage.getItem(SESSION);
    if (id) api.liveInfo(id).then((i) => { setInfo(i); setNid(i.network); setSid(i.config.scenario_id); }).catch(() => sessionStorage.removeItem(SESSION));
  }, []);

  // map geometry: the scenario's network (with its changes)
  const geoFor = info ? info.config.scenario_id : sid;
  useEffect(() => {
    setGeo(null);
    if (!geoFor) return;
    let off = false;
    api.geometry(geoFor).then((g) => !off && setGeo(g)).catch(fail);
    return () => { off = true; };
  }, [geoFor]);
  useEffect(() => {
    setStat(null);
    if (info) api.liveStatic(info.id).then(setStat).catch(() => {});
  }, [info?.id]);

  // frames: long-poll the server for the newest one
  useEffect(() => {
    if (!info) return;
    let stop = false, after = 0, run = info.run;
    (async () => {
      while (!stop) {
        try {
          const f = await api.liveFrame(info.id, after);
          if (stop) break;
          if (f.run !== run) { run = f.run; after = 0; prev.current.f = null; }
          if (f.seq === 0 || f.seq === after) { await new Promise((r) => setTimeout(r, 400)); continue; }
          const now = performance.now();
          setFrame((cur) => {
            prev.current = { f: cur && cur.run === f.run ? cur : null, at: now, dt: Math.min(1000, Math.max(120, now - prev.current.at)) };
            return f;
          });
          after = f.seq;
        } catch (e) {
          if (stop) break;
          fail(e); await new Promise((r) => setTimeout(r, 1500));
        }
      }
    })();
    return () => { stop = true; };
  }, [info?.id]);

  // smooth motion between two real frames (linear in between; no positions are invented beyond them)
  useEffect(() => {
    if (!frame || frame.state !== "running" || !layers.flow) return;
    let raf = 0;
    const loop = () => { setTick((t) => (t + 1) % 1e6); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [frame?.state, layers.flow]);

  // what the inspector watches in SUMO
  const tlsOf = (id: string) => (geo?.features.find((f) => f.properties.kind === "signal" && f.properties.id === id)?.properties as SignalProps | undefined)?.tls[0];
  useEffect(() => {
    if (!info) return;
    const w = sel?.kind === "edge" ? { edge: sel.id } : sel?.kind === "signal" ? { tls: tlsOf(sel.id) ?? sel.id } : null;
    api.liveControl(info.id, { action: "watch", watch: w }).catch(() => {});
  }, [sel?.kind, sel?.id, info?.id, frame?.run]);

  async function start() {
    if (!sid) return;
    setBusy(true);
    try {
      if (controller === "rl" && !rlAgent) throw new Error("Choose a trained agent.");
      if (controller === "external") rememberController(ext);
      const i = await api.liveStart({ scenario_id: sid, controller: controller || null, rl_agent: controller === "rl" ? rlAgent : null,
        external: controller === "external" ? ext : null,
        rl_checkpoint: rlCkpt, intensity, profile, mix, duration_min: duration, routes });
      sessionStorage.setItem(SESSION, i.id);
      setFrame(null); prev.current = { f: null, at: 0, dt: 250 };
      setInfo(i); setPick(null);
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function control(action: "pause" | "resume" | "reset", speed?: number) {
    if (!info) return;
    try { const i = await api.liveControl(info.id, { action, speed }); setInfo(i); } catch (e) { fail(e); }
  }
  async function setSpeed(v: number) { if (info) try { await api.liveControl(info.id, { action: "speed", speed: v }); } catch (e) { fail(e); } }
  async function endSession() {
    if (info) await api.liveStop(info.id).catch(() => {});
    sessionStorage.removeItem(SESSION);
    setInfo(null); setFrame(null); setStat(null); setSel(null);
  }

  // ---------- derived ----------
  const edgesById = useMemo(() => {
    const m: Record<string, { p: EdgeProps; coords: [number, number][] }> = {};
    geo?.features.forEach((f) => { if (f.properties.kind === "edge") m[f.properties.id] = { p: f.properties as EdgeProps, coords: (f.geometry as any).coordinates }; });
    return m;
  }, [geo]);
  const edgeProps = useMemo(() => Object.fromEntries(Object.entries(edgesById).map(([k, v]) => [k, v.p])), [edgesById]);
  const findItems = useMemo(() => itemsFor(geo), [geo]);
  const roadName = (id: string) => (edgesById[id] ? edgeLabel(edgesById[id].p) : id);

  const fe = frame?.edges ?? {};
  const laneView = !!stat && zoom >= 17;
  const roadColor = useMemo(() => {
    if (!info || !frame) return layers.color === "changed" ? (p: EdgeProps) => (geo?.edited?.[p.id] ? C.edited : null) : null;
    if (layers.color === "congestion") return (p: EdgeProps) => {
      const e = fe[p.id];
      if (!e) return C.noData;
      const loss = Math.max(0, 1 - e[2] / Math.max(5, p.speed_kmh)) * 100;    // % below the speed limit
      return delayColor(loss);
    };
    if (layers.color === "delay") return (p: EdgeProps) => { const e = fe[p.id]; return e ? delayColor(e[3] / e[0]) : C.noData; };
    if (layers.color === "changed") return (p: EdgeProps) => (geo?.edited?.[p.id] ? C.edited : C.same);
    return null;
  }, [frame?.seq, layers.color, info?.id, geo]);
  // once lanes are drawn as their own strips, the road under them is plain asphalt, so lane gaps show
  const edgeColor = laneView ? (_p: EdgeProps) => [70, 76, 82, 255] as RGBA : roadColor;

  const extraLayers = (z: number) => {
    const out: any[] = [];
    // lanes as separate strips once zoomed in, coloured like their road
    if (stat && z >= 17) {
      const lanes = stat.lanes.filter((l) => l[3]);
      out.push(new PathLayer<(typeof lanes)[number]>({
        id: "lanes", data: lanes, getPath: (l) => l[4], widthUnits: "meters", getWidth: (l) => l[2] * 0.82,
        getColor: (l) => { const p = edgeProps[l[1]]; const c = p && roadColor ? roadColor(p) : null; return c ?? [197, 204, 200, 255]; },
        updateTriggers: { getColor: [frame?.seq, layers.color] },
      }));
    }
    if (frame && layers.queues) {
      const q = Object.entries(fe).filter(([id, e]) => e[1] > 0 && edgesById[id]).map(([id, e]) => {
        const { p, coords } = edgesById[id];
        return { id, path: tail(coords, Math.min(p.length_m, (e[1] * 7.5) / Math.max(1, p.lanes))), w: Math.max(3, p.lanes * 3.2) + 2 };
      });
      out.push(new PathLayer<(typeof q)[number]>({ id: "queues", data: q, getPath: (d) => d.path, widthUnits: "meters", widthMinPixels: 4,
        getWidth: (d) => d.w, getColor: [200, 98, 42, 110], capRounded: false }));
    }
    if (frame && layers.flow && frame.veh.length) {
      const p = prev.current;
      const a = frame.state === "running" && p.f ? Math.min(1, (performance.now() - p.at) / p.dt) : 1;
      const old = new Map<string, LiveVehicle>();
      if (a < 1 && p.f) p.f.veh.forEach((v) => old.set(v[0], v));
      const pos = frame.veh.map((v) => {
        const o = old.get(v[0]);
        return { v, lon: o ? o[1] + (v[1] - o[1]) * a : v[1], lat: o ? o[2] + (v[2] - o[2]) * a : v[2] };
      });
      const color = (v: LiveVehicle) => (v[4] < 1 ? STOPPED : TYPE_COLOR[v[5]] ?? TYPE_COLOR[0]);
      if (z >= 16.5) out.push(new PolygonLayer<(typeof pos)[number]>({
        id: "vehicles", data: pos, getPolygon: (d) => rect(d.v, d.lon, d.lat), getFillColor: (d) => color(d.v),
        stroked: true, getLineColor: [250, 251, 249, 255], lineWidthUnits: "pixels", getLineWidth: 1, updateTriggers: { getPolygon: [tick, frame.seq] },
      }));
      else out.push(new ScatterplotLayer<(typeof pos)[number]>({
        id: "vehicles", data: pos, getPosition: (d) => [d.lon, d.lat], radiusUnits: "pixels", getRadius: z >= 15 ? 3 : 2,
        getFillColor: (d) => color(d.v), stroked: false, updateTriggers: { getPosition: [tick, frame.seq] },
      }));
    }
    if (frame && stat && layers.signals && z >= 15.5) {
      out.push(new ScatterplotLayer<LiveStatic["signal_marks"][number]>({
        id: "signal-marks", data: stat.signal_marks, getPosition: (m) => [m[2], m[3]], radiusUnits: "pixels", getRadius: z >= 17 ? 4 : 3,
        stroked: true, getLineColor: [38, 43, 48, 255], lineWidthUnits: "pixels", getLineWidth: 1,
        getFillColor: (m) => SIGNAL_COLOR[frame.tls[m[0]]?.[0]?.[m[1]] ?? "o"] ?? SIGNAL_COLOR.o, updateTriggers: { getFillColor: [frame.seq] },
      }));
    }
    // chosen entry (A) and destination (B) points
    const ends: { id: string; label: string }[] = [];
    routes.forEach((r, i) => { ends.push({ id: r.from_edge, label: `A${i + 1}` }, { id: r.to_edge, label: `B${i + 1}` }); });
    if (pick?.from) ends.push({ id: pick.from, label: "A" });
    const pts = ends.filter((e) => edgesById[e.id]).map((e) => { const c = edgesById[e.id].coords; return { ...e, pos: c[Math.floor(c.length / 2)] }; });
    if (pts.length) {
      out.push(new ScatterplotLayer<(typeof pts)[number]>({ id: "route-ends", data: pts, getPosition: (d) => d.pos, radiusUnits: "pixels", getRadius: 11,
        getFillColor: [15, 91, 69, 255], stroked: true, getLineColor: [250, 251, 249, 255], lineWidthUnits: "pixels", getLineWidth: 2 }));
      out.push(new TextLayer<(typeof pts)[number]>({ id: "route-labels", data: pts, getPosition: (d) => d.pos, getText: (d) => d.label,
        getSize: 11, getColor: [250, 251, 249, 255], fontWeight: 700, getTextAnchor: "middle", getAlignmentBaseline: "center" }));
    }
    return out;
  };

  function onMapSelect(s: Selection) {
    if (pick && s?.kind === "edge") {
      const p = edgesById[s.id]?.p;
      if (!p?.car_allowed) { fail(new Error("Pick a road open to cars.")); return; }
      if (pick.stage === "entry") setPick({ stage: "dest", from: s.id });
      else if (pick.from && s.id !== pick.from) { setRoutes((r) => [...r, { from_edge: pick.from!, to_edge: s.id, per_hour: 300 }]); setPick(null); }
      return;
    }
    setSel(s);
  }

  const k = frame?.kpi;
  const running = frame?.state === "running";
  const span = info ? info.stop - info.begin : 1;
  const progress = info && frame?.t ? Math.min(1, (frame.t - info.begin) / span) : 0;
  const winMark = info ? (info.window_end - info.begin) / span : 0;
  const busiest = Object.entries(fe).filter(([id]) => edgesById[id]).sort((a, b) => b[1][1] - a[1][1] || b[1][3] - a[1][3]).slice(0, 6);

  return (
    <main className="work live">
      <div className="stage">
        {geo ? (
          <MapView geometry={geo} mode="layout" selection={sel} onSelect={onMapSelect} edgeColor={edgeColor} focus={focus} edgeColorKey={`${frame?.seq}-${layers.color}-${laneView}`}
            extraLayers={extraLayers} onZoom={setZoom} />
        ) : nid ? <div className="empty-stage"><p>Loading the network…</p></div>
          : <div className="empty-stage"><NetworkPick networks={networks} onPick={(id) => { setNid(id); setSid(""); setRoutes([]); }} title="Choose a network to simulate" /></div>}

        {frame && k && (
          <div className="kpis" aria-label="Live traffic">
            <Kpi label="Vehicles" value={k.running.toLocaleString()} sub={`${k.waiting_to_enter} waiting to enter`} />
            <Kpi label="Average speed" value={`${k.mean_speed_kmh.toFixed(0)} km/h`} />
            <Kpi label="Average waiting" value={`${k.mean_wait_s.toFixed(0)} s`} sub="stopped so far, per vehicle" />
            <Kpi label="Congestion" value={`${k.halting_pct.toFixed(0)}%`} sub="of vehicles stopped" tone={k.halting_pct >= 40 ? "bad" : k.halting_pct >= 20 ? "warn" : undefined} />
            <Kpi label="Throughput" value={`${k.throughput_per_h.toLocaleString()}/h`} sub={`${k.arrived.toLocaleString()} trips done`} />
          </div>
        )}
        {pick && <div className="pick-hint" role="status">{pick.stage === "entry" ? "Click the road where the traffic enters." : "Now click the road it should reach."}
          <button className="btn quiet small" onClick={() => setPick(null)}>Cancel</button></div>}

        {geo && (
          <div className="layer-box" role="group" aria-label="Map layers">
            <span className="layer-title">Layers</span>
            <Toggle on={layers.flow} onClick={() => setLayers({ ...layers, flow: !layers.flow })} label="Traffic flow" swatch="flow" disabled={!info} />
            <Toggle on={layers.signals} onClick={() => setLayers({ ...layers, signals: !layers.signals })} label="Signals" swatch="signal" disabled={!info} />
            <Toggle on={layers.queues} onClick={() => setLayers({ ...layers, queues: !layers.queues })} label="Queues" swatch="queue" disabled={!info} />
            <span className="layer-sub">Colour roads by</span>
            <Toggle on={layers.color === "congestion"} onClick={() => setLayers({ ...layers, color: layers.color === "congestion" ? null : "congestion" })} label="Congestion" swatch="heat" disabled={!info} />
            <Toggle on={layers.color === "delay"} onClick={() => setLayers({ ...layers, color: layers.color === "delay" ? null : "delay" })} label="Delay" swatch="heat" disabled={!info} />
            <Toggle on={layers.color === "changed"} onClick={() => setLayers({ ...layers, color: layers.color === "changed" ? null : "changed" })} label="What changed" swatch="changed" />
            {info && layers.color && layers.color !== "changed" && (
              <span className="layer-key">{layers.color === "congestion" ? "Light: near the speed limit; dark: far below it" : "Light: little waiting · dark: 100+ s per vehicle"}</span>
            )}
            {layers.flow && info && <span className="layer-key"><i className="dot-k stopped" />stopped vehicle{zoom < 16.5 ? "; zoom in for vehicle shapes" : ""}</span>}
          </div>
        )}

        {info && (
          <div className="timeline" aria-label="Simulation controls">
            <div className="tl-buttons">
              {running ? <button className="primary small" onClick={() => control("pause")}>Pause</button>
                : frame?.state === "paused" ? <button className="primary small" onClick={() => control("resume")}>Resume</button>
                : <button className="primary small" disabled>{frame?.state === "finished" ? "Finished" : "Starting…"}</button>}
              <button className="btn secondary small" onClick={() => control("reset")} title="Start again from the beginning, same traffic">Reset</button>
              <div className="seg" role="radiogroup" aria-label="Simulation speed">
                {SPEEDS.map(([v, l]) => <button key={l} role="radio" aria-checked={(frame?.speed ?? 1) === v} onClick={() => setSpeed(v)}>{l}</button>)}
              </div>
            </div>
            <div className="tl-track">
              <span className="tl-time">{frame?.t ? clock(frame.t) : "--:--:--"}</span>
              <div className="tl-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}
                aria-label="Simulated time">
                <Spark hist={frame?.hist ?? []} begin={info.begin} stop={info.stop} />
                <i className="tl-fill" style={{ width: `${progress * 100}%` }} />
                <i className="tl-mark" style={{ left: `${winMark * 100}%` }} title="End of new traffic; after this, trips on the road finish" />
              </div>
              <span className="tl-time muted">{clock(info.stop)}</span>
            </div>
            <span className="tl-note">New traffic {clock(info.begin)}–{clock(info.window_end)}, then trips already on the road finish. Line: vehicles in the network.</span>
          </div>
        )}
      </div>

      <aside className="panel">
        <div className="panel-body">
          {tabs}
          {!info ? (
            <section className="step">
              <h2>Set up a live run</h2>
              <label className="field block"><span className="label">Network</span>
                <select value={nid} onChange={(e) => { setNid(e.target.value); setSid(""); setRoutes([]); }}>
                  <option value="">Choose a network…</option>
                  {networks.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
                </select></label>
              {nid && (
                <label className="field block"><span className="label">Scenario</span>
                  <select value={sid} onChange={(e) => setSid(e.target.value)}>
                    {onNet.map((s) => <option key={s.id} value={s.id}>{s.name}{s.baseline ? " (no changes)" : ""}</option>)}
                  </select></label>
              )}
              <div className="field block"><span className="label">Signal control</span>
                <div className="seg wide" role="radiogroup" aria-label="Signal control">
                  {CONTROLLERS.map((c) => (
                    <button key={c.id} role="radio" aria-checked={(controller || scenario?.controller) === c.id} onClick={() => setController(c.id)}>{c.name}</button>
                  ))}
                  <button role="radio" aria-checked={controller === "rl"} disabled={!agents.length} onClick={() => setController("rl")}
                    title={agents.length ? "A trained agent controls the signals" : "Train an agent in Research first"}>RL agent</button>
                  <button role="radio" aria-checked={controller === "external"} onClick={() => setController("external")}
                    title="Your own controller, running as a web service">External</button>
                </div>
                {controller === "external" ? (
                  <div className="rl-pick">
                    <ExternalPicker value={ext} onChange={setExt} compact />
                    <span className="small muted">Junction adds amber and all-red to every change.</span>
                  </div>
                ) : controller === "rl" ? (
                  <div className="rl-pick">
                    <select value={rlAgent} onChange={(e) => { setRlAgent(e.target.value); setRlCkpt("final"); }} aria-label="Trained agent">
                      <option value="">Choose a trained agent…</option>
                      {agents.map((a) => <option key={a.id} value={a.id}>{a.config.name} ({ALG_NAME[a.config.algorithm]}, {a.status.episodes_done} episodes)</option>)}
                    </select>
                    {agent && (
                      <select value={rlCkpt} onChange={(e) => setRlCkpt(e.target.value)} aria-label="Checkpoint">
                        <option value="final">Final</option>
                        {agent.has_best && <option value="best">Best episode ({agent.status.best_episode})</option>}
                        {agent.checkpoints.map((c) => <option key={c} value={c}>Episode {Number(c.slice(3, 7))}</option>)}
                      </select>
                    )}
                    {agent && agent.manifest.network !== nid && <span className="small warn-text">Trained on another network; only shared-parameter agents can run here.</span>}
                  </div>
                ) : (
                  controller && scenario && controller !== scenario.controller
                    ? <span className="small muted">Replaces the scenario's {CONTROLLERS.find((c) => c.id === scenario.controller)?.name.toLowerCase()} for this run.</span> : null
                )}
              </div>
              <div className="field block"><span className="label">Traffic intensity</span>
                <div className="seg wide" role="radiogroup" aria-label="Traffic intensity">
                  {INTENSITY.map(([v, l]) => <button key={v} role="radio" aria-checked={intensity === v} onClick={() => setIntensity(v)}>{l}</button>)}
                </div>
                <span className="small muted">{intensity === "low" ? "60%" : intensity === "high" ? "140%" : "100%"} of the network's traffic{scenario && scenario.demand_scale !== 1 ? `, times the scenario's ${Math.round(scenario.demand_scale * 100)}%` : ""}.</span>
              </div>
              <div className="field block"><span className="label">Traffic profile</span>
                <div className="seg wide" role="radiogroup" aria-label="Traffic profile">
                  {PROFILE.map(([v, l]) => <button key={v} role="radio" aria-checked={profile === v} onClick={() => setProfile(v)}>{l}</button>)}
                </div>
                <span className="small muted">{profile === "normal" ? "Trips start evenly over the period." : profile === "morning" ? "Starts build to a peak early in the period, then ease." : "Starts build slowly to a peak late in the period."}</span>
              </div>
              <label className="field block"><span className="label">Vehicles</span>
                <select value={mix} onChange={(e) => setMix(e.target.value as LiveSetup["mix"])}>
                  {MIX.map(([v, l, d]) => <option key={v} value={v}>{l}{d ? ` (${d})` : ""}</option>)}
                </select>
                
              </label>
              <div className="field block"><span className="label">Duration of new traffic</span>
                <div className="seg wide" role="radiogroup" aria-label="Duration">
                  {DURATIONS.map((d) => <button key={d} role="radio" aria-checked={duration === d} onClick={() => setDuration(d)}>{d} min</button>)}
                </div></div>
              <div className="field block"><span className="label">Extra routes <span className="muted">(optional)</span></span>
                {routes.length > 0 && (
                  <ul className="routes">
                    {routes.map((r, i) => (
                      <li key={i}>
                        <span className="route-name"><b>A{i + 1}</b> {roadName(r.from_edge)} → <b>B{i + 1}</b> {roadName(r.to_edge)}</span>
                        <input type="number" className="text" min={10} max={3000} step={10} value={r.per_hour} aria-label={`Vehicles per hour on route ${i + 1}`}
                          onChange={(e) => setRoutes(routes.map((x, k2) => (k2 === i ? { ...x, per_hour: Math.max(10, Math.min(3000, Number(e.target.value) || 10)) } : x)))} />
                        <span className="small muted">veh/h</span>
                        <button className="btn quiet small" onClick={() => setRoutes(routes.filter((_, k2) => k2 !== i))} aria-label={`Remove route ${i + 1}`}>Remove</button>
                      </li>
                    ))}
                  </ul>
                )}
                <button className="btn secondary small" disabled={!geo || !!pick} onClick={() => setPick({ stage: "entry" })}>Add a route on the map</button>
                <span className="small muted">Click where traffic enters, then where it goes. SUMO finds the way.</span>
              </div>
              <button className="primary wide" disabled={!sid || busy} onClick={start}>{busy ? "Starting…" : "Start simulation"}</button>
            </section>
          ) : (
            <section className="step">
              <div className="row spread">
                <h2>{info.scenario_name}</h2>
                <span className={`status ${frame?.state ?? "starting"}`}>{{ starting: "Starting", running: "Running", paused: "Paused", finished: "Finished", failed: "Failed" }[frame?.state ?? "starting"]}</span>
              </div>
              <p className="small muted">
                {networks.find((n) => n.id === info.network)?.name}. {info.controller === "rl" ? `RL agent ${info.rl_agent ?? ""}` : info.controller === "external" ? `External controller ${info.external ?? ""}` : CONTROLLERS.find((c) => c.id === info.controller)?.name}; {INTENSITY.find((x) => x[0] === info.config.intensity)?.[1].toLowerCase()} traffic, {PROFILE.find((x) => x[0] === info.config.profile)?.[1].toLowerCase()} profile, {info.config.duration_min} min{info.config.routes.length ? `, ${info.config.routes.length} extra route${info.config.routes.length > 1 ? "s" : ""}` : ""}.
              </p>
              {k && k.teleports > 0 && <p className="banner-inline warn">{k.teleports} vehicle{k.teleports > 1 ? "s were" : " was"} stuck for 5 minutes and removed from a jam by SUMO. Read congestion numbers with care.</p>}
              {info.warnings.length > 0 && <details className="small"><summary>{info.warnings.length} build note{info.warnings.length > 1 ? "s" : ""}</summary><ul>{info.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></details>}
              <div className="row">
                <button className="btn quiet small" onClick={endSession}>Stop and change setup</button>
              </div>

              <div className="live-find">
                <FindList variant="dropdown" items={findItems} onPick={(x) => x && selectAndShow(x)} placeholder="Find a road or signal to inspect" />
              </div>
              {sel ? (
                <Inspector sel={sel} frame={frame} geo={geo} edgeProps={edgeProps} roadName={roadName} controller={info.controller} onClose={() => setSel(null)} />
              ) : (
                <>
                  <h3>Longest queues now</h3>
                  {busiest.length === 0 ? <p className="small muted">No traffic yet.</p> : (
                    <ul className="busy">
                      {busiest.map(([id, e]) => (
                        <li key={id}><button className="link" onClick={() => selectAndShow({ kind: "edge", id })}>{roadName(id)}</button>
                          <span className="small">{e[1]} stopped of {e[0]}, {e[2].toFixed(0)} km/h</span></li>
                      ))}
                    </ul>
                  )}
                  <p className="small muted">Click a road, signal or junction on the map for its live details.</p>
                </>
              )}
            </section>
          )}
        </div>
      </aside>
    </main>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warn" | "bad" }) {
  return (
    <div className={`kpi ${tone ?? ""}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {sub && <span className="kpi-sub">{sub}</span>}
    </div>
  );
}

function Toggle({ on, onClick, label, swatch, disabled }: { on: boolean; onClick: () => void; label: string; swatch: string; disabled?: boolean }) {
  return (
    <button className="layer-toggle" role="switch" aria-checked={on} onClick={onClick} disabled={disabled}>
      <i className={`sw-${swatch}`} aria-hidden="true" />{label}
    </button>
  );
}

/** Vehicles in the network over simulated time, from the frames' history (every 30 s). */
function Spark({ hist, begin, stop }: { hist: LiveFrame["hist"]; begin: number; stop: number }) {
  if (hist.length < 2) return null;
  const max = Math.max(1, ...hist.map((h) => h[1]));
  const pts = hist.map((h) => `${((h[0] - begin) / (stop - begin)) * 100},${30 - (h[1] / max) * 26}`).join(" ");
  return <svg className="tl-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points={pts} /></svg>;
}

function Inspector({ sel, frame, geo, edgeProps, roadName, controller, onClose }: {
  sel: NonNullable<Selection>; frame: LiveFrame | null; geo: Geometry | null; edgeProps: Record<string, EdgeProps>;
  roadName: (id: string) => string; controller: Controller | "rl" | "external"; onClose: () => void;
}) {
  const w = frame?.watch;
  const head = (title: string) => <div className="row spread"><h3>{title}</h3><button className="btn quiet small" onClick={onClose}>Close</button></div>;
  if (sel.kind === "edge") {
    const p = edgeProps[sel.id];
    const e = frame?.edges[sel.id];
    const lanes = w && "edge" in w && w.edge === sel.id ? w.lanes : null;
    return (
      <div className="selected-card">
        {head(p ? edgeLabel(p) : sel.id)}
        <dl className="facts">
          <dt>Vehicles now</dt><dd>{e ? e[0] : 0}</dd>
          <dt>Queue</dt><dd>{e ? `${e[1]} stopped` : "none"}</dd>
          <dt>Average speed</dt><dd>{e ? `${e[2].toFixed(0)} km/h` : "no vehicles"} (limit {p ? Math.round(p.speed_kmh) : "?"} km/h)</dd>
          <dt>Waiting</dt><dd>{e ? `${Math.round(e[3] / e[0])} s per vehicle so far` : "–"}</dd>
          {lanes && <><dt>Travel time now</dt><dd>{(w as any).travel_time_s} s</dd></>}
          <dt>Length</dt><dd>{p ? `${Math.round(p.length_m)} m` : "?"}</dd>
        </dl>
        {lanes ? (
          <table className="compact lanes-t">
            <thead><tr><th scope="col">Lane</th><th scope="col">Vehicles</th><th scope="col">Stopped</th><th scope="col">km/h</th><th scope="col">Width</th></tr></thead>
            <tbody>
              {[...lanes].reverse().map((l) => (
                <tr key={l.index} className={l.allowed.length && !l.allowed.includes("passenger") ? "muted" : ""}>
                  <th scope="row">{l.allowed.length && !l.allowed.includes("passenger") ? (l.allowed.includes("pedestrian") ? "Footpath" : l.allowed.includes("bicycle") ? "Cycle lane" : "Other") : `Lane ${l.index + 1}`}</th>
                  <td>{l.vehicles}</td><td>{l.halting}</td><td>{l.vehicles ? l.speed_kmh.toFixed(0) : "–"}</td><td>{l.width_m} m</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="small muted">Loading lane details…</p>}
        <p className="small muted">Lanes listed from the left (centre of the road) to the kerb.</p>
      </div>
    );
  }
  const f = geo?.features.find((x) => x.properties.kind !== "edge" && x.properties.id === sel.id) as Feature | undefined;
  if (sel.kind === "junction") {
    const j = f?.properties as JunctionProps | undefined;
    return (
      <div className="selected-card">
        {head(j ? junctionLabel(j, edgeProps) : `Junction ${sel.id}`)}
        <p className="small muted">No signal: {j?.control === "priority" ? "the main road has right of way" : j?.control.replace(/_/g, " ")}.</p>
        <table className="compact">
          <thead><tr><th scope="col">Road in</th><th scope="col">Vehicles</th><th scope="col">Stopped</th></tr></thead>
          <tbody>{(j?.incoming ?? []).map((id) => { const e = frame?.edges[id]; return <tr key={id}><th scope="row">{roadName(id)}</th><td>{e ? e[0] : 0}</td><td>{e ? e[1] : 0}</td></tr>; })}</tbody>
        </table>
      </div>
    );
  }
  const s = f?.properties as SignalProps | undefined;
  const t = w && "tls" in w ? w : null;
  return (
    <div className="selected-card">
      {head(s ? signalLabel(s, edgeProps) : `Signal ${sel.id}`)}
      {!t ? <p className="small muted">Loading the signal's state…</p> : (
        <>
          <p className="small">
            {controller === "max_pressure"
              ? "Pressure-based control has no fixed plan: every 5 s it gives green to the movements with the longest queues relative to the space beyond."
              : controller === "rl"
              ? "The trained agent picks the next green every few seconds; amber and all-red are added for safety."
              : controller === "external"
              ? "Your controller picks the next green every few seconds; Junction adds amber and all-red for safety."
              : <>Phase {t.phase + 1} of {t.phases.length}{t.next_switch_s != null ? `, changes in ${t.next_switch_s} s` : ""}.{controller === "actuated" ? " Greens stretch or end early with demand." : ""}</>}
          </p>
          <table className="compact">
            <thead><tr><th scope="col">Approach</th><th scope="col">Now</th><th scope="col">Stopped</th></tr></thead>
            <tbody>
              {t.approaches.map((a) => (
                <tr key={a.lane}>
                  <th scope="row">{roadName(a.edge)} <span className="muted">lane {Number(a.lane.split("_").pop()) + 1}</span></th>
                  <td><span className="state">{[...a.states].map((ch, i) => <i key={i} className={ch === "G" || ch === "g" ? "g" : ch === "y" || ch === "Y" || ch === "u" ? "y" : ch === "o" || ch === "O" ? "o" : "r"} />)}</span></td>
                  <td>{a.halting}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(controller === "rl" || controller === "external") && t.agent && (
            <div className="agent-dec">
              <p className="small"><b>{controller === "rl" ? "Agent's" : "Controller's"} last decision</b> at {clock(t.agent.t)}: {t.agent.held ? "keep" : "switch to"} phase option {t.agent.chosen + 1}.
                {t.agent.kind === "value" ? " Bars: estimated value of each option (higher is better)." : t.agent.kind === "queue" ? " Bars: vehicles queued for each option, as sent to the controller." : " Bars: probability of each option."}</p>
              {(() => { const lo = t.agent!.kind === "queue" ? 0 : Math.min(...t.agent!.values), hi = Math.max(...t.agent!.values), span = hi - lo || 1;
                return t.agent!.values.map((v, i) => (
                  <div key={i} className={`dec-row ${i === t.agent!.chosen ? "chosen" : ""}`}>
                    <span className="dec-name">Option {i + 1}</span>
                    <span className="state">{[...t.agent!.phases[i]].map((ch, k) => <i key={k} className={ch === "G" || ch === "g" ? "g" : "r"} />)}</span>
                    <span className="dec-bar"><i style={{ width: `${t.agent!.kind === "value" ? 8 + 92 * (v - lo) / span : t.agent!.kind === "queue" ? 100 * v / span : 100 * v}%` }} /></span>
                    <span className="dec-val">{t.agent!.kind === "value" ? v.toFixed(2) : t.agent!.kind === "queue" ? `${v} veh` : `${Math.round(v * 100)}%`}</span>
                  </div>
                )); })()}
            </div>
          )}
          {controller !== "max_pressure" && controller !== "rl" && controller !== "external" && t.phases.length > 0 && (
            <div className="cycle-bar" aria-label="Signal plan">
              {t.phases.map((p, i) => <i key={i} className={/[Gg]/.test(p.state) ? "green" : /[yYu]/.test(p.state) ? "amber" : "red"}
                style={{ flexGrow: p.duration, outline: i === t.phase ? "2px solid var(--asphalt)" : undefined }} />)}
            </div>
          )}
          <p className="small muted">Marks show each movement's light: green bar, striped amber, short red bar.</p>
        </>
      )}
    </div>
  );
}
