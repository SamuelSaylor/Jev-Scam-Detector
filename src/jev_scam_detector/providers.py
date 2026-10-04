from __future__ import annotations

import math
import re

import httpx
from pydantic import BaseModel
from typesafe_sdk import AsyncTypeSafeClient, Noul, NoulCriteria, Question, Score

from jev_scam_detector.domain import (
    AssessmentDecision,
    AudioClip,
    Indicator,
    Role,
    Segment,
    Transcription,
)
from jev_scam_detector.scam_criteria import (
    CONTEXT_RULES,
    CRITERIA,
    SUSPICION_RUBRIC,
)

UNVALIDATED_EXAMPLE_EVIDENCE_THRESHOLD = 0.7
DEMO_SAFETY_CONTEXT = re.compile(
    r"\b(?:never (?:ask|request|share|send|give|install)|(?:do not|don't|dont) (?:share|send|give|install)|"
    + r"i (?:will not|won't|wont|refuse to)|(?:the scammer (?:asked|said|told)|scammers (?:ask|request)|"
    + r"scam example|safety advice|for example|beware|they said|he said|she said)|"
    + r"(?:not|no) guaranteed|not risk.free|(?:programming|source|discount|promo) code)\b"
)
DEMO_REFUSAL = re.compile(
    r"\b(?:no|refuse|won't|will not|verify|call .{0,30}(?:bank|myself))\b"
)


class TranscriptionResponse(BaseModel):
    text: str


class DemoAssessor:
    async def assess(self, segments: tuple[Segment, ...]) -> AssessmentDecision:
        findings: dict[str, set[Indicator]] = {}
        previous: dict[Role, Segment] = {}
        challenged: set[Role] = set()
        for segment in segments:
            text = segment.text.casefold().replace("’", "'")
            if DEMO_REFUSAL.search(text):
                challenged.update(role for role in previous if role != segment.speaker)
            hits: set[Indicator] = set()
            for clause in re.split(r"[.!?;]", text):
                if DEMO_SAFETY_CONTEXT.search(clause):
                    continue
                hits.update(
                    c.indicator
                    for c in CRITERIA
                    if any(re.search(pattern, clause) for pattern in c.demo_patterns)
                )
            risky = any(c.strong and c.indicator in hits for c in CRITERIA)
            prior = previous.get(segment.speaker)
            if Indicator.STORY_CHANGE in hits and not (risky and prior):
                hits.remove(Indicator.STORY_CHANGE)
            if risky:
                if (
                    prior
                    and prior.text != segment.text
                    and segment.speaker in challenged
                ):
                    hits.add(Indicator.PERSISTENCE)
                previous[segment.speaker] = segment
            if hits:
                findings[segment.id] = hits
        indicators = tuple(
            c.indicator
            for c in CRITERIA
            if any(c.indicator in h for h in findings.values())
        )
        strong = any(c.strong and c.indicator in indicators for c in CRITERIA)
        risk = (
            0.9
            if strong or len(indicators) >= 3
            else 0.5
            if len(indicators) >= 2
            else 0.1
        )
        return AssessmentDecision(risk, tuple(findings), indicators=indicators)


class OpenAITranscriber:
    def __init__(self, api_key: str, model: str = "gpt-transcribe") -> None:
        self.api_key: str = api_key
        self.model: str = model

    async def transcribe(self, clip: AudioClip) -> Transcription:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                "https://api.openai.com/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {self.api_key}"},
                data={"model": self.model},
                files={"file": ("clip.webm", clip.data, clip.mime_type)},
            )
            _ = response.raise_for_status()
            return Transcription(
                TranscriptionResponse.model_validate_json(response.content).text
            )


class JevAssessor:
    def __init__(self, api_key: str) -> None:
        self.api_key: str = api_key

    async def assess(self, segments: tuple[Segment, ...]) -> AssessmentDecision:
        policy = "Apply `evaluationPolicy` and interpret `warningSigns` using the full ordered `segments`."
        questions: dict[str, Question] = {
            "conversation_suspicion": Score(
                instructions=f"How suspicious is this conversation for a scam? {policy}",
                criteria=list(SUSPICION_RUBRIC),
            ),
            **{
                f"indicator_{c.indicator}": Noul(
                    instructions=f"Does the conversation exhibit `{c.indicator}` as defined in `warningSigns`? {policy}",
                    criteria=NoulCriteria(
                        true="There is concrete transcript evidence of this warning sign.",
                        false="Absent, merely mentioned, contradicted, or explained by benign context.",
                    ),
                )
                for c in CRITERIA
            },
            **{
                f"line_{i}": Noul(
                    instructions=f"Does `segments[{i}]` provide concrete evidence for any of these warning signs, "
                    + "considering the other lines and this speaker's earlier and later requests? "
                    + policy,
                    criteria=NoulCriteria(
                        true="This line contributes evidence of a warning sign in context.",
                        false="This line is benign, a refusal, safety advice, quotation, or irrelevant.",
                    ),
                )
                for i in range(len(segments))
            },
        }
        async with AsyncTypeSafeClient(api_key=self.api_key) as client:
            response = await client.system_one(  # pyright: ignore[reportUnknownMemberType]
                state={
                    "evaluationPolicy": CONTEXT_RULES,
                    "warningSigns": {
                        c.indicator.value: c.description for c in CRITERIA
                    },
                    "segments": [
                        {"id": s.id, "speaker": s.speaker, "text": s.text}
                        for s in segments
                    ],
                },
                questions=questions,
                model="jev-latest",
            )
        judgment = response.scores["conversation_suspicion"]
        risk = judgment.score / (len(SUSPICION_RUBRIC) - 1)
        values = [risk, judgment.confidence]
        values.extend(
            response.nouls[name].noul
            for name, question in questions.items()
            if isinstance(question, Noul)
        )
        if not all(math.isfinite(value) and 0 <= value <= 1 for value in values):
            raise ValueError("Invalid provider judgment")
        indicators = tuple(
            c.indicator
            for c in CRITERIA
            if response.nouls[f"indicator_{c.indicator}"].noul
            >= UNVALIDATED_EXAMPLE_EVIDENCE_THRESHOLD
        )
        evidence = tuple(
            s.id
            for i, s in enumerate(segments)
            if response.nouls[f"line_{i}"].noul
            >= UNVALIDATED_EXAMPLE_EVIDENCE_THRESHOLD
        )
        return AssessmentDecision(
            risk, evidence, judgment.confidence, indicators if evidence else ()
        )
