# Scaffold verification

The integration owner and parent verified the local no-key demo. The parent reran the checks in the original repository on `feat/scaffold-call-demo` after bringing in the worktree commits. The application code at that checkpoint was `1c3ff50`.

| Check | Result |
| --- | --- |
| `bash scripts/verify.sh` | Ruff lint and formatting passed. Python and TypeScript checks passed. Twelve Python tests and three frontend tests passed. The production frontend build passed. |
| `API_PORT=18080 bash scripts/verify-browser.sh` | Four Chromium tests passed against running FastAPI and Vite servers in 13.8 seconds. |
| `npm --prefix frontend audit --audit-level=moderate` | Zero vulnerabilities reported. |
| `git diff --check` | Passed. |

The browser tests use separate contexts and fake microphone devices. They check inbound audio packets on both peers, host and guest transcript attribution, backend assessment fanout, evidence links, reconnect, full and missing rooms, late microphone permission cleanup, and creation of a closed WebM blob. The parent inspected the 390-pixel-wide call screenshot produced by the test. This is local browser evidence, not a two-device or deployed-network test.

## Remaining limits

- Demo scores are fixed keyword buckets. They do not establish scam probability, voice authenticity, or safety.
- No real OpenAI or TypeSafe request ran. Real provider responses and acceptance of a browser-recorded clip remain unverified.
- The live recorder waits for upload and transcription before capturing another clip. Speech during that wait is missed. Continuous capture with bounded backpressure belongs to the transcription lane.
- Audio timestamps describe server processing. They are not word-level recording timestamps.
- The server checks WebM MIME and header bytes, not full container decodability.
- Sessions are process-local. Deployment, HTTPS, WSS, TURN, and restrictive-network connectivity remain unverified. Browser CI is manual-dispatch opt-in.
- API tests retain a file-wide `reportAny` suppression. The SDK boundary retains one unknown-member suppression. The upload middleware relies on Starlette's private request-body cache. These are maintenance follow-ups, not claims of complete static coverage.
- `.env` is no longer tracked, and the original local file was preserved. This does not remove secrets from older commits. Rotate any previously committed real key.

[The team plan](team-plan.md) assigns the next implementation tasks. [The API contract](api-contract.md) defines the current messages. The committed verification scripts rerun the checks without paid credentials.
