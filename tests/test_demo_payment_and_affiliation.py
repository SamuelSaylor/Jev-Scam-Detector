"""Local demo rules for gift-card requests and institutional introductions."""

import asyncio

import pytest

from jev_scam_detector.domain import AssessmentDecision, Indicator, Segment
from jev_scam_detector.providers import DemoAssessor


def assess(text: str) -> AssessmentDecision:
    line = Segment("line", "host", 1, text, "manual", "", 1, 1)
    return asyncio.run(DemoAssessor().assess((line,)))


@pytest.mark.parametrize(
    "text",
    [
        "Buy gift cards for the volunteers at our school raffle",
        "Purchase a gift card for a birthday",
        "Buy gift cards; nobody needs the card numbers",
        "Gift card numbers should remain private",
        "I am calling from your bank about your appointment",
        "I am with the police",
        "We are from Microsoft tech support",
        "This is the IRS",
        "Actually, I am calling from your bank",
    ],
)
def test_purchases_and_affiliation_alone_are_not_positive_evidence(text: str) -> None:
    assert assess(text) == AssessmentDecision(0.1, ())


@pytest.mark.parametrize(
    "text",
    [
        "Buy gift cards and send them to me",
        "Purchase gift cards and provide the redemption details",
        "Pay the bill with gift cards",
        "Buy gift cards to pay the invoice",
        "Send the gift cards to this address",
        "Transfer the gift card to me",
        "Deliver gift cards to this address",
        "Mail the gift cards to me",
        "Read me the gift card numbers",
        "Tell me the gift card redemption code",
        "Provide the gift card redemption details",
    ],
)
def test_explicit_gift_card_payment_delivery_or_disclosure(text: str) -> None:
    assert assess(text) == AssessmentDecision(
        0.9, ("line",), indicators=(Indicator.PAYMENT,)
    )


def test_gift_card_pin_is_both_secret_and_redemption_disclosure() -> None:
    assert assess("Share your gift card PIN") == AssessmentDecision(
        0.9,
        ("line",),
        indicators=(Indicator.CREDENTIALS, Indicator.PAYMENT),
    )


@pytest.mark.parametrize(
    "text,expected",
    [
        (
            "I am calling from your bank. Read me the verification code",
            AssessmentDecision(
                0.9,
                ("line",),
                indicators=(Indicator.CREDENTIALS, Indicator.IMPERSONATION),
            ),
        ),
        (
            "I am from tech support. Install AnyDesk",
            AssessmentDecision(
                0.9,
                ("line",),
                indicators=(Indicator.IMPERSONATION, Indicator.REMOTE_ACCESS),
            ),
        ),
        (
            "I am from the IRS. Pay with gift cards",
            AssessmentDecision(
                0.9,
                ("line",),
                indicators=(Indicator.PAYMENT, Indicator.IMPERSONATION),
            ),
        ),
        (
            "I am calling from your bank. Act now",
            AssessmentDecision(
                0.5,
                ("line",),
                indicators=(Indicator.IMPERSONATION, Indicator.URGENCY),
            ),
        ),
    ],
)
def test_affiliation_with_a_local_suspicious_sign(
    text: str, expected: AssessmentDecision
) -> None:
    assert assess(text) == expected
