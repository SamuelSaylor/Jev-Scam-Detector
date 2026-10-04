import asyncio
from dataclasses import replace

import pytest

from jev_scam_detector.domain import AssessmentDecision, Indicator, Role, Segment
from jev_scam_detector.providers import DemoAssessor


@pytest.mark.parametrize(
    "conversation,expected",
    [
        ((), AssessmentDecision(0.1, ())),
        (
            (("host", "I am calling from your bank. Act now. Keep this secret"),),
            AssessmentDecision(
                0.9,
                ("seg_1",),
                indicators=(
                    Indicator.IMPERSONATION,
                    Indicator.URGENCY,
                    Indicator.SECRECY,
                ),
            ),
        ),
        (
            (("host", "Never share your code. Send the password"),),
            AssessmentDecision(0.9, ("seg_1",), indicators=(Indicator.CREDENTIALS,)),
        ),
        (
            (("host", "SEND THE CODE"), ("guest", "I won’t send the code")),
            AssessmentDecision(0.9, ("seg_1",), indicators=(Indicator.CREDENTIALS,)),
        ),
        (
            (("host", "Send the code"), ("host", "Actually, give me your password")),
            AssessmentDecision(
                0.9,
                ("seg_1", "seg_2"),
                indicators=(Indicator.CREDENTIALS, Indicator.STORY_CHANGE),
            ),
        ),
        (
            (("host", "Send the code"), ("guest", "Actually, give me your password")),
            AssessmentDecision(
                0.9, ("seg_1", "seg_2"), indicators=(Indicator.CREDENTIALS,)
            ),
        ),
        (
            (
                ("host", "I am calling from your bank"),
                ("host", "Actually, send the code"),
            ),
            AssessmentDecision(
                0.9,
                ("seg_1", "seg_2"),
                indicators=(Indicator.CREDENTIALS, Indicator.IMPERSONATION),
            ),
        ),
        (
            (
                ("host", "Send the code"),
                ("guest", "No"),
                ("host", "Send the code"),
            ),
            AssessmentDecision(
                0.9, ("seg_1", "seg_3"), indicators=(Indicator.CREDENTIALS,)
            ),
        ),
        (
            (
                ("guest", "No"),
                ("host", "Send the code"),
                ("host", "Give me your password"),
            ),
            AssessmentDecision(
                0.9, ("seg_2", "seg_3"), indicators=(Indicator.CREDENTIALS,)
            ),
        ),
        (
            (
                ("guest", "Send the code"),
                ("host", "No"),
                ("guest", "Hello"),
                ("guest", "Actually, give me your password instead"),
            ),
            AssessmentDecision(
                0.9,
                ("seg_1", "seg_4"),
                indicators=(
                    Indicator.CREDENTIALS,
                    Indicator.STORY_CHANGE,
                    Indicator.PERSISTENCE,
                ),
            ),
        ),
        (
            (("host", "Act now"), ("guest", "I am calling from your bank")),
            AssessmentDecision(
                0.5,
                ("seg_1", "seg_2"),
                indicators=(Indicator.IMPERSONATION, Indicator.URGENCY),
            ),
        ),
    ],
)
def test_demo_preserves_context_and_ordered_decision(
    conversation: tuple[tuple[Role, str], ...], expected: AssessmentDecision
) -> None:
    segments = tuple(
        Segment(f"seg_{i}", speaker, i, text, "manual", "", i, i)
        for i, (speaker, text) in enumerate(conversation, start=1)
    )
    assert asyncio.run(DemoAssessor().assess(segments)) == expected


def test_demo_replaces_findings_for_repeated_segment_ids() -> None:
    first = Segment("same", "host", 1, "Send the code", "manual", "", 0, 0)
    second = replace(first, client_seq=2, text="Act now")
    assert asyncio.run(DemoAssessor().assess((first, second))) == AssessmentDecision(
        0.1, ("same",), indicators=(Indicator.URGENCY,)
    )
