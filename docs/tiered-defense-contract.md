# Tiered defense contract, version 0.4.0

This extension is part of `api-contract.md`. Existing room authentication, signaling, microphone, transcript, receipt sequencing, provider availability, and ended-session semantics remain unchanged. Create remains live-only in the frontend; backend demo rooms never enforce intervention tiers.

## Assessment additions

New assessment records add `rawRisk: number`, `confidence: number | null`, and `indicators: Indicator[]`. All probabilities are finite in [0,1]. `rawRisk` is Jev's immediate yes/no scam-pattern judgment. `risk` and `currentRisk` are the server's accumulated estimate, not a calibrated probability of actual fraud. Confidence is the returned Score distribution concentration, not proof that the model is correct. Legacy provider adapters have null confidence and no indicators and cannot trigger automated lockout. No confidence is manufactured for Noul answers or demo-rule output.

```ts
type Indicator = {
  segmentId: string;
  kind: 'urgency' | 'payment' | 'credentials' | 'unverified_link' | 'platform_switch' | 'independent_verification';
  probability: number;
};
type WarningTier = 'monitor' | 'caution' | 'contact' | 'lockout';
type Lockout = {
  id: string; assessmentId: string; risk: number; confidence: number;
  reasons: string[]; evidenceSegmentIds: string[];
  createdAt: string; readyAt: string;
};
type Override = { lockoutId: string; assessmentId: string; role: Role; createdAt: string };
type TrustedContact = { name: string; email: string };
type Defense = {
  tier: WarningTier;
  reasons: string[];
  trustedContact: TrustedContact | null;
  lockout: Lockout | null;
  overrides: Override[];
};
```

`Snapshot` adds `defense: Defense`. Defense is participant-specific: contacts and overrides are private to the authenticated role. During migration, frontend schemas accept older snapshots without defense and older assessments without the additions, but must never infer a lockout or confidence from their score alone.

New server frame: `{"type":"defense","defense":Defense}`. Send only to the affected participant's authenticated socket, never broadcast private contact details. The assessment event precedes its defense event. Snapshot replacement restores private defense state. `currentRisk` retains its previous freshness semantics: it is null during pending review or provider outage, and the frontend treats disconnected scores as historical. A previously imposed lockout persists through connection loss, provider outages, and newer unassessed messages, until acknowledged or session termination.

## Accumulation policy

The server retains up to 32 successful decisions, up to 120 recent deduplicated indicator pairs, and all acknowledged indicator pairs for the session. Weight urgency 0.15, payment 0.25, credentials 0.30, unverified links 0.20, and platform switching 0.10. Only indicators with probability >=0.7 are cited. Independent-verification indicators reduce suspicion; they do not establish verified identity.

For live rich decisions, the initial estimate is at most 0.45. Later target risk combines 65% immediate judgment with 35% weighted recent evidence. Repeated suspicious lines contribute 0.07 each after the first, at most 0.35, to the evidence component; explicit independent-verification evidence reduces the target by 0.15 times confidence without declaring the conversation safe. Upward interpolation uses a confidence-dependent factor. A normal increase is capped at 0.08 per newly assessed suspicious line and 0.16 per assessment; three high-probability signals with confidence >=0.85 allow 0.12 per line and at most 0.20 per assessment. No new suspicious line means no upward movement. Decreases are capped at 0.03 per newly assessed line and 0.08 per assessment; explicit high-probability independent-verification evidence with confidence >=0.85 permits at most 0.06 per line and 0.12 per assessment. Duplicate decisions do not change risk. Idle time never implies safety.

Risk >=0.70 requires at least two distinct recent cited lines; risk >=0.85 requires at least three and confidence >=0.75. Weak confidence caps the accumulated estimate below contact escalation. Tiers enter at 0.50, 0.70, and 0.85. Downward transitions require two completed decisions below the current tier's boundary minus 0.03. These unvalidated policy thresholds are configurable code, not clinically or statistically validated limits. Tier hysteresis can temporarily retain a more cautious tier than the score's numeric band.

Lockout is enforced only for live rich assessments with reinforcing cited indicators. Each participant receives a separate five-second hold. Acknowledgment marks the frozen triggering indicator pairs as reviewed. Evidence discovered while that hold was displayed is not silently acknowledged; if it still satisfies lockout eligibility, a new unique hold follows acknowledgment. The same evidence cannot impose another hold. Only new suspicious evidence at an accumulated score >=0.85 with confidence >=0.75 can trigger a new hold. Overrides never add to risk and are included as neutral context in future Jev requests, not treated as evidence of fraud or safety.

## New authenticated REST operations

| Method and URL | Request | Success |
| --- | --- | --- |
| `POST /api/sessions/{sessionId}/defense/contact` | `{ "contact": { "name": "...", "email": "..." } }` or `{ "contact": null }` | 200 `Defense` |
| `POST /api/sessions/{sessionId}/defense/overrides` | `{ "lockoutId": "..." }` | 200 `Defense` |

Both operations require the existing bearer token and a non-ended session. Reject unknown fields. Names are trimmed, nonblank, and at most 80 code points. Email is validated and at most 254 characters. Contact updates affect only that seat. The service has no outbound email/SMS provider; contact escalation **prepares a user-controlled email draft**, not a sent notification. Never claim delivery or automatically transmit the transcript. The user chooses whether to send the draft in their email client.

Lockout acknowledgment uses server UTC time and rejects requests before `readyAt` with 409 `review_wait` / `Review countdown is not complete`. Unknown hold IDs return 409 `review_conflict` / `Review has changed`. Retrying an acknowledged ID is idempotent and does not duplicate logs or acknowledge a different active hold. Retain at most 64 override records per seat for the session TTL.

While a seat has an active hold, new `/transcripts` and `/audio` submissions return 409 `review_required` / `Review the safety warning before continuing`. Exact prior submission retries still return their recorded receipt. In-flight audio may finish transcription but cannot append while the seat is held. No sequence is consumed on a review rejection. Authentication, snapshots, reconnect, contact editing, evidence reading, and ending the call remain available. Peer-to-peer media cannot be policed by the HTTP server; the browser explicitly disables its microphone track, stops transcription, and silences remote playback during the hold. The UI accurately calls this an in-app conversation pause, not a block on external calls or other apps.

The browser presents a modal with frozen triggering evidence, server-supplied reasons and confidence, and safe-action guidance. Start a local monotonic five-second countdown when it is shown; never acknowledge before that countdown or the server `readyAt`. Esc/closing cannot bypass the pause. A user may end the call immediately or submit an explicit acknowledgment afterward. Audio may resume only with the previous mute preference; transcription never auto-restarts. Reduced motion removes visual interpolation, not the required countdown.
