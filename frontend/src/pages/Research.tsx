import { Fragment, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { when } from "../shared";
import type {
  EnvExportCfg, ExternalCfg, AgentConfig, AgentInfo, BenchConfig, BenchInfo, BenchStats, ControllerSpec, EpisodeRow, Network, Scenario,
} from "../types";
import LiveSim, { ALG_NAME } from "./LiveSim";
import ExternalPicker, { rememberController, savedControllers } from "../ExternalPicker";
import PageHead from "../PageHead";

type Tab = "overview" | "train" | "watch" | "benchmark" | "connect";
type Props = {
  networks: Network[]; scenarios: Scenario[]; onChanged: () => Promise<void> | void; fail: (e: unknown) => void;
};

const FEATURES: { id: AgentConfig["observation"]["features"][number]; name: string; short: string }[] = [
  { id: "queue", name: "Stopped vehicles on each green's approaches", short: "Queues" },
  { id: "approaching", name: "Moving vehicles approaching", short: "Approaching" },
  { id: "out_queue", name: "Stopped vehicles on exits", short: "Queues beyond" },
  { id: "phase", name: "Current green", short: "Current green" },
  { id: "elapsed", name: "Time in current green", short: "Time in green" },
];
const REWARDS: { id: AgentConfig["reward"]; name: string; text: string; short: string }[] = [
  { id: "pressure", name: "Pressure", text: "Minus the difference between vehicles waiting to enter and waiting beyond the exits (PressLight).", short: "Balance queues in and out" },
  { id: "queue", name: "Queue", text: "Minus the number of stopped vehicles on the approaches.", short: "Fewer stopped vehicles" },
  { id: "waiting", name: "Waiting time", text: "Minus the increase in total waiting time since the last decision.", short: "Less waiting time" },
];
const BASIC: { kind: ControllerSpec["kind"]; name: string }[] = [
  { kind: "fixed", name: "Fixed timing" }, { kind: "actuated", name: "Actuated" }, { kind: "max_pressure", name: "Max-Pressure" },
];
const DEMANDS = [0.6, 0.8, 1.0, 1.2, 1.5];
const ACTIVE = ["queued", "running", "evaluating", "paused", "pausing", "stopping"];

const scenLabel = (s: Scenario, networks: Network[]) => `${networks.find((n) => n.id === s.base_network)?.name ?? s.base_network}: ${s.name}`;
const fmt = (v: number | null | undefined, d = 1) => (v == null || !isFinite(v) ? "–" : v.toFixed(d));
const stateName: Record<string, string> = {
  queued: "Waiting to start", running: "Training", evaluating: "Evaluating", paused: "Paused", pausing: "Pausing after this episode", stopping: "Stopping after this episode",
  done: "Finished", stopped: "Stopped", failed: "Failed", interrupted: "Interrupted", cancelled: "Cancelled",
};

export default function Research(props: Props) {
  const [tab, setTab] = useState<Tab>(() => {
    const t = sessionStorage.getItem("junction.restab");
    return (["overview", "train", "watch", "benchmark", "connect"].includes(t ?? "") ? t : "overview") as Tab;
  });
  const [focus, setFocus] = useState<string | null>(() => sessionStorage.getItem("junction.agent"));
  const [benchFor, setBenchFor] = useState<string | null>(null);
  const [benchExt, setBenchExt] = useState<ExternalCfg | null>(null);
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [benches, setBenches] = useState<BenchInfo[] | null>(null);
  const [pending, setPending] = useState<"agent" | "bench" | null>(null);   // a "New …" button was pressed
  const load = () => {
    api.agents().then(setAgents).catch(props.fail);
    api.benchmarks().then(setBenches).catch(props.fail);
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { sessionStorage.setItem("junction.restab", tab); }, [tab]);
  useEffect(() => { focus ? sessionStorage.setItem("junction.agent", focus) : sessionStorage.removeItem("junction.agent"); }, [focus]);
  const busy = agents?.some((a) => ACTIVE.includes(a.status.state)) || benches?.some((b) => b.status.state === "running" || b.status.state === "queued");
  useEffect(() => { if (!busy) return; const t = setInterval(load, 3000); return () => clearInterval(t); }, [busy]);

  const training = (agents ?? []).filter((a) => ACTIVE.includes(a.status.state)).length;
  const benchRunning = (benches ?? []).filter((b) => b.status.state === "running" || b.status.state === "queued").length;
  const focused = agents?.find((a) => a.id === focus);
  const open = (t: Tab) => setTab(t);
  const watch = (id: string) => { setFocus(id); setTab("watch"); };
  const bench = (id: string) => { setFocus(id); setBenchFor(id); setBenchExt(null); setTab("benchmark"); };
  const steps: { id: Tab; n: number; name: string; badge?: string }[] = [
    { id: "train", n: 1, name: "Train", badge: training ? `${training} running` : agents?.length ? String(agents.length) : undefined },
    { id: "watch", n: 2, name: "Watch" },
    { id: "benchmark", n: 3, name: "Benchmark", badge: benchRunning ? `${benchRunning} running` : benches?.length ? String(benches.length) : undefined },
  ];
  const nav = (
    <nav className="flow" role="tablist" aria-label="Research">
      <button role="tab" aria-selected={tab === "overview"} className="flow-home" onClick={() => open("overview")}>Overview</button>
      <ol className="flow-steps">
        {steps.map((st) => (
          <li key={st.id}>
            <button role="tab" aria-selected={tab === st.id} onClick={() => open(st.id)}>
              <span className="flow-n" aria-hidden="true">{st.n}</span>{st.name}
              {st.badge && <span className={`flow-badge ${/running/.test(st.badge) ? "live" : ""}`}>{st.badge}</span>}
            </button>
          </li>
        ))}
      </ol>
      <button role="tab" aria-selected={tab === "connect"} className="flow-aside" onClick={() => open("connect")}>Bring your own</button>
    </nav>
  );
  const context = focused && tab !== "overview" && tab !== "connect" && (
    <div className="context-bar">
      <span>Agent <b>{focused.config.name}</b> <StateTag s={focused.status.state} />
        {ACTIVE.includes(focused.status.state) && <span className="small muted"> episode {focused.status.episodes_done} of {focused.status.episodes}</span>}</span>
      <span className="row nowrap">
        {tab !== "train" && <button className="btn quiet small" onClick={() => { setTab("train"); }}>Training details</button>}
        {tab !== "watch" && focused.has_model && <button className="btn quiet small" onClick={() => watch(focused.id)}>Watch it</button>}
        {tab !== "benchmark" && focused.has_model && <button className="btn quiet small" onClick={() => bench(focused.id)}>Benchmark it</button>}
        <button className="btn quiet small" aria-label="Clear the selected agent" onClick={() => setFocus(null)}>Clear</button>
      </span>
    </div>
  );
  if (tab === "watch")
    return <LiveSim networks={props.networks} scenarios={props.scenarios} preset={null} onChanged={props.onChanged} fail={props.fail}
      tabs={<>{nav}{context}</>} presetAgent={focus} sessionKey="junction.research.live" />;
  return (
    <main className="work page-only">
      <section className="page research">
        <PageHead title="Research" lead="Train learned signal controllers and benchmark them against standard control on identical traffic."
          actions={<>
            <button className="btn secondary small" onClick={() => { setBenchFor(null); setBenchExt(null); setTab("benchmark"); setPending("bench"); }}>New benchmark</button>
            <button className="primary small" onClick={() => { setTab("train"); setPending("agent"); }}>New agent</button>
          </>} />
        {nav}
        {context}
        {tab === "overview" && <ResearchOverview {...props} agents={agents} benches={benches} open={open}
          openAgent={(id) => { setFocus(id); setTab("train"); }} openBench={(id) => { sessionStorage.setItem("junction.bench", id); setTab("benchmark"); }} />}
        {tab === "train" && <Agents {...props} list={agents} reload={load} sel={focus} setSel={setFocus} startNew={pending === "agent"} onStarted={() => setPending(null)} onWatch={watch} onBench={bench} />}
        {tab === "benchmark" && <Benchmarks {...props} preAgent={benchFor} preExternal={benchExt} startNew={pending === "bench"}
          onStarted={() => { setPending(null); setBenchFor(null); setBenchExt(null); }} />}
        {tab === "connect" && <Connect {...props} onBench={(c) => { setBenchExt(c); setBenchFor(null); setTab("benchmark"); }} />}
      </section>
    </main>
  );
}

/* ============================== overview ============================== */

function Sparkline({ values, width = 120, height = 28 }: { values: number[]; width?: number; height?: number }) {
  const v = values.filter((x) => isFinite(x));
  if (v.length < 2) return <span className="small muted">–</span>;
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  const pts = v.map((x, i) => `${(i / (v.length - 1)) * (width - 4) + 2},${height - 3 - ((x - lo) / span) * (height - 6)}`);
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={pts.join(" ")} fill="none" stroke="var(--sign)" strokeWidth={1.6} />
      <circle cx={pts[pts.length - 1].split(",")[0]} cy={pts[pts.length - 1].split(",")[1]} r={2.2} fill="var(--sign)" />
    </svg>
  );
}

/** Travel time per episode for each agent, fetched once per change in episodes done. */
function useLogs(agents: AgentInfo[] | null) {
  const [logs, setLogs] = useState<Record<string, EpisodeRow[]>>({});
  const key = (agents ?? []).map((a) => `${a.id}:${a.status.episodes_done}`).join(",");
  useEffect(() => {
    (agents ?? []).slice(0, 20).forEach((a) => api.agentLog(a.id).then((l) => setLogs((m) => ({ ...m, [a.id]: l }))).catch(() => {}));
  }, [key]);
  return logs;
}

/** Best non-reference controller per finished benchmark, from its statistics. */
function useHeadlines(benches: BenchInfo[] | null) {
  const [heads, setHeads] = useState<Record<string, { label: string; pct: number | null; significant: boolean; ref: string; study: boolean } | null>>({});
  const key = (benches ?? []).map((b) => `${b.id}:${b.status.done}`).join(",");
  useEffect(() => {
    (benches ?? []).filter((b) => b.status.done > 0).slice(0, 10).forEach((b) => api.benchStats(b.id).then((st) => {
      const c = st.conditions.find((x) => !x.heldout && x.demand === 1) ?? st.conditions[0];
      const all = (c?.rows ?? []).filter((r) => r.controller !== st.reference && r.vs_reference?.mean_travel_time_s?.pct_change != null);
      // feature the controllers under study (trained or external); fall back to the best standard one
      const study = all.filter((r) => ["rl", "external"].includes(b.config.controllers[r.controller]?.kind));
      const rows = study.length ? study : all;
      const best = rows.sort((x, y) => (x.vs_reference!.mean_travel_time_s.pct_change! - y.vs_reference!.mean_travel_time_s.pct_change!))[0];
      setHeads((h) => ({ ...h, [b.id]: best ? { label: best.label, pct: best.vs_reference!.mean_travel_time_s.pct_change,
        significant: best.vs_reference!.mean_travel_time_s.significant, ref: st.labels[st.reference], study: study.length > 0 } : null }));
    }).catch(() => {}));
  }, [key]);
  return heads;
}

function Headline({ h }: { h?: { label: string; pct: number | null; significant: boolean; ref: string; study: boolean } | null }) {
  if (!h || h.pct == null) return <span className="small muted">–</span>;
  return <span><b>{h.label}</b> <span className={h.significant ? (h.pct < 0 ? "good-text" : "warn-text") : "muted"}>
    {h.pct > 0 ? "+" : ""}{h.pct.toFixed(1)}%</span> <span className="small muted">travel time vs {h.ref.toLowerCase()}</span></span>;
}

function ResearchOverview({ agents, benches, open, openAgent, openBench }: Props & {
  agents: AgentInfo[] | null; benches: BenchInfo[] | null; open: (t: Tab) => void; openAgent: (id: string) => void; openBench: (id: string) => void;
}) {
  const logs = useLogs(agents);
  const heads = useHeadlines(benches);
  if (!agents || !benches) return <p className="status-line" role="status"><span className="spinner" aria-hidden="true" />Loading…</p>;
  const training = agents.filter((a) => ACTIVE.includes(a.status.state));
  const trained = agents.filter((a) => a.has_model);
  const bestHead = Object.values(heads).filter((h): h is NonNullable<typeof h> => !!h && h.study && h.pct != null && h.significant)
    .sort((x, y) => x.pct! - y.pct!)[0];
  return (
    <>
      <div className="stats">
        <button className="stat" onClick={() => open("train")}><span className="stat-num">{agents.length}{training.length > 0 && <small>{training.length} training</small>}</span><span className="stat-name">Agents</span></button>
        <button className="stat" onClick={() => open("train")}><span className="stat-num">{trained.length}</span><span className="stat-name">Trained models</span></button>
        <button className="stat" onClick={() => open("benchmark")}><span className="stat-num">{benches.length}</span><span className="stat-name">Benchmarks</span></button>
        <div className="stat"><span className="stat-num">{bestHead ? `${bestHead.pct! > 0 ? "+" : ""}${bestHead.pct!.toFixed(1)}%` : "–"}</span>
          <span className="stat-name">Best result under study</span><span className="stat-note">{bestHead ? `${bestHead.label}, travel time vs ${bestHead.ref.toLowerCase()}` : "Benchmark a trained agent to see one"}</span></div>
      </div>
      <div className="grid-2">
        <div className="card">
          <div className="card-head"><h2>Agents</h2><button className="btn quiet small" onClick={() => open("train")}>All agents</button></div>
          {agents.length === 0 ? (
            <div className="empty">No agents yet. Train one on any scenario; it takes seconds on the practice grid.<br />
              <button className="primary small" onClick={() => open("train")}>Train an agent</button></div>
          ) : (
            <ul className="agent-rows">
              {agents.slice(0, 6).map((a) => {
                const l = logs[a.id] ?? [];
                const tt = l.map((r) => r.eval_travel_time_s ?? r.travel_time_s ?? NaN);
                const live = ACTIVE.includes(a.status.state);
                return (
                  <li key={a.id}>
                    <button className="agent-row" onClick={() => openAgent(a.id)}>
                      <span className="agent-row-name"><b>{a.config.name}</b><span className="small muted">{ALG_NAME[a.config.algorithm]}, {a.status.agents ?? "?"} signals</span></span>
                      <span className="cell-progress">
                        <span className="small">{live ? <><StateTag s={a.status.state} /> {a.status.episodes_done}/{a.status.episodes}</> : <StateTag s={a.status.state} />}</span>
                        <span className="progress thin"><i style={{ width: `${(100 * a.status.episodes_done) / (a.status.episodes || 1)}%` }} /></span>
                      </span>
                      <span className="agent-row-trend"><Sparkline values={tt} />{tt.some(isFinite) && <span className="small muted">{fmt(tt.filter(isFinite).slice(-1)[0])} s</span>}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Benchmarks</h2><button className="btn quiet small" onClick={() => open("benchmark")}>All benchmarks</button></div>
            {benches.length === 0 ? <div className="empty">No benchmarks yet.<br /><button className="btn secondary small" onClick={() => open("benchmark")}>Set one up</button></div> : (
              <ul className="bench-rows">
                {benches.slice(0, 4).map((b) => (
                  <li key={b.id}><button className="bench-row" onClick={() => openBench(b.id)}>
                    <span><b>{b.config.name}</b> <StateTag s={b.status.state} /></span>
                    {b.status.state === "running" || b.status.state === "queued"
                      ? <span className="progress thin"><i style={{ width: `${(100 * b.status.done) / (b.status.total || 1)}%` }} /></span>
                      : <Headline h={heads[b.id]} />}
                  </button></li>
                ))}
              </ul>
            )}
          </div>
          <div className="card">
            <h2>Workflow</h2>
            <ol className="checklist">
              <li className={trained.length ? "done" : ""}><span className="tick">{trained.length ? "✓" : ""}</span><span><span className="step-name">Train an agent</span><br /><span className="small muted">On any scenario, with evaluation runs</span></span><button className="btn quiet small" onClick={() => open("train")}>Train</button></li>
              <li className={trained.length ? "done" : ""}><span className="tick">{trained.length ? "✓" : ""}</span><span><span className="step-name">Watch its decisions</span><br /><span className="small muted">Live on the map, signal by signal</span></span><button className="btn quiet small" onClick={() => open("watch")}>Watch</button></li>
              <li className={benches.some((b) => b.status.state === "done") ? "done" : ""}><span className="tick">{benches.some((b) => b.status.state === "done") ? "✓" : ""}</span><span><span className="step-name">Benchmark it</span><br /><span className="small muted">Against fixed, actuated and max-pressure</span></span><button className="btn quiet small" onClick={() => open("benchmark")}>Benchmark</button></li>
            </ol>
          </div>
        </div>
      </div>
    </>
  );
}

/* ============================== agents ============================== */

function Agents({ networks, scenarios, fail, list, reload, sel, setSel, startNew, onStarted, onWatch, onBench }: Props & {
  list: AgentInfo[] | null; reload: () => void; sel: string | null; setSel: (id: string | null) => void; startNew: boolean; onStarted: () => void;
  onWatch: (id: string) => void; onBench: (id: string) => void;
}) {
  const [draft, setDraft] = useState<AgentConfig | null>(null);
  const logs = useLogs(list);
  const newAgent = async (base?: AgentInfo) => {
    try {
      if (base) { setDraft({ ...structuredClone(base.config), name: `${base.config.name} variant`, parent_id: base.id, note: "" }); }
      else {
        const d = await api.researchDefaults();
        const s0 = scenarios.find((s) => !s.baseline) ?? scenarios[0];
        setDraft({ ...d.agent, scenario_id: s0?.id ?? "", name: "Agent" });
      }
      setSel(null);
    } catch (e) { fail(e); }
  };
  useEffect(() => { if (startNew) { onStarted(); newAgent(); } }, [startNew]);

  if (draft) return <AgentForm draft={draft} setDraft={setDraft} scenarios={scenarios} networks={networks} parent={list?.find((a) => a.id === draft.parent_id)} fail={fail}
    onCancel={() => setDraft(null)} onCreated={async (a) => { setDraft(null); await reload(); setSel(a.id); }} />;
  const cur = list?.find((a) => a.id === sel);
  if (cur) return <AgentDetail a={cur} scenarios={scenarios} networks={networks} fail={fail} onBack={() => setSel(null)} onChanged={reload}
    onVariant={() => newAgent(cur)} onWatch={() => onWatch(cur.id)} onBench={() => onBench(cur.id)} />;

  return (
    <>
      {!list && <p className="status-line" role="status"><span className="spinner" aria-hidden="true" />Loading agents…</p>}
      {list && !list.length && <div className="card"><div className="empty">No agents yet. Choose a scenario and a method; a quick test trains in seconds on the practice grid.<br />
        <button className="primary small" onClick={() => newAgent()}>New agent</button></div></div>}
      {list && list.length > 0 && (
        <table className="library">
          <thead><tr><th>Name</th><th>Method</th><th>Scenario</th><th>Progress</th><th>Travel time per episode</th><th>Created</th></tr></thead>
          <tbody>
            {list.map((a) => {
              const tt = (logs[a.id] ?? []).map((r) => r.eval_travel_time_s ?? r.travel_time_s ?? NaN);
              return (
                <tr key={a.id} tabIndex={0} onClick={() => setSel(a.id)} onKeyDown={(e) => e.key === "Enter" && setSel(a.id)}>
                  <td><b>{a.config.name}</b>{a.config.parent_id && <span className="chip">variant</span>}</td>
                  <td>{ALG_NAME[a.config.algorithm]}, {a.config.sharing === "shared" ? "shared" : "per signal"}</td>
                  <td>{(() => { const s = scenarios.find((x) => x.id === a.config.scenario_id); return s ? scenLabel(s, networks) : a.manifest.scenario_name ?? a.config.scenario_id; })()}</td>
                  <td className="cell-progress"><span className="small"><StateTag s={a.status.state} /> {a.status.episodes_done}/{a.status.episodes}</span>
                    <span className="progress thin"><i style={{ width: `${(100 * a.status.episodes_done) / (a.status.episodes || 1)}%` }} /></span></td>
                  <td><span className="row nowrap"><Sparkline values={tt} />{tt.some(isFinite) && <span className="small">{fmt(tt.filter(isFinite).slice(-1)[0])} s</span>}</span></td>
                  <td>{when(a.status.created)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

function StateTag({ s }: { s: string }) {
  const cls = ["failed", "interrupted", "cancelled"].includes(s) ? "warn" : ACTIVE.includes(s) ? "" : "done";
  return <span className={`chip ${cls}`}>{stateName[s] ?? s}</span>;
}

function Num({ label, v, set, min, max, step = 1, hint }: { label: string; v: number; set: (n: number) => void; min: number; max: number; step?: number; hint?: string }) {
  return (
    <label className="field">
      <span className="label">{label}{hint && <span className="small muted"> {hint}</span>}</span>
      <input type="number" value={v} min={min} max={max} step={step} onChange={(e) => set(Number(e.target.value))} />
    </label>
  );
}

const PRESETS: { id: string; name: string; note: string; t: Partial<AgentConfig["training"]>; h: Partial<AgentConfig["hyper"]> }[] = [
  { id: "quick", name: "Quick test", note: "10 short episodes", t: { episodes: 10, episode_min: 10, eval_every: 0, early_stop_patience: 0, checkpoint_every: 5 }, h: { lr_schedule: "constant" } },
  { id: "standard", name: "Standard", note: "30 episodes, evaluated every 5", t: { episodes: 30, episode_min: 30, eval_every: 5, eval_episodes: 1, early_stop_patience: 0, checkpoint_every: 5 }, h: { lr_schedule: "constant" } },
  { id: "thorough", name: "Thorough", note: "100 episodes, early stopping", t: { episodes: 100, episode_min: 30, eval_every: 5, eval_episodes: 2, early_stop_patience: 6, checkpoint_every: 10 }, h: { lr_schedule: "linear" } },
];
const ALG_TEXT: Record<string, string> = {
  dqn: "Learns the value of each green from replayed experience.",
  double_dqn: "DQN with less over-estimation; a good default.",
  ppo: "Learns a probability for each green; stable, needs more episodes.",
};

function AgentForm({ draft, setDraft, scenarios, networks, parent, fail, onCancel, onCreated }: {
  draft: AgentConfig; setDraft: (d: AgentConfig) => void; scenarios: Scenario[]; networks: Network[]; parent?: AgentInfo; fail: (e: unknown) => void;
  onCancel: () => void; onCreated: (a: AgentInfo) => void;
}) {
  const [busy, setBusy] = useState(false);
  const d = draft;
  const up = <K extends keyof AgentConfig>(k: K, v: Partial<AgentConfig[K]> | AgentConfig[K]) =>
    setDraft({ ...d, [k]: typeof v === "object" && !Array.isArray(v) ? { ...(d[k] as object), ...v } : v });
  const isPPO = d.algorithm === "ppo";
  const changed = parent ? diffCfg(parent.config, d) : [];
  const preset = PRESETS.find((p) => Object.entries(p.t).every(([k, v]) => (d.training as any)[k] === v) && Object.entries(p.h).every(([k, v]) => (d.hyper as any)[k] === v));
  const submit = async () => {
    setBusy(true);
    try { onCreated(await api.trainAgent(d)); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const feats = d.observation.features;
  const tr = d.training;
  const evals = tr.eval_every ? Math.ceil(tr.episodes / tr.eval_every) * tr.eval_episodes : 0;
  const simHours = ((tr.episodes + evals) * tr.episode_min) / 60;
  const scen = scenarios.find((x) => x.id === d.scenario_id);
  const ok = !!feats.length && !!d.scenario_id && !!tr.demand_scales.length;
  return (
    <div className="agent-form">
      <div className="stack">
        {parent && <p className="banner-inline">Variant of <b>{parent.config.name}</b>. {changed.length ? `Changed: ${changed.join(", ")}.` : "Change one or two settings, then benchmark both."}</p>}
        <div className="card">
          <h2>Basics</h2>
          <div className="form-2">
            <label className="field block"><span className="label">Name</span>
              <input className="text" value={d.name} onChange={(e) => up("name", e.target.value)} /></label>
            <label className="field block"><span className="label">Train on</span>
              <select value={d.scenario_id} onChange={(e) => up("scenario_id", e.target.value)}>
                {scenarios.map((s) => <option key={s.id} value={s.id}>{scenLabel(s, networks)}</option>)}
              </select></label>
          </div>
          <div className="form-2">
            <fieldset className="field block"><legend className="label">Method</legend>
              <div className="seg wide" role="radiogroup">
                {(["dqn", "double_dqn", "ppo"] as const).map((a) => (
                  <button key={a} role="radio" aria-checked={d.algorithm === a} onClick={() => up("algorithm", a)}>{ALG_NAME[a]}</button>))}
              </div>
              <p className="field-hint">{ALG_TEXT[d.algorithm]}</p>
            </fieldset>
            <fieldset className="field block"><legend className="label">Signals learn</legend>
              <div className="seg wide" role="radiogroup">
                <button role="radio" aria-checked={d.sharing === "shared"} onClick={() => up("sharing", "shared")}>Together</button>
                <button role="radio" aria-checked={d.sharing === "independent"} onClick={() => up("sharing", "independent")}>Separately</button>
              </div>
              <p className="field-hint">{d.sharing === "shared" ? "One shared network; also runs on other networks." : "One network per signal; this network only."}</p>
            </fieldset>
          </div>
        </div>

        <div className="card">
          <h2>What the agent sees and does</h2>
          <div className="form-2">
            <div>
              <Num label="Looks this far back" hint="m" v={d.observation.reach_m} min={10} max={300} step={10} set={(n) => up("observation", { reach_m: n })} />
              <div className="chip-checks" role="group" aria-label="Measurements">
                {FEATURES.map((f) => (
                  <label key={f.id} className={`chip-check ${feats.includes(f.id) ? "on" : ""}`}>
                    <input type="checkbox" checked={feats.includes(f.id)}
                      onChange={(e) => up("observation", { features: e.target.checked ? [...feats, f.id] : feats.filter((x) => x !== f.id) })} />
                    {f.short}
                  </label>
                ))}
              </div>
              {!feats.length && <p className="small warn-text">Choose at least one.</p>}
            </div>
            <div>
              <Num label="Decides every" hint="s" v={d.action.delta_t} min={2} max={30} set={(n) => up("action", { delta_t: n })} />
              <Num label="Minimum green" hint="s" v={d.action.min_green} min={5} max={60} set={(n) => up("action", { min_green: n })} />
              <Num label="Amber" hint="s" v={d.action.amber} min={2} max={6} set={(n) => up("action", { amber: n })} />
              <Num label="All-red" hint="s" v={d.action.all_red} min={0} max={5} set={(n) => up("action", { all_red: n })} />
            </div>
          </div>
          <fieldset className="field block"><legend className="label">Reward</legend>
            <div className="choice-cards" role="radiogroup">
              {REWARDS.map((r) => (
                <button key={r.id} role="radio" aria-checked={d.reward === r.id} className="choice-card" onClick={() => up("reward", r.id)}>
                  <b>{r.name}</b><span>{r.short}</span>
                </button>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="card">
          <h2>Training and evaluation</h2>
          <div className="form-2">
            <div>
              <Num label="Episodes" v={tr.episodes} min={1} max={2000} set={(n) => up("training", { episodes: n })} />
              <Num label="Traffic per episode" hint="min" v={tr.episode_min} min={5} max={60} set={(n) => up("training", { episode_min: n })} />
              <fieldset className="field block"><legend className="label">Demand levels</legend>
                <DemandChips v={tr.demand_scales} set={(v) => up("training", { demand_scales: v })} /></fieldset>
              <Num label="Seed" v={tr.seed} min={1} max={1000000} set={(n) => up("training", { seed: n })} />
            </div>
            <div>
              <Num label="Evaluate every" hint="episodes, 0 = off" v={tr.eval_every} min={0} max={100} set={(n) => up("training", { eval_every: n })} />
              <Num label="Evaluation runs" v={tr.eval_episodes} min={1} max={5} set={(n) => up("training", { eval_episodes: n })} />
              <Num label="Stop after no gain in" hint="evaluations, 0 = never" v={tr.early_stop_patience} min={0} max={50} set={(n) => up("training", { early_stop_patience: n })} />
              <Num label="Checkpoint every" hint="episodes" v={tr.checkpoint_every} min={1} max={500} set={(n) => up("training", { checkpoint_every: n })} />
            </div>
          </div>
          <p className="field-hint">Evaluation runs the agent without exploring on the same unseen traffic each time; the best model is chosen on it.</p>
        </div>

        <div className="card">
          <h2>Learning</h2>
          <div className="form-2">
            <div>
              <Num label="Learning rate" v={d.hyper.lr} min={0.00001} max={0.1} step={0.0001} set={(n) => up("hyper", { lr: n })} />
              <fieldset className="field block"><legend className="label">Learning rate over time</legend>
                <div className="seg wide" role="radiogroup">
                  <button role="radio" aria-checked={d.hyper.lr_schedule === "constant"} onClick={() => up("hyper", { lr_schedule: "constant" })}>Constant</button>
                  <button role="radio" aria-checked={d.hyper.lr_schedule === "linear"} onClick={() => up("hyper", { lr_schedule: "linear" })}>Falls to 10%</button>
                </div></fieldset>
            </div>
            <div>
              <Num label="Discount factor" v={d.hyper.gamma} min={0} max={0.999} step={0.01} set={(n) => up("hyper", { gamma: n })} />
              <label className="field"><span className="label">Hidden layers</span>
                <input className="text short" value={d.hyper.hidden.join(", ")}
                  onChange={(e) => up("hyper", { hidden: e.target.value.split(",").map((x) => parseInt(x)).filter((x) => x > 0) })} /></label>
            </div>
          </div>
          <details className="advanced">
            <summary>{isPPO ? "PPO settings" : "DQN settings"}</summary>
            <div className="form-2">
              {!isPPO ? (<>
                <div>
                  <Num label="Batch size" v={d.hyper.batch} min={8} max={1024} set={(n) => up("hyper", { batch: n })} />
                  <Num label="Replay buffer" v={d.hyper.buffer} min={1000} max={1000000} step={1000} set={(n) => up("hyper", { buffer: n })} />
                  <Num label="Learning starts after" hint="steps" v={d.hyper.learning_starts} min={0} max={100000} set={(n) => up("hyper", { learning_starts: n })} />
                  <Num label="Target update" hint="steps" v={d.hyper.target_update} min={10} max={100000} set={(n) => up("hyper", { target_update: n })} />
                </div>
                <div>
                  <Num label="Exploration start" v={d.hyper.eps_start} min={0} max={1} step={0.05} set={(n) => up("hyper", { eps_start: n })} />
                  <Num label="Exploration end" v={d.hyper.eps_end} min={0} max={1} step={0.01} set={(n) => up("hyper", { eps_end: n })} />
                  <Num label="Exploration falls over" hint="share" v={d.hyper.eps_decay_frac} min={0.05} max={1} step={0.05} set={(n) => up("hyper", { eps_decay_frac: n })} />
                </div>
              </>) : (<>
                <div>
                  <Num label="Clip range" v={d.hyper.clip} min={0.05} max={0.5} step={0.05} set={(n) => up("hyper", { clip: n })} />
                  <Num label="Epochs per update" v={d.hyper.epochs} min={1} max={20} set={(n) => up("hyper", { epochs: n })} />
                  <Num label="Minibatch" v={d.hyper.minibatch} min={16} max={4096} set={(n) => up("hyper", { minibatch: n })} />
                </div>
                <div>
                  <Num label="GAE lambda" v={d.hyper.gae_lambda} min={0} max={1} step={0.01} set={(n) => up("hyper", { gae_lambda: n })} />
                  <Num label="Entropy weight" v={d.hyper.ent_coef} min={0} max={0.2} step={0.005} set={(n) => up("hyper", { ent_coef: n })} />
                  <Num label="Value loss weight" v={d.hyper.vf_coef} min={0} max={2} step={0.1} set={(n) => up("hyper", { vf_coef: n })} />
                </div>
              </>)}
            </div>
          </details>
          <label className="field block"><span className="label">Note</span>
            <textarea className="text" rows={2} value={d.note ?? ""} placeholder="What this run is testing" onChange={(e) => up("note", e.target.value)} /></label>
        </div>
      </div>

      <aside className="form-summary card">
        <h2>{parent ? "New variant" : "New agent"}</h2>
        <fieldset className="field block"><legend className="label">Preset</legend>
          <div className="preset-list" role="radiogroup">
            {PRESETS.map((p) => (
              <button key={p.id} role="radio" aria-checked={preset?.id === p.id} className="preset"
                onClick={() => setDraft({ ...d, training: { ...d.training, ...p.t }, hyper: { ...d.hyper, ...p.h } })}>
                <b>{p.name}</b><span>{p.note}</span>
              </button>
            ))}
          </div>
          {!preset && <p className="field-hint">Custom settings.</p>}
        </fieldset>
        <dl className="facts">
          <dt>Scenario</dt><dd>{scen ? scenLabel(scen, networks) : "–"}</dd>
          <dt>Method</dt><dd>{ALG_NAME[d.algorithm]}, signals learn {d.sharing === "shared" ? "together" : "separately"}</dd>
          <dt>Reward</dt><dd>{REWARDS.find((r) => r.id === d.reward)?.name}</dd>
          <dt>Training</dt><dd>{tr.episodes} × {tr.episode_min} min{tr.demand_scales.length > 1 ? `, ${tr.demand_scales.length} demand levels` : ""}</dd>
          <dt>Evaluation</dt><dd>{tr.eval_every ? `every ${tr.eval_every} episodes${tr.early_stop_patience ? `, stops after ${tr.early_stop_patience} without gain` : ""}` : "off"}</dd>
          <dt>Simulated</dt><dd>{simHours < 1 ? `${Math.round(simHours * 60)} min` : `${simHours.toFixed(1)} h`} of traffic</dd>
        </dl>
        <button className="primary wide" disabled={busy || !ok} onClick={submit}>{busy ? "Preparing the network…" : "Start training"}</button>
        <button className="btn quiet small" onClick={onCancel}>Cancel</button>
      </aside>
    </div>
  );
}

function diffCfg(a: AgentConfig, b: AgentConfig): string[] {
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, path: string) => {
    if (path === "name" || path === "note" || path === "parent_id") return;
    if (x && y && typeof x === "object" && !Array.isArray(x)) { for (const k of Object.keys(x as object)) walk((x as any)[k], (y as any)[k], path ? `${path}.${k}` : k); return; }
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push(path.replace(/^(hyper|training|action|observation)\./, ""));
  };
  walk(a, b, "");
  return out;
}

function DemandChips({ v, set }: { v: number[]; set: (v: number[]) => void }) {
  return (
    <div className="chips-row">
      {DEMANDS.map((x) => (
        <button key={x} className="pill" aria-pressed={v.includes(x)}
          onClick={() => set(v.includes(x) ? v.filter((y) => y !== x) : [...v, x].sort((p, q) => p - q))}>{Math.round(x * 100)}%</button>
      ))}
    </div>
  );
}

function AgentDetail({ a, scenarios, networks, fail, onBack, onChanged, onVariant, onWatch, onBench }: {
  a: AgentInfo; scenarios: Scenario[]; networks: Network[]; fail: (e: unknown) => void; onBack: () => void; onChanged: () => void;
  onVariant: () => void; onWatch: () => void; onBench: () => void;
}) {
  const [log, setLog] = useState<EpisodeRow[]>([]);
  const st = a.status;
  const active = ACTIVE.includes(st.state);
  useEffect(() => {
    let live = true;
    const get = () => api.agentLog(a.id).then((l) => live && setLog(l)).catch(() => {});
    get();
    if (!active) return () => { live = false; };
    const t = setInterval(get, 3000);
    return () => { live = false; clearInterval(t); };
  }, [a.id, active, st.episodes_done]);
  const ctl = (x: "pause" | "resume" | "stop") => api.agentControl(a.id, x).then(onChanged).catch(fail);
  const del = async () => { if (!confirm(`Delete ${a.config.name} and its models? This cannot be undone.`)) return; try { await api.deleteAgent(a.id); onBack(); onChanged(); } catch (e) { fail(e); } };
  const c = a.config;
  const pct = st.episodes ? (100 * st.episodes_done) / st.episodes : 0;
  const tts = log.map((r) => r.travel_time_s).filter((x): x is number => x != null);
  const avg = (v: number[]) => (v.length ? v.reduce((x, y) => x + y, 0) / v.length : null);
  const firstTT = avg(tts.slice(0, 5)), lastTT = tts.length > 5 ? avg(tts.slice(-5)) : null;
  const evalPts = log.filter((r) => r.eval_travel_time_s != null).map((r) => [r.episode, r.eval_travel_time_s!] as [number, number]);
  return (
    <div className="agent-detail">
      <div className="detail-head">
        <div>
          <button className="btn quiet small" onClick={onBack}>← All agents</button>
          <h2 className="detail-title">{c.name} <StateTag s={st.state} /></h2>
          <p className="small muted">{ALG_NAME[c.algorithm]}, {st.agents ?? "?"} signals learning {c.sharing === "shared" ? "together" : "separately"}, on {(() => { const s = scenarios.find((x) => x.id === c.scenario_id); return s ? scenLabel(s, networks) : a.manifest.scenario_name; })()}.{c.note ? ` ${c.note}` : ""}</p>
        </div>
        <div className="page-actions">
          {st.state === "running" && <button className="btn secondary small" onClick={() => ctl("pause")}>Pause</button>}
          {st.state === "paused" && <button className="primary small" onClick={() => ctl("resume")}>Resume</button>}
          {active && <button className="btn secondary small" onClick={() => ctl("stop")}>Stop</button>}
          {a.has_model && <button className="btn secondary small" onClick={onWatch}>Watch on map</button>}
          {a.has_model && <button className="primary small" onClick={onBench}>Benchmark</button>}
          <button className="btn secondary small" onClick={onVariant}>Create variant</button>
          {!active && <button className="btn danger small" onClick={del}>Delete</button>}
        </div>
      </div>
      {st.error && <p className="error-box">{st.error}</p>}
      {st.note && <p className="banner-inline">{st.note}</p>}

      <div className="stats">
        <div className="stat"><span className="stat-num">{st.episodes_done}<small>of {st.episodes}</small></span><span className="stat-name">Episodes</span>
          <span className="progress thin" role="progressbar" aria-valuenow={st.episodes_done} aria-valuemax={st.episodes}><i style={{ width: `${pct}%` }} /></span>
          <span className="stat-note">{st.state === "evaluating" ? "Evaluating now" : st.state === "running" && st.episode != null ? `Episode ${st.episode + 1} running` : stateName[st.state]}</span></div>
        <div className="stat"><span className="stat-num">{fmt(firstTT)}<small>s</small></span><span className="stat-name">Travel time, first 5 episodes</span></div>
        <div className="stat"><span className="stat-num">{fmt(lastTT)}<small>s</small></span><span className="stat-name">Travel time, last 5 episodes</span>
          <span className="stat-note">{firstTT && lastTT ? `${lastTT < firstTT ? "" : "+"}${(100 * (lastTT - firstTT) / firstTT).toFixed(1)}% while training` : ""}</span></div>
        <div className="stat"><span className="stat-num">{st.best_eval_travel_time_s != null ? <>{fmt(st.best_eval_travel_time_s)}<small>s</small></> : st.best_episode ?? "–"}</span>
          <span className="stat-name">{st.best_eval_travel_time_s != null ? "Best evaluation" : "Best episode"}</span>
          <span className="stat-note">{st.best_episode ? `Episode ${st.best_episode}; saved as the best model` : "Not yet"}</span></div>
      </div>

      <div className="chart-grid">
        <div className="card"><h2>Average travel time</h2>
          <LineChart series={[{ name: "Episode", pts: log.filter((r) => r.travel_time_s != null).map((r) => [r.episode, r.travel_time_s!]) },
            { name: "Average of last 5", pts: smooth(log.filter((r) => r.travel_time_s != null).map((r) => [r.episode, r.travel_time_s!])) },
            ...(evalPts.length ? [{ name: "Evaluation", pts: evalPts }] : [])]} xLabel="Episode" yLabel="s" /></div>
        <div className="card"><h2>Reward per decision</h2>
          <LineChart series={[{ name: "Episode", pts: log.map((r) => [r.episode, r.reward]) }, { name: "Average of last 5", pts: smooth(log.map((r) => [r.episode, r.reward])) }]} xLabel="Episode" yLabel="reward" /></div>
        <div className="card"><h2>{c.algorithm === "ppo" ? "Policy entropy" : "Exploration"} and loss</h2>
          <LineChart series={[{ name: c.algorithm === "ppo" ? "Entropy" : "Exploration rate", pts: log.map((r) => [r.episode, (c.algorithm === "ppo" ? r.entropy : r.epsilon) ?? NaN]) },
            { name: "Loss", pts: log.filter((r) => r.loss != null).map((r) => [r.episode, r.loss!]), right: true }]} xLabel="Episode" yLabel="" /></div>
      </div>

      <div className="card">
        <h2>Episode log</h2>
        {!log.length ? <p className="small muted">The first episode is still running.</p> : (
          <div className="table-scroll"><table className="library compact">
            <thead><tr><th className="n-col">Episode</th><th className="n-col">Demand</th><th className="n-col">Seed</th><th className="n-col">Reward</th><th className="n-col">Travel time (s)</th><th className="n-col">Evaluation (s)</th>
              <th className="n-col">Arrived</th><th className="n-col">Stopped</th><th className="n-col">Gridlock</th><th className="n-col">Loss</th><th className="n-col">Time (s)</th></tr></thead>
            <tbody>{[...log].reverse().map((r) => (
              <tr key={r.episode}><td className="n-col">{r.episode}{r.episode === st.best_episode && <span className="chip">best</span>}</td>
                <td className="n-col">{Math.round(r.demand_scale * 100)}%</td><td className="n-col">{r.seed}</td><td className="n-col">{fmt(r.reward, 3)}</td>
                <td className="n-col">{fmt(r.travel_time_s)}</td><td className="n-col">{fmt(r.eval_travel_time_s)}</td><td className="n-col">{r.arrived}</td><td className="n-col">{fmt(r.mean_stopped)}</td>
                <td className="n-col">{r.teleports}</td><td className="n-col">{fmt(r.loss, 4)}</td><td className="n-col">{fmt(r.wall_s, 0)}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </div>

      <div className="form-cols">
        <div className="card">
          <h2>Models and checkpoints</h2>
          {!a.has_model && !a.checkpoints.length && <p className="small muted">Models appear after the first episode.</p>}
          <ul className="plain-list">
            {a.has_model && <li><a href={api.agentModelUrl(a.id, "final")}>Final model</a> <span className="small muted">latest weights</span></li>}
            {a.has_best && <li><a href={api.agentModelUrl(a.id, "best")}>Best episode</a> <span className="small muted">episode {st.best_episode}</span></li>}
            {a.checkpoints.map((k) => <li key={k}><a href={api.agentModelUrl(a.id, k)}>Episode {Number(k.slice(3, 7))}</a></li>)}
          </ul>
          <p className="row"><a className="btn secondary small" href={api.agentExportUrl(a.id)}>Download everything (models, config, log)</a></p>
        </div>
        <div className="card">
          <h2>Reproducibility</h2>
          <dl className="facts">
            <dt>Network</dt><dd>{a.manifest.network} <span className="small muted">sha {a.manifest.net_sha.slice(0, 10)}</span></dd>
            <dt>Training seed</dt><dd>{c.training.seed}; episode n uses seed {c.training.seed * 1000} + n</dd>
            <dt>Software</dt><dd>Junction {a.manifest.versions.app}, SUMO {a.manifest.versions.sumo}</dd>
            <dt>Numerics</dt><dd>{a.manifest.numerics}</dd>
            {c.parent_id && <><dt>Variant of</dt><dd>{c.parent_id}</dd></>}
          </dl>
          <details><summary>Full configuration</summary><pre className="config">{JSON.stringify(c, null, 2)}</pre></details>
        </div>
      </div>
    </div>
  );
}

function smooth(pts: [number, number][], k = 5): [number, number][] {
  return pts.map(([x], i) => { const w = pts.slice(Math.max(0, i - k + 1), i + 1).map((p) => p[1]).filter(isFinite); return [x, w.reduce((s, v) => s + v, 0) / (w.length || 1)]; });
}

/* ---------- small SVG charts ---------- */

type Series = { name: string; pts: [number, number][]; right?: boolean };
const SERIES_COLORS = ["var(--asphalt-2)", "var(--sign)", "#b86b00", "#6b4fa8", "#2f7d8c", "#a33b3b"];

function niceTicks(lo: number, hi: number, n = 4) {
  if (!isFinite(lo) || !isFinite(hi)) return [];
  if (lo === hi) { lo -= 1; hi += 1; }
  const step0 = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(step0)), r = step0 / mag;
  const step = (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * mag;
  const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toPrecision(10));
  return out;
}
const tickFmt = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : Math.abs(v) < 0.01 && v !== 0 ? v.toExponential(0) : `${+v.toPrecision(3)}`);

function LineChart({ series, xLabel, yLabel, xTicks }: { series: Series[]; xLabel: string; yLabel: string; xTicks?: { v: number; label: string }[] }) {
  const W = 380, H = 200, L = 44, R = series.some((s) => s.right) ? 44 : 12, T = 20, B = 32;
  const all = series.flatMap((s) => s.pts).filter((p) => isFinite(p[1]));
  if (all.length < 1) return <p className="small muted chart-empty">No data yet.</p>;
  const xs = all.map((p) => p[0]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs) === x0 ? x0 + 1 : Math.max(...xs);
  const range = (ss: Series[]) => { const v = ss.flatMap((s) => s.pts.map((p) => p[1])).filter(isFinite); if (!v.length) return [0, 1]; let lo = Math.min(...v), hi = Math.max(...v); const pad = (hi - lo || Math.abs(hi) || 1) * 0.08; return [lo - pad, hi + pad]; };
  const [ly0, ly1] = range(series.filter((s) => !s.right)), [ry0, ry1] = range(series.filter((s) => s.right));
  const X = (x: number) => L + ((x - x0) / (x1 - x0)) * (W - L - R);
  const Y = (y: number, right?: boolean) => { const [a, b] = right ? [ry0, ry1] : [ly0, ly1]; return T + (1 - (y - a) / (b - a)) * (H - T - B); };
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={series.map((s) => s.name).join(", ")}>
        {niceTicks(ly0, ly1).map((v) => <g key={v}><line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} className="grid" /><text x={L - 6} y={Y(v) + 4} textAnchor="end">{tickFmt(v)}</text></g>)}
        {series.some((s) => s.right) && niceTicks(ry0, ry1).map((v) => <text key={v} x={W - R + 6} y={Y(v, true) + 4}>{tickFmt(v)}</text>)}
        {(xTicks ?? niceTicks(x0, x1, 5).filter((v) => Number.isInteger(v)).map((v) => ({ v, label: String(v) }))).map((t) =>
          <text key={t.v} x={X(t.v)} y={H - B + 16} textAnchor="middle">{t.label}</text>)}
        <text x={(L + W - R) / 2} y={H - 2} textAnchor="middle" className="axis-label">{xLabel}</text>
        {yLabel && <text x={L - 6} y={8} className="axis-label" textAnchor="end">{yLabel}</text>}
        {series.map((s, i) => {
          const p = s.pts.filter((q) => isFinite(q[1]));
          const col = SERIES_COLORS[i % SERIES_COLORS.length];
          return <g key={s.name}>
            {p.length > 1 && <polyline fill="none" stroke={col} strokeWidth={i === 0 && series.length > 1 && s.name === "Episode" ? 1 : 2}
              strokeOpacity={s.name === "Episode" ? 0.55 : 1} points={p.map((q) => `${X(q[0])},${Y(q[1], s.right)}`).join(" ")} />}
            {p.length <= 12 && p.map((q, k) => <circle key={k} cx={X(q[0])} cy={Y(q[1], s.right)} r={2.5} fill={col} />)}
          </g>;
        })}
      </svg>
      {series.length > 1 && <figcaption className="legend-row">{series.map((s, i) =>
        <span key={s.name}><i style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />{s.name}{s.right ? " (right axis)" : ""}</span>)}</figcaption>}
    </figure>
  );
}

function BarChart({ rows, unit }: { rows: { label: string; mean: number | null; lo: number | null; hi: number | null }[]; unit: string }) {
  const ok = rows.filter((r) => r.mean != null);
  if (!ok.length) return <p className="small muted">No data.</p>;
  const max = Math.max(...ok.map((r) => r.hi ?? r.mean!)) * 1.08 || 1;
  const W = 420, rowH = 26, L = 130, R = 60, H = rows.length * rowH + 8;
  const X = (v: number) => L + (Math.max(0, v) / max) * (W - L - R);
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Mean with 95% confidence interval">
        {rows.map((r, i) => {
          const y = 4 + i * rowH;
          return <g key={r.label}>
            <text x={L - 8} y={y + 15} textAnchor="end">{r.label.length > 18 ? r.label.slice(0, 17) + "…" : r.label}</text>
            {r.mean != null && <>
              <rect x={L} y={y + 4} width={X(r.mean) - L} height={rowH - 10} fill={SERIES_COLORS[i % SERIES_COLORS.length]} opacity={0.85} rx={2} />
              {r.lo != null && r.hi != null && <g stroke="var(--asphalt)" strokeWidth={1.3}>
                <line x1={X(r.lo)} x2={X(r.hi)} y1={y + rowH / 2 - 1} y2={y + rowH / 2 - 1} />
                <line x1={X(r.lo)} x2={X(r.lo)} y1={y + 6} y2={y + rowH - 8} /><line x1={X(r.hi)} x2={X(r.hi)} y1={y + 6} y2={y + rowH - 8} /></g>}
              <text x={Math.max(X(r.hi ?? r.mean), X(r.mean)) + 6} y={y + 15}>{fmt(r.mean)} {unit}</text>
            </>}
          </g>;
        })}
      </svg>
      <figcaption className="small muted">Bars show the mean over seeds; whiskers the 95% confidence interval.</figcaption>
    </figure>
  );
}

/* ============================== benchmarks ============================== */

function Benchmarks({ networks, scenarios, fail, preAgent, preExternal, startNew, onStarted }: Props & {
  preAgent: string | null; preExternal: ExternalCfg | null; startNew: boolean; onStarted: () => void;
}) {
  const [list, setList] = useState<BenchInfo[] | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [sel, setSel] = useState<string | null>(() => sessionStorage.getItem("junction.bench"));
  const [form, setForm] = useState<BenchConfig | null>(null);
  const load = () => api.benchmarks().then(setList).catch(fail);
  useEffect(() => { load(); api.agents().then((a) => setAgents(a.filter((x) => x.has_model))).catch(() => {}); }, []);
  useEffect(() => { sel ? sessionStorage.setItem("junction.bench", sel) : sessionStorage.removeItem("junction.bench"); }, [sel]);
  const busy = list?.some((b) => b.status.state === "running" || b.status.state === "queued");
  useEffect(() => { if (!busy) return; const t = setInterval(load, 3000); return () => clearInterval(t); }, [busy]);
  const heads = useHeadlines(list);

  const start = (agentId?: string | null, ext?: ExternalCfg | null) => {
    const ag = agents.find((a) => a.id === agentId);
    const sid = ag?.config.scenario_id ?? scenarios.find((s) => !s.baseline)?.id ?? scenarios[0]?.id ?? "";
    setForm({
      name: ag ? `${ag.config.name} benchmark` : ext ? `${ext.name} benchmark` : "Benchmark", scenario_id: sid, heldout_ids: [],
      controllers: [{ kind: "fixed" }, { kind: "actuated" }, { kind: "max_pressure" },
        ...(ag ? [{ kind: "rl" as const, agent_id: ag.id, checkpoint: "final" }] : []),
        ...(ext ? [{ kind: "external" as const, external: ext }] : [])],
      reference: 0, demand_levels: [1.0], seeds: 5, first_seed: 1, depart_jitter_s: 300,
    });
    setSel(null);
  };
  useEffect(() => { if (preAgent && agents.length) { start(preAgent); onStarted(); } }, [preAgent, agents.length]);
  useEffect(() => { if (preExternal) { start(null, preExternal); onStarted(); } }, [preExternal]);
  useEffect(() => { if (startNew) { onStarted(); start(); } }, [startNew]);

  if (form) return <BenchForm f={form} set={setForm} scenarios={scenarios} networks={networks} agents={agents} fail={fail} onCancel={() => setForm(null)}
    onCreated={async (b) => { setForm(null); await load(); setSel(b.id); }} />;
  const cur = list?.find((b) => b.id === sel);
  if (cur) return <BenchDetail b={cur} networks={networks} fail={fail} onBack={() => setSel(null)} onChanged={load} />;
  return (
    <>
      {!list && <p className="status-line" role="status"><span className="spinner" aria-hidden="true" />Loading benchmarks…</p>}
      {list && !list.length && <div className="card"><div className="empty">No benchmarks yet. Pick controllers and conditions; every controller then runs on identical traffic.<br />
        <button className="primary small" onClick={() => start()} disabled={!scenarios.length}>New benchmark</button></div></div>}
      {list && list.length > 0 && (
        <table className="library">
          <thead><tr><th>Name</th><th>Result</th><th>Controllers</th><th>Conditions</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>{list.map((b) => (
            <tr key={b.id} tabIndex={0} onClick={() => setSel(b.id)} onKeyDown={(e) => e.key === "Enter" && setSel(b.id)}>
              <td><b>{b.config.name}</b></td>
              <td><Headline h={heads[b.id]} /></td>
              <td className="small">{b.manifest.labels.join(", ")}</td>
              <td className="small">{1 + b.config.heldout_ids.length} scenario{b.config.heldout_ids.length ? "s" : ""} × {b.config.demand_levels.length} demand × {b.config.seeds} seeds</td>
              <td className="cell-progress"><StateTag s={b.status.state} />
                {(b.status.state === "running" || b.status.state === "queued") && <span className="progress thin"><i style={{ width: `${(100 * b.status.done) / (b.status.total || 1)}%` }} /></span>}</td>
              <td>{when(b.status.created)}</td>
            </tr>))}
          </tbody>
        </table>
      )}
    </>
  );
}

function ctlLabel(c: ControllerSpec, agents: AgentInfo[]) {
  if (c.kind === "external") return c.external?.name ?? "External controller";
  if (c.kind !== "rl") return BASIC.find((b) => b.kind === c.kind)!.name;
  const a = agents.find((x) => x.id === c.agent_id);
  return `${a?.config.name ?? "Agent"}${c.checkpoint && c.checkpoint !== "final" ? ` (${c.checkpoint === "best" ? "best" : `ep ${Number(c.checkpoint.slice(3, 7))}`})` : ""}`;
}

function BenchForm({ f, set, scenarios, networks, agents, fail, onCancel, onCreated }: {
  f: BenchConfig; set: (f: BenchConfig) => void; scenarios: Scenario[]; networks: Network[]; agents: AgentInfo[]; fail: (e: unknown) => void;
  onCancel: () => void; onCreated: (b: BenchInfo) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [addAgent, setAddAgent] = useState("");
  const [addExt, setAddExt] = useState<ExternalCfg | null>(null);
  const up = (p: Partial<BenchConfig>) => set({ ...f, ...p });
  const hasBasic = (k: ControllerSpec["kind"]) => f.controllers.some((c) => c.kind === k);
  const toggleBasic = (k: ControllerSpec["kind"]) => {
    const i = f.controllers.findIndex((c) => c.kind === k);
    if (i < 0) up({ controllers: [...f.controllers, { kind: k }] });
    else up({ controllers: f.controllers.filter((_, j) => j !== i), reference: f.reference === i ? 0 : f.reference > i ? f.reference - 1 : f.reference });
  };
  const net = scenarios.find((s) => s.id === f.scenario_id)?.base_network;
  const runs = f.controllers.length * (1 + f.heldout_ids.length) * f.demand_levels.length * f.seeds;
  const submit = async () => { setBusy(true); try { onCreated(await api.runBenchmark(f)); } catch (e) { fail(e); } finally { setBusy(false); } };
  return (
    <div className="research-form">
      <div className="row spread"><h2>New benchmark</h2><button className="btn quiet" onClick={onCancel}>Cancel</button></div>
      <div className="form-cols">
        <div className="card">
          <h2>Conditions</h2>
          <label className="field block"><span className="label">Name</span><input className="text" value={f.name} onChange={(e) => up({ name: e.target.value })} /></label>
          <label className="field block"><span className="label">Main scenario</span>
            <select value={f.scenario_id} onChange={(e) => up({ scenario_id: e.target.value, heldout_ids: f.heldout_ids.filter((x) => x !== e.target.value) })}>
              {scenarios.map((s) => <option key={s.id} value={s.id}>{scenLabel(s, networks)}</option>)}</select></label>
          <fieldset className="field"><legend className="label">Held-out scenarios <span className="small muted">not seen in training</span></legend>
            <div className="check-list">
              {scenarios.filter((s) => s.id !== f.scenario_id).map((s) => (
                <label key={s.id} className="field-check row nowrap">
                  <input type="checkbox" checked={f.heldout_ids.includes(s.id)}
                    onChange={(e) => up({ heldout_ids: e.target.checked ? [...f.heldout_ids, s.id] : f.heldout_ids.filter((x) => x !== s.id) })} />
                  <span>{scenLabel(s, networks)}{s.base_network !== net && <span className="small muted"> (other network)</span>}</span>
                </label>))}
            </div>
          </fieldset>
          <fieldset className="field"><legend className="label">Demand levels</legend>
            <DemandChips v={f.demand_levels} set={(v) => up({ demand_levels: v })} /></fieldset>
          <Num label="Seeds per condition" v={f.seeds} min={1} max={50} set={(n) => up({ seeds: n })} />
          <Num label="First seed" v={f.first_seed} min={1} max={1000000} set={(n) => up({ first_seed: n })} />
          <Num label="Departure jitter" hint="s" v={f.depart_jitter_s} min={0} max={1800} step={30} set={(n) => up({ depart_jitter_s: n })} />
        </div>
        <div className="card">
          <h2>Controllers</h2>
          {BASIC.map((b) => (
            <label key={b.kind} className="field-check row nowrap">
              <input type="checkbox" checked={hasBasic(b.kind)} onChange={() => toggleBasic(b.kind)} /><span>{b.name}</span></label>))}
          {f.controllers.map((c, i) => c.kind === "rl" && (
            <div key={i} className="row nowrap rl-row">
              <span className="grow"><b>{agents.find((a) => a.id === c.agent_id)?.config.name ?? c.agent_id}</b></span>
              <select value={c.checkpoint ?? "final"} aria-label="Checkpoint" onChange={(e) => up({ controllers: f.controllers.map((x, j) => (j === i ? { ...x, checkpoint: e.target.value } : x)) })}>
                <option value="final">Final</option>
                {agents.find((a) => a.id === c.agent_id)?.has_best && <option value="best">Best episode</option>}
                {agents.find((a) => a.id === c.agent_id)?.checkpoints.map((k) => <option key={k} value={k}>Episode {Number(k.slice(3, 7))}</option>)}
              </select>
              <button className="btn quiet small" onClick={() => up({ controllers: f.controllers.filter((_, j) => j !== i), reference: f.reference === i ? 0 : f.reference > i ? f.reference - 1 : f.reference })}>Remove</button>
            </div>))}
          {agents.length > 0 && (
            <div className="row nowrap">
              <select value={addAgent} onChange={(e) => setAddAgent(e.target.value)} aria-label="Add trained agent">
                <option value="">Add a trained agent…</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.config.name} ({ALG_NAME[a.config.algorithm]})</option>)}
              </select>
              <button className="btn secondary small" disabled={!addAgent} onClick={() => { up({ controllers: [...f.controllers, { kind: "rl", agent_id: addAgent, checkpoint: "final" }] }); setAddAgent(""); }}>Add</button>
            </div>)}
          {!agents.length && <p className="small muted">Trained agents appear here once they have a model.</p>}
          {f.controllers.map((c, i) => c.kind === "external" && (
            <div key={`x${i}`} className="row nowrap rl-row">
              <span className="grow"><b>{c.external?.name}</b> <span className="small muted">{c.external?.url}</span></span>
              <button className="btn quiet small" onClick={() => up({ controllers: f.controllers.filter((_, j) => j !== i), reference: f.reference === i ? 0 : f.reference > i ? f.reference - 1 : f.reference })}>Remove</button>
            </div>))}
          {addExt ? (
            <div className="add-ext">
              <ExternalPicker value={addExt} onChange={setAddExt} compact />
              <div className="row nowrap">
                <button className="btn secondary small" disabled={!addExt.url} onClick={() => { rememberController(addExt); up({ controllers: [...f.controllers, { kind: "external", external: addExt }] }); setAddExt(null); }}>Add controller</button>
                <button className="btn quiet small" onClick={() => setAddExt(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button className="btn quiet small" onClick={() => setAddExt(savedControllers()[0] ?? { url: "http://localhost:9000/", name: "My controller" })}>Add an external controller</button>
          )}
          <label className="field block"><span className="label">Compare everything against</span>
            <select value={f.reference} onChange={(e) => up({ reference: Number(e.target.value) })}>
              {f.controllers.map((c, i) => <option key={i} value={i}>{ctlLabel(c, agents)}</option>)}</select></label>
        </div>
      </div>
      <div className="row">
        <button className="primary" disabled={busy || f.controllers.length < 2 || !f.demand_levels.length} onClick={submit}>{busy ? "Starting…" : `Run ${runs} simulations`}</button>
        {f.controllers.length < 2 && <span className="small muted">Choose at least two controllers.</span>}
      </div>
    </div>
  );
}

function BenchDetail({ b, networks, fail, onBack, onChanged }: { b: BenchInfo; networks: Network[]; fail: (e: unknown) => void; onBack: () => void; onChanged: () => void }) {
  const [stats, setStats] = useState<BenchStats | null>(null);
  const [cond, setCond] = useState(0);
  const [measure, setMeasure] = useState("mean_travel_time_s");
  const st = b.status;
  const running = st.state === "running" || st.state === "queued";
  useEffect(() => { if (st.done > 0) api.benchStats(b.id).then(setStats).catch(fail); }, [b.id, st.done, st.state]);
  const del = async () => { if (!confirm(`Delete ${b.config.name}? This cannot be undone.`)) return; try { await api.deleteBenchmark(b.id); onBack(); onChanged(); } catch (e) { fail(e); } };
  const c = stats?.conditions[cond];
  const ms = stats?.measures ?? {};
  const keys = Object.keys(ms).filter((k) => c?.rows.some((r) => r.measures[k]?.n));
  const m = ms[measure];
  // conditions that differ only by demand, for the main scenario and the one chosen
  const sweep = useMemo(() => (stats && c ? stats.conditions.filter((x) => x.scenario_id === c.scenario_id).sort((p, q) => p.demand - q.demand) : []), [stats, c]);
  return (
    <div className="bench-detail">
      <button className="btn quiet small" onClick={onBack}>← All benchmarks</button>
      <div className="row spread">
        <h2 className="detail-title">{b.config.name} <StateTag s={st.state} /></h2>
        <div className="row nowrap">
          {running && <button className="btn secondary small" onClick={() => api.cancelBenchmark(b.id).then(onChanged).catch(fail)}>Cancel</button>}
          {st.done > 0 && <a className="btn secondary small" href={api.benchCsvUrl(b.id)}>Download CSV</a>}
          {st.done > 0 && <a className="btn secondary small" href={api.benchJsonUrl(b.id)}>Download JSON</a>}
          {!running && <button className="btn danger small" onClick={del}>Delete</button>}
        </div>
      </div>
      {st.error && <p className="error-box">{st.error}</p>}
      {running && <>
        <div className="progress" role="progressbar" aria-valuenow={st.done} aria-valuemax={st.total}><i style={{ width: `${(100 * st.done) / (st.total || 1)}%` }} /></div>
        <p className="small">{st.done} of {st.total} simulations done. Results below update as runs finish.</p></>}
      {!stats && <p className="small muted">{st.done ? "Loading results…" : "Waiting for the first runs."}</p>}
      {stats && c && <>
        <div className="row page-tools">
          <label className="row nowrap"><span className="label">Condition</span>
            <select value={cond} onChange={(e) => setCond(Number(e.target.value))}>
              {stats.conditions.map((x, i) => <option key={i} value={i}>{networks.find((n) => n.id === x.network)?.name ?? x.network}: {x.scenario}{x.heldout ? " (held out)" : ""}, demand {Math.round(x.demand * 100)}%</option>)}
            </select></label>
          <span className="small muted">Reference: {stats.labels[stats.reference]}</span>
        </div>
        <div className="card">
          <h2>Measures, mean and 95% confidence interval</h2>
          <div className="table-scroll"><table className="library compact bench-table">
            <thead><tr><th>Controller</th>{keys.map((k) => <th key={k} className="n-col">{ms[k].label}{ms[k].unit && <span className="th-unit">{ms[k].unit}</span>}</th>)}<th className="n-col">Runs</th></tr></thead>
            <tbody>{c.rows.map((r) => (
              <tr key={r.controller} className={r.controller === stats.reference ? "ref-row" : ""}>
                <td><b>{r.label}</b>{r.controller === stats.reference && <span className="chip">reference</span>}</td>
                {keys.map((k) => { const s = r.measures[k], v = r.vs_reference?.[k];
                  return <td key={k} className="n-col">
                    <div>{fmt(s?.mean)} <span className="small muted">± {s?.mean != null && s.ci_high != null ? fmt(s.ci_high - s.mean) : "–"}</span></div>
                    {v && v.pct_change != null && <div className={`small ${v.significant ? (v.verdict === "better" ? "good-text" : "warn-text") : "muted"}`}
                      title={`Difference ${fmt(v.diff, 2)} (95% CI ${fmt(v.diff_ci_low, 2)} to ${fmt(v.diff_ci_high, 2)}); better on ${Math.round(v.share_seeds_better * 100)}% of seeds`}>
                      {v.pct_change > 0 ? "+" : ""}{fmt(v.pct_change)}%{v.significant ? (v.verdict === "better" ? ", better" : ", worse") : ", no clear difference"}</div>}
                  </td>; })}
                <td className="n-col">{r.runs}{r.errors.length > 0 && <span className="chip warn" title={r.errors.join("\n")}>{r.errors.length} failed</span>}</td>
              </tr>))}
            </tbody>
          </table></div>
          <p className="small muted">Percent change is against the reference on the same seeds; “better” or “worse” means the 95% interval of the paired difference excludes zero.</p>
        </div>
        <div className="form-cols">
          <div className="card">
            <div className="row spread"><h2>Compare one measure</h2>
              <select value={measure} onChange={(e) => setMeasure(e.target.value)} aria-label="Measure">
                {keys.map((k) => <option key={k} value={k}>{ms[k].label}</option>)}</select></div>
            {m && <BarChart unit={m.unit} rows={c.rows.map((r) => ({ label: r.label, mean: r.measures[measure]?.mean ?? null, lo: r.measures[measure]?.ci_low ?? null, hi: r.measures[measure]?.ci_high ?? null }))} />}
            {m && <p className="small muted">{m.lower_is_better ? "Lower is better." : "Higher is better."}</p>}
          </div>
          {sweep.length > 1 && m && (
            <div className="card"><h2>{m.label} across demand</h2>
              <LineChart xLabel="Demand" yLabel={m.unit} xTicks={sweep.map((x) => ({ v: x.demand, label: `${Math.round(x.demand * 100)}%` }))}
                series={stats.labels.map((lab, i) => ({ name: lab, pts: sweep.map((x) => [x.demand, x.rows.find((r) => r.controller === i)?.measures[measure]?.mean ?? NaN] as [number, number]) }))} />
            </div>)}
        </div>
        {stats.conditions.length > 1 && (
          <div className="card">
            <h2>Robustness across all {stats.conditions.length} conditions</h2>
            <table className="library compact">
              <thead><tr><th>Controller</th><th className="n-col">Better</th><th className="n-col">Worse</th><th className="n-col">Mean change</th><th className="n-col">Worst change</th></tr></thead>
              <tbody>{stats.robustness.map((r) => (
                <tr key={r.controller}><td><b>{r.label}</b></td><td className="n-col">{r.better} of {r.conditions}</td><td className="n-col">{r.worse} of {r.conditions}</td>
                  <td className="n-col">{r.mean_pct != null ? `${r.mean_pct > 0 ? "+" : ""}${fmt(r.mean_pct)}%` : "–"}</td>
                  <td className="n-col">{r.worst_pct != null ? `${r.worst_pct > 0 ? "+" : ""}${fmt(r.worst_pct)}%` : "–"}</td></tr>))}
              </tbody>
            </table>
            <p className="small muted">Average travel time against {stats.labels[stats.reference]}; a condition counts when the paired difference is significant.</p>
          </div>)}
      </>}
      <div className="card">
        <h2>Reproducibility</h2>
        <dl className="facts">
          <dt>Seeds</dt><dd>{b.manifest.seeds.join(", ")}; departure jitter {b.manifest.depart_jitter_s} s</dd>
          <dt>Scenarios</dt><dd>{b.manifest.scenarios.map((s) => `${networks.find((n) => n.id === s.network)?.name ?? s.network}: ${s.name}`).join("; ")}</dd>
          <dt>Software</dt><dd>Junction {b.manifest.versions.app}, SUMO {b.manifest.versions.sumo}</dd>
          {(b.manifest.external ?? []).map((x) => <Fragment key={x.url + x.label}><dt>{x.label}</dt><dd>external at {x.url}; decisions every {x.delta_t} s, minimum green {x.min_green} s, amber {x.amber} s, all-red {x.all_red} s, {x.reach_m} m observed</dd></Fragment>)}
          {Object.entries(b.manifest.models).map(([k, v]) => <Fragment key={k}><dt>{v.config.name}</dt><dd>{ALG_NAME[v.config.algorithm]}, {k.split("/")[1]} model, sha {v.sha.slice(0, 12)}</dd></Fragment>)}
        </dl>
      </div>
    </div>
  );
}

/* ============================== your own code ============================== */

function Connect({ networks, scenarios, fail, onBench }: Props & { onBench: (c: ExternalCfg) => void }) {
  const [sid, setSid] = useState(() => scenarios.find((s) => !s.baseline)?.id ?? scenarios[0]?.id ?? "");
  const [cfg, setCfg] = useState<EnvExportCfg>({
    observation: { reach_m: 60, features: ["queue", "approaching", "out_queue", "phase", "elapsed"] },
    action: { delta_t: 5, min_green: 10, amber: 3, all_red: 2 }, reward: "pressure", episode_min: 30, demand_scales: [0.8, 1.0, 1.2],
  });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [ext, setExt] = useState<ExternalCfg>(() => savedControllers()[0] ?? { url: "http://localhost:9000/", name: "My controller" });
  const [hosts, setHosts] = useState<string[]>([]);
  useEffect(() => { api.controllerProtocol().then((p) => setHosts(p.allowed_hosts)).catch(() => {}); }, []);
  const up = <K extends keyof EnvExportCfg>(k: K, v: Partial<EnvExportCfg[K]> | EnvExportCfg[K]) =>
    setCfg({ ...cfg, [k]: typeof v === "object" && !Array.isArray(v) ? { ...(cfg[k] as object), ...v } : v });
  const download = async () => {
    setBusy(true); setDone(null);
    try { setDone(await api.downloadRlEnv(sid, cfg)); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const cmd = "python external_controller.py --port 9000";
  const feats = cfg.observation.features;
  return (
    <div className="grid-2 connect">
      <div className="card">
        <h2>Use your own controller</h2>
        <p className="card-lead">Your program decides which light turns green next. Junction runs the traffic, keeps every change safe and compares your controller with the standard ones.</p>
        <ol className="step-tiles">
          <li>
            <span className="step-n" aria-hidden="true">1</span>
            <b>Get the example</b>
            <span className="small muted">A small Python program; nothing to install.</span>
            <a className="btn secondary small" href={api.controllerExampleUrl()}>Download example</a>
          </li>
          <li>
            <span className="step-n" aria-hidden="true">2</span>
            <b>Start it</b>
            <span className="small muted">Then swap in your own logic where it chooses the green.</span>
            <span className="cmd"><code>{cmd}</code>
              <button className="btn quiet small" onClick={() => { navigator.clipboard?.writeText(cmd).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}>{copied ? "Copied" : "Copy"}</button></span>
          </li>
          <li>
            <span className="step-n" aria-hidden="true">3</span>
            <b>Connect and test</b>
            <ExternalPicker value={ext} onChange={setExt} compact />
          </li>
        </ol>
        <div className="row">
          <button className="primary small" disabled={!ext.url} onClick={() => { rememberController(ext); onBench(ext); }}>Benchmark it</button>
          <span className="small muted">It is also available as “External” in the live view.</span>
        </div>
        <details className="dev">
          <summary>For developers: what Junction sends</summary>
          <p className="small">Every few simulated seconds, a POST with each signal that is free to change and, for each of its green options,
            the vehicles queued, approaching and queued beyond. Reply with the option to show. Allowed hosts: {hosts.join(", ") || "localhost"} (setting JUNCTION_CONTROLLER_HOSTS).</p>
          <pre className="config">{`{"type": "decide", "time_s": 125,
 "signals": [{"id": "B1", "current": 0, "green_for_s": 22,
   "options": [{"queue": 4, "approaching": 2, "queue_beyond": 0},
               {"queue": 9, "approaching": 1, "queue_beyond": 1}]}]}

reply: {"actions": {"B1": 1}}`}</pre>
        </details>
      </div>

      <div className="card">
        <h2>Train with your own code</h2>
        <p className="card-lead">Download a scenario as a ready-made RL environment for Stable-Baselines3, RLlib or PyTorch. It uses Junction's own measurements, safety rules and reward.</p>
        <label className="field block"><span className="label">Scenario</span>
          <select value={sid} onChange={(e) => setSid(e.target.value)}>
            {scenarios.map((s) => <option key={s.id} value={s.id}>{scenLabel(s, networks)}</option>)}
          </select></label>
        <fieldset className="field block"><legend className="label">Reward</legend>
          <div className="choice-cards" role="radiogroup">
            {REWARDS.map((r) => (
              <button key={r.id} role="radio" aria-checked={cfg.reward === r.id} className="choice-card" onClick={() => up("reward", r.id)}>
                <b>{r.name}</b><span>{r.short}</span>
              </button>))}
          </div>
        </fieldset>
        <details className="advanced">
          <summary>Measurements, timing and episodes</summary>
          <Num label="Looks this far back" hint="m" v={cfg.observation.reach_m} min={10} max={300} step={10} set={(n) => up("observation", { reach_m: n })} />
          <div className="chip-checks" role="group" aria-label="Measurements">
            {FEATURES.map((f) => (
              <label key={f.id} className={`chip-check ${feats.includes(f.id) ? "on" : ""}`}>
                <input type="checkbox" checked={feats.includes(f.id)}
                  onChange={(e) => up("observation", { features: e.target.checked ? [...feats, f.id] : feats.filter((x) => x !== f.id) })} />
                {f.short}
              </label>))}
          </div>
          <Num label="Seconds per step" v={cfg.action.delta_t} min={2} max={30} set={(n) => up("action", { delta_t: n })} />
          <Num label="Minimum green" hint="s" v={cfg.action.min_green} min={5} max={60} set={(n) => up("action", { min_green: n })} />
          <Num label="Amber" hint="s" v={cfg.action.amber} min={2} max={6} set={(n) => up("action", { amber: n })} />
          <Num label="All-red" hint="s" v={cfg.action.all_red} min={0} max={5} set={(n) => up("action", { all_red: n })} />
          <Num label="Episode length" hint="min" v={cfg.episode_min} min={5} max={60} set={(n) => up("episode_min", n)} />
          <fieldset className="field block"><legend className="label">Demand levels</legend>
            <DemandChips v={cfg.demand_scales} set={(v) => up("demand_scales", v)} /></fieldset>
        </details>
        <ul className="inside small">
          <li>Network and traffic for the scenario</li>
          <li>Multi-agent environment (PettingZoo parallel API)</li>
          <li>Random-policy example and README</li>
        </ul>
        <button className="primary small" onClick={download} disabled={busy || !sid || !feats.length || !cfg.demand_scales.length}>
          {busy ? "Building…" : "Download environment"}</button>
        {done && <p className="small good-text" role="status">Downloaded {done}. Run <code>python example_random.py</code> inside it to check it works.</p>}
      </div>
    </div>
  );
}
