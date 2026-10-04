# Four-person demo handoff

The demo has two participants in one in-memory FastAPI process. [The API contract](api-contract.md) is the integration input for this split. Do not change request shapes in a lane. Ask the integration owner to coordinate a contract change before editing either client or server.

## Work already assigned to the scaffold

The repository provides `scripts/verify.sh`, `scripts/verify-browser.sh`, CI, ignore rules, `.env.example`, and the single-worker `just dev` command. The backend and frontend implementations are in place. Live provider calls, TURN, a production hostname, and public deployment remain unverified.

## Team ownership

| Person | Maintenance scope | Starter tasks and acceptance |
| --- | --- | --- |
| Session and WebRTC | `src/jev_scam_detector/sessions.py`, `src/jev_scam_detector/app.py`, `tests/test_api.py`, `tests/test_lifecycle.py` | Maintain token-bound seats, TTL, capacity, REST, event authentication, and signaling. Keep the in-memory backend in one process. |
| Transcription | `src/jev_scam_detector/providers.py`, `src/jev_scam_detector/app.py`, `tests/test_providers.py` | Maintain WebM uploads under 2 MiB and token-owned speaker attribution. The server checks headers, not container decodability. Test provider failure and empty results with fakes. Do not save audio. Coordinate `app.py` edits with the session owner. |
| Jev judgment and evals | `src/jev_scam_detector/providers.py`, `src/jev_scam_detector/sessions.py`, `tests/test_providers.py`, `tests/test_lifecycle.py` | Maintain the five-second assessment ticks, four concurrent provider slots, demo rule, Jev adapter, and segment-linked evidence. Add synthetic eval fixtures before treating scores as calibrated. Coordinate shared files with their owners. |
| UI, demo, and deployment | `frontend/`, `frontend/tests/call.spec.ts`, `scripts/verify-browser.sh` | Maintain create and join, manual text, two-context WebRTC, evidence display, and optional live recording. Check inbound audio stats in both browsers and keep deployment claims separate from local checks. |

The session and WebRTC owner coordinates shared edits to `jev_scam_detector.app:app`. The table describes maintenance areas, not permission for concurrent edits to the same file. Give each shared file one active writer. Each person works in a separate branch or worktree; one integration owner resolves cross-layer contract changes. Do not stage `.env`, provider keys, real transcript text, recordings, or browser test artifacts.

## Next hackathon tasks

- The session owner uses `feat/call-reliability`. Rehearse reconnect and end-call on two laptops. Keep `app.py`, `sessions.py`, and lifecycle changes in this lane.
- The transcription owner uses `feat/live-transcription`. Develop `src/jev_scam_detector/transcription.py` and `tests/test_transcription.py`. Move the OpenAI adapter out of `providers.py` through the integration owner. Validate a real browser clip with credentials. Replace the recorder's wait-between-clips behavior with bounded continuous capture. Preserve capture timestamps separately from server processing times. Coordinate `frontend/src/recorder.ts` with the UI owner.
- The Jev owner uses `feat/jev-evals`. Develop `src/jev_scam_detector/assessment.py`, `tests/test_assessment.py`, and synthetic fixtures under `evals/`. Move the Jev adapter through the integration owner. Test ordinary and suspicious calls, inspect evidence selection, and choose questions and thresholds from those results. Do not treat the demo rule as an accuracy baseline.
- The UI and deployment owner uses `feat/demo-deployment`. Own React UI changes, a public HTTPS demo, TURN configuration, and the presentation script. Leave `frontend/src/recorder.ts` to the transcription owner while that lane is active. Verify two separate devices on the deployed origin.

Land the adapter moves before wiring them into `app.py`. The integration owner changes imports after both provider lanes finish. Keep the existing provider Protocols and wire messages stable unless the whole team agrees on a contract change.

## Checks before the demo

1. Review [`api-contract.md`](api-contract.md) and [`architecture.md`](architecture.md) before changing the wire format. Coordinate client and server changes through the integration owner.
2. Run `bash scripts/verify.sh` for locked installs, Python checks, frontend tests, and production build.
3. Run `bash scripts/verify-browser.sh` for the keyless two-context demo against the real server. The browser checks speaker attribution, inbound audio packets on both peers, evidence links, capacity, and reconnect.
4. Rehearse a host and guest in separate browsers. Keep live provider calls and remote-network TURN checks separate from the keyless demo.

## Local and deployment reference

Use Python 3.14 and Node 22. Run `bash scripts/verify.sh` for locked Python install, lint, formatting, type checking, tests, then locked frontend install, type checking, tests, and build. Run `bash scripts/verify-browser.sh` separately after installing Chromium with `cd frontend && npx playwright install --with-deps chromium`. Start exactly one backend process with `just dev`. For local frontend development, run `npm --prefix frontend run dev` and open `http://127.0.0.1:5173`. Vite proxies `/api` and its WebSocket upgrade to `http://127.0.0.1:8000`. If port 8000 is occupied, set `API_PORT` to a free port for both Vite and the browser test, and start Uvicorn on that port. Set `FRONTEND_ORIGIN` to the exact browser origin when it differs from `http://127.0.0.1:5173`. The backend reads process environment and does not load `.env.example` or `.env`. The HTTP request body limit applies before multipart parsing on `/audio`; keep the 2 MiB clip limit inside the endpoint.

Serve the built `frontend/dist` on the same HTTPS origin as `/api` through a reverse proxy for a deployed demo. The repository does not include a Docker image or production reverse-proxy configuration. Forward WebSocket upgrades, terminate TLS, configure allowed origins, and use WSS for signaling. Run exactly one process; multiple replicas split in-memory sessions. TURN is required for networks where direct WebRTC fails. This is a deployment reference, not a deployed service. Set secrets at process launch and never bake `.env` into an image. Session state disappears on restart.
