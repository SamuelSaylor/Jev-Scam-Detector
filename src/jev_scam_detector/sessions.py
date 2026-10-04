from __future__ import annotations

import asyncio
import hashlib
import math
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal

from jev_scam_detector.domain import AssessmentDecision, Mode, Role, Segment

type Event = dict[str, object]


def timestamp() -> datetime:
    return datetime.now(UTC)


def iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


@dataclass
class Seat:
    token: str
    max_seq: int = 0
    pending: set[int] = field(default_factory=set)
    receipts: dict[int, tuple[str, Segment | None]] = field(default_factory=dict)
    queue: asyncio.Queue[Event] | None = None


class SessionError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status: int = status
        self.code: str = code
        self.message: str = message


@dataclass
class Room:
    id: str
    mode: Mode
    created: datetime
    touched: datetime
    seats: dict[Role, Seat]
    segments: list[Segment] = field(default_factory=list)
    assessments: list[Event] = field(default_factory=list)
    cursor: str | None = None
    busy: bool = False
    ended: bool = False
    provider_status: dict[str, str] = field(default_factory=dict)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def elapsed(self, instant: datetime) -> int:
        return max(0, int((instant - self.created).total_seconds() * 1000))

    @staticmethod
    def enqueue(seat: Seat, event: Event) -> None:
        if seat.queue is None:
            return
        try:
            seat.queue.put_nowait(event)
        except asyncio.QueueFull:
            _ = seat.queue.get_nowait()
            seat.queue.put_nowait({"type": "overflow"})
            seat.queue = None

    def emit(self, event: Event) -> None:
        for seat in self.seats.values():
            self.enqueue(seat, event)

    def snapshot(self, role: Role) -> Event:
        other: Role = "guest" if role == "host" else "host"
        peer = self.seats.get(other)
        latest = self.assessments[-1] if self.assessments else None
        risk = (
            latest["risk"]
            if latest
            and self.segments
            and latest["throughSegmentId"] == self.segments[-1].id
            and self.provider_status["assessment"] == "available"
            else None
        )
        return {
            "sessionId": self.id,
            "role": role,
            "mode": self.mode,
            "createdAt": iso(self.created),
            "peer": {
                "role": other,
                "joined": peer is not None,
                "connected": peer is not None and peer.queue is not None,
            },
            "segments": [s.wire() for s in self.segments],
            "assessments": list(self.assessments),
            "currentRisk": risk,
            "providerStatus": dict(self.provider_status),
        }


class SessionStore:
    def __init__(self) -> None:
        self.rooms: dict[str, Room] = {}
        self.lock: asyncio.Lock = asyncio.Lock()

    async def cleanup(self) -> None:
        async with self.lock:
            for key, room in list(self.rooms.items()):
                if (timestamp() - room.touched).total_seconds() >= 1800:
                    room.ended = True
                    room.emit({"type": "expired"})
                    del self.rooms[key]

    async def create(self, mode: Mode) -> tuple[Room, str]:
        await self.cleanup()
        async with self.lock:
            if len(self.rooms) >= 32:
                raise SessionError(503, "capacity_reached", "Session capacity reached")
            now = timestamp()
            room = Room(
                "sess_" + secrets.token_urlsafe(18),
                mode,
                now,
                now,
                {"host": Seat(secrets.token_urlsafe(32))},
                provider_status={
                    "transcription": "unavailable" if mode == "demo" else "available",
                    "assessment": "available",
                },
            )
            self.rooms[room.id] = room
            return room, room.seats["host"].token

    def room(self, room_id: str) -> Room:
        room = self.rooms.get(room_id)
        if room is None or (timestamp() - room.touched).total_seconds() >= 1800:
            raise SessionError(404, "session_not_found", "Session not found")
        return room

    def auth(self, room: Room, token: str) -> Role:
        for role, seat in room.seats.items():
            if secrets.compare_digest(seat.token, token):
                room.touched = timestamp()
                return role
        raise SessionError(401, "invalid_token", "Invalid participant token")

    async def join(self, room: Room) -> str:
        async with room.lock:
            if "guest" in room.seats or room.ended:
                raise SessionError(409, "session_full", "Session full")
            token = secrets.token_urlsafe(32)
            room.seats["guest"] = Seat(token)
            room.touched = timestamp()
            return token

    @staticmethod
    def receipt(
        room: Room, role: Role, seq: int, fingerprint: str
    ) -> tuple[bool, Segment | None]:
        seat = room.seats[role]
        if seq in seat.receipts:
            prior, segment = seat.receipts[seq]
            if prior == fingerprint:
                return True, segment
            raise SessionError(409, "sequence_conflict", "Sequence conflict")
        if seq <= seat.max_seq or seq in seat.pending:
            raise SessionError(409, "sequence_conflict", "Sequence conflict")
        if len(seat.receipts) >= 512:
            raise SessionError(409, "segment_limit", "Segment limit reached")
        return False, None

    def append(
        self,
        room: Room,
        role: Role,
        seq: int,
        text: str,
        source: Literal["manual", "openai"],
        fingerprint: str,
        started: datetime,
        *,
        blank: bool = False,
    ) -> tuple[Segment | None, bool]:
        duplicate, previous = self.receipt(room, role, seq, fingerprint)
        if duplicate:
            return previous, True
        if len(room.segments) >= 256 and not blank:
            raise SessionError(409, "segment_limit", "Segment limit reached")
        seat = room.seats[role]
        now = timestamp()
        segment = (
            None
            if blank
            else Segment(
                f"seg_{len(room.segments) + 1}",
                role,
                seq,
                text,
                source,
                iso(now),
                room.elapsed(started) if source == "openai" else room.elapsed(now),
                room.elapsed(now),
            )
        )
        seat.max_seq = seq
        seat.receipts[seq] = (fingerprint, segment)
        if segment:
            room.segments.append(segment)
            room.emit({"type": "transcript", "segment": segment.wire()})
        return segment, False

    def reserve(self, room: Room) -> tuple[Segment, ...] | None:
        if (
            room.ended
            or room.busy
            or not room.segments
            or room.cursor == room.segments[-1].id
        ):
            return None
        room.busy = True
        return tuple(room.segments[-20:])

    def commit(
        self, room: Room, snapshot: tuple[Segment, ...], decision: AssessmentDecision
    ) -> None:
        if (
            not math.isfinite(decision.risk)
            or not 0 <= decision.risk <= 1
            or not set(decision.evidence_segment_ids) <= {s.id for s in snapshot}
        ):
            raise ValueError("Invalid provider decision")
        if room.ended:
            return
        now = timestamp()
        assessment: Event = {
            "id": f"asm_{int(snapshot[-1].id[4:])}",
            "status": "ready",
            "mode": room.mode,
            "provider": "demo-rule" if room.mode == "demo" else "jev",
            "risk": decision.risk,
            "evidenceSegmentIds": list(decision.evidence_segment_ids),
            "throughSegmentId": snapshot[-1].id,
            "createdAt": iso(now),
            "startMs": snapshot[0].start_ms,
            "endMs": snapshot[-1].end_ms,
        }
        room.cursor = snapshot[-1].id
        room.assessments.append(assessment)
        room.assessments = room.assessments[-32:]
        room.emit({"type": "assessment", "assessment": assessment})

    @staticmethod
    def fingerprint_audio(data: bytes) -> str:
        return hashlib.sha256(b"audio/webm\x00" + data).hexdigest()
