from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager, suppress
from typing import Annotated, ClassVar, Literal, cast

from fastapi import FastAPI, File, Form, Header, Request, UploadFile, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.websockets import WebSocketDisconnect

from jev_scam_detector.domain import (
    AudioClip,
    Mode,
    Role,
    ScamAssessor,
    Segment,
    Transcriber,
)
from jev_scam_detector.providers import DemoAssessor, JevAssessor, OpenAITranscriber
from jev_scam_detector.sessions import (
    Event,
    Room,
    SessionError,
    SessionStore,
    timestamp,
)

MAX_AUDIO = 2 * 1024 * 1024


class Strict(BaseModel):
    model_config: ClassVar[ConfigDict] = ConfigDict(extra="forbid")


class Create(Strict):
    mode: Mode


class Empty(Strict):
    pass


class TranscriptInput(Strict):
    clientSeq: int = Field(gt=0, strict=True)
    text: str = Field(min_length=1, max_length=2000)


class Auth(Strict):
    type: Literal["auth"]
    participantToken: str


class Offer(Strict):
    kind: Literal["offer", "answer"]
    sdp: str = Field(min_length=1, max_length=65536)


class Candidate(Strict):
    kind: Literal["candidate"]
    candidate: str | None = Field(max_length=4096)
    sdpMid: str | None = Field(max_length=256)
    sdpMLineIndex: int | None = Field(ge=0)


class Signal(Strict):
    type: Literal["signal"]
    data: Offer | Candidate = Field(discriminator="kind")


def error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status, content={"error": {"code": code, "message": message}}
    )


store = SessionStore()
transcriber: Transcriber | None = (
    OpenAITranscriber(os.environ["OPENAI_API_KEY"])
    if os.environ.get("OPENAI_API_KEY")
    else None
)
live_assessor: ScamAssessor | None = (
    JevAssessor(os.environ["TYPESAFE_API_KEY"])
    if os.environ.get("TYPESAFE_API_KEY")
    else None
)
demo_assessor: ScamAssessor = DemoAssessor()


async def assess_pending() -> None:
    semaphore = asyncio.Semaphore(4)

    async def assess(room: Room, snapshot: tuple[Segment, ...]) -> None:
        async with semaphore:
            try:
                assessor = demo_assessor if room.mode == "demo" else live_assessor
                if assessor is None:
                    raise ValueError("Provider unavailable")
                decision = await asyncio.wait_for(assessor.assess(snapshot), timeout=15)
                async with room.lock:
                    store.commit(room, snapshot, decision)
                    if room.provider_status["assessment"] != "available":
                        room.provider_status["assessment"] = "available"
                        room.emit(
                            {
                                "type": "provider_status",
                                "provider": "assessment",
                                "status": "available",
                            }
                        )
            except Exception:  # noqa: BLE001
                async with room.lock:
                    if not room.ended:
                        room.provider_status["assessment"] = "unavailable"
                        room.emit(
                            {
                                "type": "provider_status",
                                "provider": "assessment",
                                "status": "unavailable",
                            }
                        )
            finally:
                async with room.lock:
                    room.busy = False

    await store.cleanup()
    jobs: list[asyncio.Task[None]] = []
    for room in list(store.rooms.values()):
        async with room.lock:
            snapshot = store.reserve(room)
        if snapshot:
            jobs.append(asyncio.create_task(assess(room, snapshot)))
    if jobs:
        _ = await asyncio.gather(*jobs)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    async def loop() -> None:
        while True:
            await asyncio.sleep(5)
            await assess_pending()

    task = asyncio.create_task(loop())
    try:
        yield
    finally:
        _ = task.cancel()
        with suppress(asyncio.CancelledError):
            await task


app = FastAPI(lifespan=lifespan)
allowed_origin = os.environ.get("FRONTEND_ORIGIN", "http://127.0.0.1:5173")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[allowed_origin],
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.exception_handler(SessionError)
async def handle_session_error(_request: Request, exc: SessionError) -> JSONResponse:
    return error(exc.status, exc.code, exc.message)


@app.exception_handler(RequestValidationError)
async def handle_validation(
    _request: Request, _exc: RequestValidationError
) -> JSONResponse:
    return error(422, "invalid_input", "Invalid input")


def authorized(
    room_id: str, authorization: str | None, *, allow_ended: bool = False
) -> tuple[Room, Role]:
    room = store.room(room_id)
    if authorization is None or not authorization.startswith("Bearer "):
        raise SessionError(401, "invalid_token", "Invalid participant token")
    role = store.auth(room, authorization[7:])
    if room.ended and not allow_ended:
        raise SessionError(404, "session_not_found", "Session not found")
    return room, role


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": "0.2.0"}


@app.post("/api/sessions", status_code=201)
async def create(body: Create) -> dict[str, str]:
    if body.mode == "live" and (transcriber is None or live_assessor is None):
        raise SessionError(
            503, "live_not_configured", "Live providers are not configured"
        )
    room, token = await store.create(body.mode)
    return {
        "sessionId": room.id,
        "participantToken": token,
        "role": "host",
        "mode": room.mode,
    }


@app.post("/api/sessions/{room_id}/join", status_code=201)
async def join(room_id: str, _body: Empty) -> dict[str, str]:
    room = store.room(room_id)
    token = await store.join(room)
    return {
        "sessionId": room.id,
        "participantToken": token,
        "role": "guest",
        "mode": room.mode,
    }


@app.get("/api/sessions/{room_id}")
async def snapshot(
    room_id: str, authorization: Annotated[str | None, Header()] = None
) -> Event:
    room, role = authorized(room_id, authorization)
    async with room.lock:
        return room.snapshot(role)


@app.post("/api/sessions/{room_id}/transcripts")
async def transcript(
    room_id: str,
    body: TranscriptInput,
    authorization: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    room, role = authorized(room_id, authorization)
    text = body.text.strip()
    if not text:
        raise SessionError(422, "invalid_input", "Invalid input")
    async with room.lock:
        segment, duplicate = store.append(
            room,
            role,
            body.clientSeq,
            text,
            "manual",
            "manual:" + body.text,
            timestamp(),
        )
    assert segment is not None
    return JSONResponse(segment.wire(), status_code=200 if duplicate else 201)


@app.post("/api/sessions/{room_id}/audio")
async def audio(
    room_id: str,
    clientSeq: Annotated[int, Form(gt=0)],
    audio: Annotated[UploadFile, File()],
    authorization: Annotated[str | None, Header()] = None,
) -> Response:
    room, role = authorized(room_id, authorization)
    if room.mode != "live" or transcriber is None:
        raise SessionError(503, "provider_unavailable", "Transcription unavailable")
    if audio.content_type != "audio/webm":
        raise SessionError(422, "unsupported_audio", "Unsupported audio")
    started = timestamp()
    data = await audio.read(MAX_AUDIO + 1)
    if len(data) > MAX_AUDIO:
        raise SessionError(413, "clip_too_large", "Clip too large")
    if (
        len(data) < 16
        or data[:4] != b"\x1a\x45\xdf\xa3"
        or b"webm" not in data[:128]
        or b"\x18\x53\x80\x67" not in data[:256]
    ):
        raise SessionError(422, "unsupported_audio", "Unsupported audio")
    fingerprint = store.fingerprint_audio(data)
    async with room.lock:
        duplicate, previous = store.receipt(room, role, clientSeq, fingerprint)
        if duplicate:
            return (
                JSONResponse(previous.wire(), status_code=200)
                if previous
                else Response(status_code=204)
            )
        if len(room.segments) >= 256:
            raise SessionError(409, "segment_limit", "Segment limit reached")
        room.seats[role].pending.add(clientSeq)
    try:
        try:
            result = await asyncio.wait_for(
                transcriber.transcribe(AudioClip(data, "audio/webm", role)), timeout=25
            )
            text = result.text.strip()
            if len(text) > 2000:
                raise ValueError("Transcription too long")
        except Exception as exc:
            async with room.lock:
                room.provider_status["transcription"] = "unavailable"
                room.emit(
                    {
                        "type": "provider_status",
                        "provider": "transcription",
                        "status": "unavailable",
                    }
                )
            raise SessionError(
                502, "transcription_failed", "Transcription failed"
            ) from exc
        async with room.lock:
            if room.ended:
                raise SessionError(404, "session_not_found", "Session not found")
            room.provider_status["transcription"] = "available"
            room.seats[role].pending.discard(clientSeq)
            segment, duplicate = store.append(
                room,
                role,
                clientSeq,
                text,
                "openai",
                fingerprint,
                started,
                blank=not text,
            )
    finally:
        async with room.lock:
            room.seats[role].pending.discard(clientSeq)
    if segment is None:
        return Response(status_code=204)
    return JSONResponse(segment.wire(), status_code=200 if duplicate else 201)


@app.post("/api/sessions/{room_id}/leave", status_code=204)
async def leave(
    room_id: str, _body: Empty, authorization: Annotated[str | None, Header()] = None
) -> Response:
    room, _ = authorized(room_id, authorization, allow_ended=True)
    async with room.lock:
        room.ended = True
        room.emit({"type": "expired"})
    return Response(status_code=204)


async def sender(websocket: WebSocket, queue: asyncio.Queue[Event]) -> None:
    while True:
        event = await queue.get()
        if event["type"] == "replaced":
            await websocket.close(code=4409)
            return
        if event["type"] in ("expired", "overflow"):
            await websocket.close(code=4404 if event["type"] == "expired" else 4410)
            return
        await websocket.send_json(event)


@app.websocket("/api/sessions/{room_id}/events")
async def events(websocket: WebSocket, room_id: str) -> None:
    await websocket.accept()
    if websocket.headers.get("origin") != allowed_origin:
        await websocket.close(code=4403)
        return
    try:
        room = store.room(room_id)
    except SessionError:
        await websocket.close(code=4404)
        return
    try:
        first = Auth.model_validate(
            await asyncio.wait_for(websocket.receive_json(), timeout=5)
        )
        role = store.auth(room, first.participantToken)
    except TimeoutError, ValidationError, ValueError, SessionError, WebSocketDisconnect:
        await websocket.close(code=4401)
        return
    queue: asyncio.Queue[Event] = asyncio.Queue(maxsize=64)
    async with room.lock:
        if room.ended:
            await websocket.close(code=4404)
            return
        old = room.seats[role].queue
        if old is not None:
            if old.full():
                _ = old.get_nowait()
            old.put_nowait({"type": "replaced"})
            room.seats[role].queue = None
            room.emit(
                {"type": "peer", "role": role, "joined": True, "connected": False}
            )
        room.seats[role].queue = queue
        view = room.snapshot(role)
        room.emit({"type": "peer", "role": role, "joined": True, "connected": True})
    await websocket.send_json({"type": "snapshot", "snapshot": view})
    send_task = asyncio.create_task(sender(websocket, queue))
    try:
        while True:
            incoming = cast(object, await websocket.receive_json())
            try:
                signal = Signal.model_validate(incoming)
                if (signal.data.kind == "offer" and role != "host") or (
                    signal.data.kind == "answer" and role != "guest"
                ):
                    raise ValueError("wrong role")
            except ValidationError, ValueError:
                await websocket.close(code=4400)
                break
            async with room.lock:
                room.touched = timestamp()
                peer: Role = "guest" if role == "host" else "host"
                target = room.seats.get(peer)
                if target is None or target.queue is None:
                    room.enqueue(
                        room.seats[role],
                        {"type": "signal_error", "code": "peer_offline"},
                    )
                else:
                    room.enqueue(
                        target,
                        {
                            "type": "signal",
                            "from": role,
                            "data": signal.data.model_dump(),
                        },
                    )
    except WebSocketDisconnect, RuntimeError:
        pass
    finally:
        _ = send_task.cancel()
        with suppress(asyncio.CancelledError):
            await send_task
        async with room.lock:
            if room.seats[role].queue is queue:
                room.seats[role].queue = None
                room.emit(
                    {"type": "peer", "role": role, "joined": True, "connected": False}
                )
