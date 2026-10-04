# Verification

## Retained meter while updating

The frontend keeps the latest successful score, classification, and evidence visible while newer transcript lines await assessment, including reconnect snapshots that temporarily clear `currentRisk`. An updating note identifies the retained review. A new successful assessment replaces the result without removing the meter marker. Provider failures still show the unavailable state, and no score appears before the first successful review.

Frontend TypeScript checks, 21 unit tests, and the production build passed. Three mocked browser tests passed at desktop and mobile widths. The browser checks confirm that rapid transcript arrivals preserve the same marker DOM node and position, and a subsequent assessment updates its position and removes the note. No live or paid provider request ran.

## Contextual scam classification, version 0.4.0

Accepted the incoming call-workspace merge resolutions, then added a contextual Jev `Choice` in the existing assessment request. No live or paid provider request ran. The installed SDK definitions supplied the integration contract; no external documentation request ran.

Verified locally:

- Ruff lint and formatting passed; BasedPyright reported zero errors and warnings.
- Frontend TypeScript checks, 15 unit tests, and the production build passed.
- Three mocked browser tests passed, including classification rendering at desktop and mobile widths and hiding classification after failed or stale reviews.
- The full Python suite had 227 passes and 10 demo research failures. Running the original HEAD `DemoAssessor` against the same fixtures reproduced exactly those 10 failures. They remain failures, without relaxed gold expectations.
- Classification mapping tests cover every option, separate confidence, invalid judgments, snapshot serialization, null demo classification, and no demo fallback on service failure.

The research corpus has no scam-type gold expectations. These checks verify integration, not live classification accuracy.

## Scam assessments, version 0.3.0

Verified locally on `feat/scam-assessment-criteria`.

| Check | Result |
| --- | --- |
| `bash scripts/verify.sh` | Ruff lint and formatting passed. Python and TypeScript checks passed with zero warnings. 46 Python tests and 4 frontend unit tests passed. The production build passed. npm reported zero vulnerabilities. |
| `LD_LIBRARY_PATH=/tmp/rowdyhacks-browser-libs/root/usr/lib/x86_64-linux-gnu API_PORT=8011 npm --prefix frontend run test:e2e` | Six Chromium tests passed in 15.7 seconds against isolated FastAPI and Vite servers. |
| `git diff --check` | Passed. |

Two new browser tests exercise rapid transcript arrivals, retained results, small failure warnings, reconnect snapshots, recovery, low-suspicion summaries, and separate judgment confidence. They mock external assessment events for both display modes. Existing browser tests still exercise the real demo backend, peer audio, evidence, and room lifecycle. API tests exercise retained results and reconnects in both room modes using test assessors. No paid provider request ran.

Chromium initially could not launch because `libnspr4`, `libnss3`, and `libasound2` were missing. Debian packages were downloaded and extracted under `/tmp/rowdyhacks-browser-libs` for this run, without system installation. On a normal machine, use `npx playwright install --with-deps chromium` as documented in the README. The 390-pixel-wide demo and live assessment screenshots were inspected. Screenshots and temporary libraries are not committed.

The revised rubric is integration-tested, not accuracy-calibrated. Full retained conversations can hit Jev's context or timeout limits. Research sources, threshold semantics, and further evaluation needs are documented in [scam-criteria.md](scam-criteria.md).

## Historical scaffold verification

The integration owner and parent verified the local no-key demo. The parent reran the checks in the original repository on `feat/scaffold-call-demo` after bringing in the worktree commits. The application code at that checkpoint was `1c3ff50`.

| Check | Result |
| --- | --- |
| `bash scripts/verify.sh` | Ruff lint and formatting passed. Python and TypeScript checks passed. Twelve Python tests and three frontend tests passed. The production frontend build passed. |
| `API_PORT=18080 bash scripts/verify-browser.sh` | Four Chromium tests passed against running FastAPI and Vite servers in 13.8 seconds. |
| `npm --prefix frontend audit --audit-level=moderate` | Zero vulnerabilities reported. |
| `git diff --check` | Passed. |

The browser tests use separate contexts and fake microphone devices. They check inbound audio packets on both peers, host and guest transcript attribution, backend assessment fanout, evidence links, reconnect, full and missing rooms, late microphone permission cleanup, and creation of a closed WebM blob. The parent inspected the 390-pixel-wide call screenshot produced by the test. This is local browser evidence, not a two-device or deployed-network test.

## Remaining limits

- Demo scores are fixed contextual rule buckets. They do not establish scam probability, Jev confidence, voice authenticity, or safety.
- No real OpenAI or TypeSafe request ran. Real provider responses and acceptance of a browser-recorded clip remain unverified.
- The live recorder waits for upload and transcription before capturing another clip. Speech during that wait is missed. Continuous capture with bounded backpressure belongs to the transcription lane.
- Audio timestamps describe server processing. They are not word-level recording timestamps.
- The server checks WebM MIME and header bytes, not full container decodability.
- Sessions are process-local. Deployment, HTTPS, WSS, TURN, and restrictive-network connectivity remain unverified. Browser CI is manual-dispatch opt-in.
- API tests retain a file-wide `reportAny` suppression. The SDK boundary retains one unknown-member suppression. The upload middleware relies on Starlette's private request-body cache. These are maintenance follow-ups, not claims of complete static coverage.
- `.env` is no longer tracked, and the original local file was preserved. This does not remove secrets from older commits. Rotate any previously committed real key.

[The team plan](team-plan.md) assigns the next implementation tasks. [The API contract](api-contract.md) defines the current messages. The committed verification scripts rerun the checks without paid credentials.
