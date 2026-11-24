import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { when } from "./shared";
import type { Calibration, Scenario } from "./types";

/** Fit a scenario's traffic to counted vehicles per road (SUMO routeSampler), and check the fit. */
export default function TrafficCounts({ s, roadName, onScenario, fail }: {
  s: Scenario; roadName: (id: string) => string; onScenario: (s: Scenario) => void; fail: (e: unknown) => void;
}) {
  const [list, setList] = useState<Calibration[]>([]);
  const [cur, setCur] = useState<Calibration | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(!!s.calibration);
  const file = useRef<HTMLInputElement>(null);
  const load = () => api.calibrations(s.id).then((l) => {
    setList(l);
    setCur((c) => c ?? l.find((x) => x.id === s.calibration) ?? l[0] ?? null);
  }).catch(fail);
  useEffect(() => { setCur(null); load(); }, [s.id]);
  const running = cur && (cur.status.state === "queued" || cur.status.state === "running");
  useEffect(() => {
    if (!cur || !running) return;
    const t = setInterval(() => api.calibration(cur.id).then((c) => { setCur(c); if (c.status.state === "done" || c.status.state === "failed") load(); }).catch(fail), 1000);
    return () => clearInterval(t);
  }, [cur?.id, running]);

  const upload = async (f: File) => {
    setBusy(true); setOpen(true);
    try { setCur(await api.startCalibration(s.id, await f.text())); } catch (e) { fail(e); } finally { setBusy(false); if (file.current) file.current.value = ""; }
  };
  const use = async (cid: string | null) => {
    setBusy(true);
    try { onScenario(await api.useCalibration(s.id, cid)); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const inUse = list.find((x) => x.id === s.calibration);
  const rep = cur?.report;
  return (
    <details className="counts" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Traffic counts{s.calibration ? ": in use" : ""}</summary>
      <p className="small">{inUse?.report
        ? `This scenario's traffic is fitted to ${inUse.report.summary.counted_roads} counted roads; ${Math.round(inUse.report.summary.share_geh_under_5 * 100)}% match within GEH 5 in simulation.`
        : "Traffic comes from the network's own demand. Upload counts (vehicles per road over the demand hour) to fit it to real traffic."}</p>
      <ol className="small steps-list">
        <li><a href={api.countsTemplateUrl(s.id)}>Download the road list</a> (CSV with every road and an empty “vehicles” column).</li>
        <li>Fill in the roads you counted; leave the rest blank.</li>
        <li>
          <input ref={file} type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <button className="btn secondary small" disabled={busy || !!running} onClick={() => file.current?.click()}>Upload counts and fit</button>
        </li>
      </ol>
      {list.length > 1 && (
        <label className="field block"><span className="label">Earlier fits</span>
          <select value={cur?.id ?? ""} onChange={(e) => setCur(list.find((x) => x.id === e.target.value) ?? null)}>
            {list.map((c) => <option key={c.id} value={c.id}>{when(c.created)}{c.id === s.calibration ? " (in use)" : ""}{c.status.state === "failed" ? " (failed)" : ""}</option>)}
          </select></label>
      )}
      {cur && cur.problems.length > 0 && (
        <div className="small warn-text"><b>Skipped rows:</b> {cur.problems.slice(0, 4).join(" ")}{cur.problems.length > 4 ? ` And ${cur.problems.length - 4} more.` : ""}</div>
      )}
      {running && <p className="status-line" role="status"><span className="spinner" aria-hidden="true" />{cur!.status.step ?? "Waiting to start"}…</p>}
      {cur?.status.state === "failed" && <p className="small warn-text" role="alert">{cur.status.error}</p>}
      {rep && (
        <div className="fit">
          <p className="small"><b>{rep.summary.geh_under_5} of {rep.summary.counted_roads}</b> counted roads within GEH 5 in simulation (target: 85% or more).
            {" "}{rep.summary.replaced_trips} trips over counted roads were replaced by {rep.summary.fitted_trips} fitted trips; {rep.summary.kept_trips} other trips are unchanged.</p>
          {rep.warnings.map((w, i) => <p key={i} className="small warn-text">{w}</p>)}
          <div className="table-scroll short"><table className="compact fit-table">
            <thead><tr><th scope="col">Road</th><th scope="col" className="n-col">Count</th><th scope="col" className="n-col">Simulated</th><th scope="col" className="n-col">GEH</th></tr></thead>
            <tbody>{rep.rows.map((r) => (
              <tr key={r.edge}><th scope="row">{roadName(r.edge)}</th><td className="n-col">{r.count}</td><td className="n-col">{r.simulated}</td>
                <td className={`n-col ${r.geh_simulated < 5 ? "good-text" : "warn-text"}`}>{r.geh_simulated.toFixed(1)}</td></tr>))}
            </tbody>
          </table></div>
          <p className="small muted">Simulated: vehicles counted on the road during the hour in one run with this scenario's signals. GEH compares hourly flows; under 5 is a good match.</p>
          <div className="row nowrap">
            {cur!.id !== s.calibration
              ? <button className="primary small" disabled={busy} onClick={() => use(cur!.id)}>Use this traffic</button>
              : <span className="chip">in use</span>}
          </div>
        </div>
      )}
      {s.calibration && <button className="btn quiet small" disabled={busy} onClick={() => use(null)}>Go back to the network's own traffic</button>}
      <p className="small muted">Comparisons need the same traffic on both sides: fit the counts first, then duplicate this scenario for each change.</p>
    </details>
  );
}
