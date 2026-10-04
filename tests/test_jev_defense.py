import asyncio
from unittest.mock import patch

import httpx2
from typesafe_sdk import AsyncTypeSafeClient

from jev_scam_detector.domain import Segment
from jev_scam_detector.providers import JevAssessor


def test_jev_reads_real_typed_confidence_and_indicators_without_network() -> None:
    captured: list[httpx2.Request] = []

    def respond(request: httpx2.Request) -> httpx2.Response:
        captured.append(request)
        answers: dict[str, object] = {
            "conversation_pressure": {"type": "noul", "noul": 0.92},
            "evidence_strength": {
                "type": "score",
                "score": 3.0,
                "confidence": 0.86,
                "legend": {str(i): "test level" for i in range(5)},
                "probabilities": {str(i): 1.0 if i == 3 else 0.0 for i in range(5)},
            },
        }
        for kind in (
            "urgency",
            "payment",
            "credentials",
            "unverified_link",
            "platform_switch",
            "independent_verification",
        ):
            answers[f"line_0_{kind}"] = {
                "type": "noul",
                "noul": 0.94 if kind in ("urgency", "payment") else 0.1,
            }
        return httpx2.Response(
            200,
            json={
                "model": "jev-test",
                "usage": {"input_tokens": 1, "output_tokens": 1},
                "answers": answers,
            },
        )

    def local_client(*, api_key: str) -> AsyncTypeSafeClient:
        return AsyncTypeSafeClient(
            api_key=api_key, transport=httpx2.MockTransport(respond)
        )

    segment = Segment(
        "seg_1", "guest", 1, "Send money now", "manual", "2026-01-01T00:00:00Z", 0, 0
    )
    with patch("jev_scam_detector.providers.AsyncTypeSafeClient", local_client):
        result = asyncio.run(
            JevAssessor("test-key").assess_with_context(
                (segment,),
                (
                    {
                        "role": "host",
                        "lockoutId": "hold_1",
                        "assessmentId": "asm_1",
                        "createdAt": "2026-01-01T00:00:00Z",
                    },
                ),
            )
        )
    assert result.risk == 0.92
    assert result.confidence == 0.86
    assert result.evidence_segment_ids == ("seg_1",)
    assert len(result.indicators) == 6
    assert len(captured) == 1
    assert b"warningAcknowledgments" in captured[0].content
    assert b"evidence_strength" in captured[0].content
