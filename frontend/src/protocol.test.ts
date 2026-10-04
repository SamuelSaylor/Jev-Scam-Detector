import { describe, expect, it } from "vitest";
import { decodeEvent, updatedSnapshot, type Snapshot } from "./protocol";

const base: Snapshot = {
  sessionId: "s",
  role: "host",
  mode: "demo",
  createdAt: "2026-01-01T00:00:00Z",
  peer: { role: "guest", joined: false, connected: false },
  segments: [],
  assessments: [],
  currentRisk: null,
  providerStatus: { transcription: "unavailable", assessment: "available" },
};
const segment = {
  id: "one",
  speaker: "guest",
  clientSeq: 1,
  text: "Send the code",
  source: "manual",
  createdAt: "2026-01-01T00:00:02Z",
  startMs: 2000,
  endMs: 2000,
};
const assessment = {
  id: "a",
  status: "ready",
  mode: "demo",
  provider: "demo-rule",
  risk: 0.8,
  confidence: null,
  suspicionLevel: "high",
  indicators: ["credentials"],
  summary: "High suspicion: requests for private credentials or verification codes.",
  evidenceSegmentIds: ["one"],
  throughSegmentId: "one",
  createdAt: "2026-01-01T00:00:05Z",
  startMs: 2000,
  endMs: 5000,
};

describe("wire event boundary", () => {
  it("rejects an event with an untrusted speaker, unknown fields, or invalid probability", () => {
    expect(() =>
      decodeEvent(
        JSON.stringify({
          type: "transcript",
          segment: { ...segment, speaker: "scammer" },
        }),
      ),
    ).toThrow();
    expect(() =>
      decodeEvent(
        JSON.stringify({
          type: "peer",
          role: "guest",
          joined: true,
          connected: true,
          token: "leak",
        }),
      ),
    ).toThrow();
    expect(() =>
      decodeEvent(
        JSON.stringify({
          type: "assessment",
          assessment: { ...assessment, risk: -1 },
        }),
      ),
    ).toThrow();
    for (const invalid of [
      { ...assessment, confidence: 1.1 },
      { ...assessment, indicators: ["invented"] },
      { ...assessment, summary: "" },
    ]) {
      expect(() => decodeEvent(JSON.stringify({
        type: "assessment", assessment: invalid,
      }))).toThrow();
    }
  });
  it("ignores self peer broadcasts and tracks the remote seat", () => {
    const self = decodeEvent(
      JSON.stringify({
        type: "peer", role: "host", joined: true, connected: true,
      }),
    );
    expect(updatedSnapshot(base, self).peer).toEqual({
      role: "guest",
      joined: false,
      connected: false,
    });
    const remote = decodeEvent(
      JSON.stringify({
        type: "peer", role: "guest", joined: true, connected: true,
      }),
    );
    expect(updatedSnapshot(base, remote).peer).toEqual({
      role: "guest",
      joined: true,
      connected: true,
    });
  });
  it("retains the last successful assessment during updates and outages and deduplicates events", () => {
    const textEvent = decodeEvent(
      JSON.stringify({ type: "transcript", segment }),
    );
    const assessmentEvent = decodeEvent(
      JSON.stringify({ type: "assessment", assessment }),
    );
    const assessed = updatedSnapshot(
      updatedSnapshot(base, textEvent),
      assessmentEvent,
    );
    expect(assessed.currentRisk).toBe(0.8);
    expect(updatedSnapshot(assessed, assessmentEvent).assessments).toHaveLength(1);
    expect(updatedSnapshot(assessed, textEvent).segments).toHaveLength(1);
    const newer = decodeEvent(
      JSON.stringify({
        type: "transcript",
        segment: { ...segment, id: "two", clientSeq: 2, text: "Hello" },
      }),
    );
    const pending = updatedSnapshot(assessed, newer);
    expect(pending.currentRisk).toBe(0.8);
    expect(pending.assessments.at(-1)?.summary).toBe(assessment.summary);
    const unavailable = decodeEvent(
      JSON.stringify({
        type: "provider_status",
        provider: "assessment",
        status: "unavailable",
      }),
    );
    const failed = updatedSnapshot(pending, unavailable);
    expect(failed.currentRisk).toBe(0.8);
    expect(failed.providerStatus.assessment).toBe("unavailable");
    const reconnected = updatedSnapshot(base, decodeEvent(JSON.stringify({
      type: "snapshot", snapshot: failed,
    })));
    expect(reconnected.currentRisk).toBe(0.8);
    expect(reconnected.assessments.at(-1)?.summary).toBe(assessment.summary);
    const failedBeforeFirstResult = updatedSnapshot(base, unavailable);
    expect(failedBeforeFirstResult.currentRisk).toBeNull();
    expect(failedBeforeFirstResult.assessments).toHaveLength(0);
  });
  it("shows a completed result even if additional lines arrived during its review", () => {
    const first = decodeEvent(JSON.stringify({ type: "transcript", segment }));
    const newer = decodeEvent(JSON.stringify({
      type: "transcript", segment: { ...segment, id: "two", clientSeq: 2 },
    }));
    const result = decodeEvent(JSON.stringify({ type: "assessment", assessment }));
    const state = updatedSnapshot(updatedSnapshot(updatedSnapshot(base, first), newer), result);
    expect(state.currentRisk).toBe(0.8);
    expect(state.assessments.at(-1)?.throughSegmentId).toBe("one");
    expect(state.segments.at(-1)?.id).toBe("two");
  });
});
