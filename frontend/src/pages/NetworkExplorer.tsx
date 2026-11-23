import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import MapView, { edgeLabel, featureBBox, type Selection } from "../MapView";
import FindList, { type Item } from "../FindList";
import { Legend } from "../shared";
import type { EdgeProps, Geometry, Network, SignalProgram, SignalProps } from "../types";

type Props = {
  networks: Network[];
  selected: string | null;
  onSelect: (nid: string | null) => void;
  onChanged: () => void;
  onBuildScenario: (nid: string) => void;
  fail: (e: unknown) => void;
};

type AddMode = "area" | "osm" | "sumo";

export function useNetworkMap(nid: string | null, fail: (e: unknown) => void) {
  const [geo, setGeo] = useState<Geometry | null>(null);
  const [signals, setSignals] = useState<Record<string, SignalProgram> | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setGeo(null); setSignals(null);
    if (!nid) return;
    let off = false;
    setLoading(true);
    Promise.all([api.networkGeometry(nid), api.networkSignals(nid)])
      .then(([g, s]) => { if (!off) { setGeo(g); setSignals(s); } })
      .catch((e) => !off && fail(e))
      .finally(() => !off && setLoading(false));
    return () => { off = true; };
  }, [nid]);
  return { geo, signals, loading };
}

export function itemsFor(geo: Geometry | null): Item[] {
  if (!geo) return [];
  const edges: Record<string, EdgeProps> = {};
  geo.features.forEach((f) => { if (f.properties.kind === "edge") edges[f.properties.id] = f.properties as EdgeProps; });
  return geo.features.map((f) => {
    if (f.properties.kind === "edge") {
      const p = f.properties as EdgeProps;
      return { kind: "edge" as const, id: p.id, label: edgeLabel(p), changed: !!geo.edited?.[p.id],
        sub: `${p.car_allowed ? `${p.lanes} lane${p.lanes === 1 ? "" : "s"}, ${Math.round(p.speed_kmh)} km/h` : "closed"}, ${Math.round(p.length_m)} m` };
    }
    const s = f.properties as SignalProps;
    return { kind: "signal" as const, id: s.id, label: signalLabel(s, edges), sub: `${s.incoming.length} approaches` };
  }).sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === "signal" ? -1 : 1));
}

export function signalLabel(s: SignalProps, edges: Record<string, EdgeProps>) {
  const names = [...new Set(s.incoming.map((e) => edges[e]?.name).filter(Boolean))];
  return names.length ? `Signal at ${names.slice(0, 2).join(" / ")}` : `Signal ${s.id.length > 18 ? s.id.slice(0, 16) + "…" : s.id}`;
}

export default function NetworkExplorer({ networks, selected, onSelect, onChanged, onBuildScenario, fail }: Props) {
  const [adding, setAdding] = useState<AddMode | null>(null);
  const { geo, signals, loading } = useNetworkMap(adding ? null : selected, fail);
  const [sel, setSel] = useState<Selection>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ bbox: [number, number, number, number]; key: number; maxZoom?: number } | null>(null);
  const [bounds, setBounds] = useState<{ bbox: [number, number, number, number]; km2: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { setSel(null); setConfirmDelete(false); setFocus(null); }, [selected]);

  const net = networks.find((n) => n.id === selected);
  const items = useMemo(() => itemsFor(geo), [geo]);
  const edges = useMemo(() => {
    const m: Record<string, EdgeProps> = {};
    geo?.features.forEach((f) => { if (f.properties.kind === "edge") m[f.properties.id] = f.properties as EdgeProps; });
    return m;
  }, [geo]);
  const zoomTo = (kind: "edge" | "signal", id: string) => {
    const f = geo?.features.find((x) => x.properties.kind === kind && x.properties.id === id);
    if (f) setFocus({ bbox: featureBBox(f), key: Date.now(), maxZoom: kind === "signal" ? 17 : 17.5 });
  };

  async function remove() {
    if (!net) return;
    try { await api.deleteNetwork(net.id); onSelect(null); onChanged(); } catch (e) { fail(e); }
  }

  return (
    <main className="work">
      <div className="stage">
        {adding === "area" ? (
          <>
            <MapView geometry={null} mode="layout" selection={null} onSelect={() => {}} basemap focus={focus}
              onBounds={(bbox, km2) => setBounds({ bbox, km2 })} />
            <div className="area-frame" aria-hidden="true" />
          </>
        ) : geo ? (
          <>
            <MapView geometry={geo} mode="layout" selection={sel} onSelect={setSel} hoverId={hoverId} focus={focus} />
            <div className="map-top">
              <FindList variant="dropdown" items={items} onPick={(s) => { if (s) { setSel(s); zoomTo(s.kind, s.id); } }} onHover={setHoverId} />
            </div>
            <Legend mode="layout" />
          </>
        ) : (
          <div className="empty-stage"><p>{loading ? "Loading the network…" : "Pick a network to see its map."}</p></div>
        )}
      </div>

      <aside className="panel">
        <div className="panel-body">
          {adding ? (
            <AddNetwork mode={adding} setMode={setAdding} bounds={bounds} onFocus={(bbox) => setFocus({ bbox, key: Date.now(), maxZoom: 16 })}
              onDone={(n) => { setAdding(null); onChanged(); onSelect(n.id); }} fail={fail} />
          ) : (
            <section className="step">
              <div className="row spread">
                <h2>Network Explorer</h2>
                <button className="btn secondary small" onClick={() => setAdding("area")}>Add network</button>
              </div>
              <p className="lead">Your road networks. Add one from OpenStreetMap or a SUMO file, then build scenarios on it.</p>
              <div className="nets" role="listbox" aria-label="Networks">
                {networks.map((n) => (
                  <button key={n.id} role="option" aria-selected={n.id === selected} className="net" onClick={() => onSelect(n.id)}>
                    <span className="net-name">{n.name}{n.kind === "imported" && <span className="chip">imported</span>}</span>
                    <span className="net-desc">{n.description}</span>
                    {n.edges != null && <span className="net-stats">{n.signals} signals, {n.edges} roads, {n.trips?.toLocaleString()} trips</span>}
                    {n.note && <span className="net-note">{n.note}</span>}
                  </button>
                ))}
              </div>

              {net && (
                <div className="card net-current">
                  <p className="big">{net.name}</p>
                  {net.license && <p className="small muted">Data: {net.license}</p>}
                  <div className="row">
                    <button className="primary" onClick={() => onBuildScenario(net.id)}>Build a scenario on this network</button>
                    {net.kind === "imported" && !confirmDelete && <button className="btn danger small" onClick={() => setConfirmDelete(true)}>Delete network</button>}
                  </div>
                  {confirmDelete && (
                    <div className="banner q-caution">
                      <p>Delete {net.name} from the library? Its scenarios and past results stay, but can no longer be run.</p>
                      <div className="row">
                        <button className="btn secondary small" onClick={remove}>Delete</button>
                        <button className="btn quiet small" onClick={() => setConfirmDelete(false)}>Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {net && geo && (
                <>
                  {sel && <Inspector sel={sel} edges={edges} geo={geo} signals={signals} onClose={() => setSel(null)} />}
                  <div className="browse">
                    <h3>Roads and signals</h3>
                    <FindList variant="list" items={items} selectedId={sel?.id ?? null} onHover={setHoverId}
                      onPick={(s) => { if (s) { setSel(s); zoomTo(s.kind, s.id); } }} />
                  </div>
                </>
              )}
            </section>
          )}
        </div>
      </aside>
    </main>
  );
}

function Inspector({ sel, edges, geo, signals, onClose }: {
  sel: NonNullable<Selection>; edges: Record<string, EdgeProps>; geo: Geometry; signals: Record<string, SignalProgram> | null; onClose: () => void;
}) {
  if (sel.kind === "edge") {
    const e = edges[sel.id];
    if (!e) return null;
    return (
      <div className="selected-card">
        <div className="row spread"><h3>{edgeLabel(e)}</h3><button className="btn quiet small" onClick={onClose}>Close</button></div>
        <dl className="facts">
          <dt>Lanes</dt><dd>{e.car_allowed ? e.lanes : "closed to cars"}</dd>
          <dt>Speed limit</dt><dd>{Math.round(e.speed_kmh)} km/h</dd>
          <dt>Length</dt><dd>{Math.round(e.length_m)} m</dd>
          {e.road_type && <><dt>Type</dt><dd>{e.road_type.replace(/_/g, " ")}</dd></>}
          <dt>Id</dt><dd className="mono">{e.id}</dd>
        </dl>
      </div>
    );
  }
  const node = geo.features.find((f) => f.properties.kind === "signal" && f.properties.id === sel.id)?.properties as SignalProps | undefined;
  const prog = node?.tls.map((t) => signals?.[t]).find(Boolean);
  return (
    <div className="selected-card">
      <div className="row spread"><h3>{node ? signalLabel(node, edges) : `Signal ${sel.id}`}</h3><button className="btn quiet small" onClick={onClose}>Close</button></div>
      <dl className="facts">
        <dt>Approaches</dt><dd>{node?.incoming.length ?? "?"}</dd>
        <dt>Cycle</dt><dd>{prog ? `${Math.round(prog.cycle_s)} s, ${prog.phases.length} phases` : "not editable"}</dd>
        <dt>Id</dt><dd className="mono">{sel.id}</dd>
      </dl>
    </div>
  );
}

type Place = { display_name: string; boundingbox: [string, string, string, string] };

function AddNetwork({ mode, setMode, bounds, onFocus, onDone, fail }: {
  mode: AddMode; setMode: (m: AddMode | null) => void; bounds: { bbox: [number, number, number, number]; km2: number } | null;
  onFocus: (bbox: [number, number, number, number]) => void; onDone: (n: Network) => void; fail: (e: unknown) => void;
}) {
  const [name, setName] = useState("");
  const [trips, setTrips] = useState<string>("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [placeErr, setPlaceErr] = useState<string | null>(null);
  const LIMIT = 6;
  const tooBig = !!bounds && bounds.km2 > LIMIT;

  async function search() {
    setPlaceErr(null); setPlaces(null);
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`, { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error(`search failed (${r.status})`);
      setPlaces(await r.json());
    } catch (e: any) { setPlaceErr(`Place search is unavailable (${e.message}). Move the map by hand instead.`); }
  }
  async function go() {
    setBusy(true);
    const nm = name.trim() || (mode === "area" ? (q.trim() || "Imported area") : file?.name.replace(/\..*$/, "") || "Imported network");
    const t = trips ? Math.max(10, Math.round(Number(trips))) : undefined;
    try {
      const n = mode === "area" ? await api.importOsmArea(bounds!.bbox, nm, t)
        : mode === "osm" ? await api.importOsmFile(file!, nm, t) : await api.importSumo(file!, nm, t);
      onDone(n);
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  return (
    <section className="step">
      <div className="row spread">
        <h2>Add a network</h2>
        <button className="btn quiet small" onClick={() => setMode(null)}>Cancel</button>
      </div>
      <div className="seg wide" role="tablist" aria-label="Source">
        <button role="tab" aria-selected={mode === "area"} onClick={() => setMode("area")}>Map area</button>
        <button role="tab" aria-selected={mode === "osm"} onClick={() => setMode("osm")}>OSM file</button>
        <button role="tab" aria-selected={mode === "sumo"} onClick={() => setMode("sumo")}>SUMO file</button>
      </div>

      {mode === "area" && (
        <>
          <p className="lead">Move the map to the area you want. Everything inside the frame is downloaded from OpenStreetMap.</p>
          <div className="row nowrap">
            <input type="search" className="grow" value={q} placeholder="Find a place, e.g. Shivajinagar, Pune" aria-label="Find a place"
              onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && q && search()} />
            <button className="btn secondary small" disabled={!q} onClick={search}>Search</button>
          </div>
          {placeErr && <p className="small muted">{placeErr}</p>}
          {places && (
            <ul className="places">
              {places.length === 0 && <li className="small muted">No place found.</li>}
              {places.map((p, i) => (
                <li key={i}><button className="link" onClick={() => {
                  const [s, n, w, e] = p.boundingbox.map(Number);
                  onFocus([w, s, e, n]); setPlaces(null); if (!name) setName(p.display_name.split(",")[0]);
                }}>{p.display_name}</button></li>
              ))}
            </ul>
          )}
          <p className={`small ${tooBig ? "warn-text" : "muted"}`}>
            {bounds ? `Area in the frame: ${bounds.km2.toFixed(2)} km² (limit ${LIMIT} km²).` : "Move the map to choose an area."}
            {tooBig && " Zoom in to make it smaller."}
          </p>
          <p className="small muted">Map data © OpenStreetMap contributors. Place search by Nominatim.</p>
        </>
      )}
      {mode === "osm" && (
        <>
          <p className="lead">Upload an OpenStreetMap file (.osm, .osm.gz or .osm.bz2), for example exported from openstreetmap.org.</p>
          <input type="file" accept=".osm,.xml,.gz,.bz2" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </>
      )}
      {mode === "sumo" && (
        <>
          <p className="lead">Upload a SUMO network (.net.xml), or a .zip with one .net.xml and one .rou.xml to use its own traffic.</p>
          <input type="file" accept=".xml,.zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </>
      )}

      <label className="field block">
        <span className="label">Name</span>
        <input type="text" className="text" value={name} placeholder="e.g. Shivajinagar centre" onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field block">
        <span className="label">Trips in one hour <span className="muted">(optional)</span></span>
        <input type="number" className="text" min={10} max={50000} value={trips} placeholder="Automatic: about 150 per km of road"
          onChange={(e) => setTrips(e.target.value)} />
        <span className="small muted">OpenStreetMap has no traffic counts, so traffic is generated randomly{mode === "sumo" ? " unless the zip has a route file" : ""}.</span>
      </label>
      <button className="primary wide" disabled={busy || (mode === "area" ? !bounds || tooBig : !file)} onClick={go}>
        {busy ? "Importing… this can take a minute" : "Import network"}
      </button>
      {busy && <p className="status-line" role="status"><span className="spinner" aria-hidden="true" />Downloading and converting the roads, then generating traffic.</p>}
    </section>
  );
}
