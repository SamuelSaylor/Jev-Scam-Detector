# Jev call demo

A two-person browser call with a shared transcript and periodic text-based risk review. The no-key demo uses typed lines and a sample word-matching rule. You can connect microphones for peer-to-peer audio without uploading or transcribing it. This is a demonstration, not a calibrated scam verdict or caller-identity check.

Created for RowdyHacks 2026 by Samuel Saylor, Simon Teague, Neil Parker, and Nicolas Powell.

## Run locally

Install [uv](https://docs.astral.sh/uv/), Python 3.14, Node.js 22 with npm, and a current browser. From the repository root, install the locked dependencies:

```bash
uv sync --locked
npm --prefix frontend ci
```

Start the backend in terminal 1:

```bash
uv run uvicorn jev_scam_detector.app:app --host 127.0.0.1 --port 8000
```

Start the frontend in terminal 2:

```bash
npm --prefix frontend run dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/api` requests and WebSocket connections to the backend. Keep one backend process running. If port 8000 is occupied, choose a free port, set `API_PORT` to it when starting Vite, and pass the same port to Uvicorn. If you use a different browser origin, set `FRONTEND_ORIGIN` to that exact origin in the backend process.

## Try the two-person no-key demo

1. In one browser, leave **Demo, no keys needed** selected and create a room. Copy the **Room ID to share**, not a participant token.
2. Open the app in a second browser or separate browser context. Enter the room ID and join. Each participant has a separate seat. Both can add lines with **Add typed line** without microphone permission.
3. Type `Please send the code` in one browser. Both timelines show the line with its speaker and the **typed** label. After the next assessment tick, the demo rule shows 80% and links to the matching transcript line. The rule looks for `code`, `money`, or `transfer`; other text yields 20%. Neither number establishes safety or fraud.
4. To test audio, click **Connect microphone** in each browser and grant permission. This sends WebRTC audio to the other participant. Demo mode does not upload or transcribe microphone audio. You can mute independently or use **Reconnect to room** if signaling disconnects.
5. Click **End call for everyone** to close the room for both participants.

Before the first review, the panel says **Unassessed**. A new line awaiting the next five-second review also shows a warning; five seconds is the assessment interval, not a guaranteed response time. **Unavailable** means the assessment provider failed, not that the call is safe. The timeline labels manually submitted text as typed, not speech recognition.

## Optional live providers

Live mode requires server-side `OPENAI_API_KEY` for transcription and `TYPESAFE_API_KEY` for Jev assessment. Set both as process environment variables before starting Uvicorn; `.env.example` lists the names but the app does not load an `.env` file. Do not put keys in the browser or commit them. A live room cannot be created without both providers configured.

In a live room, click **Connect microphone**, then **Start live transcription** to upload complete WebM/Opus clips of about five seconds to the backend. The backend attributes transcripts to the authenticated participant. **Stop live transcription** stops uploads without stopping peer audio. You can still type lines. The backend checks the MIME type and WebM header, not full container decodability, and limits each file to 2 MiB. Unsupported recording browsers and provider failures leave typed input available. The Jev example scores transcript text and cites existing lines; it does not verify who is speaking. Credentialed requests and a real provider upload of a browser clip have not been validated in this project. The recorder waits for each upload and transcription result before recording the next clip, so speech during that wait is missed. Audio timestamps describe server processing, not word-level capture timing. The transcription owner must address those gaps before using this as continuous call monitoring.

## Check the implementation

From the repository root, run the locked installs, Python lint, formatting, types and tests, frontend types and tests, and production build:

```bash
bash scripts/verify.sh
```

For the two-context Chromium check, install the browser once and then run the script. Playwright starts its own backend and Vite servers, so stop local servers on ports 8000 and 5173 first or set `API_PORT` to a free backend port.

```bash
cd frontend && npx playwright install --with-deps chromium && cd ..
bash scripts/verify-browser.sh
```

The browser check covers peer audio packets, speaker labels, transcript evidence, room capacity, reconnect, and microphone lifecycle. It uses fake media devices and no paid providers. CI runs the first script on pushes and pull requests; the browser job is available through a manual workflow dispatch.

## Boundaries and project docs

Sessions, tokens, transcripts, and assessments live only in one backend process. A restart loses them, and multiple backend workers do not share rooms. The backend does not persist audio clips after transcription. Avoid putting participant tokens, transcripts, or recordings in logs or Git.

The default [`frontend/public/config.json`](frontend/public/config.json) has a public STUN server but no TURN server. Restrictive networks may block peer audio. Configure short-lived TURN credentials for those networks. Browser microphone access needs HTTPS outside localhost. A deployment needs one backend process, HTTPS and WSS, a reverse proxy that routes `/api` and WebSocket upgrades, and an exact allowed frontend origin. No production host, Docker image, reverse-proxy configuration, or TURN connectivity test is supplied.

- [Team ownership and deployment reference](docs/team-plan.md)
- [API and WebSocket contract](docs/api-contract.md)
- [Architecture and provider boundaries](docs/architecture.md)
- [Example wire messages](contracts/examples.json)
