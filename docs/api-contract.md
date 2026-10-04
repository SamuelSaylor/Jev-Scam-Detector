# API contract, version 0.3.0

This reference fixes the independent backend and frontend wire format. JSON fields use camelCase. Request and response bodies have exactly the fields shown; reject unknown input fields with 422. IDs are opaque strings. Timestamps are UTC RFC 3339 strings with `Z`; relative times are nonnegative integer milliseconds since server `createdAt` for the session. The server stamps receipt time and derives `startMs` and `endMs`; manual segments have equal bounds. For audio, the bounds cover server upload receipt through completed transcription, not exact spoken-word timing. Segment order follows server append order. `clientSeq` is a positive integer scoped to the participant and session, shared by text and audio submissions. The browser increments it for each new submission and retains it for retries. The server returns the prior segment for the same speaker and sequence and identical request fingerprint, even after later sequences; conflicting reuse returns 409. The fingerprint for manual input uses the original submitted text, before trimming. Lower unseen sequences return 409. Audio fingerprint is MIME and full file digest; check dedupe before a second provider call. Sequence gaps are allowed. All success and error JSON use `Content-Type: application/json` except 204.

## Common types

```ts
type Role = 'host' | 'guest';
type Mode = 'demo' | 'live';
type ProviderState = 'available' | 'unavailable';
type RiskStatus = 'ready' | 'unavailable';
type Segment = {
  id: string; speaker: Role; clientSeq: number; text: string;
  source: 'manual' | 'openai'; createdAt: string;
  startMs: number; endMs: number;
};
type Assessment = {
  id: string; status: 'ready'; mode: Mode;
  provider: 'demo-rule' | 'jev'; risk: number;
  confidence: number | null; suspicionLevel: 'low' | 'moderate' | 'high';
  indicators: ('credentials' | 'payment' | 'impersonation' | 'urgency' | 'secrecy' |
    'remote_access' | 'upfront_fee' | 'reward' | 'story_change' | 'persistence')[];
  summary: string;
  evidenceSegmentIds: string[]; throughSegmentId: string;
  createdAt: string; startMs: number; endMs: number;
};
type Snapshot = {
  sessionId: string; role: Role; mode: Mode; createdAt: string;
  peer: { role: Role; joined: boolean; connected: boolean };
  segments: Segment[]; assessments: Assessment[]; currentRisk: number | null;
  providerStatus: { transcription: ProviderState; assessment: ProviderState };
};
type ErrorBody = { error: { code: string; message: string } };
```

`risk` is a finite normalized suspicion score in `[0,1]`, not a calibrated scam probability. Live mode normalizes Jev's three-level `Score` by dividing by 2. Demo scores are 0.1, 0.5, or 0.9 and have no model certainty estimate. `confidence` is Jev's returned distribution-based judgment confidence in `[0,1]`; demo uses `null`. High confidence can mean a confident low-suspicion judgment. `suspicionLevel` is low below 0.35, moderate from 0.35 to below 0.7, and high from 0.7. These display bands and evidence thresholds are unvalidated defaults, not safety gates. `summary` is a bounded, evidence-based one-line description assembled in code, not generated prose. No assessment exists before text arrives. `currentRisk` is `null` only when no successful assessment exists. Otherwise it retains the last successful assessment's score, including during pending reviews and provider failures. The `Assessment` ledger contains only successful results and retains at most 32; its evidence IDs must still resolve in the retained segments. The UI displays the latest assessment and summary together. Provider status `unavailable` takes precedence over the freshness note and shows a small failure warning without clearing the last result. Otherwise, a latest `throughSegmentId` different from the newest segment means updating. With no successful result the UI awaits its first assessment. REST and WebSocket reconnect snapshots retain all these fields for an active room. An unavailable state never means zero or safe. `demo-rule` only sees submitted text. `jev` is a typed judgment on transcript text, not verification of an actual scam. `providerStatus.transcription` is `unavailable` in demo mode; `assessment` starts `available` in demo mode. In live mode the server requires both configured providers at creation, and later failures change availability independently. A successful provider operation changes its state to `available`.

## REST

All session URLs use `/api/sessions/{sessionId}` with the literal session ID URL encoded. No anonymous session read exists. Authenticated requests set `Authorization: Bearer <participantToken>`; the token is never sent in URLs, signals, responses other than create/join, or event payloads. The server derives speaker and role from the token. A session ID alone grants no read access.

| Method and URL | Request | Success |
| --- | --- | --- |
| `GET /api/health` | No body or token. | 200 `{"status":"ok","version":"0.3.0"}`. |
| `POST /api/sessions` | JSON `{"mode":"demo"}` or `{"mode":"live"}`. | 201 `{"sessionId":"...","participantToken":"...","role":"host","mode":"demo"}`. |
| `POST /api/sessions/{sessionId}/join` | JSON `{}`. | 201 `{"sessionId":"...","participantToken":"...","role":"guest","mode":"demo"}`. |
| `GET /api/sessions/{sessionId}` | Bearer token, no body. | 200 `Snapshot`. |
| `POST /api/sessions/{sessionId}/transcripts` | Bearer token, JSON `{"clientSeq":1,"text":"..."}`. | 201 `Segment`; exact retry returns 200 same `Segment`. |
| `POST /api/sessions/{sessionId}/audio` | Bearer token, multipart fields `clientSeq` (decimal integer) and `audio` (file named `clip.webm`, `Content-Type: audio/webm`). | 201 `Segment`; exact retry returns 200 same `Segment`; empty transcription returns 204, records the sequence as consumed, and broadcasts nothing. |
| `POST /api/sessions/{sessionId}/leave` | Bearer token, JSON `{}`. | 204 no body; repeated leave with a previously valid token returns 204 until TTL cleanup. |

`POST /audio` accepts `audio/webm` uploads up to 2 MiB. The server checks the declared MIME and WebM header before sending the clip to the transcription provider. It does not validate container completeness or independent decodability. The browser recorder stops each clip before upload. The request body is limited to 2 MiB plus 16 KiB for multipart framing; the file itself remains limited to 2 MiB. It is available only in live mode; demo returns 503. Trim transcript text. Empty or whitespace-only manual text and text over 2,000 code points return 422. Blank transcription produces no segment and is not interpreted as safe. On a capacity error, no sequence is consumed. `POST /leave` ends the entire session and closes both sockets with code 4404. It does not free the guest seat for replacement. An expired session is 404.

Errors use `ErrorBody` only. The server supplies fixed safe messages, never SDK error strings. Codes and statuses are fixed: 401 `invalid_token`; 404 `session_not_found` for unknown or expired sessions; 409 `session_full`, `sequence_conflict`, or `segment_limit`; 413 `clip_too_large`; 422 `invalid_input` or `unsupported_audio`; 502 `transcription_failed`; 503 `capacity_reached`, `provider_unavailable`, or `live_not_configured`. A missing bearer token is 401. Join to a claimed guest seat is 409, even when that guest is offline. Provider failure sets the corresponding provider status to unavailable and emits the status event; it never emits an assessment with a safe risk.

## WebSocket

Open `WS /api/sessions/{sessionId}/events` from an allowed Origin. Within five seconds, send exactly `{"type":"auth","participantToken":"..."}` as the first frame. No state or events are sent before authentication. The server responds with exactly `{"type":"snapshot","snapshot":Snapshot}`. The snapshot is authoritative and includes a joined peer even if that peer connected before this socket. Each role has one socket. A newly authenticated socket atomically replaces its older socket; the old socket closes with 4409. On replacement, the other socket receives `peer` with `connected:false` followed by `peer` with `connected:true`, even if the seat stayed joined. The replacing socket receives its new snapshot. Both clients discard the old peer connection and negotiate again. Failed authentication closes with 4401, unknown or expired sessions with 4404, malformed messages with 4400, forbidden Origin with 4403, and a slow consumer with 4410. The server limits each role to 64 queued events; overflow closes the socket, and reconnect restores state by snapshot. Successful authenticated requests and socket frames refresh the 30-minute idle TTL; a connected but idle socket does not. There is no signaling replay.

Client frames after authentication have only these shapes:

```json
{"type":"signal","data":{"kind":"offer","sdp":"v=0..."}}
{"type":"signal","data":{"kind":"answer","sdp":"v=0..."}}
{"type":"signal","data":{"kind":"candidate","candidate":"candidate:...","sdpMid":"0","sdpMLineIndex":0}}
{"type":"signal","data":{"kind":"candidate","candidate":null,"sdpMid":null,"sdpMLineIndex":null}}
```

Only the host sends an offer; only the guest sends an answer. Either sends a candidate. `sdp` is a nonempty string at most 64 KiB. A non-null candidate is at most 4 KiB; `sdpMid` is a nullable string at most 256 characters, and `sdpMLineIndex` is a nullable nonnegative integer. Null candidate marks end of candidates. No client `from`, `to`, `speaker`, or event frame is accepted. The server attaches `from` from the authenticated token and forwards a signal only to the other connected participant. A signal when the peer socket is absent returns `{"type":"signal_error","code":"peer_offline"}` to the sender. No signal is queued for the peer.

Server frames after the snapshot have exactly these shapes:

```json
{"type":"peer","role":"guest","joined":true,"connected":true}
{"type":"signal","from":"host","data":{"kind":"offer","sdp":"v=0..."}}
{"type":"transcript","segment":{"id":"seg_1","speaker":"host","clientSeq":1,"text":"Send the code","source":"manual","createdAt":"2026-01-01T00:00:02Z","startMs":2000,"endMs":2000}}
{"type":"assessment","assessment":{"id":"asm_1","status":"ready","mode":"demo","provider":"demo-rule","risk":0.9,"confidence":null,"suspicionLevel":"high","indicators":["credentials"],"summary":"High suspicion: requests for private credentials or verification codes.","evidenceSegmentIds":["seg_1"],"throughSegmentId":"seg_1","createdAt":"2026-01-01T00:00:05Z","startMs":2000,"endMs":2000}}
{"type":"provider_status","provider":"assessment","status":"unavailable"}
{"type":"signal_error","code":"peer_offline"}
```

Both connected roles receive `peer`, `transcript`, `assessment`, and `provider_status` events, including the submitting role. `peer.role` names the participant whose presence changed. `peer.joined` remains true once a seat is claimed. `provider_status.provider` is `transcription` or `assessment`; its status is `available` or `unavailable`. No provider details leave the server. Incremental events are ordered per session; a reconnect must replace its local state with the snapshot, deduplicate by segment and assessment ID, then renegotiate. A join before either socket opens appears in the next snapshot. Presence updates describe sockets, not media health.

## Scripts and verification contract

The frontend package lives in `frontend/` and exposes `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:e2e`. Backend checks run at the repository root with `uv run pytest`, `uv run ruff check .`, `uv run ruff format --check .`, and `uv run basedpyright`. End-to-end testing uses two separate browser contexts and keyless demo text; provider calls remain untested without explicit safe credentials. Version `0.3.0` updates both Python and frontend metadata. It changes score semantics and adds required assessment fields, so deploy the backend and frontend together.
