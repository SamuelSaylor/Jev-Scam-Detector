import { describe, expect, it } from "vitest";
import { assessmentCopy, assessmentView, percentage } from "./assessment-view";
import type { Assessment, Segment, Snapshot } from "./protocol";

const line: Segment = {
  id: "one",
  speaker: "host",
  clientSeq: 1,
  text: "Send the code",
  source: "manual",
  createdAt: "2026-01-01T00:00:02Z",
  startMs: 2000,
  endMs: 2000,
};
const review: Assessment = {
  id: "review",
  status: "ready",
  mode: "live",
  provider: "jev",
  risk: 0.8,
  evidenceSegmentIds: [line.id],
  throughSegmentId: line.id,
  createdAt: "2026-01-01T00:00:05Z",
  startMs: 2000,
  endMs: 2000,
};
const empty: Snapshot = {
  sessionId: "room",
  role: "host",
  mode: "live",
  createdAt: "2026-01-01T00:00:00Z",
  peer: { role: "guest", joined: false, connected: false },
  segments: [],
  assessments: [],
  currentRisk: null,
  providerStatus: { transcription: "available", assessment: "available" },
};
const ready: Snapshot = {
  ...empty,
  segments: [line],
  assessments: [review],
  currentRisk: 0.8,
};
const newer: Snapshot = {
  ...ready,
  segments: [line, { ...line, id: "two", clientSeq: 2 }],
  currentRisk: null,
};
const unavailable: Snapshot = {
  ...newer,
  providerStatus: { ...newer.providerStatus, assessment: "unavailable" },
};

describe("contract-derived assessment presentation", () => {
  it("never substitutes zero for no completed assessment", () => {
    expect(assessmentView(empty)).toMatchObject({
      kind: "unassessed",
      latest: undefined,
    });
    expect(assessmentView({ ...empty, segments: [line] })).toMatchObject({
      kind: "pending",
      latest: undefined,
    });
  });
  it("retains assessment identity, time and exact evidence source", () => {
    expect(assessmentView(ready)).toEqual({
      kind: "ready",
      risk: 0.8,
      provider: "jev",
      evidence: [line],
      latest: review,
    });
    const missing = {
      ...ready,
      assessments: [{ ...review, evidenceSegmentIds: ["missing", line.id] }],
    };
    expect(assessmentView(missing)).toMatchObject({ evidence: [line] });
  });
  it.each([0, 0.2, 0.5, 0.755, 0.8, 1])(
    "uses returned currentRisk including %s",
    (risk) => {
      const view = assessmentView({ ...ready, currentRisk: risk });
      expect(view).toMatchObject({ kind: "ready", risk });
      expect(assessmentCopy("live", view).likelihood).toBe(
        `${Math.round(risk * 100)}%`,
      );
    },
  );
  it("keeps earlier results historical after newer messages", () => {
    expect(assessmentView(newer)).toMatchObject({
      kind: "stale",
      latest: review,
      earlierEvidence: [line],
    });
    expect(assessmentCopy("live", assessmentView(newer)).likelihood).toBe(
      "Review pending",
    );
  });
  it("does not revive the ledger score after provider recovery", () => {
    expect(assessmentView({ ...ready, currentRisk: null }).kind).toBe(
      "pending",
    );
    expect(assessmentView(unavailable).kind).toBe("unavailable");
    expect(
      assessmentView({ ...unavailable, providerStatus: ready.providerStatus })
        .kind,
    ).toBe("stale");
  });
  it("ended takes priority over unavailable and connection loss", () => {
    expect(
      assessmentView(unavailable, { connection: "disconnected", ended: true }),
    ).toMatchObject({ kind: "ended", latest: review });
  });
  it.each(["reconnecting", "disconnected"] satisfies Array<
    "reconnecting" | "disconnected"
  >)("marks a valid score historical when %s", (connection) => {
    expect(assessmentView(ready, { connection, ended: false })).toMatchObject({
      kind: "connection",
      latest: review,
    });
    expect(assessmentView(newer, { connection, ended: false }).kind).toBe(
      "connection",
    );
  });
  it("provider failure takes priority over pending and room connection loss", () => {
    expect(
      assessmentView(unavailable, { connection: "reconnecting", ended: false })
        .kind,
    ).toBe("unavailable");
  });
  it("distinguishes loading the snapshot from an empty ready room", () => {
    expect(
      assessmentView(null, { connection: "connecting", ended: false }).kind,
    ).toBe("connecting");
    expect(assessmentView(empty).kind).toBe("unassessed");
  });
  it("labels backend demo output as a demo rule, not Jev", () => {
    const view = assessmentView({
      ...ready,
      mode: "demo",
      assessments: [{ ...review, mode: "demo", provider: "demo-rule" }],
    });
    expect(assessmentCopy("demo", view).sentence).toContain("Demo rule");
  });
  it("rounds probabilities without altering their semantics", () => {
    expect(percentage(0)).toBe("0%");
    expect(percentage(0.755)).toBe("76%");
    expect(percentage(1)).toBe("100%");
  });
});
