import asyncio

import httpx
from pytest import MonkeyPatch

from jev_scam_detector.domain import AudioClip
from jev_scam_detector.providers import OpenAITranscriber


def test_openai_complete_clip_upload_without_network(monkeypatch: MonkeyPatch) -> None:
    captured: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"text": "  Send the code  "})

    original = httpx.AsyncClient

    def local_client(*, timeout: int) -> httpx.AsyncClient:
        return original(timeout=timeout, transport=httpx.MockTransport(respond))

    monkeypatch.setattr(httpx, "AsyncClient", local_client)
    clip = AudioClip(b"\x1a\x45\xdf\xa3example", "audio/webm", "host")
    result = asyncio.run(OpenAITranscriber("test-key").transcribe(clip))
    assert result.text == "  Send the code  "
    assert len(captured) == 1
    assert captured[0].url == "https://api.openai.com/v1/audio/transcriptions"
    assert captured[0].headers["authorization"] == "Bearer test-key"
    assert b"gpt-transcribe" in captured[0].content
    assert b"audio/webm" in captured[0].content
    assert clip.data in captured[0].content
