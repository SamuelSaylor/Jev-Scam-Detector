# pyright: reportAny=false

import asyncio
from datetime import timedelta

from fastapi.testclient import TestClient

from jev_scam_detector import app as backend
from jev_scam_detector.domain import AssessmentDecision, Segment
from jev_scam_detector.sessions import SessionError, SessionStore, timestamp


class HoldingAssessor:
    def __init__(self) -> None:
        self.calls: int = 0
        self.started: asyncio.Event = asyncio.Event()
        self.release: asyncio.Event = asyncio.Event()

    async def assess(self, _segments: tuple[Segment, ...]) -> AssessmentDecision:
        self.calls += 1
        _ = self.started.set()
        _ = await self.release.wait()
        return AssessmentDecision(0.3, ())


def test_assessments_do_not_overlap_and_new_lines_wait() -> None:
    async def scenario() -> None:
        original, backend.demo_assessor = backend.demo_assessor, HoldingAssessor()
        holding = backend.demo_assessor
        backend.store = SessionStore()
        try:
            room, token = await backend.store.create("demo")
            _ = backend.store.append(
                room, "host", 1, "hello", "manual", "manual:hello", timestamp()
            )
            first = asyncio.create_task(backend.assess_pending())
            _ = await holding.started.wait()
            _ = backend.store.append(
                room, "host", 2, "code", "manual", "manual:code", timestamp()
            )
            await backend.assess_pending()
            assert holding.calls == 1
            assert room.snapshot(backend.store.auth(room, token))["currentRisk"] is None
            _ = holding.release.set()
            await first
            assert room.assessments[0]["throughSegmentId"] == "seg_1"
            await backend.assess_pending()
            assert holding.calls == 2
            assert room.assessments[1]["throughSegmentId"] == "seg_2"
        finally:
            backend.demo_assessor = original

    asyncio.run(scenario())


def test_capacity_expiration_and_sequence_bounds() -> None:
    async def scenario() -> None:
        store = SessionStore()
        rooms = [await store.create("demo") for _ in range(32)]
        try:
            _ = await store.create("demo")
            assert False
        except SessionError as exc:
            assert exc.code == "capacity_reached"
        expired, _ = rooms[0]
        expired.touched = timestamp() - timedelta(minutes=31)
        await store.cleanup()
        assert expired.id not in store.rooms
        _ = await store.create("demo")
        room, _ = rooms[1]
        for seq in range(1, 513):
            _ = store.append(
                room,
                "host",
                seq,
                "",
                "manual",
                f"silent:{seq}",
                timestamp(),
                blank=True,
            )
        try:
            _ = store.append(
                room, "host", 513, "", "manual", "silent:513", timestamp(), blank=True
            )
            assert False
        except SessionError as exc:
            assert exc.code == "segment_limit"

    asyncio.run(scenario())


def test_socket_replacement_closes_old_connection() -> None:
    backend.store = SessionStore()
    with TestClient(backend.app) as client:
        session = client.post("/api/sessions", json={"mode": "demo"}).json()
        url = f"/api/sessions/{session['sessionId']}/events"
        origin = {"origin": "http://127.0.0.1:5173"}
        with client.websocket_connect(url, headers=origin) as original:
            original.send_json(
                {"type": "auth", "participantToken": session["participantToken"]}
            )
            assert original.receive_json()["type"] == "snapshot"
            assert original.receive_json()["type"] == "peer"
            with client.websocket_connect(url, headers=origin) as replacement:
                replacement.send_json(
                    {"type": "auth", "participantToken": session["participantToken"]}
                )
                assert replacement.receive_json()["type"] == "snapshot"
                from starlette.websockets import WebSocketDisconnect

                try:
                    original.receive_json()
                    assert False
                except WebSocketDisconnect as exc:
                    assert exc.code == 4409
