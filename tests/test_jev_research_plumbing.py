# pyright: reportAny=false

"""Mocked Jev plumbing only, NOT evidence of live Jev semantic accuracy.

Synthetic SDK answers are supplied from the research gold expectations. These
checks verify that full prefix context reaches the provider, all line/indicator
questions exist, and the adapter maps supplied answers back to the right IDs.
They do not test whether Jev would actually produce those answers.
"""

import asyncio
import json
from collections.abc import Mapping
from typing import Self

import pytest
from typesafe_sdk import Choice, Noul, Question, Score, SystemOneResponse

from jev_scam_detector.domain import Indicator
from jev_scam_detector.providers import JevAssessor
from jev_scam_detector.scam_criteria import CONTEXT_RULES, CRITERIA, SUSPICION_RUBRIC
from jev_scam_detector.scam_types import (
    SCAM_TYPE_CRITERIA,
    ScamClassification,
    ScamType,
)

from .research_scam_cases import (
    CASE_IDS,
    CASES,
    Checkpoint,
    Scenario,
    assert_expectations,
)


@pytest.mark.parametrize("scenario,checkpoint", CASES, ids=CASE_IDS)
def test_jev_research_prefix_request_and_mocked_answer_mapping(
    monkeypatch: pytest.MonkeyPatch,
    scenario: Scenario,
    checkpoint: Checkpoint,
) -> None:
    segments = scenario.segments(checkpoint.through)
    captured: list[tuple[object, Mapping[str, Question]]] = []

    class MockClient:
        def __init__(self, *, api_key: str) -> None:
            assert api_key == "research-test-key"

        async def __aenter__(self) -> Self:
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        async def system_one(
            self, *, state: object, questions: Mapping[str, Question], model: str
        ) -> SystemOneResponse:
            assert model == "jev-latest"
            captured.append((state, questions))
            # These are stipulated answers, not an inference engine.
            is_high = checkpoint.level == "high"
            answers: dict[str, object] = {
                "scam_type": {
                    "type": "choice",
                    "choice": "insufficient_context",
                    "confidence": 0.6,
                    "probabilities": {"insufficient_context": 1.0},
                },
                "conversation_suspicion": {
                    "type": "score",
                    "score": 1.8 if is_high else 0.2,
                    "confidence": 0.7,
                    "legend": {"0": "low", "1": "moderate", "2": "high"},
                    "probabilities": {
                        "0": 0.0 if is_high else 0.8,
                        "1": 0.2,
                        "2": 0.8 if is_high else 0.0,
                    },
                },
            }
            for indicator in Indicator:
                answers[f"indicator_{indicator}"] = {
                    "type": "noul",
                    "noul": 0.99
                    if indicator in checkpoint.required_indicators
                    else 0.01,
                }
            for i, segment in enumerate(segments):
                answers[f"line_{i}"] = {
                    "type": "noul",
                    "noul": 0.99
                    if segment.id in checkpoint.required_evidence
                    else 0.01,
                }
            return SystemOneResponse.model_validate_json(
                json.dumps(
                    {
                        "model": "jev-mocked-research",
                        "usage": {"input_tokens": 10, "output_tokens": 10},
                        "answers": answers,
                    }
                )
            )

    monkeypatch.setattr("jev_scam_detector.providers.AsyncTypeSafeClient", MockClient)
    decision = asyncio.run(JevAssessor("research-test-key").assess(segments))
    assert_expectations(decision, segments, checkpoint)
    assert decision.confidence == 0.7
    # Stipulated classification for mapping only, not research type gold.
    assert decision.classification == ScamClassification(
        ScamType.INSUFFICIENT_CONTEXT, 0.6
    )
    assert decision.risk == pytest.approx(0.9 if checkpoint.level == "high" else 0.1)
    assert len(captured) == 1
    state, questions = captured[0]
    assert state == {
        "evaluationPolicy": CONTEXT_RULES,
        "warningSigns": {c.indicator.value: c.description for c in CRITERIA},
        "segments": [
            {"id": s.id, "speaker": s.speaker, "text": s.text} for s in segments
        ],
    }
    # Exact ordered input includes all counterevidence and late clarification;
    # original host/guest attribution and fragment boundaries are preserved.
    assert set(questions) == {
        "conversation_suspicion",
        "scam_type",
        *(f"indicator_{indicator}" for indicator in Indicator),
        *(f"line_{i}" for i in range(len(segments))),
    }
    classification = questions["scam_type"]
    assert isinstance(classification, Choice)
    serialized_choice = json.loads(classification.model_dump_json())
    assert serialized_choice["criteria"] == SCAM_TYPE_CRITERIA
    assert "full ordered `segments`" in serialized_choice["instructions"]
    suspicion = questions["conversation_suspicion"]
    assert isinstance(suspicion, Score)
    serialized_suspicion = json.loads(suspicion.model_dump_json())
    assert serialized_suspicion["criteria"] == list(SUSPICION_RUBRIC)
    assert "full ordered `segments`" in serialized_suspicion["instructions"]
    for indicator in Indicator:
        question = questions[f"indicator_{indicator}"]
        assert isinstance(question, Noul)
        instructions = json.loads(question.model_dump_json())["instructions"]
        assert f"`{indicator}`" in instructions
        assert "full ordered `segments`" in instructions
    for i in range(len(segments)):
        question = questions[f"line_{i}"]
        assert isinstance(question, Noul)
        instructions = json.loads(question.model_dump_json())["instructions"]
        assert f"segments[{i}]" in instructions
        assert "earlier and later requests" in instructions
        assert "full ordered `segments`" in instructions
    assert decision.evidence_segment_ids == tuple(
        s.id for s in segments if s.id in checkpoint.required_evidence
    )
    assert decision.indicators == tuple(
        c.indicator for c in CRITERIA if c.indicator in checkpoint.required_indicators
    )
