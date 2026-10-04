import { useAnimatedRisk } from "./useAnimatedRisk";
import {
  assessmentCopy,
  percentage,
  receiptTime,
  type AssessmentView,
} from "./assessment-view";
import type { Membership } from "./protocol";

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
  const evidence = view.kind === "ready" ? view.evidence : view.earlierEvidence;
  const copy = assessmentCopy(mode, view);
  const current = view.kind === "ready" ? view.risk : null;
  const accumulated =
    view.latest?.rawRisk !== undefined && view.latest.confidence != null;
  const displayed = useAnimatedRisk(current, view.latest?.id);
  const fill = { amount: displayed, animate: false };
  const band =
    current === null
      ? "unknown"
      : current >= 0.7
        ? "high"
        : current >= 0.35
          ? "medium"
          : "low";
  const announcement = `${mode.toUpperCase()}. ${copy.likelihood}. ${view.kind === "ready" ? `Completed assessment ${view.latest.createdAt}.` : "No current estimate."}`;

  return (
    <>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      <aside
        className={`likelihood panel band-${band} ${view.kind === "ready" ? "is-ready" : "is-neutral"}`}
        aria-labelledby="risk-title"
      >
        <h2 id="risk-title">{accumulated ? "SCAM RISK" : "SCAM CHANCE"}</h2>
        <span className="stamp risk-state">
          {view.kind === "ready" ? "CURRENT" : copy.likelihood.toUpperCase()}
        </span>
        <strong className="likelihood-value">
          {view.kind === "ready" ? `${Math.round(displayed)}%` : "No estimate"}
        </strong>
        <div
          className="risk-gauge"
          role={current !== null ? "meter" : undefined}
          aria-label={
            current !== null
              ? accumulated
                ? "Accumulated scam risk"
                : "Estimated scam chance"
              : undefined
          }
          aria-valuemin={current !== null ? 0 : undefined}
          aria-valuemax={current !== null ? 100 : undefined}
          aria-valuenow={
            current !== null ? Math.round(current * 100) : undefined
          }
        >
          <div className="likelihood-track" aria-hidden="true">
            {current !== null && (
              <>
                <span
                  className={`likelihood-fill vertical ${fill.animate ? "animate" : ""}`}
                  style={{ height: `${fill.amount}%` }}
                />
                <span
                  className={`likelihood-fill horizontal ${fill.animate ? "animate" : ""}`}
                  style={{ width: `${fill.amount}%` }}
                />
              </>
            )}
            <span className="gauge-segments" />
          </div>
          <div className="gauge-scale" aria-hidden="true">
            <span>100</span>
            <span>50</span>
            <span>0</span>
          </div>
        </div>
        <div className="historical-slot">
          {view.kind !== "ready" && view.latest && (
            <p className="historical-score">
              <strong>Previous · {percentage(view.latest.risk)}</strong>
              <span>Historical only.</span>
            </p>
          )}
        </div>
        <p className="qualification">
          Estimate based on the latest completed assessment; not a confirmed
          scam verdict.
          {accumulated &&
            " Accumulated policy score, not a calibrated fraud probability."}
        </p>
        {mode === "demo" && (
          <p className="demo-label">DEMO RULE · Not live Jev.</p>
        )}
      </aside>
      <section
        className="explanation panel"
        aria-labelledby="explanation-title"
      >
        <div className="response-heading">
          <img src="/logo.png" alt="" width="38" height="38" />
          <h2 id="explanation-title">JEV RESPONSE</h2>
          <span>
            {view.latest
              ? `${view.latest.mode.toUpperCase()} / ${view.latest.provider.toUpperCase()}`
              : mode.toUpperCase()}
          </span>
        </div>
        <div className="response-body">
          <div className="recommendation">
            <h3>
              {view.latest
                ? `${view.kind === "ready" ? "Latest" : "Historical result"} · ${percentage(view.latest.risk)}`
                : "No assessment yet"}
            </h3>
            {view.latest && (
              <p className="assessment-time">
                Assessed{" "}
                <time
                  dateTime={view.latest.createdAt}
                  title={view.latest.createdAt}
                >
                  {receiptTime(view.latest.createdAt)}
                </time>{" "}
                · {view.latest.provider}
              </p>
            )}
            {view.latest &&
              view.latest.confidence !== undefined &&
              view.latest.confidence !== null && (
                <p className="assessment-confidence">
                  Model confidence · {percentage(view.latest.confidence)}
                  <span className="confidence-note">
                    Evidence-rating certainty, not proof of fraud.
                  </span>
                </p>
              )}
            {view.kind !== "ready" && (
              <p className="review-description">{copy.sentence}</p>
            )}
          </div>
          <div className="evidence">
            <h3>{view.kind === "ready" ? "Evidence" : "Earlier evidence"}</h3>
            {evidence.length ? (
              <ul>
                {evidence.map((line) => (
                  <li key={line.id}>
                    <button type="button" onClick={() => jumpTo(line.id)}>
                      <span className="evidence-meta">
                        {line.speaker === role
                          ? "You"
                          : line.speaker === "host"
                            ? "Host"
                            : "Guest"}{" "}
                        · {receiptTime(line.createdAt)} ·{" "}
                        {line.source === "manual"
                          ? "Typed"
                          : "Transcribed audio"}{" "}
                        ↗
                      </span>
                      <span>{line.text}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                {view.latest
                  ? "No cited lines. This does not establish safety."
                  : "None"}
              </p>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
