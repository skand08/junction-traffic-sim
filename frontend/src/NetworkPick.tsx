import type { Network } from "./types";

/** Shown on an empty map: choose a network by clicking it instead of hunting for a dropdown. */
export default function NetworkPick({ networks, onPick, title = "Choose a network", inline }: {
  networks: Network[]; onPick: (id: string) => void; title?: string; inline?: boolean;
}) {
  return (
    <div className={`net-pick ${inline ? "inline" : ""}`}>
      {title && <h2>{title}</h2>}
      <div className="net-pick-grid">
        {networks.map((n) => (
          <button key={n.id} className="net-tile" onClick={() => onPick(n.id)}>
            <b>{n.name}</b>
            <span className="small muted">
              {[n.edges != null && `${n.edges} roads`, n.signals != null && `${n.signals} signals`, n.trips != null && `${n.trips.toLocaleString()} trips/h`]
                .filter(Boolean).join(", ") || n.description}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
