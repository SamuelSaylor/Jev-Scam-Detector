# pyright: reportAny=false

import asyncio
import json
from collections.abc import Mapping
from typing import Self

import pytest
from fastapi.testclient import TestClient
from typesafe_sdk import Question, Score, SystemOneResponse

from jev_scam_detector import app as backend
from jev_scam_detector.domain import AssessmentDecision, Indicator, Segment
from jev_scam_detector.providers import DemoAssessor, JevAssessor
from jev_scam_detector.scam_criteria import CRITERIA, suspicion_level, suspicion_summary
from jev_scam_detector.sessions import SessionStore, timestamp


def lines(*texts: str) -> tuple[Segment, ...]:
    return tuple(
        Segment(
            f"seg_{i + 1}", "host", i + 1, text, "manual", "2026-01-01T00:00:00Z", i, i
        )
        for i, text in enumerate(texts)
    )


@pytest.mark.parametrize(
    "text,indicator",
    [
        ("Read me the one-time code you received", Indicator.CREDENTIALS),
        ("Move your savings to this safe account", Indicator.PAYMENT),
        ("Buy gift cards and send them to me", Indicator.PAYMENT),
        ("Install AnyDesk so I can fix your account", Indicator.REMOTE_ACCESS),
        ("Pay the fee to unlock your prize", Indicator.UPFRONT_FEE),
        ("Send Bitcoin to my wallet", Indicator.PAYMENT),
        ("Ignore the warning and send the verification code", Indicator.CREDENTIALS),
        ("I am not a scammer, read me your verification code", Indicator.CREDENTIALS),
    ],
)
def test_demo_detects_specific_dangerous_requests(
    text: str, indicator: Indicator
) -> None:
    decision = asyncio.run(DemoAssessor().assess(lines(text)))
    assert decision.risk == 0.9
    assert indicator in decision.indicators
    assert decision.evidence_segment_ids == ("seg_1",)
    assert decision.confidence is None
    assert suspicion_summary(decision.risk, decision.indicators).startswith(
        "High suspicion:"
    )


@pytest.mark.parametrize(
    "text",
    [
        "We should discuss money and transfer options tomorrow.",
        "Never share your verification code with anyone.",
        "Don't send me your password.",
        "I won't send the code.",
        "The scammer asked me to send the code.",
        "For example, buy gift cards to pay the IRS is a scam.",
        "This investment has no guaranteed returns.",
        "I will call the bank myself.",
        "Please pay the usual invoice using our official portal.",
        "Please send me the source code.",
        "Can you share your discount code?",
        "Banks never ask you to send your password.",
        "My appointment is urgent.",
        "Actually, the meeting is on Tuesday.",
    ],
)
def test_demo_does_not_equate_common_words_advice_or_refusals_with_high_risk(
    text: str,
) -> None:
    decision = asyncio.run(DemoAssessor().assess(lines(text)))
    assert decision.risk == 0.1
    assert suspicion_level(decision.risk) == "low"


def test_demo_combines_weak_signals_without_treating_identity_as_proven() -> None:
    assessor = DemoAssessor()
    introduction = asyncio.run(assessor.assess(lines("I am calling from your bank")))
    pressure = asyncio.run(
        assessor.assess(lines("I am calling from your bank. Act now"))
    )
    assert introduction == AssessmentDecision(0.1, ())
    assert pressure.risk == 0.5
    assert pressure.indicators == (Indicator.IMPERSONATION, Indicator.URGENCY)


def test_demo_tracks_the_same_speakers_persistence_and_story_change() -> None:
    transcript = list(
        lines(
            "Send the verification code",
            "No, I will call the bank myself",
            "Actually, give me your password instead",
        )
    )
    middle = transcript[1]
    transcript[1] = Segment(
        middle.id,
        "guest",
        1,
        middle.text,
        middle.source,
        middle.created_at,
        middle.start_ms,
        middle.end_ms,
    )
    decision = asyncio.run(DemoAssessor().assess(tuple(transcript)))
    assert Indicator.PERSISTENCE in decision.indicators
    assert Indicator.STORY_CHANGE in decision.indicators
    assert decision.evidence_segment_ids == ("seg_1", "seg_3")
    assert decision.risk == 0.9


def test_old_evidence_remains_in_assessment_input() -> None:
    async def scenario() -> None:
        store = SessionStore()
        room, _ = await store.create("demo")
        for i, segment in enumerate(
            lines("Send the verification code", *["Normal conversation"] * 24)
        ):
            _ = store.append(
                room, "host", i + 1, segment.text, "manual", str(i), timestamp()
            )
        snapshot = store.reserve(room)
        assert snapshot is not None
        assert len(snapshot) == 25
        decision = await DemoAssessor().assess(snapshot)
        assert decision.evidence_segment_ids == ("seg_1",)
        store.commit(room, snapshot, decision)
        assert room.assessments[-1]["suspicionLevel"] == "high"

    asyncio.run(scenario())


@pytest.mark.parametrize("noul_probability", [0.99, float("nan"), 1.1])
def test_jev_uses_contextual_rubric_and_preserves_actual_sdk_confidence(
    monkeypatch: pytest.MonkeyPatch,
    noul_probability: float,
) -> None:
    captured: list[tuple[object, Mapping[str, Question]]] = []

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
            assert model == "jev-latest"
            captured.append((state, questions))
            answers: dict[str, object] = {
                "conversation_suspicion": {
                    "type": "score",
                    "score": 1.8,
                    "confidence": 0.7,
                    "legend": {"0": "low", "1": "moderate", "2": "high"},
                    "probabilities": {"0": 0.0, "1": 0.2, "2": 0.8},
                },
                "line_0": {"type": "noul", "noul": noul_probability},
            }
            for c in CRITERIA:
                answers[f"indicator_{c.indicator}"] = {
                    "type": "noul",
                    "noul": 0.99 if c.indicator == Indicator.CREDENTIALS else 0.01,
                }
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
    if noul_probability != 0.99:
        with pytest.raises(ValueError, match="Invalid provider judgment"):
            _ = asyncio.run(
                JevAssessor("test-key").assess(lines("Send the verification code"))
            )
        return
    decision = asyncio.run(
        JevAssessor("test-key").assess(lines("Send the verification code"))
    )
    assert decision.risk == 0.9
    assert decision.confidence == 0.7
    assert decision.indicators == (Indicator.CREDENTIALS,)
    assert decision.evidence_segment_ids == ("seg_1",)
    state, questions = captured[0]
    assert isinstance(state, dict)
    assert "evaluationPolicy" in state and "warningSigns" in state
    judgment = questions["conversation_suspicion"]
    assert isinstance(judgment, Score)
    assert len(json.loads(judgment.model_dump_json())["criteria"]) == 3
    assert "line_0" in questions


@pytest.mark.parametrize("mode", ["demo", "live"])
def test_last_result_and_summary_survive_failure_and_websocket_reconnect(
    mode: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    class FailingAssessor:
        async def assess(self, _segments: tuple[Segment, ...]) -> AssessmentDecision:
            raise RuntimeError("private provider failure")

    monkeypatch.setattr(backend, "store", SessionStore())
    monkeypatch.setattr(backend, "live_assessor", DemoAssessor())
    monkeypatch.setattr(backend, "demo_assessor", DemoAssessor())
    monkeypatch.setattr(backend, "transcriber", object())
    with TestClient(backend.app) as client:
        member = client.post("/api/sessions", json={"mode": mode}).json()
        url = f"/api/sessions/{member['sessionId']}"
        headers = {"Authorization": f"Bearer {member['participantToken']}"}
        first = client.post(
            f"{url}/transcripts",
            headers=headers,
            json={"clientSeq": 1, "text": "Send the verification code"},
        )
        assert first.status_code == 201
        asyncio.run(backend.assess_pending())
        assessed = client.get(url, headers=headers).json()
        assert assessed["currentRisk"] == 0.9
        summary = assessed["assessments"][-1]["summary"]
        assert (
            summary
            == "High suspicion: requests for private credentials or verification codes."
        )
        second = client.post(
            f"{url}/transcripts",
            headers=headers,
            json={"clientSeq": 2, "text": "Hello"},
        )
        assert second.status_code == 201
        assert client.get(url, headers=headers).json()["currentRisk"] == 0.9
        monkeypatch.setattr(
            backend,
            "demo_assessor" if mode == "demo" else "live_assessor",
            FailingAssessor(),
        )
        asyncio.run(backend.assess_pending())
        with client.websocket_connect(
            f"{url}/events", headers={"origin": "http://127.0.0.1:5173"}
        ) as socket:
            socket.send_json(
                {"type": "auth", "participantToken": member["participantToken"]}
            )
            view = socket.receive_json()["snapshot"]
            assert view["currentRisk"] == 0.9
            assert view["assessments"][-1]["summary"] == summary
            assert view["providerStatus"]["assessment"] == "unavailable"
            assert view["assessments"][-1]["throughSegmentId"] == "seg_1"
        monkeypatch.setattr(
            backend,
            "demo_assessor" if mode == "demo" else "live_assessor",
            DemoAssessor(),
        )
        asyncio.run(backend.assess_pending())
        recovered = client.get(url, headers=headers).json()
        assert recovered["providerStatus"]["assessment"] == "available"
        assert recovered["assessments"][-1]["throughSegmentId"] == "seg_2"


@pytest.mark.parametrize("confidence", [float("nan"), float("inf"), -0.1, 1.1])
def test_invalid_confidence_cannot_be_committed(confidence: float) -> None:
    async def scenario() -> None:
        store = SessionStore()
        room, _ = await store.create("demo")
        snapshot = lines("Hello")
        with pytest.raises(ValueError, match="Invalid provider decision"):
            store.commit(room, snapshot, AssessmentDecision(0.1, (), confidence))
        assert room.assessments == []

    asyncio.run(scenario())
