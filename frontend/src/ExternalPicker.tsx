import { useState } from "react";
import { api } from "./api";
import type { ControllerTestResult, ExternalCfg } from "./types";

const KEY = "junction.controllers";

/** Controllers the user has connected before, remembered in this browser. */
export function savedControllers(): ExternalCfg[] {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
}
export function rememberController(c: ExternalCfg) {
  try {
    const rest = savedControllers().filter((x) => x.url !== c.url);
    localStorage.setItem(KEY, JSON.stringify([c, ...rest].slice(0, 8)));
  } catch { /* storage unavailable: nothing to remember */ }
}

/** Address and name of an external controller, with a check that it answers correctly. */
export default function ExternalPicker({ value, onChange, compact }: {
  value: ExternalCfg; onChange: (c: ExternalCfg) => void; compact?: boolean;
}) {
  const [test, setTest] = useState<ControllerTestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saved = savedControllers().filter((c) => c.url !== value.url);
  const check = async () => {
    setBusy(true); setErr(null); setTest(null);
    try { const r = await api.testController(value.url); setTest(r); rememberController(value); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className={`ext-pick ${compact ? "compact" : ""}`}>
      <label className="field block"><span className="label">Controller address</span>
        <input className="text" value={value.url} placeholder="http://localhost:9000/" spellCheck={false}
          onChange={(e) => { onChange({ ...value, url: e.target.value }); setTest(null); setErr(null); }} /></label>
      <label className="field block"><span className="label">Name in results</span>
        <input className="text" value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} /></label>
      <div className="row nowrap">
        <button className="btn secondary small" onClick={check} disabled={busy || !value.url}>{busy ? "Checking…" : "Check connection"}</button>
        {saved.length > 0 && (
          <select aria-label="Use a controller you connected before" value="" onChange={(e) => {
            const c = saved.find((x) => x.url === e.target.value); if (c) { onChange(c); setTest(null); setErr(null); } }}>
            <option value="">Used before…</option>
            {saved.map((c) => <option key={c.url} value={c.url}>{c.name} ({c.url})</option>)}
          </select>
        )}
      </div>
      {test && <p className="small good-text" role="status">Answered in {test.ms} ms. {test.note}</p>}
      {err && <p className="small warn-text" role="alert">{err}</p>}
    </div>
  );
}
