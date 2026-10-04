import type { Assessment, Segment, Snapshot } from "./protocol";

export type EvidenceLine = Pick<Segment, "id" | "text" | "speaker" | "startMs">;
type Earlier = { earlierEvidence: EvidenceLine[] };
export type AssessmentView =
  | ({ kind: "unavailable" } & Earlier)
  | { kind: "unassessed" }
  | { kind: "pending"; earlierEvidence: EvidenceLine[] }
  | ({ kind: "stale" } & Earlier)
  | { kind: "ready"; risk: number; provider: Assessment["provider"]; evidence: EvidenceLine[] };

export function assessmentView(snapshot: Snapshot | null): AssessmentView {
  const latest = snapshot?.assessments.at(-1);
  const evidence = latest ? selectEvidence(snapshot!.segments, latest.evidenceSegmentIds) : [];
  if (snapshot?.providerStatus.assessment === "unavailable")
    return { kind: "unavailable", earlierEvidence: evidence };
  if (!snapshot?.segments.length && !latest) return { kind: "unassessed" };
  if (!latest) return { kind: "pending", earlierEvidence: [] };
  if (latest.throughSegmentId !== snapshot?.segments.at(-1)?.id)
    return { kind: "stale", earlierEvidence: evidence };
  if (snapshot.currentRisk === null)
    return { kind: "pending", earlierEvidence: evidence };
  return { kind: "ready", risk: snapshot.currentRisk, provider: latest.provider, evidence };
}

function selectEvidence(segments: Segment[], ids: string[]): EvidenceLine[] {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  return ids.flatMap((id) => {
    const segment = byId.get(id);
    return segment ? [{ id: segment.id, text: segment.text, speaker: segment.speaker, startMs: segment.startMs }] : [];
  });
}

export function assessmentCopy(mode: Snapshot["mode"], view: AssessmentView): string {
  if (view.kind !== "ready") {
    return {
      unavailable: "Assessment unavailable. No score can establish safety.",
      unassessed: "No lines reviewed yet.",
      pending: "Waiting for the next review. No result does not mean safe.",
      stale: "New lines await review. Earlier evidence is not a current assessment.",
    }[view.kind];
  }
  return mode === "demo"
    ? "Sample rule reviewed the shared text. Low likelihood does not establish safety."
    : "Jev estimated likelihood from transcript text. Low likelihood does not establish safety.";
}
