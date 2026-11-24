import type { Edit, Feature, Geometry, SignalProps } from "./types";

export type Explained = { text: string; impact: string; tls?: string; kind: "signal" | "trips" | "other" };

/** Turn a build warning into plain language plus what it means for the simulation. */
export function explainWarning(w: string): Explained {
  let m = /^Signal (\S+): lanes or turns changed, so its signal plan was regenerated \(default timings, (\d+) phases\)/.exec(w);
  if (m)
    return {
      kind: "signal", tls: m[1],
      text: "This junction's signal plan was rebuilt with standard timings to fit the new lanes.",
      impact: "Part of any change here may come from the new timings, not the road change.",
    };
  m = /^Signal (\S+): the plan now has (\d+) phases \(it was regenerated\), so the retiming with (\d+) phases was skipped/.exec(w);
  if (m)
    return {
      kind: "signal", tls: m[1],
      text: `Your timing for this signal was not used: the plan was rebuilt with ${m[2]} phases, and your timing has ${m[3]}.`,
      impact: "The signal runs the rebuilt default plan. Open the signal again to set times for the new phases.",
    };
  m = /^Signal (\S+) was removed by these changes/.exec(w);
  if (m)
    return { kind: "signal", tls: m[1], text: "This signal no longer exists after the changes.", impact: "The junction is now unsignalised; traffic follows right-of-way rules." };
  m = /^Signal (\S+) no longer exists; its retiming was skipped/.exec(w);
  if (m)
    return { kind: "signal", tls: m[1], text: "Your timing for this signal was skipped because the signal no longer exists.", impact: "Remove the timing change or undo the change that removed the signal." };
  m = /^(\d+) of (\d+) trips can no longer reach their destination/.exec(w);
  if (m)
    return {
      kind: "trips",
      text: `${Number(m[1]).toLocaleString()} of ${Number(m[2]).toLocaleString()} trips can no longer reach their destination, so they are left out of the proposal.`,
      impact: "Trip totals will differ between the options for this reason alone.",
    };
  return { kind: "other", text: w, impact: "" };
}

/** Edits a warning most likely comes from: retiming of that signal, or road edits touching its junction;
 *  for dropped trips, closures and turn bans. */
export function relatedEdits(x: Explained, edits: Edit[], geo: Geometry | null): number[] {
  if (x.kind === "trips") return edits.map((e, i) => (e.type === "close_road" || e.type === "ban_turn" ? i : -1)).filter((i) => i >= 0);
  if (!x.tls) return [];
  const sig = geo?.features.find((f: Feature) => f.properties.kind === "signal" && (f.properties as SignalProps).tls.includes(x.tls!))
    ?.properties as SignalProps | undefined;
  const roads = new Set([...(sig?.incoming ?? []), ...(sig?.outgoing ?? [])]);
  return edits
    .map((e, i) => {
      if (e.type === "retime_signal") return e.tls === x.tls ? i : -1;
      if (e.type === "add_signal" || e.type === "remove_signal") return e.node === x.tls ? i : -1;
      const id = "edge" in e ? e.edge : e.from_edge;
      return roads.has(id) || (e.type === "ban_turn" && roads.has(e.to_edge)) ? i : -1;
    })
    .filter((i) => i >= 0);
}
