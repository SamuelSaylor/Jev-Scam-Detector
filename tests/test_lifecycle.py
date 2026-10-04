import asyncio
from collections.abc import Callable
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from pydantic import TypeAdapter
from pytest import MonkeyPatch

from jev_scam_detector import app as backend
from jev_scam_detector.domain import AssessmentDecision, Segment
from jev_scam_detector.sessions import (
    Event,
    Room,
    SessionError,
    SessionStore,
    timestamp,
)


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
            assert room.snapshot(backend.store.auth(room, token))["currentRisk"] == 0.3
            await backend.assess_pending()
            assert holding.calls == 2
            assert room.assessments[1]["throughSegmentId"] == "seg_2"
        finally:
            backend.demo_assessor = original

    asyncio.run(scenario())


def test_slow_rooms_do_not_delay_later_assessment_ticks() -> None:
    async def scenario() -> None:
        original, backend.demo_assessor = backend.demo_assessor, HoldingAssessor()
        holding = backend.demo_assessor
        backend.store = SessionStore()
        for index in range(8):
            room, _ = await backend.store.create("demo")
            _ = backend.store.append(
                room,
                "host",
                1,
                f"line {index}",
                "manual",
                f"manual:{index}",
                timestamp(),
            )
        try:
            async with backend.lifespan(backend.app):
                _ = await asyncio.wait_for(holding.started.wait(), timeout=7)
                ninth, _ = await backend.store.create("demo")
                _ = backend.store.append(
                    ninth, "host", 1, "new line", "manual", "manual:new", timestamp()
                )
                await asyncio.sleep(5.3)
                assert ninth.busy is True
                assert holding.calls == 4
                _ = holding.release.set()
        finally:
            backend.demo_assessor = original

    asyncio.run(scenario())


def test_local_commit_failure_is_not_reported_as_provider_outage(
    monkeypatch: MonkeyPatch,
) -> None:
    async def scenario() -> None:
        original, backend.demo_assessor = backend.demo_assessor, HoldingAssessor()
        holding = backend.demo_assessor
        backend.store = SessionStore()
        room, _ = await backend.store.create("demo")
        _ = backend.store.append(
            room, "host", 1, "hello", "manual", "manual:hello", timestamp()
        )

        def fail_commit(*_args: object) -> None:
            raise RuntimeError("local commit failed")

        monkeypatch.setattr(backend.store, "commit", fail_commit)
        _ = holding.release.set()
        try:
            try:
                await backend.assess_pending()
                assert False, "local failure must propagate"
            except RuntimeError as exc:
                assert str(exc) == "local commit failed"
            assert room.provider_status["assessment"] == "available"
            assert room.busy is False
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
        session = TypeAdapter(dict[str, str]).validate_json(
            client.post("/api/sessions", json={"mode": "demo"}).content
        )
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


class LiveHoldingAssessor:
    def __init__(self) -> None:
        self.snapshots: list[tuple[Segment, ...]] = []
        self.release: asyncio.Event = asyncio.Event()
        self.cancelled: int = 0
        self.active: int = 0
        self.maximum: int = 0

    async def assess(self, segments: tuple[Segment, ...]) -> AssessmentDecision:
        self.snapshots.append(segments)
        self.active += 1
        self.maximum = max(self.maximum, self.active)
        try:
            _ = await self.release.wait()
            return AssessmentDecision(0.3, ())
        except asyncio.CancelledError:
            self.cancelled += 1
            raise
        finally:
            self.active -= 1


async def settle_until(predicate: Callable[[], bool]) -> None:
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(0)


def live_setup(monkeypatch: MonkeyPatch) -> LiveHoldingAssessor:
    assessor = LiveHoldingAssessor()
    monkeypatch.setattr(backend, "store", SessionStore())
    monkeypatch.setattr(backend, "assessment_slots", asyncio.Semaphore(4))
    monkeypatch.setattr(backend, "live_assessor", assessor)
    return assessor


async def live_room() -> Room:
    room, _ = await backend.store.create("live")
    append_line(room, 1)
    return room


def append_line(room: Room, seq: int) -> None:
    _ = backend.store.append(
        room, "host", seq, f"line {seq}", "manual", f"manual:{seq}", timestamp()
    )


def short_deadline(monkeypatch: MonkeyPatch, seconds: int) -> None:
    original = asyncio.timeout

    def timeout(delay: float | None) -> asyncio.Timeout:
        return original(0.01 if delay == seconds else delay)

    monkeypatch.setattr(asyncio, "timeout", timeout)


def test_live_queued_snapshot_refresh_and_overlapping_sweeps(
    monkeypatch: MonkeyPatch,
) -> None:
    async def scenario() -> None:
        assessor = live_setup(monkeypatch)
        slots = backend.assessment_slots
        for _ in range(4):
            _ = await slots.acquire()
        room = await live_room()
        sweep = asyncio.create_task(backend.assess_pending())
        await settle_until(lambda: room.busy)
        append_line(room, 2)
        await backend.assess_pending()
        assert assessor.snapshots == []
        slots.release()
        await settle_until(lambda: len(assessor.snapshots) == 1)
        assert [s.id for s in assessor.snapshots[0]] == ["seg_1", "seg_2"]
        append_line(room, 3)
        await backend.assess_pending()
        assert len(assessor.snapshots) == 1
        assessor.release.set()
        await sweep
        assert room.cursor == "seg_2"
        await backend.assess_pending()
        assert room.cursor == "seg_3"
        assert len(assessor.snapshots) == 2
        for _ in range(3):
            slots.release()
        assert slots._value == 4
        assert not room.busy

    asyncio.run(scenario())


def test_live_queue_timeout_preserves_result_and_retries(
    monkeypatch: MonkeyPatch,
) -> None:
    async def scenario() -> None:
        assessor = live_setup(monkeypatch)
        assessor.release.set()
        room = await live_room()
        await backend.assess_pending()
        previous = list(room.assessments)
        append_line(room, 2)
        for _ in range(4):
            _ = await backend.assessment_slots.acquire()
        short_deadline(monkeypatch, 5)
        await backend.assess_pending()
        assert not room.busy
        assert room.cursor == "seg_1"
        assert room.assessments == previous
        assert room.provider_status["assessment"] == "available"
        assert len(assessor.snapshots) == 1
        assert backend.assessment_slots._value == 0
        for _ in range(4):
            backend.assessment_slots.release()
        await backend.assess_pending()
        assert room.cursor == "seg_2"
        assert backend.assessment_slots._value == 4

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "stage", ["before_start", "worker_start", "room_lock", "queued", "provider"]
)
def test_live_cancellation_releases_ownership(
    monkeypatch: MonkeyPatch, stage: str
) -> None:
    async def scenario() -> None:
        assessor = live_setup(monkeypatch)
        room = await live_room()
        if stage == "room_lock":
            _ = await room.lock.acquire()
        if stage == "queued":
            for _ in range(4):
                _ = await backend.assessment_slots.acquire()
        sweep = asyncio.create_task(backend.assess_pending())
        if stage == "worker_start":
            await asyncio.sleep(0)
        elif stage == "room_lock":
            await asyncio.sleep(0)
            await asyncio.sleep(0)
        elif stage == "queued":
            await settle_until(lambda: room.busy)
        elif stage == "provider":
            await settle_until(lambda: bool(assessor.snapshots))
        _ = sweep.cancel()
        with pytest.raises(asyncio.CancelledError):
            await sweep
        if stage == "room_lock":
            room.lock.release()
        if stage == "queued":
            for _ in range(4):
                backend.assessment_slots.release()
        assert not room.busy
        assert room.cursor is None
        assert room.assessments == []
        assert room.provider_status["assessment"] == "available"
        assert backend.assessment_slots._value == 4
        assert assessor.active == 0
        assert assessor.cancelled == (1 if stage == "provider" else 0)
        assessor.release.set()
        await backend.assess_pending()
        assert room.cursor == "seg_1"

    asyncio.run(scenario())


@pytest.mark.parametrize("failure", ["exception", "timeout", "missing"])
def test_live_provider_failures_release_and_retry(
    monkeypatch: MonkeyPatch, failure: str
) -> None:
    async def scenario() -> None:
        assessor = live_setup(monkeypatch)
        room = await live_room()
        if failure == "exception":

            class Broken:
                async def assess(
                    self, _segments: tuple[Segment, ...]
                ) -> AssessmentDecision:
                    raise ValueError("provider failed")

            monkeypatch.setattr(backend, "live_assessor", Broken())
        elif failure == "missing":
            monkeypatch.setattr(backend, "live_assessor", None)
        else:
            short_deadline(monkeypatch, 15)
        await backend.assess_pending()
        assert not room.busy
        assert room.cursor is None
        assert room.assessments == []
        assert room.provider_status["assessment"] == "unavailable"
        assert backend.assessment_slots._value == 4
        assert assessor.active == 0
        if failure == "timeout":
            assert assessor.cancelled == 1
        monkeypatch.setattr(backend, "live_assessor", assessor)
        assessor.release.set()
        await backend.assess_pending()
        assert room.cursor == "seg_1"
        assert room.provider_status["assessment"] == "available"

    asyncio.run(scenario())


@pytest.mark.parametrize("stage", ["queued", "expired", "provider"])
def test_live_ended_rooms_skip_evaluation_and_recovery(
    monkeypatch: MonkeyPatch, stage: str
) -> None:
    async def scenario() -> None:
        assessor = live_setup(monkeypatch)
        room = await live_room()
        room.provider_status["assessment"] = "unavailable"
        events: asyncio.Queue[Event] = asyncio.Queue()
        room.seats["host"].queue = events
        if stage != "provider":
            for _ in range(4):
                _ = await backend.assessment_slots.acquire()
        sweep = asyncio.create_task(backend.assess_pending())
        await settle_until(
            lambda: bool(assessor.snapshots) if stage == "provider" else room.busy
        )
        if stage == "expired":
            room.touched = timestamp() - timedelta(minutes=31)
            await backend.store.cleanup()
        else:
            async with room.lock:
                room.ended = True
        if stage == "provider":
            assessor.release.set()
        else:
            for _ in range(4):
                backend.assessment_slots.release()
        await sweep
        assert not room.busy
        assert room.cursor is None
        assert room.assessments == []
        assert room.provider_status["assessment"] == "unavailable"
        assert backend.assessment_slots._value == 4
        assert len(assessor.snapshots) == (1 if stage == "provider" else 0)
        while not events.empty():
            assert events.get_nowait()["type"] == "expired"

    asyncio.run(scenario())


def test_live_local_failure_drains_running_and_queued_siblings(
    monkeypatch: MonkeyPatch,
) -> None:
    async def scenario() -> None:
        assessor = live_setup(monkeypatch)
        rooms = [await live_room() for _ in range(6)]
        fail = asyncio.Event()

        class OneCompletes:
            async def assess(self, segments: tuple[Segment, ...]) -> AssessmentDecision:
                if segments[0] is rooms[0].segments[0]:
                    _ = await fail.wait()
                    return AssessmentDecision(0.3, ())
                return await assessor.assess(segments)

        monkeypatch.setattr(backend, "live_assessor", OneCompletes())

        def fail_commit(*_args: object) -> None:
            raise RuntimeError("local commit failed")

        monkeypatch.setattr(backend.store, "commit", fail_commit)
        sweep = asyncio.create_task(backend.assess_pending())
        await settle_until(
            lambda: len(assessor.snapshots) == 3 and all(r.busy for r in rooms)
        )
        fail.set()
        with pytest.raises(RuntimeError, match="local commit failed"):
            await sweep
        assert all(not r.busy for r in rooms)
        assert all(r.provider_status["assessment"] == "available" for r in rooms)
        assert all(not r.assessments for r in rooms)
        assert assessor.active == 0
        assert backend.assessment_slots._value == 4

    asyncio.run(scenario())


def test_live_repeated_cancellation_waits_for_locked_cleanup(
    monkeypatch: MonkeyPatch,
) -> None:
    async def scenario() -> None:
        assessor = live_setup(monkeypatch)
        room = await live_room()
        sweep = asyncio.create_task(backend.assess_pending())
        await settle_until(lambda: bool(assessor.snapshots))
        _ = await room.lock.acquire()
        _ = sweep.cancel()
        await settle_until(lambda: backend.assessment_slots._value == 4)
        _ = sweep.cancel()
        await asyncio.sleep(0)
        _ = sweep.cancel()
        await asyncio.sleep(0)
        assert not sweep.done()
        assert room.busy
        room.lock.release()
        with pytest.raises(asyncio.CancelledError):
            await sweep
        assert not room.busy
        assert assessor.active == 0
        assert backend.assessment_slots._value == 4

    asyncio.run(scenario())


def test_live_capacity_limit_and_cancel_release_races(monkeypatch: MonkeyPatch) -> None:
    async def scenario() -> None:
        assessor = live_setup(monkeypatch)
        rooms = [await live_room() for _ in range(8)]
        sweep = asyncio.create_task(backend.assess_pending())
        await settle_until(
            lambda: len(assessor.snapshots) == 4 and all(r.busy for r in rooms)
        )
        assert assessor.maximum == 4
        assert backend.assessment_slots._value == 0
        assessor.release.set()
        _ = sweep.cancel()
        with pytest.raises(asyncio.CancelledError):
            await sweep
        assert all(not r.busy for r in rooms)
        assert assessor.active == 0
        assert backend.assessment_slots._value == 4
        await backend.assess_pending()
        assert all(r.cursor == "seg_1" for r in rooms)
        assert assessor.maximum <= 4
        assert backend.assessment_slots._value == 4

    asyncio.run(scenario())


@pytest.mark.parametrize("release_delay", [0, 0.01, 0.02])
def test_live_capacity_timeout_release_race(
    monkeypatch: MonkeyPatch, release_delay: float
) -> None:
    async def scenario() -> None:
        assessor = live_setup(monkeypatch)
        assessor.release.set()
        short_deadline(monkeypatch, 5)
        for _ in range(10):
            room = await live_room()
            slots = backend.assessment_slots
            for _ in range(4):
                _ = await slots.acquire()
            sweep = asyncio.create_task(backend.assess_pending())
            await settle_until(lambda room=room: room.busy)
            released = asyncio.Event()

            def release_one(
                slots: asyncio.Semaphore = slots,
                released: asyncio.Event = released,
            ) -> None:
                slots.release()
                released.set()

            _ = asyncio.get_running_loop().call_later(release_delay, release_one)
            await sweep
            _ = await released.wait()
            assert not room.busy
            assert room.provider_status["assessment"] == "available"
            for _ in range(3):
                slots.release()
            assert slots._value == 4
            await backend.assess_pending()
            assert room.cursor == "seg_1"
            assert slots._value == 4

    asyncio.run(scenario())


def test_live_end_after_capacity_acquired_skips_provider(
    monkeypatch: MonkeyPatch,
) -> None:
    async def scenario() -> None:
        assessor = live_setup(monkeypatch)
        room = await live_room()
        slots = backend.assessment_slots
        for _ in range(4):
            _ = await slots.acquire()
        sweep = asyncio.create_task(backend.assess_pending())
        await settle_until(lambda: room.busy)
        _ = await room.lock.acquire()
        slots.release()
        # Let the worker acquire its permit and block on the refresh lock.
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert slots._value == 0
        room.ended = True
        room.lock.release()
        await sweep
        for _ in range(3):
            slots.release()
        assert assessor.snapshots == []
        assert not room.busy
        assert slots._value == 4

    asyncio.run(scenario())


def test_live_cancel_after_capacity_acquired_releases_permit(
    monkeypatch: MonkeyPatch,
) -> None:
    async def scenario() -> None:
        assessor = live_setup(monkeypatch)
        room = await live_room()
        slots = backend.assessment_slots
        for _ in range(4):
            _ = await slots.acquire()
        sweep = asyncio.create_task(backend.assess_pending())
        await settle_until(lambda: room.busy)
        _ = await room.lock.acquire()
        slots.release()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert slots._value == 0
        _ = sweep.cancel()
        await settle_until(lambda: slots._value == 1)
        assert not sweep.done()
        room.lock.release()
        with pytest.raises(asyncio.CancelledError):
            await sweep
        for _ in range(3):
            slots.release()
        assert not room.busy
        assert slots._value == 4
        assert assessor.snapshots == []
        assert room.provider_status["assessment"] == "available"
        assert asyncio.all_tasks() == {asyncio.current_task()}

    asyncio.run(scenario())
