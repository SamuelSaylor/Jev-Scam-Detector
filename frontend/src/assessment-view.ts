import type { Assessment, Segment, Snapshot } from "./protocol";

export type EvidenceLine = Pick<Segment, "id" | "text" | "speaker" | "startMs">;
type Earlier = { earlierEvidence: EvidenceLine[] };
export type AssessmentView =
  | ({ kind: "unavailable" } & Earlier)
  | { kind: "unassessed" }
  | { kind: "pending"; earlierEvidence: EvidenceLine[] }
  | ({ kind: "stale" } & Earlier)
  | {
      kind: "ready";
      risk: Assessment["risk"];
      provider: Assessment["provider"];
      evidence: EvidenceLine[];
    };

export function assessmentView(snapshot: Snapshot | null): AssessmentView {
  if (!snapshot) return { kind: "unassessed" };
  const latest = snapshot.assessments.at(-1);
  const evidence = latest
    ? selectEvidence(snapshot.segments, latest.evidenceSegmentIds)
    : [];
  if (snapshot.providerStatus.assessment === "unavailable")
    return { kind: "unavailable", earlierEvidence: evidence };
  if (!snapshot.segments.length && !latest) return { kind: "unassessed" };
  if (!latest) return { kind: "pending", earlierEvidence: [] };
  if (latest.throughSegmentId !== snapshot.segments.at(-1)?.id)
    return { kind: "stale", earlierEvidence: evidence };
  if (snapshot.currentRisk === null)
    return { kind: "pending", earlierEvidence: evidence };
  return {
    kind: "ready",
    risk: snapshot.currentRisk,
    provider: latest.provider,
    evidence,
  };
}

function selectEvidence(segments: Segment[], ids: string[]): EvidenceLine[] {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  return ids.flatMap((id) => {
    const segment = byId.get(id);
    return segment
      ? [
          {
            id: segment.id,
            text: segment.text,
            speaker: segment.speaker,
            startMs: segment.startMs,
          },
        ]
      : [];
  });
}

export function assessmentCopy(
  mode: Snapshot["mode"],
  view: AssessmentView,
): { likelihood: string; sentence: string } {
  if (view.kind !== "ready") {
    return {
      unavailable: { likelihood: "Unavailable", sentence: "Review unavailable." },
      unassessed: { likelihood: "Unassessed", sentence: "Waiting for a review." },
      pending: { likelihood: "Pending", sentence: "Waiting for a review." },
      stale: { likelihood: "Earlier review", sentence: "New lines await review." },
    }[view.kind];
  }
  const likelihood = `${Math.round(view.risk * 100)}%`;
  return {
    likelihood,
    sentence: `${mode === "demo" ? "Sample rule" : "Jev"} estimates a ${likelihood} likelihood of a scam.`,
  };
}
