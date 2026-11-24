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
  description?: string; baseline?: boolean; created?: number;
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
  scenario_id: string; controller?: Controller | null;
  intensity: "low" | "medium" | "high"; profile: "normal" | "morning" | "evening";
  mix: "data" | "cars" | "mixed" | "two_wheelers"; duration_min: number; routes: LiveRoute[]; seed?: number;
};
export type LiveInfo = {
  id: string; config: LiveSetup; scenario_name: string; network: string; controller: Controller;
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
      approaches: { lane: string; edge: string; states: string; halting: number; vehicles: number }[] }
  | { error: string };
export type LiveFrame = {
  kind: "frame"; seq: number; run: number; t: number; state: LiveInfo["state"]; speed: number;
  veh: LiveVehicle[]; edges: Record<string, [number, number, number, number]>;
  tls: Record<string, [string, number, number | null]>; kpi: LiveKpi;
  hist: [number, number, number, number, number][]; watch: LiveWatch | null;
};
export type LiveStatic = { lanes: [string, string, number, boolean, [number, number][]][]; signal_marks: [string, number, number, number][]; geo: boolean };
