# Cross-tab call demo

Two people join a room in their browsers and talk over WebRTC. Each person's
audio is also streamed to the server, transcribed locally by the free Vosk
speech recognizer (no account, key or cost), and shown as a
live `Person A: ... / Person B: ...` feed on both screens. Finished messages are
saved to `cross-tab-demo/transcripts/<ROOM>.json` and served at
`/api/rooms/<ROOM>/transcript`.

## Run

1. Once: `uv run python cross-tab-demo/download_model.py` (downloads the ~40 MB model).
2. From the repo root: `uv run fastapi dev cross-tab-demo/server.py`
3. Open http://localhost:8000 in two tabs (or two machines), click **Create room**
   in one, then **Join** with the code (or the invite link) in the other.

Without the model the call still works; the transcript feed shows a notice.

## Notes

- Use headphones when testing with two tabs on one machine, or you get echo.
- **MP3 test mode:** pick a file under "Test mode" in the lobby before creating or
  joining. It plays into the call as your voice and is transcribed like live speech.
- Microphone access needs `localhost` or HTTPS. For two machines, serve over HTTPS
  (for example a tunnel such as `cloudflared` or `ngrok`).
- Use a current Chrome, Edge or Firefox.
- The small Vosk model is fast and runs on any CPU but is less accurate than paid
  services; swap in a larger model from https://alphacephei.com/vosk/models by
  changing `MODEL_PATH` in `server.py`.
- Rooms hold two people. Audio is sent in ~256 ms chunks, Vosk closes an
  utterance on a pause in speech, and a person's recognizer is released when they leave.
