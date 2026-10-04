"""Focused regressions for the demo's bounded lexical and turn-identity rules."""

import asyncio
from dataclasses import replace

import pytest

from jev_scam_detector.domain import AssessmentDecision, Indicator, Role, Segment
from jev_scam_detector.providers import DemoAssessor


def segment(id: str, speaker: Role, text: str, time: int = 0) -> Segment:
    return Segment(id, speaker, time, text, "manual", "", time, time)


@pytest.mark.parametrize(
    "text,indicator",
    [
        ("Read me the verification code", Indicator.CREDENTIALS),
        ("Send your login code", Indicator.CREDENTIALS),
        ("Tell me your authentication code", Indicator.CREDENTIALS),
        ("Share the security code", Indicator.CREDENTIALS),
        ("Give me the one-time code", Indicator.CREDENTIALS),
        ("Provide your password", Indicator.CREDENTIALS),
        ("Tell me your PIN", Indicator.CREDENTIALS),
        ("Read me the OTP", Indicator.CREDENTIALS),
        (
            "Provide the twelve-word recovery phrase for your wallet",
            Indicator.CREDENTIALS,
        ),
        ("Share your wallet seed phrase", Indicator.CREDENTIALS),
        ("Deposit $50 to unlock withdrawal of your earnings", Indicator.UPFRONT_FEE),
        ("Pay $20 to unlock your wages", Indicator.UPFRONT_FEE),
        ("Send $10 to unlock your earnings", Indicator.UPFRONT_FEE),
        (
            "Never share your code with strangers, but read me the verification code now",
            Indicator.CREDENTIALS,
        ),
        (
            "Don't send your password, but give me your wallet seed phrase",
            Indicator.CREDENTIALS,
        ),
    ],
)
def test_explicit_bounded_requests(text: str, indicator: Indicator) -> None:
    decision = asyncio.run(DemoAssessor().assess((segment("request", "host", text),)))
    assert decision == AssessmentDecision(0.9, ("request",), indicators=(indicator,))


@pytest.mark.parametrize(
    "text",
    [
        "Send me the code",
        "SEND THE CODE",
        "Read me the six digits",
        "Please send the source code",
        "Share your promo code",
        "Wallet recovery phrases are private secrets",
        "Never share your wallet seed phrase",
        "Don't provide your recovery phrase",
        "Never deposit money to unlock withdrawal of earnings",
        "Don't pay $20 to unlock your wages",
        "Deposit money into your savings account",
        "Pay the ordinary withdrawal service charge",
        "Pay $20 to unlock the door",
        "Never share your code, but don't send your password either",
    ],
)
def test_mentions_ambiguous_objects_and_negated_requests(text: str) -> None:
    decision = asyncio.run(DemoAssessor().assess((segment("line", "host", text),)))
    assert decision == AssessmentDecision(0.1, ())


@pytest.mark.parametrize("speaker", ["host", "guest"])
def test_duplicate_delivery_after_refusal_is_not_persistence(speaker: Role) -> None:
    other: Role = "guest" if speaker == "host" else "host"
    request = segment("request", speaker, "Send the verification code", 1)
    refusal = segment("refusal", other, "No", 2)
    decision = asyncio.run(DemoAssessor().assess((request, refusal, request)))
    assert decision == AssessmentDecision(
        0.9, ("request",), indicators=(Indicator.CREDENTIALS,)
    )


def test_replay_does_not_remove_real_spoken_persistence() -> None:
    first = segment("first", "host", "Send the verification code", 1)
    refusal = segment("refusal", "guest", "No", 2)
    repeated = replace(first, id="repeated", client_seq=3, start_ms=3, end_ms=3)
    decision = asyncio.run(
        DemoAssessor().assess((first, refusal, repeated, first, repeated))
    )
    assert decision == AssessmentDecision(
        0.9,
        ("first", "repeated"),
        indicators=(Indicator.CREDENTIALS, Indicator.PERSISTENCE),
    )


def test_same_segment_id_update_is_not_a_distinct_spoken_turn() -> None:
    request = segment("request", "host", "Send the verification code", 1)
    refusal = segment("refusal", "guest", "No", 2)
    updated = replace(request, text="Give me your password", end_ms=3)
    decision = asyncio.run(DemoAssessor().assess((request, refusal, updated)))
    assert decision == AssessmentDecision(
        0.9, ("request",), indicators=(Indicator.CREDENTIALS,)
    )
