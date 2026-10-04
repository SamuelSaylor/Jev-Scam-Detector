# Four-person demo handoff

The demo has two participants in one in-memory FastAPI process. [The API contract](api-contract.md) is the integration input for this split. Do not change request shapes in a lane. Ask the integration owner to coordinate a contract change before editing either client or server.

## Work already assigned to the scaffold

The delivery lane provides `scripts/verify.sh`, `scripts/verify-browser.sh`, CI, ignore rules, a configuration example, and the single-worker `just dev` command. The backend and frontend lanes own their implementations and tests. This handoff does not claim that live providers, TURN, a production hostname, or a public deployment work.

## Team ownership

| Person | Exclusive files | Starter tasks and acceptance |
| --- | --- | --- |
| Session and WebRTC | `src/jev_scam_detector/session.py`, `src/jev_scam_detector/app.py`, `tests/test_session.py`, `tests/test_api.py` | Implement token-bound seats, TTL, capacity, REST, event authentication, signaling, and peer replacement. Two sockets exchange an offer, answer, and candidates; invalid tokens and a third participant fail as specified. Coordinate module names with the backend owner before splitting shared files. |
| Transcription | `src/jev_scam_detector/transcription.py`, `tests/test_transcription.py` | Accept complete WebM clips under 2 MiB, attribute uploads to the authenticated seat through the session interface, and call the OpenAI adapter only for live mode. Test invalid containers, retries, empty transcription, and provider failure with fakes. Do not save audio. |
| Jev judgment and evals | `src/jev_scam_detector/assessment.py`, `tests/test_assessment.py`, `evals/` | Implement the five-second assessment trigger, demo rule, typed Jev adapter, and provider-status handling. Test fresh text, no text, stale cursor, invalid output, and evidence IDs. Keep any eval fixtures synthetic and keyless; do not assert that a score is a calibrated fraud verdict. |
| UI, demo, and deployment | `frontend/`, `docs/demo.md`, deployment config after integration | Build create and join, manual text, two-browser WebRTC, risk and evidence display, and an optional live microphone control. Write a repeatable local demo and deployment notes; use the frozen frontend script names. Prove the keyless two-context browser path before claiming a demo. |

The session and WebRTC owner is also the backend integration owner. They wire the three backend modules into `jev_scam_detector.app:app`. Each person works in a separate branch or worktree; only this owner edits the backend entry point. The overall integration owner edits contract files after the lanes stop. Do not stage `.env`, provider keys, real transcript text, recordings, or browser test artifacts.

## Schedule and handoffs

1. At kickoff, agree on module interfaces and freeze [`api-contract.md`](api-contract.md) and [`architecture.md`](architecture.md) in the integration worktree. The session owner publishes fake-provider hooks so transcription and judgment can test without credentials.
2. In the first implementation block, the session owner completes snapshots, auth, and signaling while transcription and judgment implement adapters against the agreed interfaces. The UI owner builds against the frozen wire examples and mocked responses.
3. In the integration block, the backend owner connects adapters to the store, then the UI owner runs the keyless two-context demo against the real server. Run `bash scripts/verify.sh` and `bash scripts/verify-browser.sh` after the implementations and lockfiles arrive. Resolve contract changes through the integration owner before continuing.
4. Before the demo, rehearse a host and guest in separate browsers. Confirm transcript attribution, a server-produced assessment with real segment IDs, peer audio, invalid-token rejection, and recovery after reconnect. Live provider calls and remote-network audio remain separate checks with explicit credentials and TURN.

## Local and deployment reference

Use Python 3.14 and Node 22. Run `bash scripts/verify.sh` for locked Python install, lint, formatting, type checking, tests, then locked frontend install, type checking, tests, and build. Run `bash scripts/verify-browser.sh` separately after installing Chromium with `cd frontend && npx playwright install --with-deps chromium`. Start exactly one backend process with `just dev`. For local frontend development, run `npm --prefix frontend run dev` and proxy `/api` and the WebSocket upgrade to `http://127.0.0.1:8000`. Serve the built `frontend/dist` on the same HTTPS origin as `/api` through a reverse proxy for a deployed demo. Forward WebSocket upgrades, terminate TLS, configure allowed origins, and use WSS for signaling. Run exactly one process; multiple replicas split in-memory sessions. TURN is required for networks where direct WebRTC fails. This is a deployment reference, not a deployed service. Set secrets at process launch and never bake `.env` into an image. Session state disappears on restart.
