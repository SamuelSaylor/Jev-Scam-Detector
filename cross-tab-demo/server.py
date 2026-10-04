# pyright: basic
"""Cross-tab call demo: WebRTC signaling plus per-speaker live transcription.

Each browser sends its own microphone (or MP3 test) audio to this server over
the room WebSocket as 16 kHz mono PCM. The server runs a local, free Vosk
recognizer per person, so every transcribed message is attributed to the right
speaker with no paid service involved.

Run from the repo root:  uv run fastapi dev cross-tab-demo/server.py
"""

import asyncio
import contextlib
import json
import logging
import secrets
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from vosk import KaldiRecognizer, Model, SetLogLevel

HERE = Path(__file__).parent
load_dotenv(HERE.parent / ".env")
load_dotenv(HERE / ".env")

log = logging.getLogger("cross-tab-demo")

MODEL_PATH = HERE / "models" / "vosk-model-small-en-us-0.15"
SAMPLE_RATE = 16000
TRANSCRIPT_DIR = HERE / "transcripts"
SLOTS = ("A", "B")
ROOM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no look-alike characters
ROOM_TTL_SECONDS = 2 * 60 * 60  # empty rooms are forgotten after this long
MAX_MESSAGES_PER_ROOM = 2000
MAX_QUEUED_CHUNKS = 200  # ~50s of audio; oldest dropped beyond it

SetLogLevel(-1)
_model: Model | None = None


def stt_available() -> bool:
    return MODEL_PATH.is_dir()


def get_model() -> Model:
    global _model
    if _model is None:
        _model = Model(str(MODEL_PATH))
    return _model


def iso_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


@dataclass
class Peer:
    ws: WebSocket
    slot: str
    transcriber: Transcriber | None = None

    @property
    def label(self) -> str:
        return f"Person {self.slot}"


@dataclass
class Room:
    code: str
    created: float = field(default_factory=time.time)
    peers: dict[str, Peer] = field(default_factory=dict)
    transcript: list[dict[str, Any]] = field(default_factory=list)

    async def broadcast(
        self, payload: dict[str, Any], *, exclude: str | None = None
    ) -> None:
        for slot, peer in list(self.peers.items()):
            if slot == exclude:
                continue
            with contextlib.suppress(Exception):
                await peer.ws.send_json(payload)

    async def add_message(self, peer: Peer, text: str) -> None:
        now = time.time()
        message = {
            "id": len(self.transcript) + 1,
            "speaker": peer.slot,
            "label": peer.label,
            "text": text,
            "ts": iso_now(),
            "t": round(now - self.created, 2),  # seconds since the room opened
        }
        if len(self.transcript) >= MAX_MESSAGES_PER_ROOM:
            self.transcript.pop(0)
        self.transcript.append(message)
        await self.broadcast({"type": "transcript", "message": message})
        await asyncio.to_thread(self.save)

    def save(self) -> None:
        TRANSCRIPT_DIR.mkdir(exist_ok=True)
        path = TRANSCRIPT_DIR / f"{self.code}.json"
        path.write_text(json.dumps(self.transcript, indent=2), encoding="utf-8")


class Transcriber:
    """One local Vosk recognizer for one speaker."""

    def __init__(self, room: Room, peer: Peer) -> None:
        self.room = room
        self.peer = peer
        self.queue: asyncio.Queue[bytes | None] = asyncio.Queue(
            maxsize=MAX_QUEUED_CHUNKS
        )
        self.last_partial = ""
        self.task = asyncio.create_task(self._run())

    def push(self, chunk: bytes) -> None:
        if self.queue.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                self.queue.get_nowait()
        self.queue.put_nowait(chunk)

    async def close(self) -> None:
        """Flush whatever the recognizer still holds, then stop."""
        with contextlib.suppress(asyncio.QueueFull):
            self.queue.put_nowait(None)
        try:
            await asyncio.wait_for(self.task, timeout=5)
        except TimeoutError, asyncio.CancelledError:
            self.task.cancel()

    async def _run(self) -> None:
        try:
            recognizer = await asyncio.to_thread(
                lambda: KaldiRecognizer(get_model(), SAMPLE_RATE)
            )
            while (chunk := await self.queue.get()) is not None:
                # Vosk ends an utterance on its own after a pause in speech.
                if await asyncio.to_thread(recognizer.AcceptWaveform, chunk):
                    await self._final(json.loads(recognizer.Result())["text"])
                else:
                    await self._partial(
                        json.loads(recognizer.PartialResult())["partial"]
                    )
            await self._final(json.loads(recognizer.FinalResult())["text"])
        except Exception as exc:  # noqa: BLE001 - any failure should surface to the user
            log.warning("Transcription for %s ended: %s", self.peer.label, exc)
            with contextlib.suppress(Exception):
                await self.peer.ws.send_json(
                    {
                        "type": "stt-error",
                        "detail": "Transcription failed on the server.",
                    }
                )

    async def _partial(self, text: str) -> None:
        if text != self.last_partial:
            self.last_partial = text
            await self._interim(text)

    async def _final(self, text: str) -> None:
        text = text.strip()
        self.last_partial = ""
        if text:
            await self.room.add_message(self.peer, text)
        await self._interim("")

    async def _interim(self, text: str) -> None:
        await self.room.broadcast(
            {
                "type": "interim",
                "speaker": self.peer.slot,
                "label": self.peer.label,
                "text": text,
            }
        )


rooms: dict[str, Room] = {}


def purge_rooms() -> None:
    cutoff = time.time() - ROOM_TTL_SECONDS
    for code in [c for c, r in rooms.items() if not r.peers and r.created < cutoff]:
        del rooms[code]


app = FastAPI(title="Cross-tab call demo")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(HERE / "static" / "index.html")


@app.post("/api/rooms")
async def create_room() -> dict[str, Any]:
    purge_rooms()
    code = "".join(secrets.choice(ROOM_ALPHABET) for _ in range(5))
    while code in rooms:
        code = "".join(secrets.choice(ROOM_ALPHABET) for _ in range(5))
    rooms[code] = Room(code)
    return {"code": code, "stt": stt_available()}


@app.get("/api/rooms/{code}/transcript")
async def get_transcript(code: str) -> list[dict[str, Any]]:
    room = rooms.get(code.upper())
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    return room.transcript


@app.websocket("/ws/{code}")
async def room_socket(ws: WebSocket, code: str) -> None:
    await ws.accept()
    room = rooms.get(code.upper())
    slot = next((s for s in SLOTS if room and s not in room.peers), None)
    if room is None or slot is None:
        reason = "Room not found." if room is None else "Room is full."
        await ws.send_json({"type": "error", "detail": reason})
        await ws.close(code=4004 if room is None else 4009)
        return

    peer = Peer(ws, slot)
    room.peers[slot] = peer
    await ws.send_json(
        {
            "type": "joined",
            "you": slot,
            "peers": [s for s in room.peers if s != slot],
            "history": room.transcript,
            "stt": stt_available(),
        }
    )
    await room.broadcast({"type": "peer-joined", "peer": slot}, exclude=slot)

    try:
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                break
            if (chunk := message.get("bytes")) is not None:
                if peer.transcriber:
                    peer.transcriber.push(chunk)
            elif (text := message.get("text")) is not None:
                await handle_text(room, peer, json.loads(text))
    finally:
        del room.peers[slot]
        if peer.transcriber:
            await peer.transcriber.close()
        await room.broadcast({"type": "peer-left", "peer": slot})


async def handle_text(room: Room, peer: Peer, data: dict[str, Any]) -> None:
    kind = data.get("type")
    if kind == "signal":
        await room.broadcast(
            {"type": "signal", "from": peer.slot, "data": data["data"]},
            exclude=peer.slot,
        )
    elif kind == "start-stt" and peer.transcriber is None:
        if stt_available():
            peer.transcriber = Transcriber(room, peer)
        else:
            await peer.ws.send_json(
                {
                    "type": "stt-error",
                    "detail": "Vosk model not found in cross-tab-demo/models.",
                }
            )


app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")
