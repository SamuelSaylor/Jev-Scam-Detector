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
  });
  it("ignores self peer broadcasts and tracks the remote seat", () => {
    const self = decodeEvent(
      JSON.stringify({
        type: "peer",
        role: "host",
        joined: true,
        connected: true,
      }),
    );
    expect(updatedSnapshot(base, self).peer).toEqual({
      role: "guest",
      joined: false,
      connected: false,
    });
    const remote = decodeEvent(
      JSON.stringify({
        type: "peer",
        role: "guest",
        joined: true,
        connected: true,
      }),
    );
    expect(updatedSnapshot(base, remote).peer).toEqual({
      role: "guest",
      joined: true,
      connected: true,
    });
  });
  it("validates private defense and real confidence, preserving holds across pending review", () => {
    const defenseEvent = decodeEvent(
      JSON.stringify({
        type: "defense",
        defense: {
          tier: "lockout",
          reasons: ["A request for payment."],
          trustedContact: null,
          lockout: {
            id: "hold_a",
            assessmentId: "a",
            risk: 0.9,
            confidence: 0.95,
            reasons: ["A request for payment."],
            evidenceSegmentIds: ["one"],
            createdAt: "2026-01-01T00:00:05Z",
            readyAt: "2026-01-01T00:00:10Z",
          },
          overrides: [],
        },
      }),
    );
    const held = updatedSnapshot(base, defenseEvent);
    expect(held.defense?.lockout?.id).toBe("hold_a");
    expect(
      updatedSnapshot(
        held,
        decodeEvent(JSON.stringify({ type: "transcript", segment })),
      ).defense?.lockout?.id,
    ).toBe("hold_a");
    expect(() =>
      decodeEvent(
        JSON.stringify({
          type: "assessment",
          assessment: {
            ...assessment,
            confidence: 1.1,
            indicators: [],
            rawRisk: 0.9,
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      decodeEvent(
        JSON.stringify({
          type: "assessment",
          assessment: {
            ...assessment,
            confidence: 0.8,
            indicators: [
              { segmentId: "one", kind: "invented", probability: 0.9 },
            ],
            rawRisk: 0.9,
          },
        }),
      ),
    ).toThrow();
  });
  it("marks a newer line unassessed, deduplicates repeated events, and does not turn unavailable into safety", () => {
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
    expect(updatedSnapshot(assessed, textEvent).segments).toHaveLength(1);
    const newer = decodeEvent(
      JSON.stringify({
        type: "transcript",
        segment: { ...segment, id: "two", clientSeq: 2, text: "Hello" },
      }),
    );
    expect(updatedSnapshot(assessed, newer).currentRisk).toBeNull();
    const unavailable = decodeEvent(
      JSON.stringify({
        type: "provider_status",
        provider: "assessment",
        status: "unavailable",
      }),
    );
    expect(updatedSnapshot(assessed, unavailable).currentRisk).toBeNull();
  });
});
