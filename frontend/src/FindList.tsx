import { useId, useMemo, useState } from "react";
import type { Selection } from "./MapView";

export type Item = { kind: "edge" | "signal"; id: string; label: string; sub: string; changed?: boolean };

type Props = {
  items: Item[];
  onPick: (s: Selection) => void;
  onHover?: (id: string | null) => void;
  variant: "dropdown" | "list";
  selectedId?: string | null;
  placeholder?: string;
};

function matches(it: Item, q: string) {
  const hay = `${it.label} ${it.id} ${it.sub}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

/** Search roads and signals by name or id. As a dropdown it sits on the map; as a list it is the
 *  keyboard-friendly alternative to clicking the map. */
export default function FindList({ items, onPick, onHover, variant, selectedId, placeholder }: Props) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"all" | "edge" | "signal">("all");
  const id = useId();
  const found = useMemo(() => {
    const f = items.filter((it) => (kind === "all" || it.kind === kind) && (!q || matches(it, q)));
    return f.slice(0, variant === "dropdown" ? 12 : 200);
  }, [items, q, kind, variant]);
  const total = items.filter((it) => (kind === "all" || it.kind === kind) && (!q || matches(it, q))).length;

  const pick = (it: Item) => {
    onPick({ kind: it.kind, id: it.id });
    onHover?.(null);
    if (variant === "dropdown") { setOpen(false); setQ(""); }
  };

  const list = (
    <ul className={variant === "dropdown" ? "find-drop" : "find-list"} id={`${id}-list`} role="listbox" aria-label="Roads and signals">
      {found.map((it) => (
        <li key={`${it.kind}:${it.id}`} role="option" aria-selected={selectedId === it.id}>
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => pick(it)}
            onMouseEnter={() => onHover?.(it.id)} onMouseLeave={() => onHover?.(null)}
            onFocus={() => onHover?.(it.id)} onBlur={() => onHover?.(null)}>
            <span className={`find-kind ${it.kind}`} aria-hidden="true" />
            <span className="find-text">
              <span className="find-label">{it.label}{it.changed && <span className="chip">changed</span>}</span>
              <span className="find-sub">{it.sub}</span>
            </span>
          </button>
        </li>
      ))}
      {found.length === 0 && <li className="find-empty">No road or signal matches “{q}”.</li>}
      {total > found.length && <li className="find-empty">Showing {found.length} of {total}. Type more to narrow down.</li>}
    </ul>
  );

  if (variant === "dropdown")
    return (
      <div className="find" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
        <input type="search" value={q} placeholder={placeholder ?? "Find a road or signal"}
          aria-label="Find a road or signal" aria-controls={`${id}-list`} aria-expanded={open && !!q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === "Enter" && found[0]) pick(found[0]); if (e.key === "Escape") setOpen(false); }} />
        {open && q && list}
      </div>
    );

  return (
    <div className="find-panel">
      <div className="row">
        <input type="search" value={q} placeholder={placeholder ?? "Filter by name or id"} aria-label="Filter roads and signals"
          onChange={(e) => setQ(e.target.value)} />
        <div className="seg" role="group" aria-label="Show">
          {(["all", "edge", "signal"] as const).map((k) => (
            <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{k === "all" ? "All" : k === "edge" ? "Roads" : "Signals"}</button>
          ))}
        </div>
      </div>
      {list}
    </div>
  );
}
