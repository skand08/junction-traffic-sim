import type { Bundle, Comparison, Edit, Geometry, Health, Job, Network, Run, RunSummary, Scenario, SignalProgram } from "./types";

const BASE = (import.meta as any).env?.VITE_API ?? "/api";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
/** The scenario or run this page refers to is gone from the server (restarted with other data). */
export const isLost = (e: unknown) => e instanceof ApiError && e.status === 404 && /^(scenario|run|job) '/.test(e.message);

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(BASE + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!r.ok) {
    let msg = `Request failed (${r.status})`;
    try {
      const j = await r.json();
      msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch { /* keep default */ }
    throw new ApiError(msg, r.status);
  }
  return r.json();
}

export const api = {
  health: () => req<Health>("/health"),
  networks: () => req<Network[]>("/networks"),
  scenario: (id: string) => req<{ scenario: Scenario; warnings: string[] }>(`/scenarios/${id}`),
  scenarios: () => req<Scenario[]>("/scenarios"),
  runs: (scenarioId?: string) => req<RunSummary[]>(`/runs${scenarioId ? `?scenario_id=${scenarioId}` : ""}`),
  cancel: (jobId: string) => req<Job>(`/jobs/${jobId}/cancel`, { method: "POST" }),
  createScenario: (base_network: string, name: string) =>
    req<Scenario>("/scenarios", { method: "POST", body: JSON.stringify({ base_network, name }) }),
  copyScenario: (id: string, name: string) =>
    req<Scenario>(`/scenarios/${id}/copy?name=${encodeURIComponent(name)}`, { method: "POST" }),
  updateScenario: (id: string, body: Partial<{ name: string; demand_scale: number; controller: string; edits: Edit[] }>) =>
    req<{ scenario: Scenario; warnings: string[] }>(`/scenarios/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  geometry: (id: string) => req<Geometry>(`/scenarios/${id}/geometry`),
  signals: (id: string) => req<Record<string, SignalProgram>>(`/scenarios/${id}/signals`),
  startRun: (id: string, seeds: number | number[], depart_jitter_s = 0) =>
    req<Job>(`/scenarios/${id}/runs`, { method: "POST", body: JSON.stringify({ seeds, depart_jitter_s }) }),
  job: (id: string) => req<Job>(`/jobs/${id}`),
  run: (id: string) => req<Run>(`/runs/${id}`),
  compare: (before: string, after: string) => req<Comparison>(`/compare?before=${before}&after=${after}`),
  bundleUrl: (id: string, o?: { seeds?: number; first?: number; before?: string; after?: string }) => {
    const q = new URLSearchParams();
    if (o?.seeds) q.set("seeds", String(o.seeds));
    if (o?.first) q.set("first_seed", String(o.first));
    if (o?.before && o?.after) { q.set("before", o.before); q.set("after", o.after); }
    const s = q.toString();
    return `${BASE}/scenarios/${id}/bundle${s ? `?${s}` : ""}`;
  },
  bundle: (id: string, before: string, after: string) =>
    req<Bundle>(`/scenarios/${id}/bundle?before=${before}&after=${after}`),
  importBundle: (bundle: unknown) => req<Scenario>("/bundles", { method: "POST", body: JSON.stringify(bundle) }),
};
