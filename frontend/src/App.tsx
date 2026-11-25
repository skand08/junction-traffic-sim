import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import NetworkExplorer from "./pages/NetworkExplorer";
import ScenarioBuilder from "./pages/ScenarioBuilder";
import SimulationPage from "./pages/Simulation";
import ResultsPage from "./pages/ResultsPage";
import Experiments from "./Experiments";
import Research from "./pages/Research";
import Overview from "./pages/Overview";
import { when } from "./shared";
import type { Health, Network, Scenario, Simulation } from "./types";
import type { AuthUser } from "./api";

type Section = "overview" | "network" | "scenario" | "simulation" | "results" | "experiments" | "research";
const SECTIONS: { id: Section; name: string; short: string; icon: string }[] = [
  { id: "overview", name: "Overview", short: "Overview", icon: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" },
  { id: "network", name: "Network Explorer", short: "Networks", icon: "M9 4l-6 2v14l6-2 6 2 6-2V4l-6 2-6-2zm0 0v14m6-12v14" },
  { id: "scenario", name: "Scenario Builder", short: "Scenarios", icon: "M4 20h4L19 9l-4-4L4 16v4zm11-15l4 4" },
  { id: "simulation", name: "Traffic Simulation", short: "Simulate", icon: "M7 4l12 8-12 8V4z" },
  { id: "results", name: "Results & Analytics", short: "Results", icon: "M4 20V10m6 10V4m6 16v-7m6 7H2" },
  { id: "experiments", name: "Experiments & History", short: "History", icon: "M12 7v5l3 2m6-2a9 9 0 1 1-3-6.7M21 4v5h-5" },
  { id: "research", name: "Research", short: "Research", icon: "M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3M7 15h10" },
];

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

// the URL hash remembers where you are, so a reload comes back to the same place
function readHash() {
  const h = new URLSearchParams(window.location.hash.slice(1));
  return { s: h.get("s") as Section | null, n: h.get("n"), sc: h.get("sc"), sim: h.get("sim"), exp: h.get("exp") };
}

export default function App({ user, onSignOut }: { user: AuthUser | null; onSignOut: () => void }) {
  const init = readHash();
  const [section, setSection] = useState<Section>(init.s && SECTIONS.some((x) => x.id === init.s) ? init.s : "overview");
  const [health, setHealth] = useState<Health | null>(null);
  const [networks, setNetworks] = useState<Network[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [sims, setSims] = useState<Simulation[]>([]);
  const [netSel, setNetSel] = useState<string | null>(init.n);
  const [scenSel, setScenSel] = useState<string | null>(init.sc);
  const [simSel, setSimSel] = useState<string | null>(init.sim);
  const [expSel, setExpSel] = useState<string | null>(init.exp);
  const [newScenFor, setNewScenFor] = useState<string | null>(null);
  const [simPreset, setSimPreset] = useState<{ network: string; scenario?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const fail = (e: any) => setError(e?.message ?? String(e));
  const loadNetworks = () => api.networks().then(setNetworks).catch(fail);
  const loadScenarios = () => api.scenarios().then(setScenarios).catch(fail);
  const loadSims = () => api.simulations().then(setSims).catch(fail);

  useEffect(() => {
    loadNetworks(); loadScenarios(); loadSims();
    api.health().then(setHealth).catch(() => {});
  }, []);

  // keep the hash in step with what is open
  useEffect(() => {
    const h = new URLSearchParams();
    h.set("s", section);
    if (section === "network" && netSel) h.set("n", netSel);
    if (section === "scenario" && scenSel) h.set("sc", scenSel);
    if (section === "results" && simSel) h.set("sim", simSel);
    if (section === "experiments" && expSel) h.set("exp", expSel);
    window.history.replaceState(null, "", `#${h.toString()}`);
  }, [section, netSel, scenSel, simSel, expSel]);

  // poll while any simulation runs; when one finishes, the lists refresh so Results can show it
  const running = sims.some((s) => s.state === "running");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(loadSims, 1500);
    return () => clearInterval(t);
  }, [running]);

  function go(s: Section) { setSection(s); window.scrollTo(0, 0); setError(null); }

  async function openFile(file: File) {
    try {
      const bundle = JSON.parse(await file.text());
      if (!bundle?.scenario?.base_network) throw new Error("This file is not a saved scenario or experiment.");
      const s = await api.importBundle(bundle);
      await loadScenarios();
      setScenSel(s.id); go("scenario");
    } catch (e: any) { setError(`Could not open the file: ${e.message}`); }
    if (fileRef.current) fileRef.current.value = "";
  }

  const done = sims.filter((s) => s.state === "done");
  const counts = { networks: networks.length, scenarios: scenarios.filter((s) => !s.baseline).length, sims: sims.length };

  return (
    <div className="app">
      <header className="bar">
        <div className="brand"><span className="mark" aria-hidden="true" />Junction</div>
        <p className="tag">Test a street change before you build it.</p>
        {user && (
          <div className="bar-actions">
            <span className="bar-user" title={user.email}>{user.name}</span>
            <button className="btn small bar-btn" onClick={onSignOut}>Sign out</button>
          </div>
        )}
        <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && openFile(e.target.files[0])} />
      </header>

      <div className="shell">
        <nav className="side" aria-label="Sections">
          {SECTIONS.map((s) => (
            <button key={s.id} className="side-item" aria-current={section === s.id ? "page" : undefined} aria-label={s.name}
              onClick={() => { if (s.id === "results") setSimSel(null); if (s.id === "experiments") setExpSel(null); go(s.id); }}>
              <Icon d={s.icon} />
              <span className="side-name">{s.name}</span><span className="side-short" aria-hidden="true">{s.short}</span>
              {s.id === "simulation" && running && <span className="spinner" aria-label="running" />}
              {s.id === "results" && done.length > 0 && <span className="count">{done.length}</span>}
            </button>
          ))}
        </nav>

        <div className="content">
          {error && (
            <div className="banner q-error toast" role="alert">
              <p className="banner-title">Something went wrong</p>
              <p>{error}</p>
              <button className="btn quiet small" onClick={() => setError(null)}>Dismiss</button>
            </div>
          )}

          {section === "overview" && (
            <Overview networks={networks} scenarios={scenarios} sims={sims} go={go} openResult={(id) => { setSimSel(id); go("results"); }} />
          )}

          {section === "network" && (
            <NetworkExplorer networks={networks} selected={netSel} onSelect={setNetSel} onChanged={loadNetworks} fail={fail}
              onBuildScenario={(nid) => { setNewScenFor(nid); setScenSel(null); go("scenario"); }} />
          )}
          {section === "scenario" && (
            <ScenarioBuilder networks={networks} scenarios={scenarios} selected={scenSel} onSelect={(id) => { setScenSel(id); setNewScenFor(null); }}
              onChanged={loadScenarios} presetNetwork={newScenFor} fail={fail} onOpenFile={() => fileRef.current?.click()}
              onSimulate={(s) => { setSimPreset({ network: s.base_network, scenario: s.baseline ? undefined : s.id }); go("simulation"); }} />
          )}
          {section === "simulation" && (
            <SimulationPage networks={networks} scenarios={scenarios} sims={sims} health={health} preset={simPreset} fail={fail}
              onChanged={loadScenarios} onStarted={loadSims} onResults={(id) => { setSimSel(id); go("results"); }}
              onEditScenario={(id) => { setScenSel(id); go("scenario"); }} />
          )}
          {section === "results" && (
            <ResultsPage sims={sims} networks={networks} selected={simSel} onSelect={setSimSel} fail={fail}
              onEditScenario={(id) => { setScenSel(id); go("scenario"); }} onOpenFile={() => fileRef.current?.click()}
              onExperiment={(id) => { setExpSel(id); go("experiments"); }} />
          )}
          {section === "experiments" && (
            <Experiments sims={sims} networks={networks} fail={fail} onChanged={loadSims} onOpenFile={() => fileRef.current?.click()}
              selected={expSel} onSelect={setExpSel} onScenario={(id) => { setScenSel(id); go("scenario"); }}
              onOpen={(id) => { setSimSel(id); go("results"); }} />
          )}
          {section === "research" && (
            <Research networks={networks} scenarios={scenarios} onChanged={loadScenarios} fail={fail} />
          )}
        </div>
      </div>
    </div>
  );
}
