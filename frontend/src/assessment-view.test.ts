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

describe("call assessment view", () => {
  it("distinguishes empty, waiting and unavailable without a zero score", () => {
    expect(assessmentView(empty)).toEqual({ kind: "unassessed" });
    expect(assessmentView({ ...empty, segments: [line] })).toEqual({
      kind: "pending",
      earlierEvidence: [],
    });
    expect(
      assessmentView({
        ...empty,
        providerStatus: { ...empty.providerStatus, assessment: "unavailable" },
      }),
    ).toEqual({ kind: "unavailable", earlierEvidence: [] });
  });
  it("shows only exact available evidence and preserves genuine zero and one", () => {
    const ready = {
      ...empty,
      segments: [line],
      assessments: [review],
      currentRisk: 0,
    };
    expect(assessmentView(ready)).toEqual({
      kind: "ready",
      risk: 0,
      provider: "demo-rule",
      evidence: [
        { id: "one", speaker: "host", text: "Send the code", startMs: 5000 },
      ],
    });
    expect(assessmentView({ ...ready, currentRisk: 1 })).toMatchObject({
      kind: "ready",
      risk: 1,
    });
    expect(assessmentCopy("demo", assessmentView(ready))).toEqual({
      likelihood: "0%",
      sentence: "Sample rule estimates a 0% likelihood of a scam.",
    });
    expect(assessmentCopy("live", assessmentView({ ...ready, currentRisk: 0.755 }))).toEqual({
      likelihood: "76%",
      sentence: "Jev estimates a 76% likelihood of a scam.",
    });
    expect(assessmentCopy("live", assessmentView({ ...ready, currentRisk: 1 }))).toEqual({
      likelihood: "100%",
      sentence: "Jev estimates a 100% likelihood of a scam.",
    });
  });
  it("keeps earlier evidence neutral after new lines, outage and provider recovery", () => {
    const covered = {
      ...empty,
      segments: [line],
      assessments: [review],
      currentRisk: null,
    };
    expect(assessmentCopy("live", assessmentView(covered))).toEqual({
      likelihood: "Pending", sentence: "Waiting for a review.",
    });
    expect(assessmentView(covered)).toMatchObject({
      kind: "pending",
      earlierEvidence: [{ id: "one" }],
    });
    expect(
      assessmentView({
        ...covered,
        providerStatus: {
          ...covered.providerStatus,
          assessment: "unavailable",
        },
      }),
    ).toMatchObject({ kind: "unavailable", earlierEvidence: [{ id: "one" }] });
    expect(assessmentCopy("live", assessmentView({
      ...covered, segments: [line, { ...line, id: "two", clientSeq: 2 }],
    }))).toEqual({ likelihood: "Earlier review", sentence: "New lines await review." });
    expect(assessmentCopy("live", assessmentView({
      ...covered, providerStatus: { ...covered.providerStatus, assessment: "unavailable" },
    }))).toEqual({ likelihood: "Unavailable", sentence: "Review unavailable." });
  });
});
