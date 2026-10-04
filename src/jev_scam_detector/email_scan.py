"""Email scanning: reuse the call assessor on lines of an email thread.

The browser extension splits an open email thread into short lines. Each line
becomes one `Segment`, exactly like a transcribed line of a call, so the same
`ScamAssessor` (Jev or the demo rule) judges it and picks evidence lines.
"""

from __future__ import annotations

import math
from typing import ClassVar

from pydantic import BaseModel, ConfigDict, Field

from jev_scam_detector.domain import AssessmentDecision, Segment

MAX_LINES = 30
MAX_LINE_CHARS = 1000


class Strict(BaseModel):
    model_config: ClassVar[ConfigDict] = ConfigDict(extra="forbid")


class EmailLine(Strict):
    id: str = Field(min_length=1, max_length=64)
    sender: str = Field(min_length=1, max_length=320)
    text: str = Field(min_length=1, max_length=MAX_LINE_CHARS)


class EmailScan(Strict):
    lines: list[EmailLine] = Field(min_length=1, max_length=MAX_LINES)


def to_segments(scan: EmailScan, created_at: str) -> tuple[Segment, ...]:
    """Map email lines to call segments.

    The first sender in the thread plays "host" and everyone else "guest", so
    the assessor still sees who wrote what. Text is trimmed like call text.
    """
    first_sender = scan.lines[0].sender.casefold()
    return tuple(
        Segment(
            id=line.id,
            speaker="host" if line.sender.casefold() == first_sender else "guest",
            client_seq=index,
            text=line.text.strip(),
            source="manual",
            created_at=created_at,
            start_ms=0,
            end_ms=0,
        )
        for index, line in enumerate(scan.lines, start=1)
    )


def result(
    decision: AssessmentDecision, segments: tuple[Segment, ...], provider: str
) -> dict[str, object]:
    """Wire result. Evidence ids that were not in the input are dropped.

    An out-of-range risk is a provider failure, never a safe score.
    """
    if not math.isfinite(decision.risk) or not 0 <= decision.risk <= 1:
        raise ValueError("Provider returned an invalid risk")
    known = {segment.id for segment in segments}
    return {
        "risk": decision.risk,
        "evidenceIds": [i for i in decision.evidence_segment_ids if i in known],
        "provider": provider,
    }
