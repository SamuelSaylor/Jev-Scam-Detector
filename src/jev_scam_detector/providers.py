from __future__ import annotations

import httpx
from pydantic import BaseModel
from typesafe_sdk import AsyncTypeSafeClient, Noul, NoulCriteria

from jev_scam_detector.domain import (
    AssessmentDecision,
    AudioClip,
    Segment,
    Transcription,
)

UNVALIDATED_EXAMPLE_EVIDENCE_THRESHOLD = 0.7


class TranscriptionResponse(BaseModel):
    text: str


class DemoAssessor:
    async def assess(self, segments: tuple[Segment, ...]) -> AssessmentDecision:
        ids = tuple(
            s.id
            for s in segments
            if any(word in s.text.casefold() for word in ("code", "money", "transfer"))
        )
        return AssessmentDecision(0.8 if ids else 0.2, ids)


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
        questions = {
            "conversation_pressure": Noul(
                instructions="Does the conversation request a code, money transfer, or bypass of independent verification?",
                criteria=NoulCriteria(
                    true="The conversation contains such a request.",
                    false="It does not.",
                ),
            )
        }
        questions.update(
            {
                f"line_{i}": Noul(
                    instructions=f"Does this exact line request a code, money transfer, or bypass of independent verification? Line: {segment.text}"
                )
                for i, segment in enumerate(segments)
            }
        )
        async with AsyncTypeSafeClient(api_key=self.api_key) as client:
            response = await client.system_one(  # pyright: ignore[reportUnknownMemberType]
                state={
                    "segments": [
                        {"id": s.id, "speaker": s.speaker, "text": s.text}
                        for s in segments
                    ]
                },
                questions=questions,
                model="jev-latest",
            )
        risk = response.nouls["conversation_pressure"].noul
        evidence = tuple(
            s.id
            for i, s in enumerate(segments)
            if response.nouls[f"line_{i}"].noul
            >= UNVALIDATED_EXAMPLE_EVIDENCE_THRESHOLD
        )
        return AssessmentDecision(risk, evidence)
