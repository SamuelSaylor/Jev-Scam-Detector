# pyright: reportAny=false

"""Mocked classification plumbing, not measured live Jev accuracy."""

import asyncio
import json
from collections.abc import Mapping
from typing import Self

import pytest
from typesafe_sdk import Choice, Noul, Question, SystemOneResponse

from jev_scam_detector.domain import AssessmentDecision, Segment
from jev_scam_detector.providers import DemoAssessor, JevAssessor
from jev_scam_detector.scam_types import (
    SCAM_TYPE_CRITERIA,
    ScamClassification,
    ScamType,
)
from jev_scam_detector.sessions import SessionStore


@pytest.mark.parametrize("scam_type", list(ScamType))
def test_choice_maps_every_type_and_round_trips_in_snapshot(
    monkeypatch: pytest.MonkeyPatch, scam_type: ScamType
) -> None:
    run_case(monkeypatch, scam_type.value, 0.8)


@pytest.mark.parametrize(
    "choice,confidence",
    [
        ("invented", 0.8),
        ("credential_theft", float("nan")),
        ("credential_theft", float("inf")),
        ("credential_theft", -0.1),
        ("credential_theft", 1.1),
    ],
)
def test_invalid_classification_is_a_provider_failure(
    monkeypatch: pytest.MonkeyPatch, choice: str, confidence: float
) -> None:
    with pytest.raises(ValueError):
        run_case(monkeypatch, choice, confidence)


def run_case(monkeypatch: pytest.MonkeyPatch, choice: str, confidence: float) -> None:
    segments = (
        Segment("seg_1", "host", 1, "Read me", "manual", "2026-01-01T00:00:00Z", 1, 1),
        Segment(
            "seg_2",
            "host",
            2,
            "your login code",
            "manual",
            "2026-01-01T00:00:00Z",
            2,
            2,
        ),
    )
    requests = 0

    class LocalClient:
        def __init__(self, *, api_key: str) -> None:
            assert api_key == "test-key"

        async def __aenter__(self) -> Self:
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        async def system_one(
            self, *, state: object, questions: Mapping[str, Question], model: str
        ) -> SystemOneResponse:
            nonlocal requests
            requests += 1
            assert model == "jev-latest"
            assert isinstance(state, dict)
            assert state["segments"] == [
                {"id": s.id, "speaker": s.speaker, "text": s.text} for s in segments
            ]
            classification = questions["scam_type"]
            assert isinstance(classification, Choice)
            serialized = json.loads(classification.model_dump_json())
            assert serialized["criteria"] == SCAM_TYPE_CRITERIA
            assert "evaluationPolicy" in serialized["instructions"]
            answers: dict[str, object] = {
                "scam_type": {
                    "type": "choice",
                    "choice": choice,
                    "confidence": confidence,
                    "probabilities": {choice: 1.0},
                },
                "conversation_suspicion": {
                    "type": "score",
                    "score": 1.8,
                    "confidence": 0.7,
                    "legend": {"0": "low", "1": "moderate", "2": "high"},
                    "probabilities": {"0": 0.0, "1": 0.2, "2": 0.8},
                },
            }
            for name, question in questions.items():
                if isinstance(question, Noul):
                    answers[name] = {"type": "noul", "noul": 0.99}
            return SystemOneResponse.model_validate_json(
                json.dumps(
                    {
                        "model": "jev-test",
                        "usage": {"input_tokens": 10, "output_tokens": 10},
                        "answers": answers,
                    }
                )
            )

    monkeypatch.setattr("jev_scam_detector.providers.AsyncTypeSafeClient", LocalClient)

    async def scenario() -> None:
        decision = await JevAssessor("test-key").assess(segments)
        assert requests == 1
        assert decision.risk == 0.9
        assert decision.confidence == 0.7
        assert decision.classification == ScamClassification(
            ScamType(choice), confidence
        )
        assert decision.evidence_segment_ids == ("seg_1", "seg_2")
        store = SessionStore()
        room, _ = await store.create("live")
        room.segments.extend(segments)
        store.commit(room, segments, decision)
        response = room.assessments[-1]
        assert response["scamType"] == choice
        assert response["scamTypeConfidence"] == confidence
        assert room.snapshot("host")["assessments"] == [response]

    asyncio.run(scenario())


def test_service_failure_never_falls_back_to_demo(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FailingClient:
        def __init__(self, *, api_key: str) -> None:
            raise RuntimeError("Provider unavailable")

    async def forbidden_demo(
        _self: DemoAssessor, _segments: tuple[Segment, ...]
    ) -> AssessmentDecision:
        pytest.fail("Live assessment must never fall back to demo")

    monkeypatch.setattr(
        "jev_scam_detector.providers.AsyncTypeSafeClient", FailingClient
    )
    monkeypatch.setattr(DemoAssessor, "assess", forbidden_demo)
    with pytest.raises(RuntimeError, match="Provider unavailable"):
        _ = asyncio.run(JevAssessor("test-key").assess(()))


def test_demo_does_not_invent_a_jev_classification() -> None:
    async def scenario() -> None:
        decision = await DemoAssessor().assess(())
        assert decision.classification is None
        store = SessionStore()
        room, _ = await store.create("demo")
        segment = Segment(
            "seg_1", "host", 1, "Hello", "manual", "2026-01-01T00:00:00Z", 1, 1
        )
        store.commit(room, (segment,), decision)
        assert room.assessments[-1]["scamType"] is None
        assert room.assessments[-1]["scamTypeConfidence"] is None

    asyncio.run(scenario())


@pytest.mark.parametrize("confidence", [float("nan"), float("inf"), -0.1, 1.1])
def test_commit_rejects_invalid_classification_confidence(confidence: float) -> None:
    async def scenario() -> None:
        store = SessionStore()
        room, _ = await store.create("live")
        segment = Segment(
            "seg_1", "host", 1, "Hello", "manual", "2026-01-01T00:00:00Z", 1, 1
        )
        decision = AssessmentDecision(
            0.1,
            (),
            classification=ScamClassification(
                ScamType.NO_APPARENT_SCAM,
                confidence,
            ),
        )
        with pytest.raises(ValueError, match="Invalid provider classification"):
            store.commit(room, (segment,), decision)
        assert not room.assessments

    asyncio.run(scenario())
