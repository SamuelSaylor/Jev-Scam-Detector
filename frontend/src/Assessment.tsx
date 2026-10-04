import type { CSSProperties } from "react";
import { assessmentCopy, type AssessmentView } from "./assessment-view";
import { scamTypeLabels, type Membership } from "./protocol";

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
  const copy = assessmentCopy(mode, view);
  const markerStyle: CSSProperties & {
    "--risk-position": string;
    "--risk-color": string;
  } = {
    "--risk-position": `${view.kind === "ready" ? view.risk * 100 : 0}%`,
    "--risk-color": `hsl(${view.kind === "ready" ? 120 * (1 - view.risk) : 0} 90% 45%)`,
  };
  return (
    <>
      <aside
        className={`likelihood ${view.kind === "ready" ? "is-ready" : "is-neutral"}`}
        aria-labelledby="risk-title"
      >
        <h2 id="risk-title">Scam suspicion</h2>
        <strong className="likelihood-value" aria-live="polite">
          {copy.likelihood}
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
        <div className="recommendation">
          <h2 id="explanation-title">RECOMMENDATION</h2>
          <p>
            {view.kind === "ready" ? (
              <strong>{copy.likelihood} scam suspicion</strong>
            ) : copy.sentence}
          </p>
          {view.kind === "ready" && view.freshness === "updating" && (
            <p className="assessment-note" role="status">
              Updating. Showing the previous assessment.
            </p>
          )}
          {view.kind === "ready" && view.scamType != null && (
            <div aria-live="polite">
              <p>
                <small>Likely scam type</small>{": "}
                {scamTypeLabels[view.scamType]}
              </p>
              <small>
                Based on the conversation context, not definitive proof of fraud.
              </small>
            </div>
          )}
        </div>
        {evidence.length > 0 && (
          <div className="evidence">
            <h3>
              {view.kind === "ready" && view.freshness === "current"
                ? "Evidence"
                : "Earlier evidence"}
            </h3>
            <ul>
              {evidence.map((line) => (
                <li key={line.id}>
                  <button type="button" onClick={() => jumpTo(line.id)}>
                    <span className="evidence-meta">{line.speaker === role ? "You" : "Other participant"} · {elapsed(line.startMs)}</span>
                    <span>“{line.text}”</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </>
  );
}
