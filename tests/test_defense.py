import asyncio
from datetime import timedelta
from itertools import pairwise

import pytest
from fastapi.testclient import TestClient
from pydantic import TypeAdapter
from pytest import MonkeyPatch

from jev_scam_detector import app as backend
from jev_scam_detector.defense import RiskAccumulator, SeatDefense, TrustedContact
from jev_scam_detector.domain import AssessmentDecision, Indicator, Segment
from jev_scam_detector.sessions import SessionError, SessionStore, timestamp


def line(index: int) -> Segment:
    return Segment(
        f"seg_{index}",
        "host",
        index,
        "Send money and your password immediately",
        "manual",
        "2026-01-01T00:00:00Z",
        0,
        0,
    )


def decision(
    segments: tuple[Segment, ...], risk: float = 0.99, confidence: float = 0.95
) -> AssessmentDecision:
    return AssessmentDecision(
        risk,
        tuple(s.id for s in segments),
        confidence,
        tuple(
            Indicator(s.id, kind, 0.99)
            for s in segments
            for kind in (
                "urgency",
                "payment",
                "credentials",
                "unverified_link",
                "platform_switch",
            )
        ),
    )


def test_risk_builds_gradually_and_deduplicates() -> None:
    state = RiskAccumulator()
    scores: list[float] = []
    for index in range(1, 14):
        segments = tuple(line(i) for i in range(1, index + 1))
        scores.append(state.apply(segments, decision(segments), "live"))
        assert state.apply(segments, decision(segments), "live") == scores[-1]
    assert scores[0] <= 0.45
    assert all(-1e-6 <= new - old <= 0.120001 for old, new in pairwise(scores))
    assert any(0.5 <= value < 0.7 for value in scores)
    assert any(0.7 <= value < 0.85 for value in scores)
    assert scores[-1] >= 0.85
    assert state.tier == "lockout"
    assert len(state.history) == 13


def test_no_new_evidence_cannot_increase_and_risk_decays_slowly() -> None:
    state = RiskAccumulator()
    segments = (line(1),)
    _ = state.apply(segments, decision(segments), "live")
    initial = state.risk
    segments += (line(2),)
    _ = state.apply(
        segments,
        AssessmentDecision(0.99, ("seg_1",), 0.95, decision((line(1),)).indicators),
        "live",
    )
    assert state.risk == initial
    prior = state.risk or 0
    segments += (line(3),)
    result = state.apply(segments, AssessmentDecision(0, (), 0.95), "live")
    assert 0 <= prior - result <= 0.03


def test_low_confidence_and_single_line_do_not_lockout() -> None:
    state = RiskAccumulator()
    for index in range(1, 15):
        segments = tuple(line(i) for i in range(1, index + 1))
        _ = state.apply(segments, decision(segments, confidence=0.2), "live")
    assert (state.risk or 0) <= 0.69
    assert state.tier not in ("contact", "lockout")
    demo = RiskAccumulator()
    assert demo.apply((line(1),), decision((line(1),)), "demo") == 0.99
    assert demo.tier == "monitor"


def test_hysteresis_requires_two_below_boundary_decisions() -> None:
    state = RiskAccumulator(risk=0.69, tier="contact")
    state.update_tier("caution")
    assert state.tier == "contact"
    state.risk = 0.66
    state.update_tier("caution")
    assert state.tier == "contact"
    state.update_tier("caution")
    assert state.tier == "caution"


def test_override_requires_server_wait_is_private_and_does_not_relock_same_evidence(
    monkeypatch: MonkeyPatch,
) -> None:
    async def scenario() -> None:
        store = SessionStore()
        room, _ = await store.create("live")
        _ = await store.join(room)
        for index in range(1, 12):
            _ = store.append(
                room, "host", index, line(index).text, "manual", str(index), timestamp()
            )
            snapshot = tuple(room.segments)
            store.commit(room, snapshot, decision(snapshot))
            if room.seats["host"].defense.hold:
                break
        hold = room.seats["host"].defense.hold
        assert hold is not None
        with pytest.raises(SessionError, match="countdown"):
            _ = store.acknowledge(room, "host", hold.id)
        with pytest.raises(SessionError, match="safety warning"):
            _ = store.append(room, "host", 20, "new", "manual", "new", timestamp())
        _ = store.set_contact(
            room, "host", TrustedContact("Friend", "friend@example.com")
        )
        assert room.seats["guest"].defense.contact is None
        from jev_scam_detector import sessions

        monkeypatch.setattr(
            sessions, "timestamp", lambda: hold.ready + timedelta(seconds=1)
        )
        _ = store.acknowledge(room, "host", hold.id)
        _ = store.acknowledge(room, "host", hold.id)
        assert len(room.seats["host"].defense.overrides) == 1
        assert room.seats["guest"].defense.hold is not None
        assert room.seats["guest"].defense.overrides == []
        assert room.accumulator.tier == "lockout"
        next_seq = len(room.segments) + 1
        _ = store.append(
            room, "host", next_seq, "ordinary hello", "manual", "ordinary", timestamp()
        )
        snapshot = tuple(room.segments)
        old_indicators = decision(snapshot[:-1]).indicators
        store.commit(room, snapshot, AssessmentDecision(0.99, (), 0.95, old_indicators))
        assert room.seats["host"].defense.hold is None
        next_seq += 1
        _ = store.append(
            room, "host", next_seq, "send password", "manual", "password", timestamp()
        )
        snapshot = tuple(room.segments)
        store.commit(room, snapshot, decision(snapshot))
        assert room.seats["host"].defense.hold is not None

    asyncio.run(scenario())


def test_contact_api_validates_and_requires_auth() -> None:
    backend.store = SessionStore()
    with TestClient(backend.app) as client:
        member = TypeAdapter(dict[str, str]).validate_json(
            client.post("/api/sessions", json={"mode": "demo"}).content
        )
        url = f"/api/sessions/{member['sessionId']}/defense/contact"
        headers = {"Authorization": f"Bearer {member['participantToken']}"}
        assert client.post(url, json={"contact": None}).status_code == 401
        assert (
            client.post(
                url,
                headers=headers,
                json={"contact": {"name": " ", "email": "friend@example.com"}},
            ).status_code
            == 422
        )
        assert (
            client.post(
                url,
                headers=headers,
                json={"contact": {"name": "Friend", "email": "bad"}},
            ).status_code
            == 422
        )
        result = client.post(
            url,
            headers=headers,
            json={"contact": {"name": " Friend ", "email": "friend@example.com"}},
        )
        assert result.status_code == 200
        assert '"name":"Friend"' in result.text
        assert (
            client.post(url, headers=headers, json={"contact": None}).status_code == 200
        )


def test_seat_defense_has_no_hold_without_actual_evidence() -> None:
    seat = SeatDefense()
    state = RiskAccumulator(risk=0.99, tier="lockout")
    seat.update(state, "asm_1", 0.99, timestamp())
    assert seat.hold is None


def test_repeated_payment_evidence_can_escalate_without_other_categories() -> None:
    state = RiskAccumulator()
    for index in range(1, 21):
        segments = tuple(line(i) for i in range(1, index + 1))
        payment = AssessmentDecision(
            0.99,
            tuple(s.id for s in segments),
            0.95,
            tuple(Indicator(s.id, "payment", 0.99) for s in segments),
        )
        _ = state.apply(segments, payment, "live")
    assert (state.risk or 0) >= 0.85
    assert state.tier == "lockout"


def test_independent_verification_decays_even_with_high_raw_risk() -> None:
    state = RiskAccumulator()
    segments: tuple[Segment, ...] = ()
    for index in range(1, 12):
        segments = tuple(line(i) for i in range(1, index + 1))
        _ = state.apply(segments, decision(segments), "live")
    before = state.risk or 0
    verified = line(12)
    rich = decision(segments)
    segments += (verified,)
    result = state.apply(
        segments,
        AssessmentDecision(
            0.99,
            rich.evidence_segment_ids,
            0.95,
            rich.indicators
            + (Indicator(verified.id, "independent_verification", 0.99),),
        ),
        "live",
    )
    assert 0 < before - result <= 0.060001


def test_acknowledgment_does_not_review_evidence_added_while_held(
    monkeypatch: MonkeyPatch,
) -> None:
    async def scenario() -> None:
        store = SessionStore()
        room, _ = await store.create("live")
        for index in range(1, 12):
            _ = store.append(
                room, "host", index, line(index).text, "manual", str(index), timestamp()
            )
            snapshot = tuple(room.segments)
            store.commit(room, snapshot, decision(snapshot))
            if room.seats["host"].defense.hold:
                break
        first = room.seats["host"].defense.hold
        assert first is not None
        from jev_scam_detector import sessions

        monkeypatch.setattr(
            sessions, "timestamp", lambda: first.ready + timedelta(seconds=1)
        )
        new = Indicator("seg_pending", "credentials", 0.99)
        room.accumulator.evidence[(new.segment_id, new.kind)] = new
        _ = store.acknowledge(room, "host", first.id)
        second = room.seats["host"].defense.hold
        assert second is not None and second.id != first.id
        _ = store.acknowledge(room, "host", first.id)
        assert room.seats["host"].defense.hold == second
        assert (new.segment_id, new.kind) not in room.seats["host"].defense.acknowledged

    asyncio.run(scenario())
