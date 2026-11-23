import { useEffect, useState } from "react";
import type { Job } from "./types";

const STATE_TEXT: Record<Job["state"], string> = {
  queued: "Waiting to start",
  building: "Building the network",
  running: "Running",
  done: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
};

function clock(s: number) {
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** Status of one option's job, from GET /jobs/{id} only. One square per seed, filled when that seed has
 *  finished; elapsed time is from the browser clock since the run was started. No estimates. */
export function JobRow({ label, job, startedAt, onRetry, onShowChange, versions }: {
  label: string; job: Job; startedAt: number | null; onRetry?: () => void; onShowChange?: () => void; versions?: string;
}) {
  const [now, setNow] = useState(Date.now());
  const live = !["done", "failed", "cancelled"].includes(job.state);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  const [copied, setCopied] = useState(false);
  const seeds = job.seeds ?? Array.from({ length: job.total }, (_, i) => i + 1);
  const doneSet = new Set(job.done_seeds ?? []);
  const elapsed = startedAt ? (now - startedAt) / 1000 : null;
  const failed = job.state === "failed";
  const stage = job.stage === "build" ? "while building the network" : job.stage === "simulation" ? "while simulating" : "";

  const details = [
    `Option: ${label}`, `Job: ${job.id}`, `Scenario: ${job.scenario_id}`, `State: ${job.state}${stage ? ` (${stage})` : ""}`,
    `Finished runs: ${job.done} of ${job.total}`, `Error: ${job.error ?? "none"}`, versions ? `Versions: ${versions}` : "",
    job.trace ? `Trace (last lines):\n${job.trace}` : "",
  ].filter(Boolean).join("\n");

  return (
    <div className={`job ${job.state}`}>
      <div className="job-head">
        <span className="job-label">{label}</span>
        <span className={`status ${job.state}`}>{live && <span className="spinner" aria-hidden="true" />}{STATE_TEXT[job.state]}</span>
        <span className="job-count">{job.done} of {job.total} runs</span>
        {elapsed != null && live && <span className="job-time" aria-label="Elapsed time">{clock(elapsed)}</span>}
      </div>
      <div className="squares" role="img" aria-label={`${job.done} of ${job.total} runs finished`}>
        {seeds.map((s) => <i key={s} className={doneSet.has(s) ? "on" : ""} title={`Run with seed ${s}${doneSet.has(s) ? ": finished" : ""}`} />)}
      </div>
      {job.message && live && job.message !== STATE_TEXT[job.state] && <p className="job-msg">{job.message}</p>}
      {job.warnings?.length > 0 && !failed && (
        <details className="job-warn"><summary>{job.warnings.length} warning{job.warnings.length > 1 ? "s" : ""} from the build</summary>
          <ul>{job.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></details>
      )}
      {failed && (
        <div className="banner q-error">
          <p className="banner-title">{label} failed {stage}.</p>
          <p>{job.stage === "build"
            ? "The network couldn't be built with these changes. Often one closure or turn ban cuts the network apart."
            : "A run stopped with an error, so no results were saved."}</p>
          <p className="mono">{job.error}</p>
          <div className="row">
            {onRetry && <button className="btn secondary small" onClick={onRetry}>Retry</button>}
            {onShowChange && job.stage === "build" && <button className="btn secondary small" onClick={onShowChange}>Review changes</button>}
            <button className="btn quiet small" onClick={() => { navigator.clipboard?.writeText(details).then(() => setCopied(true)); }}>
              {copied ? "Copied" : "Copy details"}
            </button>
          </div>
          {job.trace && <details><summary>Technical details</summary><pre>{job.trace}</pre></details>}
        </div>
      )}
    </div>
  );
}
