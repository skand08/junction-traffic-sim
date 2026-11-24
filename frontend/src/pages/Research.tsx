import { Fragment, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { when } from "../shared";
import type {
  AgentConfig, AgentInfo, BenchConfig, BenchInfo, BenchStats, ControllerSpec, EpisodeRow, Network, Scenario,
} from "../types";
import LiveSim, { ALG_NAME } from "./LiveSim";

type Tab = "agents" | "watch" | "benchmarks";
type Props = {
  networks: Network[]; scenarios: Scenario[]; onChanged: () => Promise<void> | void; fail: (e: unknown) => void;
};

const FEATURES: { id: AgentConfig["observation"]["features"][number]; name: string }[] = [
  { id: "queue", name: "Stopped vehicles on each green's approaches" },
  { id: "approaching", name: "Moving vehicles approaching" },
  { id: "out_queue", name: "Stopped vehicles on exits" },
  { id: "phase", name: "Current green" },
  { id: "elapsed", name: "Time in current green" },
];
const REWARDS: { id: AgentConfig["reward"]; name: string; text: string }[] = [
  { id: "pressure", name: "Pressure", text: "Minus the difference between vehicles waiting to enter and waiting beyond the exits (PressLight)." },
  { id: "queue", name: "Queue", text: "Minus the number of stopped vehicles on the approaches." },
  { id: "waiting", name: "Waiting time", text: "Minus the increase in total waiting time since the last decision." },
];
const BASIC: { kind: ControllerSpec["kind"]; name: string }[] = [
  { kind: "fixed", name: "Fixed timing" }, { kind: "actuated", name: "Actuated" }, { kind: "max_pressure", name: "Max-Pressure" },
];
const DEMANDS = [0.6, 0.8, 1.0, 1.2, 1.5];
const ACTIVE = ["queued", "running", "paused", "pausing", "stopping"];

const scenLabel = (s: Scenario, networks: Network[]) => `${networks.find((n) => n.id === s.base_network)?.name ?? s.base_network}: ${s.name}`;
const fmt = (v: number | null | undefined, d = 1) => (v == null || !isFinite(v) ? "–" : v.toFixed(d));
const stateName: Record<string, string> = {
  queued: "Waiting to start", running: "Training", paused: "Paused", pausing: "Pausing after this episode", stopping: "Stopping after this episode",
  done: "Finished", stopped: "Stopped", failed: "Failed", interrupted: "Interrupted", cancelled: "Cancelled",
};

export default function Research(props: Props) {
  const [tab, setTab] = useState<Tab>(() => (sessionStorage.getItem("junction.restab") as Tab) || "agents");
  const [watchAgent, setWatchAgent] = useState<string | null>(null);
  const [benchFor, setBenchFor] = useState<string | null>(null);
  useEffect(() => { sessionStorage.setItem("junction.restab", tab); }, [tab]);
  const tabs = (
    <div className="seg wide sim-tabs" role="tablist" aria-label="Research">
      <button role="tab" aria-selected={tab === "agents"} onClick={() => setTab("agents")}>Agents and training</button>
      <button role="tab" aria-selected={tab === "watch"} onClick={() => setTab("watch")}>Watch on map</button>
      <button role="tab" aria-selected={tab === "benchmarks"} onClick={() => setTab("benchmarks")}>Benchmarks</button>
    </div>
  );
  if (tab === "watch")
    return <LiveSim networks={props.networks} scenarios={props.scenarios} preset={null} onChanged={props.onChanged} fail={props.fail}
      tabs={tabs} presetAgent={watchAgent} sessionKey="junction.research.live" />;
  return (
    <main className="work page-only">
      <section className="page wide research">
        <div className="page-head">
          <h1>Research</h1>
          <p className="lead">Train signal-control agents with reinforcement learning, then benchmark them against fixed, actuated and max-pressure control on identical traffic.</p>
        </div>
        <div className="research-tabs">{tabs}</div>
        {tab === "agents"
          ? <Agents {...props} onWatch={(id) => { setWatchAgent(id); setTab("watch"); }} onBench={(id) => { setBenchFor(id); setTab("benchmarks"); }} />
          : <Benchmarks {...props} preAgent={benchFor} />}
      </section>
    </main>
  );
}

/* ============================== agents ============================== */

function Agents({ networks, scenarios, fail, onWatch, onBench }: Props & { onWatch: (id: string) => void; onBench: (id: string) => void }) {
  const [list, setList] = useState<AgentInfo[] | null>(null);
  const [sel, setSel] = useState<string | null>(() => sessionStorage.getItem("junction.agent"));
  const [draft, setDraft] = useState<AgentConfig | null>(null);
  const load = () => api.agents().then(setList).catch(fail);
  useEffect(() => { load(); }, []);
  useEffect(() => { sel ? sessionStorage.setItem("junction.agent", sel) : sessionStorage.removeItem("junction.agent"); }, [sel]);
  const busy = list?.some((a) => ACTIVE.includes(a.status.state));
  useEffect(() => { if (!busy) return; const t = setInterval(load, 3000); return () => clearInterval(t); }, [busy]);

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

  if (draft) return <AgentForm draft={draft} setDraft={setDraft} scenarios={scenarios} networks={networks} parent={list?.find((a) => a.id === draft.parent_id)} fail={fail}
    onCancel={() => setDraft(null)} onCreated={async (a) => { setDraft(null); await load(); setSel(a.id); }} />;
  const cur = list?.find((a) => a.id === sel);
  if (cur) return <AgentDetail a={cur} scenarios={scenarios} networks={networks} fail={fail} onBack={() => setSel(null)} onChanged={load}
    onVariant={() => newAgent(cur)} onWatch={() => onWatch(cur.id)} onBench={() => onBench(cur.id)} />;

  return (
    <>
      <div className="row spread page-tools">
        <p className="small muted">{list ? `${list.length} agent${list.length === 1 ? "" : "s"}` : ""}</p>
        <button className="btn primary" onClick={() => newAgent()} disabled={!scenarios.length}>New agent</button>
      </div>
      {!list && <p className="status-line" role="status"><span className="spinner" aria-hidden="true" />Loading agents…</p>}
      {list && !list.length && <p className="small muted">No agents yet. Create one to train a controller on one of your scenarios.</p>}
      {list && list.length > 0 && (
        <table className="library">
          <thead><tr><th>Name</th><th>Method</th><th>Scenario</th><th>Status</th><th className="n-col">Episodes</th><th>Created</th></tr></thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.id} tabIndex={0} onClick={() => setSel(a.id)} onKeyDown={(e) => e.key === "Enter" && setSel(a.id)}>
                <td><b>{a.config.name}</b>{a.config.parent_id && <span className="chip">variant</span>}</td>
                <td>{ALG_NAME[a.config.algorithm]}, {a.config.sharing === "shared" ? "shared" : "per signal"}</td>
                <td>{(() => { const s = scenarios.find((x) => x.id === a.config.scenario_id); return s ? scenLabel(s, networks) : a.manifest.scenario_name ?? a.config.scenario_id; })()}</td>
                <td><StateTag s={a.status.state} /></td>
                <td className="n-col">{a.status.episodes_done} / {a.status.episodes}</td>
                <td>{when(a.status.created)}</td>
              </tr>
            ))}
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
  const submit = async () => {
    setBusy(true);
    try { onCreated(await api.trainAgent(d)); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const feats = d.observation.features;
  return (
    <div className="research-form">
      <div className="row spread">
        <h2>{parent ? `Variant of ${parent.config.name}` : "New agent"}</h2>
        <button className="btn quiet" onClick={onCancel}>Cancel</button>
      </div>
      {parent && <p className="small muted">An ablation: change one or two settings and benchmark both agents. {changed.length ? `Changed: ${changed.join(", ")}.` : "Nothing changed yet."}</p>}

      <div className="form-cols">
        <div className="card">
          <h2>Basics</h2>
          <label className="field block"><span className="label">Name</span>
            <input className="text" value={d.name} onChange={(e) => up("name", e.target.value)} /></label>
          <label className="field block"><span className="label">Train on scenario</span>
            <select value={d.scenario_id} onChange={(e) => up("scenario_id", e.target.value)}>
              {scenarios.map((s) => <option key={s.id} value={s.id}>{scenLabel(s, networks)}</option>)}
            </select></label>
          <fieldset className="field"><legend className="label">Method</legend>
            <div className="seg wide" role="radiogroup">
              {(["dqn", "double_dqn", "ppo"] as const).map((a) => (
                <button key={a} role="radio" aria-checked={d.algorithm === a} onClick={() => up("algorithm", a)}>{ALG_NAME[a]}</button>))}
            </div>
            <p className="small muted">{isPPO ? "Policy gradient with a clipped objective; learns a probability for each green." : d.algorithm === "double_dqn" ? "DQN that picks the next action with the online network and values it with the target network, which reduces over-estimation." : "Learns the value of each green from replayed experience, with a target network."}</p>
          </fieldset>
          <fieldset className="field"><legend className="label">Agents</legend>
            <div className="seg wide" role="radiogroup">
              <button role="radio" aria-checked={d.sharing === "shared"} onClick={() => up("sharing", "shared")}>One shared network</button>
              <button role="radio" aria-checked={d.sharing === "independent"} onClick={() => up("sharing", "independent")}>One per signal</button>
            </div>
            <p className="small muted">Every signal is an agent. {d.sharing === "shared" ? "They share parameters and learn from each other's experience; the model also runs on other networks." : "Each signal learns its own network; the model only runs on this network."}</p>
          </fieldset>
        </div>

        <div className="card">
          <h2>Observation</h2>
          <Num label="Observation distance" hint="m from the stop line" v={d.observation.reach_m} min={10} max={300} step={10} set={(n) => up("observation", { reach_m: n })} />
          {FEATURES.map((f) => (
            <label key={f.id} className="field-check row nowrap">
              <input type="checkbox" checked={feats.includes(f.id)}
                onChange={(e) => up("observation", { features: e.target.checked ? [...feats, f.id] : feats.filter((x) => x !== f.id) })} />
              <span>{f.name}</span>
            </label>
          ))}
          {!feats.length && <p className="small warn-text">Choose at least one.</p>}
          <h2>Actions and safety</h2>
          <p className="small muted">Each decision picks which green to show next. A change always runs amber then all-red, and no green is cut before its minimum.</p>
          <Num label="Seconds between decisions" v={d.action.delta_t} min={2} max={30} set={(n) => up("action", { delta_t: n })} />
          <Num label="Minimum green" hint="s" v={d.action.min_green} min={5} max={60} set={(n) => up("action", { min_green: n })} />
          <Num label="Amber" hint="s" v={d.action.amber} min={2} max={6} set={(n) => up("action", { amber: n })} />
          <Num label="All-red" hint="s" v={d.action.all_red} min={0} max={5} set={(n) => up("action", { all_red: n })} />
        </div>

        <div className="card">
          <h2>Reward</h2>
          {REWARDS.map((r) => (
            <label key={r.id} className="field-check row nowrap">
              <input type="radio" name="reward" checked={d.reward === r.id} onChange={() => up("reward", r.id)} />
              <span><b>{r.name}.</b> {r.text}</span>
            </label>
          ))}
          <h2>Training</h2>
          <Num label="Episodes" v={d.training.episodes} min={1} max={2000} set={(n) => up("training", { episodes: n })} />
          <Num label="Traffic per episode" hint="min" v={d.training.episode_min} min={5} max={60} set={(n) => up("training", { episode_min: n })} />
          <fieldset className="field"><legend className="label">Demand levels to train on</legend>
            <DemandChips v={d.training.demand_scales} set={(v) => up("training", { demand_scales: v })} />
          </fieldset>
          <Num label="Seed" v={d.training.seed} min={1} max={1000000} set={(n) => up("training", { seed: n })} />
          <Num label="Save a checkpoint every" hint="episodes" v={d.training.checkpoint_every} min={1} max={500} set={(n) => up("training", { checkpoint_every: n })} />
          <Num label="Learning rate" v={d.hyper.lr} min={0.00001} max={0.1} step={0.0001} set={(n) => up("hyper", { lr: n })} />
          <Num label="Discount factor" v={d.hyper.gamma} min={0} max={0.999} step={0.01} set={(n) => up("hyper", { gamma: n })} />
          <details className="advanced">
            <summary>Advanced settings</summary>
            <label className="field"><span className="label">Hidden layers <span className="small muted">comma separated</span></span>
              <input className="text short" value={d.hyper.hidden.join(", ")}
                onChange={(e) => up("hyper", { hidden: e.target.value.split(",").map((x) => parseInt(x)).filter((x) => x > 0) })} /></label>
            {!isPPO ? (<>
              <Num label="Batch size" v={d.hyper.batch} min={8} max={1024} set={(n) => up("hyper", { batch: n })} />
              <Num label="Replay buffer" v={d.hyper.buffer} min={1000} max={1000000} step={1000} set={(n) => up("hyper", { buffer: n })} />
              <Num label="Learning starts after" hint="steps" v={d.hyper.learning_starts} min={0} max={100000} set={(n) => up("hyper", { learning_starts: n })} />
              <Num label="Target network update" hint="steps" v={d.hyper.target_update} min={10} max={100000} set={(n) => up("hyper", { target_update: n })} />
              <Num label="Exploration start" v={d.hyper.eps_start} min={0} max={1} step={0.05} set={(n) => up("hyper", { eps_start: n })} />
              <Num label="Exploration end" v={d.hyper.eps_end} min={0} max={1} step={0.01} set={(n) => up("hyper", { eps_end: n })} />
              <Num label="Exploration decays over" hint="share of training" v={d.hyper.eps_decay_frac} min={0.05} max={1} step={0.05} set={(n) => up("hyper", { eps_decay_frac: n })} />
            </>) : (<>
              <Num label="Clip range" v={d.hyper.clip} min={0.05} max={0.5} step={0.05} set={(n) => up("hyper", { clip: n })} />
              <Num label="Epochs per update" v={d.hyper.epochs} min={1} max={20} set={(n) => up("hyper", { epochs: n })} />
              <Num label="Minibatch" v={d.hyper.minibatch} min={16} max={4096} set={(n) => up("hyper", { minibatch: n })} />
              <Num label="GAE lambda" v={d.hyper.gae_lambda} min={0} max={1} step={0.01} set={(n) => up("hyper", { gae_lambda: n })} />
              <Num label="Entropy weight" v={d.hyper.ent_coef} min={0} max={0.2} step={0.005} set={(n) => up("hyper", { ent_coef: n })} />
              <Num label="Value loss weight" v={d.hyper.vf_coef} min={0} max={2} step={0.1} set={(n) => up("hyper", { vf_coef: n })} />
            </>)}
          </details>
          <label className="field block"><span className="label">Note</span>
            <textarea className="text" rows={2} value={d.note ?? ""} onChange={(e) => up("note", e.target.value)} /></label>
        </div>
      </div>
      <div className="row">
        <button className="btn primary" disabled={busy || !feats.length || !d.scenario_id || !d.training.demand_scales.length} onClick={submit}>
          {busy ? "Preparing the network…" : "Start training"}</button>
        <span className="small muted">About {Math.round(d.training.episodes * d.training.episode_min * 0.08)}–{Math.round(d.training.episodes * d.training.episode_min * 0.25)} min, depending on network size.</span>
      </div>
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
  return (
    <div className="agent-detail">
      <button className="btn quiet" onClick={onBack}>All agents</button>
      <div className="row spread">
        <h2 className="detail-title">{c.name} <StateTag s={st.state} /></h2>
        <div className="row nowrap">
          {st.state === "running" && <button className="btn secondary small" onClick={() => ctl("pause")}>Pause</button>}
          {st.state === "paused" && <button className="btn secondary small" onClick={() => ctl("resume")}>Resume</button>}
          {active && <button className="btn secondary small" onClick={() => ctl("stop")}>Stop</button>}
          {a.has_model && <button className="btn secondary small" onClick={onWatch}>Watch on map</button>}
          {a.has_model && <button className="btn secondary small" onClick={onBench}>Benchmark</button>}
          <button className="btn secondary small" onClick={onVariant}>Create variant</button>
          {!active && <button className="btn danger small" onClick={del}>Delete</button>}
        </div>
      </div>
      <p className="small muted">{ALG_NAME[c.algorithm]}, {c.sharing === "shared" ? "one network shared by" : "one network for each of"} {st.agents ?? "the"} signals,
        trained on {(() => { const s = scenarios.find((x) => x.id === c.scenario_id); return s ? scenLabel(s, networks) : a.manifest.scenario_name; })()}. {c.note}</p>
      {st.error && <p className="error-box">{st.error}</p>}
      <div className="progress" role="progressbar" aria-valuenow={st.episodes_done} aria-valuemax={st.episodes}><i style={{ width: `${pct}%` }} /></div>
      <p className="small">{st.episodes_done} of {st.episodes} episodes{st.state === "running" && st.episode ? `; episode ${st.episode} running` : ""}
        {st.best_episode ? `. Best so far: episode ${st.best_episode} (lowest travel time).` : "."}</p>

      <div className="chart-grid">
        <div className="card"><h2>Reward per decision</h2>
          <LineChart series={[{ name: "Episode", pts: log.map((r) => [r.episode, r.reward]) }, { name: "Average of last 5", pts: smooth(log.map((r) => [r.episode, r.reward])) }]} xLabel="Episode" yLabel="reward" /></div>
        <div className="card"><h2>Average travel time</h2>
          <LineChart series={[{ name: "Episode", pts: log.filter((r) => r.travel_time_s != null).map((r) => [r.episode, r.travel_time_s!]) },
            { name: "Average of last 5", pts: smooth(log.filter((r) => r.travel_time_s != null).map((r) => [r.episode, r.travel_time_s!])) }]} xLabel="Episode" yLabel="s" /></div>
        <div className="card"><h2>{c.algorithm === "ppo" ? "Policy entropy" : "Exploration"} and loss</h2>
          <LineChart series={[{ name: c.algorithm === "ppo" ? "Entropy" : "Exploration rate", pts: log.map((r) => [r.episode, (c.algorithm === "ppo" ? r.entropy : r.epsilon) ?? NaN]) },
            { name: "Loss", pts: log.filter((r) => r.loss != null).map((r) => [r.episode, r.loss!]), right: true }]} xLabel="Episode" yLabel="" /></div>
      </div>

      <div className="card">
        <h2>Episode log</h2>
        {!log.length ? <p className="small muted">The first episode is still running.</p> : (
          <div className="table-scroll"><table className="library compact">
            <thead><tr><th className="n-col">Episode</th><th className="n-col">Demand</th><th className="n-col">Seed</th><th className="n-col">Reward</th><th className="n-col">Travel time (s)</th>
              <th className="n-col">Arrived</th><th className="n-col">Stopped</th><th className="n-col">Gridlock</th><th className="n-col">Loss</th><th className="n-col">Time (s)</th></tr></thead>
            <tbody>{[...log].reverse().map((r) => (
              <tr key={r.episode}><td className="n-col">{r.episode}{r.episode === st.best_episode && <span className="chip">best</span>}</td>
                <td className="n-col">{Math.round(r.demand_scale * 100)}%</td><td className="n-col">{r.seed}</td><td className="n-col">{fmt(r.reward, 3)}</td>
                <td className="n-col">{fmt(r.travel_time_s)}</td><td className="n-col">{r.arrived}</td><td className="n-col">{fmt(r.mean_stopped)}</td>
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

function Benchmarks({ networks, scenarios, fail, preAgent }: Props & { preAgent: string | null }) {
  const [list, setList] = useState<BenchInfo[] | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [sel, setSel] = useState<string | null>(() => sessionStorage.getItem("junction.bench"));
  const [form, setForm] = useState<BenchConfig | null>(null);
  const load = () => api.benchmarks().then(setList).catch(fail);
  useEffect(() => { load(); api.agents().then((a) => setAgents(a.filter((x) => x.has_model))).catch(() => {}); }, []);
  useEffect(() => { sel ? sessionStorage.setItem("junction.bench", sel) : sessionStorage.removeItem("junction.bench"); }, [sel]);
  const busy = list?.some((b) => b.status.state === "running" || b.status.state === "queued");
  useEffect(() => { if (!busy) return; const t = setInterval(load, 3000); return () => clearInterval(t); }, [busy]);

  const start = (agentId?: string | null) => {
    const ag = agents.find((a) => a.id === agentId);
    const sid = ag?.config.scenario_id ?? scenarios.find((s) => !s.baseline)?.id ?? scenarios[0]?.id ?? "";
    setForm({
      name: ag ? `${ag.config.name} benchmark` : "Benchmark", scenario_id: sid, heldout_ids: [],
      controllers: [{ kind: "fixed" }, { kind: "actuated" }, { kind: "max_pressure" }, ...(ag ? [{ kind: "rl" as const, agent_id: ag.id, checkpoint: "final" }] : [])],
      reference: 0, demand_levels: [1.0], seeds: 5, first_seed: 1, depart_jitter_s: 300,
    });
    setSel(null);
  };
  useEffect(() => { if (preAgent && agents.length) start(preAgent); }, [preAgent, agents.length]);

  if (form) return <BenchForm f={form} set={setForm} scenarios={scenarios} networks={networks} agents={agents} fail={fail} onCancel={() => setForm(null)}
    onCreated={async (b) => { setForm(null); await load(); setSel(b.id); }} />;
  const cur = list?.find((b) => b.id === sel);
  if (cur) return <BenchDetail b={cur} networks={networks} fail={fail} onBack={() => setSel(null)} onChanged={load} />;
  return (
    <>
      <div className="row spread page-tools">
        <p className="small muted">Every controller runs on the same seeds, departures and demand, so differences come from the control alone.</p>
        <button className="btn primary" onClick={() => start()} disabled={!scenarios.length}>New benchmark</button>
      </div>
      {!list && <p className="status-line" role="status"><span className="spinner" aria-hidden="true" />Loading benchmarks…</p>}
      {list && !list.length && <p className="small muted">No benchmarks yet.</p>}
      {list && list.length > 0 && (
        <table className="library">
          <thead><tr><th>Name</th><th>Controllers</th><th>Conditions</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>{list.map((b) => (
            <tr key={b.id} tabIndex={0} onClick={() => setSel(b.id)} onKeyDown={(e) => e.key === "Enter" && setSel(b.id)}>
              <td><b>{b.config.name}</b></td>
              <td>{b.manifest.labels.join(", ")}</td>
              <td>{1 + b.config.heldout_ids.length} scenario{b.config.heldout_ids.length ? "s" : ""} × {b.config.demand_levels.length} demand × {b.config.seeds} seeds</td>
              <td><StateTag s={b.status.state} />{b.status.state === "running" && <span className="small"> {b.status.done}/{b.status.total}</span>}</td>
              <td>{when(b.status.created)}</td>
            </tr>))}
          </tbody>
        </table>
      )}
    </>
  );
}

function ctlLabel(c: ControllerSpec, agents: AgentInfo[]) {
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
          <label className="field block"><span className="label">Compare everything against</span>
            <select value={f.reference} onChange={(e) => up({ reference: Number(e.target.value) })}>
              {f.controllers.map((c, i) => <option key={i} value={i}>{ctlLabel(c, agents)}</option>)}</select></label>
        </div>
      </div>
      <div className="row">
        <button className="btn primary" disabled={busy || f.controllers.length < 2 || !f.demand_levels.length} onClick={submit}>{busy ? "Starting…" : `Run ${runs} simulations`}</button>
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
      <button className="btn quiet" onClick={onBack}>All benchmarks</button>
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
            <thead><tr><th>Controller</th>{keys.map((k) => <th key={k} className="n-col">{ms[k].label}{ms[k].unit && ` (${ms[k].unit})`}</th>)}<th className="n-col">Runs</th></tr></thead>
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
          {Object.entries(b.manifest.models).map(([k, v]) => <Fragment key={k}><dt>{v.config.name}</dt><dd>{ALG_NAME[v.config.algorithm]}, {k.split("/")[1]} model, sha {v.sha.slice(0, 12)}</dd></Fragment>)}
        </dl>
      </div>
    </div>
  );
}
