import { describe, expect, it } from "vitest";
import { assessmentView, assessmentCopy } from "./assessment-view";
import type { Snapshot, Segment, Assessment } from "./protocol";

const line: Segment = {
  id: "one",
  speaker: "host",
  clientSeq: 1,
  text: "Send the code",
  source: "manual",
  createdAt: "2026-01-01T00:00:00Z",
  startMs: 5000,
  endMs: 5000,
};
const review: Assessment = {
  id: "review",
  status: "ready",
  mode: "demo",
  provider: "demo-rule",
  risk: 0,
  confidence: null,
  suspicionLevel: "low",
  indicators: [],
  summary: "Low suspicion: no clear scam indicators detected.",
  evidenceSegmentIds: ["missing", "one"],
  throughSegmentId: "one",
  createdAt: "2026-01-01T00:00:01Z",
  startMs: 0,
  endMs: 5000,
};
const empty: Snapshot = {
  sessionId: "room",
  role: "host",
  mode: "demo",
  createdAt: "2026-01-01T00:00:00Z",
  peer: { role: "guest", joined: false, connected: false },
  segments: [],
  assessments: [],
  currentRisk: null,
  providerStatus: { transcription: "available", assessment: "available" },
};

function assessed(risk: number): Snapshot {
  return {
    ...empty,
    segments: [line],
    assessments: [{ ...review, risk }],
    currentRisk: risk,
  };
}

describe("call assessment view", () => {
  it("distinguishes empty, waiting and unavailable without a zero score", () => {
    expect(assessmentView(null)).toEqual({ kind: "unassessed" });
    expect(assessmentView(empty)).toEqual({ kind: "unassessed" });
    expect(assessmentView({ ...empty, segments: [line] })).toEqual({
      kind: "pending", earlierEvidence: [],
    });
    expect(assessmentView({
      ...empty,
      providerStatus: { ...empty.providerStatus, assessment: "unavailable" },
    })).toEqual({ kind: "unavailable", earlierEvidence: [] });
  });

  it("shows only exact available evidence", () => {
    expect(assessmentView(assessed(0))).toEqual({
      kind: "ready",
      freshness: "current",
      risk: 0,
      provider: "demo-rule",
      scamType: null,
      scamTypeConfidence: null,
      evidence: [{ id: "one", speaker: "host", text: "Send the code", startMs: 5000 }],
    });
  });

  it.each([0, 0.755, 1])("preserves genuine scores and rounds %s for display", (risk) => {
    const view = assessmentView(assessed(risk));
    expect(view).toMatchObject({ kind: "ready", freshness: "current", risk });
    const likelihood = `${Math.round(risk * 100)}%`;
    expect(assessmentCopy("live", view)).toEqual({
      likelihood, sentence: `Jev suspicion score: ${likelihood}.`,
    });
    expect(assessmentCopy("demo", view)).toEqual({
      likelihood, sentence: `Sample rule suspicion score: ${likelihood}.`,
    });
  });

  it.each([0, 0.8, 1])("keeps the previous %s score through rapid arrivals and reconnect snapshots", (risk) => {
    const before = assessed(risk);
    for (const count of [1, 2, 3]) {
      const updating: Snapshot = {
        ...before,
        currentRisk: null,
        segments: [line, ...Array.from({ length: count }, (_, i) => ({
          ...line, id: `new_${i}`, clientSeq: i + 2,
        }))],
      };
      const view = assessmentView(updating);
      expect(view).toMatchObject({
        kind: "ready", freshness: "updating", risk,
        evidence: [{ id: "one" }],
      });
      expect(assessmentCopy("live", view)).toEqual(
        assessmentCopy("live", assessmentView(before)),
      );
      const latest = updating.segments.at(-1);
      if (!latest) throw new Error("Expected a new transcript line");
      const nextRisk = risk === 0 ? 0.9 : 0;
      expect(assessmentView({
        ...updating,
        currentRisk: nextRisk,
        assessments: [...before.assessments, {
          ...review, id: "next", risk: nextRisk, throughSegmentId: latest.id,
        }],
      })).toMatchObject({ kind: "ready", freshness: "current", risk: nextRisk });
    }
  });

  it("uses the latest successful assessment even if currentRisk is cleared", () => {
    expect(assessmentView({ ...assessed(0.8), currentRisk: null })).toMatchObject({
      kind: "ready", freshness: "updating", risk: 0.8,
    });
    expect(assessmentView({ ...assessed(0.8), currentRisk: 0 })).toMatchObject({
      kind: "ready", risk: 0.8,
    });
  });

  it("retains classification while updating but hides it during provider failures", () => {
    const classified: Snapshot = {
      ...assessed(0.9),
      mode: "live",
      assessments: [{
        ...review, risk: 0.9, mode: "live", provider: "jev",
        scamType: "credential_theft", scamTypeConfidence: 0.85,
      }],
    };
    expect(assessmentView(classified)).toMatchObject({
      kind: "ready", freshness: "current",
      scamType: "credential_theft", scamTypeConfidence: 0.85,
    });
    expect(assessmentView({
      ...classified, segments: [line, { ...line, id: "two", clientSeq: 2 }],
    })).toMatchObject({
      kind: "ready", freshness: "updating",
      scamType: "credential_theft", scamTypeConfidence: 0.85,
    });
    const failed = assessmentView({
      ...classified,
      providerStatus: { ...classified.providerStatus, assessment: "unavailable" },
    });
    expect(failed).toMatchObject({ kind: "unavailable", earlierEvidence: [{ id: "one" }] });
    expect(failed).not.toHaveProperty("scamType");
    expect(assessmentCopy("live", failed)).toEqual({
      likelihood: "Unavailable", sentence: "Review unavailable.",
    });
  });
});
