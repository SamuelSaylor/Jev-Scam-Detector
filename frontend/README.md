# Jev call web

The React app is version 0.3.3. From `frontend/`, run `npm install` and `npm run dev`. Start FastAPI separately on `127.0.0.1:8000`. Vite proxies REST and WebSocket requests under `/api`. Production uses same-origin requests; deploy behind HTTPS with WebSocket upgrades enabled.

## Live rooms

The welcome screen creates **live rooms only**, with no demo section or mode picker. Configure the server-side OpenAI transcription and Jev assessment providers before creating a room. The frontend never accepts provider keys. Joining uses the existing room's mode. If the backend supplies a demo membership, the UI labels its actual mode and rule output instead of misrepresenting it as live Jev.

Share the room ID with a second browser. Both participants can type conversation lines without microphone permission. Connect the microphone separately for peer-to-peer audio. Starting live transcription uploads closed WebM/Opus clips of about five seconds. Unsupported browsers and provider failures leave typed input available. Mute affects the microphone track independently.

## Review and session controls

The shared transcript uses local/right and remote/left bubbles with server receipt timestamps and Typed or Transcribed audio source labels. Evidence controls focus and briefly highlight their matching bubble. Reading history preserves the scroll position and announces new lines. Returning to latest restores follow mode.

The risk rail is vertical on desktop and horizontal on mobile. The black panels use red header strips, outlines, and solid meter fills; readable text stays off-white with yellow keyboard focus. The UI omits instructional captions, repeated assessment commentary, decorative footer text, and implementation caveats. Risk freshness, timestamps, sources, and the verdict qualification stay visible. Only a returned current risk is shown as current. Pending review, provider outage, room connection loss, and ended calls keep previous scores explicitly historical. Assessment timestamps come from the backend. Explanations and confidence are not supplied by the API and are not synthesized. Bands are presentation categories, not validated thresholds.

Ending the call requires confirmation and ends the room for both participants. The transcript remains visible in the browser until **Back to rooms**. If the end request fails, the UI distinguishes local disconnection from server-confirmed termination. Room connection state, peer seat presence, and audio health are separate.

## Deployment

The app fetches `/config.json` for `iceServers`. Configure STUN and TURN where needed. Issue short-lived scoped TURN credentials rather than committing permanent secrets. Browser media capture requires HTTPS outside localhost. Sessions remain in one server process and disappear on restart. Do not log audio or participant tokens.

## Verification

Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:e2e`. Playwright starts uvicorn and Vite and uses independent browser contexts to check real peer audio, room events, and responsive layouts. Integration tests create keyless demo sessions through a test-only helper; the shipped create action remains live-only. Simulated provider events exist only inside the tests. Paid live providers are not called by the suite.
