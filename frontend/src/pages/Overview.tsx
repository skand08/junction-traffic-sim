import { useEffect, useState } from "react";
import { api } from "../api";
import PageHead from "../PageHead";
import { when } from "../shared";
import type { AgentInfo, BenchInfo, Network, Scenario, Simulation } from "../types";

type Section = "network" | "scenario" | "simulation" | "results" | "experiments" | "research";

/** Home: where things stand, what to do next, and what is running. */
export default function Overview({ networks, scenarios, sims, go, openResult }: {
  networks: Network[]; scenarios: Scenario[]; sims: Simulation[];
  go: (s: Section) => void; openResult: (simId: string) => void;
}) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [benches, setBenches] = useState<BenchInfo[]>([]);
  useEffect(() => {
    const load = () => { api.agents().then(setAgents).catch(() => {}); api.benchmarks().then(setBenches).catch(() => {}); };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const changed = scenarios.filter((s) => !s.baseline).length;
  const done = sims.filter((s) => s.state === "done").length;
  const running = sims.filter((s) => s.state === "running");
  const training = agents.filter((a) => ["queued", "running", "paused", "evaluating", "pausing", "stopping"].includes(a.status.state));
  const steps: { name: string; text: string; done: boolean; go: Section; action: string }[] = [
    { name: "Pick a road network", text: "Built-in, or any area from OpenStreetMap", done: networks.length > 0, go: "network", action: "Networks" },
    { name: "Make a change to test", text: "Lanes, closures, turns, signals, traffic", done: changed > 0, go: "scenario", action: "Scenarios" },
    { name: "Simulate it against today", text: "Same traffic, several runs", done: sims.length > 0, go: "simulation", action: "Simulate" },
    { name: "Read the result", text: "What changed and how sure it is", done: done > 0, go: "results", action: "Results" },
  ];
  const next = steps.find((s) => !s.done);
  return (
    <main className="work page-only">
      <section className="page">
        <PageHead title="Overview" lead="Test street and signal changes on real road networks before building them."
          actions={next ? <button className="primary small" onClick={() => go(next.go)}>Next: {next.name.toLowerCase()}</button> : undefined} />
        <div className="stats">
          <button className="stat" onClick={() => go("network")}><span className="stat-num">{networks.length}</span><span className="stat-name">Networks</span></button>
          <button className="stat" onClick={() => go("scenario")}><span className="stat-num">{changed}</span><span className="stat-name">Scenarios with changes</span></button>
          <button className="stat" onClick={() => go("experiments")}>
            <span className="stat-num">{sims.length}{running.length > 0 && <small>{running.length} running</small>}</span><span className="stat-name">Simulations</span></button>
          <button className="stat" onClick={() => go("research")}>
            <span className="stat-num">{agents.length}{training.length > 0 && <small>{training.length} training</small>}</span><span className="stat-name">Trained agents</span></button>
        </div>
        <div className="grid-2">
          <div className="stack">
            <div className="card">
              <div className="card-head"><h2>Recent simulations</h2>{sims.length > 0 && <button className="btn quiet small" onClick={() => go("experiments")}>All simulations</button>}</div>
              {sims.length === 0 ? (
                <div className="empty">No simulations yet.<br /><button className="primary small" onClick={() => go("simulation")}>Compare scenarios</button></div>
              ) : (
                <ul className="recent">
                  {sims.slice(0, 5).map((s) => (
                    <li key={s.id}>
                      <span><b>{s.name}</b> <span className="small muted">{networks.find((n) => n.id === s.network)?.name ?? s.network}, {when(s.created)}</span></span>
                      {s.state === "done" ? <button className="btn quiet small" onClick={() => openResult(s.id)}>View results</button>
                        : <span className={`status ${s.state}`}>{s.state === "running" ? "Running" : s.state}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="card">
              <div className="card-head"><h2>Research</h2><button className="btn quiet small" onClick={() => go("research")}>Open Research</button></div>
              {training.map((a) => (
                <div key={a.id} className="mini-job">
                  <span><b>{a.config.name}</b> <span className="small muted">training, episode {a.status.episodes_done} of {a.status.episodes}</span></span>
                  <div className="progress thin"><i style={{ width: `${(100 * a.status.episodes_done) / (a.status.episodes || 1)}%` }} /></div>
                </div>
              ))}
              {training.length === 0 && (agents.length === 0 && benches.length === 0
                ? <p className="small muted">Train learned signal controllers and benchmark them against standard control.</p>
                : <p className="small">{agents.length} agent{agents.length === 1 ? "" : "s"} and {benches.length} benchmark{benches.length === 1 ? "" : "s"}.
                    {benches[0] && <> Latest benchmark: <b>{benches[0].config.name}</b>, {when(benches[0].status.created)}.</>}</p>)}
            </div>
          </div>
          <div className="card">
            {next ? (<>
              <h2>Get started</h2>
              <ol className="checklist">
                {steps.map((st) => (
                  <li key={st.name} className={st.done ? "done" : ""}>
                    <span className="tick" aria-hidden="true">{st.done ? "✓" : ""}</span>
                    <span><span className="step-name">{st.name}</span><br /><span className="small muted">{st.text}</span></span>
                    <button className="btn quiet small" onClick={() => go(st.go)}>{st.action}<span className="sr-only">{st.done ? " (done)" : ""}</span></button>
                  </li>
                ))}
              </ol>
            </>) : (<>
              <h2>Quick actions</h2>
              <div className="quick">
                <button className="quick-item" onClick={() => go("network")}><b>Add a network</b><span>From a map area or file</span></button>
                <button className="quick-item" onClick={() => go("scenario")}><b>New scenario</b><span>Change roads or signals</span></button>
                <button className="quick-item" onClick={() => go("simulation")}><b>Watch it live</b><span>Vehicles and signals on the map</span></button>
                <button className="quick-item" onClick={() => go("simulation")}><b>Compare scenarios</b><span>Same traffic, several runs</span></button>
                <button className="quick-item" onClick={() => go("research")}><b>Train an agent</b><span>Learned signal control</span></button>
                <button className="quick-item" onClick={() => go("results")}><b>Read results</b><span>Changes and confidence</span></button>
              </div>
            </>)}
          </div>
        </div>
      </section>
    </main>
  );
}
