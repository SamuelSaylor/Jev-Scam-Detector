# Cross-tab call demo

Two people join a room in their browsers and talk over WebRTC. Each person's
audio is also streamed to the server, transcribed by Deepgram, and shown as a
live `Person A: ... / Person B: ...` feed on both screens. Finished messages are
saved to `cross-tab-demo/transcripts/<ROOM>.json` and served at
`/api/rooms/<ROOM>/transcript`.

## Run

1. Add `DEEPGRAM_API_KEY` to the repo-root `.env` (see `.env.example`).
2. From the repo root: `uv run fastapi dev cross-tab-demo/server.py`
3. Open http://localhost:8000 in two tabs (or two machines), click **Create room**
   in one, then **Join** with the code (or the invite link) in the other.

Without a key the call still works; the transcript feed shows a notice.

## Notes

- Use headphones when testing with two tabs on one machine, or you get echo.
- **MP3 test mode:** pick a file under "Test mode" in the lobby before creating or
  joining. It plays into the call as your voice and is transcribed like live speech.
- Microphone access needs `localhost` or HTTPS. For two machines, serve over HTTPS
  (for example a tunnel such as `cloudflared` or `ngrok`).
- Use Chrome, Edge or Firefox (Safari does not record `audio/webm`).
- Rooms hold two people. Audio is sent in 250 ms chunks, utterances close after
  400 ms of silence, and Deepgram connections close when a person leaves.
