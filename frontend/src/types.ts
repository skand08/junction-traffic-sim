export type Network = {
  id: string; name: string; description: string; kind: string;
  edges?: number; signals?: number; trips?: number; geo?: boolean; license?: string; note?: string;
  source?: string; created?: number; prepared?: boolean;
};

export type Edit =
  | { type: "set_lanes"; edge: string; lanes: number }
  | { type: "set_speed"; edge: string; speed_kmh: number }
  | { type: "close_road"; edge: string }
  | { type: "ban_turn"; from_edge: string; to_edge: string }
  | { type: "retime_signal"; tls: string; durations: number[] }
  | { type: "add_signal"; node: string }
  | { type: "remove_signal"; node: string }
  | { type: "set_lane_width"; edge: string; width_m: number }
  | { type: "set_road_type"; edge: string; road_type: RoadType };

export type RoadType = "local" | "collector" | "arterial" | "major_arterial" | "expressway";
/** Same presets as the backend (scenario.ROAD_TYPES): speed limit + right of way at unsignalled junctions. */
export const ROAD_TYPES: { id: RoadType; label: string; speed_kmh: number; priority: number }[] = [
  { id: "local", label: "Local street", speed_kmh: 30, priority: 3 },
  { id: "collector", label: "Collector road", speed_kmh: 40, priority: 6 },
  { id: "arterial", label: "Arterial road", speed_kmh: 50, priority: 9 },
  { id: "major_arterial", label: "Major arterial", speed_kmh: 60, priority: 11 },
  { id: "expressway", label: "Expressway", speed_kmh: 80, priority: 13 },
];

export type Controller = "fixed" | "actuated" | "max_pressure";

export type Scenario = {
  id: string; name: string; base_network: string; demand_scale: number;
  controller: Controller; edits: Edit[]; parent_id?: string | null;
  description?: string; baseline?: boolean; created?: number; calibration?: string | null;
};

export type EdgeProps = {
  kind: "edge"; id: string; name: string; lanes: number; speed_kmh: number; length_m: number;
  road_type: string; from_node: string; to_node: string; car_allowed: boolean;
  priority?: number; lane_width_m?: number;
  label?: string; heading?: string;
};
export type SignalProps = { kind: "signal"; id: string; tls: string[]; incoming: string[]; outgoing: string[] };
/** An unsignalled junction where a signal could be added (two or more roads in for cars). */
export type JunctionProps = { kind: "junction"; id: string; control: string; incoming: string[]; outgoing: string[] };
export type Feature = {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number][] } | { type: "Point"; coordinates: [number, number] };
  properties: EdgeProps | SignalProps | JunctionProps;
};
export type Geometry = { features: Feature[]; bbox: [number, number, number, number]; geo: boolean; edited: Record<string, string[]> };

export type SignalProgram = {
  program_id: string; type: string; cycle_s: number; links: number;
  phases: { duration: number; state: string }[]; retimed_durations: number[] | null;
  link_info?: { index: number; from_edge: string; to_edge: string; turn: string; from_label?: string; to_label?: string }[];
};

export type Job = {
  id: string; run_id: string; scenario_id: string;
  state: "queued" | "building" | "running" | "done" | "failed" | "cancelled";
  done: number; total: number; message: string; warnings: string[]; error: string | null;
  stage?: "build" | "simulation" | null; trace?: string | null; seeds?: number[]; done_seeds?: number[]; created?: number;
};
export type Versions = { app: string; sumo: string; python?: string };
export type Health = {
  ok: boolean; workers: number; versions: Versions;
  settings: { time_to_teleport_s: number; ignore_junction_blocker_s: number; step_length_s: number; drain_s: number; default_seeds: number };
};
export type RunSummary = {
  id: string; scenario_id: string; scenario_name: string; base_network?: string; controller?: Controller;
  demand_scale?: number; edits?: number; state: string; seeds: number[]; started?: number; finished?: number;
  versions?: Versions; teleports?: number | null; mean_travel_time_s?: number | null;
  parent_id?: string | null; error?: string | null; stage?: string | null; depart_jitter_s?: number;
};
export type Experiment = { id: string; before: RunSummary; after: RunSummary };
export type SimPart = { scenario_id: string; scenario_name: string; run_id: string; job: Job };
export type Simulation = {
  id: string; name: string; network: string; created: number; seeds: number[]; depart_jitter_s: number;
  reference: SimPart; alternatives: SimPart[]; state: "running" | "done" | "failed" | "cancelled" | "missing";
  rerun_of?: string | null;
};
export type Bundle = {
  bundle_version: string; scenario: Scenario; run: { seeds: number[] };
  simulator?: { version: string }; app?: { version: string };
  experiment?: {
    before_run: string; after_run: string; baseline: Scenario; seeds: number[]; versions?: Versions; depart_jitter_s?: number;
    values: Record<string, { before: (number | null)[]; after: (number | null)[] }>;
  };
};

export type KpiAgg = { label: string; unit: string; lower_is_better: boolean; mean: number | null; ci_low: number | null; ci_high: number | null; values?: (number | null)[] };
export type EdgeAgg = { speed_kmh: number | null; delay_per_veh_s: number | null; volume: number };
export type Run = {
  id: string; state: string; warnings: string[]; scenario: Scenario; seeds: number[]; started?: number; finished?: number;
  versions?: Versions; build?: { unroutable_trips: number; total_trips: number }; error?: string; stage?: string;
  depart_jitter_s?: number;
  aggregate: { kpis: Record<string, KpiAgg>; edges: Record<string, EdgeAgg>; seeds: number[] };
};

export type KpiCmp = {
  label: string; unit: string; lower_is_better: boolean; before: number; after: number; diff: number;
  diff_ci_low: number | null; diff_ci_high: number | null; pct_change: number | null; share_seeds_better: number;
  ties?: number; n: number; significant: boolean; pairs?: [number, number | null, number | null][]; verdict: "better" | "worse" | "no change"; confidence: "high" | "medium" | "low";
};
export type EdgeCmp = { change: "better" | "worse" | "unchanged" | "new" | "removed"; delay_change_s?: number | null; speed_change_kmh?: number | null };
export type Comparison = {
  headline: string; paired_seeds: number[]; kpis: Record<string, KpiCmp>; edges: Record<string, EdgeCmp>;
  matched?: { trips: number; share: number };
  before?: { run: string; scenario: Scenario }; after?: { run: string; scenario: Scenario };
};

/** One finished simulation with its headline numbers (GET /api/results). */
export type ResultAlt = {
  scenario_id: string; scenario_name: string; run_id: string; controller?: Controller; edits: number;
  before_s: number | null; after_s: number | null; diff_s: number | null; pct: number | null;
  verdict: "better" | "worse" | "no change" | null; confidence?: string; better: number; n: number | null;
  teleports_before?: number | null; teleports_after?: number | null;
};
export type ResultSummary = {
  id: string; name: string; network: string; created: number; seeds: number[]; depart_jitter_s: number;
  rerun_of?: string | null; reference_name: string; alternatives: ResultAlt[];
  versions?: Versions; started?: number; finished?: number;
};

/* ---------- live simulation ---------- */
export type LiveRoute = { from_edge: string; to_edge: string; per_hour: number };
export type LiveSetup = {
  scenario_id: string; controller?: Controller | "rl" | "external" | null; rl_agent?: string | null; rl_checkpoint?: string;
  external?: ExternalCfg | null;
  intensity: "low" | "medium" | "high"; profile: "normal" | "morning" | "evening";
  mix: "data" | "cars" | "mixed" | "two_wheelers"; duration_min: number; routes: LiveRoute[]; seed?: number;
};
export type LiveInfo = {
  id: string; config: LiveSetup; scenario_name: string; network: string; controller: Controller | "rl" | "external"; rl_agent?: string | null; external?: string | null;
  begin: number; window_end: number; stop: number; warnings: string[];
  state: "starting" | "running" | "paused" | "finished" | "failed"; error: string | null; t: number | null; run: number;
};
/** [id, lon, lat, angle, km/h, type (0 car, 1 two-wheeler, 2 bus, 3 truck), waiting s] */
export type LiveVehicle = [string, number, number, number, number, number, number];
export type LiveKpi = {
  running: number; mean_speed_kmh: number; mean_wait_s: number; halting_pct: number; throughput_per_h: number;
  arrived: number; departed: number; teleports: number; waiting_to_enter: number;
};
export type LiveLane = { index: number; vehicles: number; halting: number; speed_kmh: number; limit_kmh: number; occupancy_pct: number; width_m: number; allowed: string[] };
export type LiveWatch =
  | { edge: string; lanes: LiveLane[]; travel_time_s: number }
  | { tls: string; state: string; phase: number; next_switch_s: number | null; phases: { duration: number; state: string }[];
      approaches: { lane: string; edge: string; states: string; halting: number; vehicles: number }[];
      agent?: { t: number; chosen: number; held: boolean; kind: "value" | "probability" | "queue"; values: number[]; phases: string[] } | null }
  | { error: string };
export type LiveFrame = {
  kind: "frame"; seq: number; run: number; t: number; state: LiveInfo["state"]; speed: number;
  veh: LiveVehicle[]; edges: Record<string, [number, number, number, number]>;
  tls: Record<string, [string, number, number | null]>; kpi: LiveKpi;
  hist: [number, number, number, number, number][]; watch: LiveWatch | null;
};
export type LiveStatic = { lanes: [string, string, number, boolean, [number, number][]][]; signal_marks: [string, number, number, number][]; geo: boolean };

/* ---------- research mode ---------- */
export type RLAlgorithm = "dqn" | "double_dqn" | "ppo";
export type AgentConfig = {
  name: string; scenario_id: string; algorithm: RLAlgorithm; sharing: "shared" | "independent";
  observation: { reach_m: number; features: ("queue" | "approaching" | "out_queue" | "phase" | "elapsed")[] };
  action: { delta_t: number; min_green: number; amber: number; all_red: number };
  reward: "pressure" | "queue" | "waiting";
  training: { episodes: number; episode_min: number; demand_scales: number[]; seed: number; checkpoint_every: number };
  hyper: {
    lr: number; gamma: number; hidden: number[]; batch: number; buffer: number; learning_starts: number; target_update: number;
    eps_start: number; eps_end: number; eps_decay_frac: number; clip: number; epochs: number; minibatch: number;
    gae_lambda: number; ent_coef: number; vf_coef: number;
  };
  parent_id?: string | null; note?: string;
};
export type AgentInfo = {
  id: string; config: AgentConfig; checkpoints: string[]; has_model: boolean; has_best: boolean;
  manifest: { created: number; versions: Versions; network: string; net_sha: string; scenario_name?: string; episode_seeds: number[]; numerics: string };
  status: { state: "queued" | "running" | "paused" | "pausing" | "stopping" | "done" | "stopped" | "failed" | "interrupted";
    episode?: number; episodes_done: number; episodes: number; agents?: number; n_obs?: number; n_act?: number;
    best_episode?: number; error?: string; created: number; finished?: number };
};
export type EpisodeRow = {
  episode: number; demand_scale: number; seed: number; wall_s: number; epsilon: number | null; entropy: number | null;
  reward: number; reward_sum: number; decisions: number; travel_time_s: number | null; arrived: number;
  mean_stopped: number; teleports: number; loss: number | null;
};
export type ExternalCfg = { url: string; name: string; timeout_s?: number; delta_t?: number; min_green?: number; amber?: number; all_red?: number; reach_m?: number };
export type ControllerSpec = { kind: "fixed" | "actuated" | "max_pressure" | "rl" | "external"; agent_id?: string; checkpoint?: string; label?: string; external?: ExternalCfg };
export type BenchConfig = {
  name: string; scenario_id: string; heldout_ids: string[]; controllers: ControllerSpec[]; reference: number;
  demand_levels: number[]; seeds: number; first_seed: number; depart_jitter_s: number;
};
export type BenchInfo = {
  id: string; config: BenchConfig;
  manifest: { created: number; versions: Versions; seeds: number[]; labels: string[]; depart_jitter_s: number;
    scenarios: { id: string; name: string; network: string; edits: Edit[]; demand_scale: number }[];
    models: Record<string, { file: string; sha: string; config: AgentConfig; manifest: AgentInfo["manifest"] }>;
    external?: (ExternalCfg & { label: string })[] };
  status: { state: "queued" | "running" | "done" | "failed" | "cancelled" | "interrupted"; done: number; total: number; error?: string; created: number; started?: number; finished?: number };
};
export type MeasureStat = { mean: number | null; ci_low: number | null; ci_high: number | null; n: number; values: number[] };
export type VsRef = { diff: number | null; diff_ci_low: number | null; diff_ci_high: number | null; pct_change: number | null; share_seeds_better: number; n: number; significant: boolean; verdict: string };
export type BenchStats = {
  measures: Record<string, { label: string; unit: string; lower_is_better: boolean }>;
  reference: number; labels: string[];
  conditions: { scenario_id: string; scenario: string; network: string; demand: number; heldout: boolean;
    rows: { controller: number; label: string; measures: Record<string, MeasureStat>; vs_reference: Record<string, VsRef> | null; runs: number; errors: string[]; teleport_trips: number }[] }[];
  robustness: { controller: number; label: string; conditions: number; better: number; worse: number; mean_pct: number | null; worst_pct: number | null }[];
};

/* ---------- integrations ---------- */
export type ControllerTestResult = { ok: boolean; ms: number; reply: unknown; note: string };
export type EnvExportCfg = {
  observation: AgentConfig["observation"]; action: AgentConfig["action"]; reward: AgentConfig["reward"];
  episode_min: number; demand_scales: number[];
};
export type CalibrationRow = { edge: string; count: number; in_demand: number; simulated: number; geh_demand: number; geh_simulated: number; reachable: boolean };
export type Calibration = {
  id: string; scenario_id: string; network: string; created: number; problems: string[]; seed: number;
  counts?: { edge: string; count: number }[];
  status: { state: "queued" | "running" | "done" | "failed"; step?: string | null; error?: string; started?: number; finished?: number };
  report: null | {
    rows: CalibrationRow[]; begin: number; end: number; warnings: string[];
    summary: { counted_roads: number; geh_under_5: number; share_geh_under_5: number; target_vehicles: number; demand_vehicles: number;
      simulated_vehicles: number; original_trips: number; kept_trips: number; replaced_trips: number; fitted_trips: number; total_trips: number; candidate_routes: number };
  };
};
