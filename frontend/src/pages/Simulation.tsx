import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { JobRow } from "../RunMonitor";
import { CONTROLLERS, when, listNav } from "../shared";
import type { Health, Network, Scenario, Simulation as Sim } from "../types";

const REPEATS = [5, 10, 20];

type Props = {
  networks: Network[];
  scenarios: Scenario[];
  sims: Sim[];
  health: Health | null;
  preset: { network: string; scenario?: string } | null;
  onStarted: () => void;
  onChanged: () => Promise<void> | void;
  onResults: (simId: string) => void;
  onEditScenario?: (scenarioId: string) => void;
  fail: (e: unknown) => void;
};

export default function SimulationPage({ networks, scenarios, sims, health, preset, onStarted, onChanged, onResults, onEditScenario, fail }: Props) {
  const [nid, setNid] = useState<string>(preset?.network ?? "");
  const [ref, setRef] = useState<string>("");
  const [alts, setAlts] = useState<string[]>(preset?.scenario ? [preset.scenario] : []);
  const [repeats, setRepeats] = useState(10);
  const [firstSeed, setFirstSeed] = useState(1);
  const [jitter, setJitter] = useState(300);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!preset) return;
    setNid(preset.network);
    setAlts(preset.scenario ? [preset.scenario] : []);
  }, [preset]);

  // every network has an "as it is" scenario to compare against; create it when the network is chosen
  useEffect(() => {
    if (!nid) return;
    const b = scenarios.find((s) => s.base_network === nid && s.baseline);
    if (b) { setRef((r) => (r && scenarios.some((s) => s.id === r && s.base_network === nid) ? r : b.id)); return; }
    api.baseline(nid).then(async (s) => { await onChanged(); setRef(s.id); }).catch(fail);
  }, [nid, scenarios.length]);

  const onNet = useMemo(() => scenarios.filter((s) => s.base_network === nid), [scenarios, nid]);
  const choices = onNet.filter((s) => s.id !== ref);
  const seeds = Array.from({ length: repeats }, (_, i) => firstSeed + i);
  const running = sims.filter((s) => s.state === "running");
  const failed = sims.filter((s) => s.state === "failed").slice(0, 3);
  const recent = sims.filter((s) => s.state !== "running" && !failed.includes(s)).slice(0, 6);
  const act = (f: () => Promise<unknown>) => async () => { try { await f(); onStarted(); } catch (e) { fail(e); } };
  const netName = (id: string) => networks.find((n) => n.id === id)?.name ?? id;

  async function start() {
    setBusy(true);
    try {
      await api.startSimulation({ reference: ref, alternatives: alts.filter((a) => a !== ref), seeds, depart_jitter_s: jitter, name: name.trim() || undefined });
      setName("");
      onStarted();
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  return (
    <main className="work page-only">
      <section className="page">
        <div className="page-head">
          <h1>Traffic Simulation</h1>
          <p className="lead">Run scenarios against a reference with the same traffic, several times each. Simulations run in the background; you can keep working.</p>
        </div>

        <div className="card">
          <h2>New simulation</h2>
          <label className="field block">
            <span className="label">Network</span>
            <select value={nid} onChange={(e) => { setNid(e.target.value); setAlts([]); setRef(""); }}>
              <option value="">Choose a network…</option>
              {networks.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </select>
          </label>

          {nid && (
            <>
              <label className="field block">
                <span className="label">Reference: what to compare against</span>
                <select value={ref} onChange={(e) => { setRef(e.target.value); setAlts((a) => a.filter((x) => x !== e.target.value)); }}>
                  {onNet.map((s) => <option key={s.id} value={s.id}>{s.name}{s.baseline ? " (no changes)" : ""}</option>)}
                </select>
              </label>

              <fieldset className="field block">
                <legend className="label">Scenarios to test</legend>
                {choices.length === 0 && <p className="small muted">No other scenarios on this network yet. Build one in Scenario Builder.</p>}
                <ul className="check-list" onKeyDown={listNav}>
                  {choices.map((s) => (
                    <li key={s.id}>
                      <label className="check">
                        <input type="checkbox" checked={alts.includes(s.id)}
                          onChange={(e) => setAlts(e.target.checked ? [...alts, s.id] : alts.filter((x) => x !== s.id))} />
                        <span>
                          <b>{s.name}</b>{" "}
                          <span className="small muted">
                            {s.edits.length} change{s.edits.length === 1 ? "" : "s"}, {CONTROLLERS.find((c) => c.id === s.controller)?.name.toLowerCase()}
                            {s.demand_scale !== 1 ? `, ${Math.round(s.demand_scale * 100)}% traffic` : ""}
                          </span>
                          {s.controller === "max_pressure" && <span className="tag-exp">EXPERIMENTAL</span>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>

              <fieldset className="field block">
                <legend className="label">Number of runs</legend>
                <div className="seg" role="radiogroup" aria-label="Number of runs">
                  {REPEATS.map((r) => <button key={r} role="radio" aria-checked={repeats === r} onClick={() => setRepeats(r)}>{r}</button>)}
                </div>
                <p className="small muted">Traffic is random, so each scenario runs several times with the same seeds. More runs: more reliable, but slower.</p>
              </fieldset>
              <label className="check field-check">
                <input type="checkbox" checked={jitter > 0} onChange={(e) => setJitter(e.target.checked ? 300 : 0)} />
                <span><b>Vary when trips start</b> (up to ±{Math.round((jitter || 300) / 60)} min per run), like different days. All scenarios get the same pattern in each run.</span>
              </label>
              <details className="advanced">
                <summary>Advanced settings</summary>
                <label className="field"><span className="label">Simulation name</span>
                  <input type="text" className="text" value={name} placeholder="Automatic" onChange={(e) => setName(e.target.value)} /></label>
                <label className="field"><span className="label">First random seed</span>
                  <input type="number" min={1} value={firstSeed} onChange={(e) => setFirstSeed(Math.max(1, Math.floor(Number(e.target.value) || 1)))} /></label>
                <label className="field"><span className="label">Start-time variation (± seconds)</span>
                  <input type="number" min={0} max={1800} step={30} value={jitter} onChange={(e) => setJitter(Math.max(0, Math.min(1800, Math.round(Number(e.target.value) || 0))))} /></label>
                {health && (
                  <dl className="facts">
                    <dt>Stuck car is moved ahead after</dt><dd>{health.settings.time_to_teleport_s} s</dd>
                    <dt>Extra time for trips to finish</dt><dd>{Math.round(health.settings.drain_s / 60)} min</dd>
                    <dt>Versions</dt><dd>Junction {health.versions.app}, SUMO {health.versions.sumo}</dd>
                  </dl>
                )}
              </details>
              <button className="primary wide" disabled={busy || !ref || alts.length === 0} onClick={start}>
                {busy ? "Starting…" : alts.length === 0 ? "Choose at least one scenario to test" : `Run ${alts.length + 1} scenarios × ${repeats} runs`}
              </button>
            </>
          )}
        </div>

        <h2 className="h2-inline">Running now</h2>
        {running.length === 0 && <p className="small muted">Nothing is running.</p>}
        {running.map((s) => (
          <div key={s.id} className="card">
            <div className="row spread"><h3 className="h3-flat">{s.name}</h3><span className="small muted">{netName(s.network)}, started {when(s.created)}</span></div>
            <JobRow label={`${s.reference.scenario_name} (reference)`} job={s.reference.job} startedAt={s.created * 1000} />
            {s.alternatives.map((a) => <JobRow key={a.run_id} label={a.scenario_name} job={a.job} startedAt={s.created * 1000} />)}
            <button className="btn secondary small" onClick={async () => { try { await api.cancelSimulation(s.id); onStarted(); } catch (e) { fail(e); } }}>Cancel</button>
          </div>
        ))}

        {failed.length > 0 && (
          <>
            <h2 className="h2-inline">Needs attention</h2>
            {failed.map((s) => (
              <div key={s.id} className="card">
                <div className="row spread"><h3 className="h3-flat">{s.name}</h3><span className="small muted">{netName(s.network)}, started {when(s.created)}</span></div>
                {[{ ...s.reference, label: `${s.reference.scenario_name} (reference)` }, ...s.alternatives.map((a) => ({ ...a, label: a.scenario_name }))]
                  .filter((p) => p.job.state === "failed")
                  .map((p) => (
                    <JobRow key={p.run_id} label={p.label} job={p.job} startedAt={null}
                      onRetry={act(() => api.rerunSimulation(s.id))}
                      onShowChange={onEditScenario ? () => onEditScenario(p.scenario_id) : undefined} />
                  ))}
                <button className="btn quiet small" onClick={act(() => api.deleteSimulation(s.id))}>Remove from list</button>
              </div>
            ))}
          </>
        )}

        {recent.length > 0 && (
          <>
            <h2 className="h2-inline">Recently finished</h2>
            <ul className="recent card" onKeyDown={listNav}>
              {recent.map((s) => (
                <li key={s.id}>
                  <span><b>{s.name}</b> <span className="small muted">{netName(s.network)}, {when(s.created)}</span></span>
                  {s.state === "done" ? <button className="btn quiet small" onClick={() => onResults(s.id)}>View results</button>
                    : <span className={`status ${s.state}`}>{s.state === "failed" ? "Failed" : s.state === "cancelled" ? "Cancelled" : "Unavailable"}</span>}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </main>
  );
}
