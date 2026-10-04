import asyncio
from dataclasses import replace
from datetime import timedelta

from fastapi.testclient import TestClient
from pydantic import TypeAdapter

from jev_scam_detector import app as backend
from jev_scam_detector.domain import AssessmentDecision, Indicator
from jev_scam_detector.sessions import SessionStore, timestamp


def test_real_authenticated_hold_routes_and_private_socket_events() -> None:
    backend.store = SessionStore()
    with TestClient(backend.app) as client:
        host = TypeAdapter(dict[str, str]).validate_json(
            client.post("/api/sessions", json={"mode": "demo"}).content
        )
        url = f"/api/sessions/{host['sessionId']}"
        guest = TypeAdapter(dict[str, str]).validate_json(
            client.post(f"{url}/join", json={}).content
        )
        room = backend.store.rooms[host["sessionId"]]
        # Deterministic injected judgments. No live AI credentials or provider calls.
        room.mode = "live"
        for index in range(1, 12):
            _ = backend.store.append(
                room,
                "host",
                index,
                "send codes and money now",
                "manual",
                str(index),
                timestamp(),
            )
            segment_tuple = tuple(room.segments)
            judgment = AssessmentDecision(
                0.99,
                tuple(s.id for s in segment_tuple),
                0.95,
                tuple(
                    Indicator(s.id, kind, 0.99)
                    for s in segment_tuple
                    for kind in (
                        "urgency",
                        "payment",
                        "credentials",
                        "unverified_link",
                        "platform_switch",
                    )
                ),
            )
            backend.store.commit(room, segment_tuple, judgment)
            if room.seats["host"].defense.hold:
                break
        hold = room.seats["host"].defense.hold
        assert hold is not None
        headers = {"Authorization": f"Bearer {host['participantToken']}"}
        origin = {"origin": "http://127.0.0.1:5173"}
        with client.websocket_connect(f"{url}/events", headers=origin) as host_ws:
            host_ws.send_json(
                {"type": "auth", "participantToken": host["participantToken"]}
            )
            assert (
                host_ws.receive_json()["snapshot"]["defense"]["lockout"]["id"]
                == hold.id
            )
            assert host_ws.receive_json()["type"] == "peer"
            response = client.post(
                f"{url}/defense/contact",
                headers=headers,
                json={"contact": {"name": "Friend", "email": "friend@example.com"}},
            )
            assert response.status_code == 200
            assert host_ws.receive_json()["type"] == "defense"
            guest_headers = {"Authorization": f"Bearer {guest['participantToken']}"}
            guest_view = TypeAdapter(dict[str, object]).validate_json(
                client.get(url, headers=guest_headers).content
            )
            assert (
                '"trustedContact":null' in client.get(url, headers=guest_headers).text
            )
            assert "defense" in guest_view
            early = client.post(
                f"{url}/defense/overrides", headers=headers, json={"lockoutId": hold.id}
            )
            assert early.status_code == 409 and "review_wait" in early.text
            blocked = client.post(
                f"{url}/transcripts",
                headers=headers,
                json={"clientSeq": 100, "text": "blocked"},
            )
            assert blocked.status_code == 409 and "review_required" in blocked.text
            # Advance the hold's creation rather than waiting in the test.
            room.seats["host"].defense.hold = replace(
                hold, created=timestamp() - timedelta(seconds=6)
            )
            acknowledged = client.post(
                f"{url}/defense/overrides", headers=headers, json={"lockoutId": hold.id}
            )
            assert acknowledged.status_code == 200
            assert host_ws.receive_json()["defense"]["lockout"] is None
            assert (
                client.post(
                    f"{url}/defense/overrides",
                    headers=headers,
                    json={"lockoutId": hold.id},
                ).status_code
                == 200
            )
            assert len(room.seats["host"].defense.overrides) == 1
            assert room.seats["guest"].defense.hold is not None
            assert (
                client.post(
                    f"{url}/transcripts",
                    headers=headers,
                    json={"clientSeq": 100, "text": "resumed"},
                ).status_code
                == 201
            )


def test_late_join_receives_its_own_hold() -> None:
    async def scenario() -> None:
        store = SessionStore()
        room, _ = await store.create("live")
        room.accumulator.risk = 0.9
        room.accumulator.tier = "lockout"
        room.accumulator.evidence = {
            (f"seg_{i}", "payment"): Indicator(f"seg_{i}", "payment", 0.95)
            for i in range(1, 4)
        }
        from jev_scam_detector.defense import DecisionRecord

        room.accumulator.history.append(DecisionRecord("seg_3", 0.9, 0.95, ()))
        room.assessments.append({"id": "asm_3"})
        _ = await store.join(room)
        assert room.seats["guest"].defense.hold is not None

    asyncio.run(scenario())


def test_invalid_provider_confidence_cannot_enter_ledger() -> None:
    async def scenario() -> None:
        store = SessionStore()
        room, _ = await store.create("live")
        _ = store.append(room, "host", 1, "line", "manual", "line", timestamp())
        import pytest

        with pytest.raises(ValueError, match="Invalid provider"):
            store.commit(
                room, tuple(room.segments), AssessmentDecision(0.9, (), float("nan"))
            )
        assert room.assessments == []

    asyncio.run(scenario())
