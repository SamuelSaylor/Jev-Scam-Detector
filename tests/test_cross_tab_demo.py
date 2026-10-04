import importlib.util
import sys
import wave
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType

import pytest
from fastapi.testclient import TestClient

DEMO = Path(__file__).parent.parent / "cross-tab-demo"


def load_server() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "cross_tab_server", DEMO / "server.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["cross_tab_server"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def server(tmp_path: Path) -> ModuleType:
    module = load_server()
    setattr(module, "TRANSCRIPT_DIR", tmp_path)  # noqa: B010 - dynamically loaded module
    return module


@pytest.fixture
def client(server: ModuleType) -> Iterator[TestClient]:
    with TestClient(server.app) as test_client:
        yield test_client


def test_pages_are_served(client: TestClient) -> None:
    assert client.get("/").status_code == 200
    assert client.get("/static/app.js").status_code == 200
    assert client.get("/static/pcm-worklet.js").status_code == 200


def test_two_people_can_signal_and_a_third_is_rejected(client: TestClient) -> None:
    code = client.post("/api/rooms").json()["code"]
    with client.websocket_connect(f"/ws/{code}") as a:
        assert a.receive_json()["you"] == "A"
        with client.websocket_connect(f"/ws/{code}") as b:
            joined = b.receive_json()
            assert joined["you"] == "B"
            assert joined["peers"] == ["A"]
            assert a.receive_json() == {"type": "peer-joined", "peer": "B"}

            a.send_json({"type": "signal", "data": {"x": 1}})
            assert b.receive_json() == {"type": "signal", "from": "A", "data": {"x": 1}}

            with client.websocket_connect(f"/ws/{code}") as third:
                assert third.receive_json() == {
                    "type": "error",
                    "detail": "Room is full.",
                }
        assert a.receive_json() == {"type": "peer-left", "peer": "B"}


def test_unknown_room_is_rejected(client: TestClient) -> None:
    with client.websocket_connect("/ws/NOPE1") as ws:
        assert ws.receive_json()["detail"] == "Room not found."
    assert client.get("/api/rooms/NOPE1/transcript").status_code == 404


def test_speech_becomes_a_labelled_message(
    client: TestClient, server: ModuleType
) -> None:
    sample = Path(__file__).parent / "data" / "hello.wav"
    if not server.stt_available():
        pytest.skip("Vosk model not downloaded (run cross-tab-demo/download_model.py)")
    with wave.open(str(sample)) as wav:
        pcm = wav.readframes(wav.getnframes())

    code = client.post("/api/rooms").json()["code"]
    with (
        client.websocket_connect(f"/ws/{code}") as a,
        client.websocket_connect(f"/ws/{code}") as b,
    ):
        a.receive_json()
        b.receive_json()
        a.receive_json()
        a.send_json({"type": "start-stt"})
        for i in range(0, len(pcm), 8192):
            a.send_bytes(pcm[i : i + 8192])
        a.send_bytes(b"\x00" * 32000)  # trailing silence closes the utterance
        message = next(
            m["message"]
            for m in iter(b.receive_json, None)
            if m["type"] == "transcript"
        )

    assert message["speaker"] == "A"
    assert "hello" in message["text"]
    assert (
        client.get(f"/api/rooms/{code}/transcript").json()[0]["text"] == message["text"]
    )
