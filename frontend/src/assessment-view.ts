import type { Assessment, Segment, Snapshot } from "./protocol";
import type { RoomConnection } from "./room";

export type EvidenceLine = Pick<
  Segment,
  "id" | "text" | "speaker" | "startMs" | "createdAt" | "source"
>;
type Historical = {
  earlierEvidence: EvidenceLine[];
  latest: Assessment | undefined;
};
export type AssessmentView =
  | ({
      kind:
        | "ended"
        | "unavailable"
        | "connecting"
        | "connection"
        | "unassessed"
        | "pending"
        | "stale";
    } & Historical)
  | {
      kind: "ready";
      risk: Assessment["risk"];
      provider: Assessment["provider"];
      evidence: EvidenceLine[];
      latest: Assessment;
    };

export function assessmentView(
  snapshot: Snapshot | null,
  context: { connection: RoomConnection; ended: boolean } = {
    connection: "connected",
    ended: false,
  },
): AssessmentView {
  const latest = snapshot?.assessments.at(-1);
  const history: Historical = {
    latest,
    earlierEvidence:
      latest && snapshot
        ? selectEvidence(snapshot.segments, latest.evidenceSegmentIds)
        : [],
  };
  if (context.ended) return { kind: "ended", ...history };
  if (snapshot?.providerStatus.assessment === "unavailable")
    return { kind: "unavailable", ...history };
  if (context.connection !== "connected")
    return {
      kind: context.connection === "connecting" ? "connecting" : "connection",
      ...history,
    };
  if (!snapshot || (!snapshot.segments.length && !latest))
    return { kind: "unassessed", ...history };
  if (!latest) return { kind: "pending", ...history };
  if (latest.throughSegmentId !== snapshot.segments.at(-1)?.id)
    return { kind: "stale", ...history };
  if (snapshot.currentRisk === null) return { kind: "pending", ...history };
  return {
    kind: "ready",
    risk: snapshot.currentRisk,
    provider: latest.provider,
    evidence: selectEvidence(snapshot.segments, latest.evidenceSegmentIds),
    latest,
  };
}

function selectEvidence(segments: Segment[], ids: string[]): EvidenceLine[] {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  return ids.flatMap((id) => {
    const segment = byId.get(id);
    return segment ? [segment] : [];
  });
}

export function assessmentCopy(
  mode: Snapshot["mode"],
  view: AssessmentView,
): { likelihood: string; sentence: string } {
  switch (view.kind) {
    case "ready":
      return {
        likelihood: percentage(view.risk),
        sentence: `${view.provider === "demo-rule" ? "Demo rule" : "Jev"} reviewed the latest transcript.`,
      };
    case "ended":
      return {
        likelihood: "Session ended",
        sentence: "Call closed. Results are historical.",
      };
    case "unavailable":
      return {
        likelihood: "Unavailable",
        sentence: "Assessment unavailable. Typed lines and audio still work.",
      };
    case "connecting":
      return {
        likelihood: "Connecting",
        sentence: "Waiting for room data.",
      };
    case "connection":
      return {
        likelihood: "Connection issue",
        sentence: "Reconnecting. Previous results are historical.",
      };
    case "unassessed":
      return {
        likelihood: "Unassessed",
        sentence: `Add a line for ${mode === "demo" ? "the demo rule" : "Jev"} to review. Unknown risk is not safe.`,
      };
    case "pending":
      return {
        likelihood: "Review pending",
        sentence: "Lines await review. No current estimate.",
      };
    case "stale":
      return {
        likelihood: "Review pending",
        sentence: "New lines await review. Previous results are historical.",
      };
    default: {
      const unreachable: never = view;
      return unreachable;
    }
  }
}

export function percentage(risk: number): string {
  return `${Math.round(risk * 100)}%`;
}
export function receiptTime(createdAt: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(createdAt));
}
