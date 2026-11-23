import { useEffect, useMemo, useRef, useState } from "react";
import DeckGL from "@deck.gl/react";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { WebMercatorViewport } from "@deck.gl/core";
import { Map } from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import type { EdgeAgg, EdgeCmp, EdgeProps, Feature, Geometry, SignalProps } from "./types";

export type MapMode = "layout" | "results" | "change";
export type Selection = { kind: "edge" | "signal"; id: string } | null;

const BASEMAP = "https://tiles.openfreemap.org/styles/positron";
type RGBA = [number, number, number, number];
// Colour roles (design system): amber is only selection/hover; red is never a map colour.
export const C = {
  road: [91, 99, 107, 255] as RGBA,       // ink-2
  closedEdge: [38, 43, 48, 255] as RGBA,  // closed roads: hollow ink double line
  closedCore: [250, 251, 249, 255] as RGBA,
  edited: [15, 91, 69, 255] as RGBA,      // sign green
  halo: [242, 183, 5, 255] as RGBA,       // amber: selection only
  better: [47, 109, 181, 255] as RGBA,
  worse: [200, 98, 42, 255] as RGBA,
  same: [197, 204, 200, 255] as RGBA,
  noData: [214, 219, 216, 255] as RGBA,
};

// delay per vehicle (s) -> single-hue magenta ramp, light to dark (no amber, no red)
const DELAY_STOPS: [number, RGBA][] = [
  [0, [237, 231, 241, 255]], [10, [201, 166, 201, 255]], [25, [163, 92, 150, 255]],
  [50, [110, 36, 104, 255]], [100, [59, 15, 58, 255]],
];
export const DELAY_LEGEND = DELAY_STOPS.map(([v, c]) => ({ v, c }));

function delayColor(d: number | null | undefined): RGBA {
  if (d == null) return C.noData;
  for (let i = 1; i < DELAY_STOPS.length; i++) {
    const [v1, c1] = DELAY_STOPS[i];
    const [v0, c0] = DELAY_STOPS[i - 1];
    if (d <= v1) {
      const t = (d - v0) / (v1 - v0);
      return c0.map((x, k) => Math.round(x + t * (c1[k] - x))) as RGBA;
    }
  }
  return DELAY_STOPS[DELAY_STOPS.length - 1][1];
}

export function edgeLabel(p: EdgeProps) {
  return p.label || p.name || `Road ${p.from_node} → ${p.to_node}`;
}

export function featureBBox(f: Feature): [number, number, number, number] {
  const pts = f.geometry.type === "Point" ? [f.geometry.coordinates] : f.geometry.coordinates;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Chevrons along a road showing its travel direction: one at the middle, more on long roads.
 *  Each chevron is two short strokes about 6 screen pixels long, so it reads at any zoom. */
function chevrons(f: Feature, mPerPx: number): { path: [number, number][]; f: Feature }[] {
  const pts = (f.geometry as any).coordinates as [number, number][];
  if (pts.length < 2) return [];
  const lat = pts[0][1] * Math.PI / 180;
  const mx = 111320 * Math.cos(lat), my = 110540;           // metres per degree
  const xy = pts.map(([x, y]) => [x * mx, y * my]);
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < xy.length; i++) { const d = Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]); seg.push(d); total += d; }
  const arm = 6 * mPerPx;
  if (total < arm * 4) return [];
  const n = Math.max(1, Math.min(4, Math.floor(total / (260 * mPerPx))));
  const out: { path: [number, number][]; f: Feature }[] = [];
  for (let k = 0; k < n; k++) {
    let at = total * (k + 0.62) / n, i = 0;   // a little past the middle, so the two sides of a street do not overlap
    while (i < seg.length - 1 && at > seg[i]) { at -= seg[i]; i++; }
    const t = seg[i] ? at / seg[i] : 0;
    const [ax, ay] = xy[i], [bx, by] = xy[i + 1];
    const ux = (bx - ax) / (seg[i] || 1), uy = (by - ay) / (seg[i] || 1);
    const tip = [ax + (bx - ax) * t + ux * arm / 2, ay + (by - ay) * t + uy * arm / 2];
    const back = (side: number) => [tip[0] - ux * arm - side * uy * arm * 0.8, tip[1] - uy * arm + side * ux * arm * 0.8];
    const toLL = ([x, y]: number[]) => [x / mx, y / my] as [number, number];
    out.push({ path: [toLL(back(1)), toLL(tip), toLL(back(-1))], f });
  }
  return out;
}

type View = { longitude: number; latitude: number; zoom: number; pitch?: number; bearing?: number };

type Props = {
  geometry: Geometry | null;
  mode: MapMode;
  selection: Selection;
  onSelect: (s: Selection) => void;
  hoverId?: string | null;
  runEdges?: Record<string, EdgeAgg> | null;
  cmpEdges?: Record<string, EdgeCmp> | null;
  focus?: { bbox: [number, number, number, number]; key: number; maxZoom?: number } | null;
  basemap?: boolean;                                   // show the street map even without a network
  onBounds?: (bbox: [number, number, number, number], km2: number) => void;   // visible area, after moves
};

const DEFAULT_VIEW = { longitude: 73.8567, latitude: 18.5204, zoom: 15.5 };   // Pune, India

function areaKm2([w, s, e, n]: [number, number, number, number]) {
  const lat = ((s + n) / 2) * Math.PI / 180;
  return Math.abs(e - w) * 111.32 * Math.cos(lat) * Math.abs(n - s) * 110.57;
}

export default function MapView({ geometry, mode, selection, onSelect, hoverId, runEdges, cmpEdges, focus, basemap, onBounds }: Props) {
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(basemap && !geometry ? DEFAULT_VIEW : { longitude: 0, latitude: 0, zoom: 14 });
  useEffect(() => {
    if (!onBounds) return;
    const el = box.current;
    const w = el?.clientWidth ?? 800, h = el?.clientHeight ?? 600;
    const [[x0, y0], [x1, y1]] = [
      new WebMercatorViewport({ ...view, width: w, height: h }).unproject([0, h]),
      new WebMercatorViewport({ ...view, width: w, height: h }).unproject([w, 0]),
    ] as [number, number][];
    const b: [number, number, number, number] = [x0, y0, x1, y1];
    onBounds(b, areaKm2(b));
  }, [view.longitude, view.latitude, view.zoom]);

  const edges = useMemo(() => (geometry?.features ?? []).filter((f) => f.properties.kind === "edge"), [geometry]);
  const signals = useMemo(() => (geometry?.features ?? []).filter((f) => f.properties.kind === "signal"), [geometry]);
  const closedEdges = useMemo(() => edges.filter((f) => !(f.properties as EdgeProps).car_allowed), [edges]);
  const showArrows = view.zoom >= 15.5;
  const zStep = Math.round(view.zoom * 2) / 2;            // rebuild arrows every half zoom level
  const arrows = useMemo(() => {
    if (!showArrows || !edges.length) return [];
    const lat = ((edges[0].geometry as any).coordinates[0][1] * Math.PI) / 180;
    const mPerPx = (78271.52 * Math.cos(lat)) / 2 ** zStep;   // metres per screen pixel (512-px tiles)
    return edges.filter((f) => (f.properties as EdgeProps).car_allowed).flatMap((f) => chevrons(f, mPerPx));
  }, [edges, zStep, showArrows]);

  const fit = (bbox: [number, number, number, number], maxZoom = 19) => {
    const el = box.current;
    const w = Math.max(240, el?.clientWidth ?? 800), h = Math.max(240, el?.clientHeight ?? 600);
    const [x0, y0, x1, y1] = bbox;
    const pad = Math.min(56, Math.floor(Math.min(w, h) / 6));
    const dx = Math.max(x1 - x0, 1e-5), dy = Math.max(y1 - y0, 1e-5);
    const vp = new WebMercatorViewport({ width: w, height: h }).fitBounds(
      [[x0 - dx * 0.02, y0 - dy * 0.02], [x1 + dx * 0.02, y1 + dy * 0.02]], { padding: pad });
    setView({ longitude: vp.longitude, latitude: vp.latitude, zoom: Math.min(vp.zoom, maxZoom), pitch: 0, bearing: 0 });
  };

  // Fit once per network (bbox); after that the user owns the camera.
  const bboxKey = geometry?.bbox?.join(",") ?? "none";
  useEffect(() => { if (geometry) fit(geometry.bbox); }, [bboxKey]);
  // act only on zoom requests made while this map is shown, not on one left over from an earlier map
  const lastFocus = useRef(focus?.key);
  useEffect(() => {
    if (focus && focus.key !== lastFocus.current) fit(focus.bbox, focus.maxZoom ?? 17.5);
    lastFocus.current = focus?.key;
  }, [focus?.key]);

  const selectedFeature = selection
    ? (selection.kind === "edge" ? edges : signals).find((f) => f.properties.id === selection.id) ?? null
    : null;

  const edited = geometry?.edited ?? {};
  const colorFor = (f: Feature): RGBA => {
    const p = f.properties as EdgeProps;
    if (!p.car_allowed) return [0, 0, 0, 0];   // drawn by the closed-road layers below
    if (mode === "results") return delayColor(runEdges?.[p.id]?.delay_per_veh_s);
    if (mode === "change") {
      const ch = cmpEdges?.[p.id]?.change;
      return ch === "better" ? C.better : ch === "worse" ? C.worse : C.same;
    }
    return edited[p.id] ? C.edited : C.road;
  };
  const widthFor = (f: Feature) => {
    const p = f.properties as EdgeProps;
    return p.car_allowed ? Math.max(2.5, p.lanes * 3.0) : 5;
  };

  const selectedEdges = selection?.kind === "edge" && selectedFeature ? [selectedFeature] : [];
  const hoverEdges = hoverId ? edges.filter((f) => f.properties.id === hoverId) : [];
  const layers = [
    new PathLayer<Feature>({
      id: "halo", data: [...selectedEdges, ...hoverEdges], getPath: (f) => (f.geometry as any).coordinates,
      getColor: (f) => (f.properties.id === selection?.id ? C.halo : [242, 183, 5, 140]),
      getWidth: (f) => widthFor(f) + 9, widthUnits: "meters", widthMinPixels: 9,
      capRounded: true, jointRounded: true, updateTriggers: { getColor: [selection?.id] },
    }),
    new PathLayer<Feature>({
      id: "roads", data: edges, pickable: true, autoHighlight: true, highlightColor: [242, 183, 5, 170],
      getPath: (f) => (f.geometry as any).coordinates, getColor: colorFor, getWidth: widthFor,
      widthUnits: "meters", widthMinPixels: 2, capRounded: true, jointRounded: true,
      updateTriggers: { getColor: [mode, runEdges, cmpEdges, edited] },
      onClick: (info) => info.object && onSelect({ kind: "edge", id: info.object.properties.id }),
    }),
    // travel direction, shown once zoomed in: dark chevrons with a light outline read on any road colour
    new PathLayer<{ path: [number, number][]; f: Feature }>({
      id: "direction-halo", data: arrows, visible: showArrows, getPath: (a) => a.path,
      getColor: [250, 251, 249, 235], getWidth: 4.5, widthUnits: "pixels", capRounded: true, jointRounded: true,
    }),
    new PathLayer<{ path: [number, number][]; f: Feature }>({
      id: "direction", data: arrows, visible: showArrows, getPath: (a) => a.path,
      getColor: [38, 43, 48, 255], getWidth: 2, widthUnits: "pixels", capRounded: true, jointRounded: true,
    }),
    // closed roads: ink outline with a light core, so they read as a hollow double line
    new PathLayer<Feature>({
      id: "closed-edge", data: closedEdges, getPath: (f) => (f.geometry as any).coordinates,
      getColor: C.closedEdge, getWidth: 6, widthUnits: "pixels", capRounded: false,
    }),
    new PathLayer<Feature>({
      id: "closed-core", data: closedEdges, getPath: (f) => (f.geometry as any).coordinates,
      getColor: C.closedCore, getWidth: 2.5, widthUnits: "pixels", capRounded: false,
    }),
    new ScatterplotLayer<Feature>({
      id: "signals", data: signals, pickable: true, autoHighlight: true, highlightColor: [242, 183, 5, 255],
      getPosition: (f) => (f.geometry as any).coordinates,
      getRadius: (f) => (f.properties.id === hoverId ? 9 : 7), radiusUnits: "pixels", stroked: true,
      lineWidthUnits: "pixels", getLineWidth: 2,
      getFillColor: (f) => (selection?.kind === "signal" && selection.id === f.properties.id ? C.halo : [38, 43, 48, 255]),
      getLineColor: [250, 251, 249, 255],
      updateTriggers: { getFillColor: [selection], getRadius: [hoverId] },
      onClick: (info) => info.object && onSelect({ kind: "signal", id: info.object.properties.id }),
    }),
  ];

  const tooltip = (info: any) => {
    if (!info.object) return setHover(null);
    const p = info.object.properties as EdgeProps | SignalProps;
    let text = "";
    if (p.kind === "edge") {
      text = `${edgeLabel(p)}: ${p.lanes} lane${p.lanes === 1 ? "" : "s"}, ${Math.round(p.speed_kmh)} km/h`;
      if (!p.car_allowed) text += ", closed";
      const r = runEdges?.[p.id];
      if (mode === "results" && r?.delay_per_veh_s != null) text += `. ${r.delay_per_veh_s.toFixed(0)} s delay per vehicle`;
      const c = cmpEdges?.[p.id];
      if (mode === "change" && c?.delay_change_s != null)
        text += `. Delay ${c.delay_change_s > 0 ? "+" : "−"}${Math.abs(c.delay_change_s).toFixed(1)} s per vehicle`;
    } else text = "Traffic signal. Click to see or change its timing";
    setHover({ x: info.x, y: info.y, text });
  };

  const zoomBy = (d: number) => setView((v) => ({ ...v, zoom: Math.max(1, Math.min(20, v.zoom + d)) }));

  return (
    <div className="map" ref={box} aria-label="Road network map">
      <DeckGL
        viewState={view as any}
        onViewStateChange={({ viewState, interactionState }: any) => {
          // deck/maplibre also emit start-up events carrying the old camera; only user interaction moves the view
          const i = interactionState || {};
          if (i.isDragging || i.isPanning || i.isZooming || i.isRotating || i.inTransition) setView(viewState);
        }}
        controller={{ doubleClickZoom: true, dragRotate: false, touchRotate: false }}
        layers={layers}
        pickingRadius={8}
        onHover={tooltip}
        onClick={(info: any) => !info.object && onSelect(null)}
        getCursor={({ isHovering, isDragging }: any) => (isHovering ? "pointer" : isDragging ? "grabbing" : "grab")}
      >
        {(geometry?.geo || (basemap && !geometry)) && <Map mapStyle={BASEMAP} attributionControl={{ compact: true }} />}
      </DeckGL>
      <div className="map-tools" role="toolbar" aria-label="Map view">
        <button className="icon" onClick={() => zoomBy(1)} aria-label="Zoom in" title="Zoom in">+</button>
        <button className="icon" onClick={() => zoomBy(-1)} aria-label="Zoom out" title="Zoom out">−</button>
        <button className="icon" onClick={() => geometry && fit(geometry.bbox)} aria-label="Show the whole network" title="Show the whole network">⤢</button>
        <button className="icon" disabled={!selectedFeature} onClick={() => selectedFeature && fit(featureBBox(selectedFeature), 17.5)}
          aria-label="Zoom to the selected road or signal" title="Zoom to selection">◎</button>
      </div>
      {hover && <div className="tip" style={{ left: hover.x + 12, top: hover.y + 12 }}>{hover.text}</div>}
      {geometry && !geometry.geo && <div className="map-note">Synthetic network: no real-world location</div>}
    </div>
  );
}
