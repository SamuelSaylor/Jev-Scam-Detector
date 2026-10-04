from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

Role = Literal["host", "guest"]
Mode = Literal["demo", "live"]


@dataclass(frozen=True)
class Segment:
    id: str
    speaker: Role
    client_seq: int
    text: str
    source: Literal["manual", "openai"]
    created_at: str
    start_ms: int
    end_ms: int

    def wire(self) -> dict[str, object]:
        return {
            "id": self.id,
            "speaker": self.speaker,
            "clientSeq": self.client_seq,
            "text": self.text,
            "source": self.source,
            "createdAt": self.created_at,
            "startMs": self.start_ms,
            "endMs": self.end_ms,
        }


@dataclass(frozen=True)
class AudioClip:
    data: bytes
    mime_type: Literal["audio/webm"]
    speaker: Role


@dataclass(frozen=True)
class Transcription:
    text: str


@dataclass(frozen=True)
class AssessmentDecision:
    risk: float
    evidence_segment_ids: tuple[str, ...]


class Transcriber(Protocol):
    async def transcribe(self, clip: AudioClip) -> Transcription: ...


class ScamAssessor(Protocol):
    async def assess(self, segments: tuple[Segment, ...]) -> AssessmentDecision: ...
