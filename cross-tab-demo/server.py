"""Cross-tab call demo: WebRTC signaling plus per-speaker live transcription.

Each browser sends its own microphone (or MP3 test) audio to this server over
the room WebSocket. The server forwards that audio to Deepgram on a dedicated
connection, so every transcribed message is attributed to the right person.

Run from the repo root:  uv run fastapi dev cross-tab-demo/server.py
"""

import asyncio
import contextlib
import json
import logging
import os
import secrets
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import websockets
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

HERE = Path(__file__).parent
load_dotenv(HERE.parent / ".env")
load_dotenv(HERE / ".env")

log = logging.getLogger("cross-tab-demo")

DEEPGRAM_API_KEY = os.environ.get("DEEPGRAM_API_KEY", "")
DEEPGRAM_URL = "wss://api.deepgram.com/v1/listen?" + urlencode(
    {
        "model": "nova-3",
        "language": "en",
        "smart_format": "true",
        "interim_results": "true",
        "endpointing": "400",  # ms of silence that closes an utterance
        "utterance_end_ms": "1000",
    }
)
TRANSCRIPT_DIR = HERE / "transcripts"
SLOTS = ("A", "B")
ROOM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no look-alike characters
ROOM_TTL_SECONDS = 2 * 60 * 60  # empty rooms are forgotten after this long
MAX_MESSAGES_PER_ROOM = 2000
MAX_QUEUED_CHUNKS = 200  # ~50s of audio at 250ms/chunk; oldest dropped beyond it
KEEPALIVE_SECONDS = 5


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
    """One Deepgram streaming connection for one speaker."""

    def __init__(self, room: Room, peer: Peer) -> None:
        self.room = room
        self.peer = peer
        self.queue: asyncio.Queue[bytes | None] = asyncio.Queue(
            maxsize=MAX_QUEUED_CHUNKS
        )
        self.buffer: list[str] = []  # finalized pieces of the utterance in progress
        self.task = asyncio.create_task(self._run())

    def push(self, chunk: bytes) -> None:
        if self.queue.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                self.queue.get_nowait()
        self.queue.put_nowait(chunk)

    async def close(self) -> None:
        """Ask Deepgram to flush what it has, then wait briefly for the tail."""
        with contextlib.suppress(asyncio.QueueFull):
            self.queue.put_nowait(None)
        try:
            await asyncio.wait_for(self.task, timeout=5)
        except TimeoutError, asyncio.CancelledError:
            self.task.cancel()

    async def _run(self) -> None:
        try:
            async with websockets.connect(
                DEEPGRAM_URL,
                additional_headers={"Authorization": f"Token {DEEPGRAM_API_KEY}"},
            ) as dg:
                sender = asyncio.create_task(self._send(dg))
                keepalive = asyncio.create_task(self._keepalive(dg))
                try:
                    await self._receive(dg)
                finally:
                    sender.cancel()
                    keepalive.cancel()
        except Exception as exc:  # noqa: BLE001 - any failure should surface to the user
            log.warning("Deepgram connection for %s ended: %s", self.peer.label, exc)
            with contextlib.suppress(Exception):
                await self.peer.ws.send_json(
                    {"type": "stt-error", "detail": "Transcription connection failed."}
                )
        finally:
            await self._flush()

    async def _send(self, dg: Any) -> None:
        while (chunk := await self.queue.get()) is not None:
            await dg.send(chunk)
        await dg.send(json.dumps({"type": "CloseStream"}))

    async def _keepalive(self, dg: Any) -> None:
        # Deepgram drops connections that go quiet for ~10s.
        while True:
            await asyncio.sleep(KEEPALIVE_SECONDS)
            await dg.send(json.dumps({"type": "KeepAlive"}))

    async def _receive(self, dg: Any) -> None:
        async for raw in dg:
            event = json.loads(raw)
            kind = event.get("type")
            if kind == "Results":
                text = event["channel"]["alternatives"][0]["transcript"].strip()
                if event.get("is_final"):
                    if text:
                        self.buffer.append(text)
                    if event.get("speech_final"):
                        await self._flush()
                    else:
                        await self._interim("")
                elif text:
                    await self._interim(text)
            elif kind == "UtteranceEnd":
                await self._flush()

    async def _interim(self, tail: str) -> None:
        text = " ".join([*self.buffer, tail]).strip()
        await self.room.broadcast(
            {
                "type": "interim",
                "speaker": self.peer.slot,
                "label": self.peer.label,
                "text": text,
            }
        )

    async def _flush(self) -> None:
        text = " ".join(self.buffer).strip()
        self.buffer.clear()
        if text:
            await self.room.add_message(self.peer, text)
        await self.room.broadcast(
            {
                "type": "interim",
                "speaker": self.peer.slot,
                "label": self.peer.label,
                "text": "",
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
    return {"code": code, "stt": bool(DEEPGRAM_API_KEY)}


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
            "stt": bool(DEEPGRAM_API_KEY),
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
        if DEEPGRAM_API_KEY:
            peer.transcriber = Transcriber(room, peer)
        else:
            await peer.ws.send_json(
                {"type": "stt-error", "detail": "DEEPGRAM_API_KEY is not set."}
            )


app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")
