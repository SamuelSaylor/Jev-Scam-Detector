import { z } from "zod";

const role = z.enum(["host", "guest"]);
const mode = z.enum(["demo", "live"]);
const providerState = z.enum(["available", "unavailable"]);
const segment = z
  .object({
    id: z.string(),
    speaker: role,
    clientSeq: z.number().int().positive(),
    text: z.string(),
    source: z.enum(["manual", "openai"]),
    createdAt: z.string().datetime(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
  })
  .strict();
const assessment = z
  .object({
    id: z.string(),
    status: z.literal("ready"),
    mode,
    provider: z.enum(["demo-rule", "jev"]),
    risk: z.number().finite().min(0).max(1),
    evidenceSegmentIds: z.array(z.string()),
    throughSegmentId: z.string(),
    createdAt: z.string().datetime(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
  })
  .strict();
const peer = z
  .object({ role, joined: z.boolean(), connected: z.boolean() })
  .strict();
export const snapshot = z
  .object({
    sessionId: z.string(),
    role,
    mode,
    createdAt: z.string().datetime(),
    peer,
    segments: z.array(segment),
    assessments: z.array(assessment),
    currentRisk: z.number().finite().min(0).max(1).nullable(),
    providerStatus: z
      .object({ transcription: providerState, assessment: providerState })
      .strict(),
  })
  .strict();
export const membership = z
  .object({ sessionId: z.string(), participantToken: z.string(), role, mode })
  .strict();
export const errorBody = z
  .object({
    error: z.object({ code: z.string(), message: z.string() }).strict(),
  })
  .strict();
export const signal = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("offer"), sdp: z.string().min(1).max(65536) })
    .strict(),
  z
    .object({ kind: z.literal("answer"), sdp: z.string().min(1).max(65536) })
    .strict(),
  z
    .object({
      kind: z.literal("candidate"),
      candidate: z.string().max(4096).nullable(),
      sdpMid: z.string().max(256).nullable(),
      sdpMLineIndex: z.number().int().nonnegative().nullable(),
    })
    .strict(),
]);
export const event = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), snapshot }).strict(),
  z.object({ type: z.literal("peer"), ...peer.shape }).strict(),
  z.object({ type: z.literal("signal"), from: role, data: signal }).strict(),
  z.object({ type: z.literal("transcript"), segment }).strict(),
  z.object({ type: z.literal("assessment"), assessment }).strict(),
  z
    .object({
      type: z.literal("provider_status"),
      provider: z.enum(["transcription", "assessment"]),
      status: providerState,
    })
    .strict(),
  z
    .object({
      type: z.literal("signal_error"),
      code: z.literal("peer_offline"),
    })
    .strict(),
]);
export const iceConfig = z
  .object({
    iceServers: z.array(
      z
        .object({
          urls: z.union([z.string(), z.array(z.string())]),
          username: z.string().optional(),
          credential: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type Membership = z.infer<typeof membership>;
export type Snapshot = z.infer<typeof snapshot>;
export type Event = z.infer<typeof event>;
export type Signal = z.infer<typeof signal>;
export type Segment = z.infer<typeof segment>;
export type Assessment = z.infer<typeof assessment>;

export function decodeEvent(raw: string): Event {
  return event.parse(JSON.parse(raw));
}
export function updatedSnapshot(state: Snapshot, incoming: Event): Snapshot {
  switch (incoming.type) {
    case "snapshot":
      return incoming.snapshot;
    case "peer":
      return {
        ...state,
        peer: {
          role: incoming.role,
          joined: incoming.joined,
          connected: incoming.connected,
        },
      };
    case "transcript":
      return {
        ...state,
        segments: state.segments.some((item) => item.id === incoming.segment.id)
          ? state.segments
          : [...state.segments, incoming.segment],
        currentRisk: null,
      };
    case "assessment":
      return {
        ...state,
        assessments: state.assessments.some(
          (item) => item.id === incoming.assessment.id,
        )
          ? state.assessments
          : [...state.assessments, incoming.assessment],
        currentRisk:
          state.providerStatus.assessment === "available" &&
          state.segments.at(-1)?.id === incoming.assessment.throughSegmentId
            ? incoming.assessment.risk
            : null,
      };
    case "provider_status":
      return {
        ...state,
        providerStatus: {
          ...state.providerStatus,
          [incoming.provider]: incoming.status,
        },
        currentRisk:
          incoming.provider === "assessment" &&
          incoming.status === "unavailable"
            ? null
            : state.currentRisk,
      };
    case "signal":
    case "signal_error":
      return state;
    default: {
      const unreachable: never = incoming;
      return unreachable;
    }
  }
}
