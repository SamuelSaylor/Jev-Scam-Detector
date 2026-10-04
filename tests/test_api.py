# pyright: reportAny=false

import asyncio
import json
from pathlib import Path

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from jev_scam_detector import app as backend
from jev_scam_detector.domain import (
    AssessmentDecision,
    AudioClip,
    Segment,
    Transcription,
)
from jev_scam_detector.providers import DemoAssessor
from jev_scam_detector.sessions import SessionStore

ORIGIN = {"origin": "http://127.0.0.1:5173"}


def setup(client: TestClient) -> tuple[str, str, str]:
    host = client.post("/api/sessions", json={"mode": "demo"}).json()
    room = host["sessionId"]
    guest = client.post(f"/api/sessions/{room}/join", json={}).json()
    return room, host["participantToken"], guest["participantToken"]


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_contract_examples_and_auth() -> None:
    fixture = json.loads(
        (
            Path(__file__).parents[1] / "contracts/examples.json"
            if (Path(__file__).parents[1] / "contracts/examples.json").exists()
            else Path("/tmp/jev-scaffold-worktrees/core/contracts/examples.json")
        ).read_text()
    )
    backend.store = SessionStore()
    with TestClient(backend.app) as client:
        assert client.get("/api/health").json() == fixture["health"]["response"]["body"]
        room, host, guest = setup(client)
        url = f"/api/sessions/{room}"
        assert set(client.get(url, headers=auth(host)).json()) == set(
            fixture["snapshot"]["response"]["body"]
        )
        assert client.get(url).json()["error"]["code"] == "invalid_token"
        assert client.get(url, headers=auth(guest)).json()["peer"] == {
            "role": "host",
            "joined": True,
            "connected": False,
        }
        assert (
            client.post(f"{url}/join", json={}).json()["error"]["code"]
            == "session_full"
        )
        segment = client.post(
            f"{url}/transcripts",
            headers=auth(host),
            json=fixture["transcript"]["request"]["body"],
        )
        assert segment.status_code == 201
        assert set(segment.json()) == set(fixture["transcript"]["response"]["body"])
        assert segment.json()["speaker"] == "host"
        assert (
            client.post(
                f"{url}/transcripts",
                headers=auth(host),
                json={"clientSeq": 1, "text": "Send the code"},
            ).status_code
            == 200
        )
        assert (
            client.post(
                f"{url}/transcripts",
                headers=auth(host),
                json={"clientSeq": 1, "text": "Send the money"},
            ).json()["error"]["code"]
            == "sequence_conflict"
        )
        assert (
            client.post(
                f"{url}/transcripts",
                headers=auth(guest),
                json={"clientSeq": 1, "text": "No"},
            ).json()["speaker"]
            == "guest"
        )
        assert client.get(url, headers=auth(host)).json()["currentRisk"] is None
        asyncio.run(backend.assess_pending())
        view = client.get(url, headers=auth(host)).json()
        assert view["currentRisk"] == 0.8
        assert view["assessments"][0]["evidenceSegmentIds"] == [segment.json()["id"]]
        asyncio.run(backend.assess_pending())
        assert len(client.get(url, headers=auth(host)).json()["assessments"]) == 1
        assert (
            client.post(f"{url}/leave", headers=auth(host), json={}).status_code == 204
        )
        assert (
            client.post(f"{url}/leave", headers=auth(host), json={}).status_code == 204
        )
        assert client.get(url, headers=auth(host)).status_code == 404


def test_invalid_inputs_and_live_provider_requirement() -> None:
    backend.store = SessionStore()
    with TestClient(backend.app) as client:
        room, token, _ = setup(client)
        url = f"/api/sessions/{room}"
        for body in (
            {"clientSeq": 1, "text": "   "},
            {"clientSeq": 1, "text": "a" * 2001},
            {"clientSeq": 0, "text": "hi"},
            {"clientSeq": 1, "text": "hi", "speaker": "guest"},
        ):
            result = client.post(f"{url}/transcripts", headers=auth(token), json=body)
            assert result.status_code == 422
            assert result.json()["error"]["code"] == "invalid_input"
        assert (
            client.post(
                f"{url}/audio",
                headers=auth(token),
                data={"clientSeq": "1"},
                files={"audio": ("clip.webm", b"\x1a\x45\xdf\xa3", "audio/webm")},
            ).status_code
            == 503
        )
        original_transcriber, original_assessor = (
            backend.transcriber,
            backend.live_assessor,
        )
        backend.transcriber = None
        backend.live_assessor = None
        assert (
            client.post("/api/sessions", json={"mode": "live"}).json()["error"]["code"]
            == "live_not_configured"
        )
        backend.transcriber, backend.live_assessor = (
            original_transcriber,
            original_assessor,
        )


def test_oversized_multipart_rejected_before_file_parsing() -> None:
    backend.store = SessionStore()
    with TestClient(backend.app) as client:
        room, token, _ = setup(client)
        result = client.post(
            f"/api/sessions/{room}/audio",
            headers=auth(token),
            data={"clientSeq": "1"},
            files={
                "audio": ("clip.webm", b"x" * (backend.MAX_MULTIPART + 1), "audio/webm")
            },
        )
        assert result.status_code == 413
        assert result.json() == {
            "error": {"code": "clip_too_large", "message": "Clip too large"}
        }


def test_websocket_signal_and_invalid_auth() -> None:
    backend.store = SessionStore()
    with TestClient(backend.app) as client:
        room, host, guest = setup(client)
        url = f"/api/sessions/{room}/events"
        with client.websocket_connect(url, headers=ORIGIN) as bad:
            bad.send_json({"type": "auth", "participantToken": "wrong"})
            try:
                bad.receive_json()
                assert False
            except WebSocketDisconnect as exc:
                assert exc.code == 4401
        with client.websocket_connect(url, headers=ORIGIN) as host_ws:
            host_ws.send_json({"type": "auth", "participantToken": host})
            assert host_ws.receive_json()["type"] == "snapshot"
            assert host_ws.receive_json()["type"] == "peer"
            host_ws.send_json(
                {"type": "signal", "data": {"kind": "offer", "sdp": "v=0"}}
            )
            assert host_ws.receive_json() == {
                "type": "signal_error",
                "code": "peer_offline",
            }
            with client.websocket_connect(url, headers=ORIGIN) as guest_ws:
                guest_ws.send_json({"type": "auth", "participantToken": guest})
                assert guest_ws.receive_json()["snapshot"]["peer"]["connected"] is True
                assert guest_ws.receive_json()["type"] == "peer"
                assert host_ws.receive_json() == {
                    "type": "peer",
                    "role": "guest",
                    "joined": True,
                    "connected": True,
                }
                host_ws.send_json(
                    {"type": "signal", "data": {"kind": "offer", "sdp": "v=0"}}
                )
                assert guest_ws.receive_json() == {
                    "type": "signal",
                    "from": "host",
                    "data": {"kind": "offer", "sdp": "v=0"},
                }
                guest_ws.send_json(
                    {"type": "signal", "data": {"kind": "offer", "sdp": "v=0"}}
                )
                try:
                    guest_ws.receive_json()
                    assert False
                except WebSocketDisconnect as exc:
                    assert exc.code == 4400


class SilentTranscriber:
    async def transcribe(self, _clip: AudioClip) -> Transcription:
        return Transcription("  ")


class BrokenTranscriber:
    async def transcribe(self, _clip: AudioClip) -> Transcription:
        raise RuntimeError("private provider text")


class BrokenAssessor:
    async def assess(self, _segments: tuple[Segment, ...]) -> AssessmentDecision:
        raise ValueError("private error")


def test_silent_clip_and_assessment_retry() -> None:
    backend.store = SessionStore()
    old_transcriber, old_assessor, old_demo = (
        backend.transcriber,
        backend.live_assessor,
        backend.demo_assessor,
    )
    backend.transcriber = SilentTranscriber()
    backend.live_assessor = BrokenAssessor()
    backend.demo_assessor = BrokenAssessor()
    try:
        with TestClient(backend.app) as client:
            live = client.post("/api/sessions", json={"mode": "live"}).json()
            url = f"/api/sessions/{live['sessionId']}"
            clip = {
                "audio": (
                    "clip.webm",
                    b"\x1a\x45\xdf\xa3\x82webm\x18\x53\x80\x67" + b"\0" * 20,
                    "audio/webm",
                )
            }
            first = client.post(
                f"{url}/audio",
                headers=auth(live["participantToken"]),
                data={"clientSeq": "1"},
                files=clip,
            )
            assert first.status_code == 204
            assert (
                client.post(
                    f"{url}/audio",
                    headers=auth(live["participantToken"]),
                    data={"clientSeq": "1"},
                    files=clip,
                ).status_code
                == 204
            )
            assert (
                client.get(url, headers=auth(live["participantToken"])).json()[
                    "segments"
                ]
                == []
            )
            backend.transcriber = BrokenTranscriber()
            failed = client.post(
                f"{url}/audio",
                headers=auth(live["participantToken"]),
                data={"clientSeq": "2"},
                files=clip,
            )
            assert failed.status_code == 502
            assert failed.json() == {
                "error": {
                    "code": "transcription_failed",
                    "message": "Transcription failed",
                }
            }
            assert (
                client.get(url, headers=auth(live["participantToken"])).json()[
                    "providerStatus"
                ]["transcription"]
                == "unavailable"
            )
            demo = client.post("/api/sessions", json={"mode": "demo"}).json()
            demo_url = f"/api/sessions/{demo['sessionId']}"
            _ = client.post(
                f"{demo_url}/transcripts",
                headers=auth(demo["participantToken"]),
                json={"clientSeq": 1, "text": "code"},
            )
            asyncio.run(backend.assess_pending())
            view = client.get(demo_url, headers=auth(demo["participantToken"])).json()
            assert view["currentRisk"] is None
            assert view["providerStatus"]["assessment"] == "unavailable"
            backend.demo_assessor = DemoAssessor()
            asyncio.run(backend.assess_pending())
            assert (
                client.get(demo_url, headers=auth(demo["participantToken"])).json()[
                    "currentRisk"
                ]
                == 0.8
            )
    finally:
        backend.transcriber, backend.live_assessor, backend.demo_assessor = (
            old_transcriber,
            old_assessor,
            old_demo,
        )
