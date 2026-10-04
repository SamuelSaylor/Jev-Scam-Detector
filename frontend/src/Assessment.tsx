import type { CSSProperties } from "react";
import { assessmentCopy, type AssessmentView } from "./assessment-view";
import type { Membership } from "./protocol";

function elapsed(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function Assessment({
  view,
  mode,
  role,
  jumpTo,
}: {
  view: AssessmentView;
  mode: Membership["mode"];
  role: Membership["role"];
  jumpTo: (id: string) => void;
}) {
  const evidence =
    view.kind === "ready"
      ? view.evidence
      : "earlierEvidence" in view
        ? view.earlierEvidence
        : [];
  const status =
    view.kind === "ready"
      ? `${Math.round(view.risk * 100)}%`
      : {
          unavailable: "Unavailable",
          unassessed: "Unassessed",
          pending: "Pending",
          stale: "Earlier review",
        }[view.kind];
  const markerStyle: CSSProperties & { "--risk-position": string } = {
    "--risk-position": `${view.kind === "ready" ? view.risk * 100 : 0}%`,
  };
  return (
    <>
      <aside
        className={`likelihood ${view.kind === "ready" ? "is-ready" : "is-neutral"}`}
        aria-labelledby="risk-title"
      >
        <h2 id="risk-title">Scam likelihood</h2>
        <strong className="likelihood-value" aria-live="polite">
          {status}
        </strong>
        <span className="likelihood-high" aria-hidden="true">
          High
        </span>
        <div className="likelihood-track" aria-hidden="true">
          {view.kind === "ready" && (
            <span className="likelihood-marker" style={markerStyle} />
          )}
        </div>
        <span className="likelihood-low" aria-hidden="true">
          Low
        </span>
      </aside>
      <section className="explanation" aria-labelledby="explanation-title">
        <div className="section-heading">
          <h2 id="explanation-title">What the text suggests</h2>
        </div>
        <p>{assessmentCopy(mode, view)}</p>
        {evidence.length > 0 && (
          <div className="evidence">
            <h3>
              {view.kind === "ready"
                ? "Evidence in this review"
                : "Evidence from an earlier review"}
            </h3>
            <ul>
              {evidence.map((line) => (
                <li key={line.id}>
                  <button type="button" onClick={() => jumpTo(line.id)}>
                    {line.speaker === role ? "Your" : "Other participant's"}{" "}
                    line at {elapsed(line.startMs)}: “{line.text}”
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {view.kind === "ready" && evidence.length === 0 && (
          <p>No lines cited in this review. This does not establish safety.</p>
        )}
        <p className="guidance">
          <strong>If anything feels wrong</strong> Pause the call. Find the
          organization's number yourself from a trusted source. Do not share
          codes or send money based on this call.
        </p>
      </section>
    </>
  );
}
