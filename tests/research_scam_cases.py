"""Research-derived expectations, not measured Jev accuracy or fraud probabilities.

Scenario numbers refer to the research analysis. Each checkpoint is assessed from
scratch over its ordered prefix. Counterevidence remains in the input but must
not appear as positive scam evidence. No fixtures contain real credentials.
"""

from dataclasses import dataclass

from jev_scam_detector.domain import AssessmentDecision, Indicator, Role, Segment
from jev_scam_detector.scam_criteria import SuspicionLevel, suspicion_level


@dataclass(frozen=True)
class Checkpoint:
    through: int
    level: SuspicionLevel
    required_indicators: frozenset[Indicator] = frozenset()
    required_evidence: frozenset[str] = frozenset()
    counterevidence: frozenset[str] = frozenset()
    rationale: str = ""

    @property
    def forbidden_indicators(self) -> frozenset[Indicator]:
        return frozenset(Indicator) - self.required_indicators

    @property
    def forbidden_evidence(self) -> frozenset[str]:
        return (
            frozenset(f"seg_{i}" for i in range(1, self.through + 1))
            - self.required_evidence
        )


@dataclass(frozen=True)
class Scenario:
    name: str
    research: str
    turns: tuple[tuple[Role, str], ...]
    checkpoints: tuple[Checkpoint, ...]

    def segments(self, through: int) -> tuple[Segment, ...]:
        return tuple(
            Segment(f"seg_{i}", role, i, text, "manual", "2026-01-01T00:00:00Z", i, i)
            for i, (role, text) in enumerate(self.turns[:through], start=1)
        )


def low(through: int, rationale: str, *counterevidence: int) -> Checkpoint:
    return Checkpoint(
        through,
        "low",
        counterevidence=frozenset(f"seg_{i}" for i in counterevidence),
        rationale=rationale,
    )


def high(
    through: int,
    indicators: tuple[Indicator, ...],
    evidence: tuple[int, ...],
    rationale: str,
    counterevidence: tuple[int, ...] = (),
) -> Checkpoint:
    return Checkpoint(
        through,
        "high",
        frozenset(indicators),
        frozenset(f"seg_{i}" for i in evidence),
        frozenset(f"seg_{i}" for i in counterevidence),
        rationale,
    )


SCENARIOS = (
    Scenario(
        "s02_verified_remote_support",
        "phone-scam-taxonomy: TECH_SUPPORT_REFUND; historical-manipulation: Finding 3",
        (
            (
                "host",
                "I opened this support ticket from the vendor portal and called its listed number.",
            ),
            ("guest", "Install AnyDesk for the screen sharing session you requested."),
            ("host", "I will close my banking apps first."),
            ("guest", "You can stop at any time; we do not need bank access."),
        ),
        (
            low(1, "User initiated the support session.", 1),
            low(2, "Requested remote support is not unsolicited exploitation.", 1),
            low(
                4,
                "Consent, purpose, and the exclusion of bank access remain relevant.",
                1,
                3,
                4,
            ),
        ),
    ),
    Scenario(
        "s03_source_code_clarification",
        "jev-judgment-design: contextual exclusions; streaming-call-detection: clarification",
        (
            ("host", "Send me the code."),
            ("guest", "Do you mean my login code?"),
            (
                "host",
                "No, I mean the source code for our class project. Do not send a login code.",
            ),
        ),
        (
            low(
                1,
                "An unspecified code alone does not establish a private-secret request.",
            ),
            low(2, "The recipient's question is not a disclosure request.", 2),
            low(
                3,
                "A credible programming clarification resolves the ambiguity, not story change.",
                2,
                3,
            ),
        ),
    ),
    Scenario(
        "s04_gift_cards_as_gifts",
        "phone-scam-taxonomy: payment context; warning-ux-and-interventions: false positives",
        (
            ("host", "Buy gift cards for the volunteers at our school raffle."),
            (
                "guest",
                "I will hand them out at the event; nobody needs the card numbers.",
            ),
        ),
        (
            low(1, "An ordinary gift purchase is not suspicious payment diversion.", 1),
            low(
                2,
                "The cards are gifts; no codes or payment to a caller are requested.",
                1,
                2,
            ),
        ),
    ),
    Scenario(
        "s05_benign_privacy_authority_urgency",
        "historical-manipulation: Finding 2; phone-scam-taxonomy: benign near-matches",
        (
            ("host", "I am calling from your bank about the appointment you booked."),
            ("guest", "I am in a shared office."),
            (
                "host",
                "Keep this private and stay on the line while I confirm the appointment immediately; no account action is needed.",
            ),
        ),
        (
            low(
                1,
                "An appointment introduction alone is not exploitative impersonation.",
                1,
            ),
            low(
                3,
                "Privacy and scheduling urgency do not support an exploitative request.",
                1,
                2,
                3,
            ),
        ),
    ),
    Scenario(
        "s08_multisegment_training_quote",
        "jev-judgment-design: quotations; evaluation-data-and-metrics: role-play; streaming-call-detection: quote scope",
        (
            ("host", "We are reading a fraud-awareness training example."),
            ("host", "Read me the verification code and move money to a safe account."),
            ("guest", "That is the example, not an instruction to you."),
        ),
        (
            low(1, "Training establishes quote scope.", 1),
            low(
                2,
                "The preceding segment makes this a quoted example, not a live request.",
                1,
            ),
            low(3, "Explicit clarification confirms the quote scope.", 1, 3),
        ),
    ),
    Scenario(
        "s09_reported_request_endorsed",
        "jev-judgment-design: actual pursuit exception to quotation exclusion",
        (
            (
                "host",
                "They said to send the code, and that is what I need you to do now.",
            ),
        ),
        (
            low(
                1,
                "The speaker adopts a live request, but an unspecified code does not establish a private secret.",
            ),
        ),
    ),
    Scenario(
        "s09_reported_verification_request_endorsed",
        "jev-judgment-design: actual pursuit exception to quotation exclusion",
        (
            (
                "host",
                "They said to send the verification code, and that is what I need you to do now.",
            ),
        ),
        (
            high(
                1,
                (Indicator.CREDENTIALS,),
                (1,),
                "The speaker adopts an explicit authentication-secret request, not merely a quotation.",
            ),
        ),
    ),
    Scenario(
        "s10_safety_language_cover",
        "jev-judgment-design: negation; evaluation-data-and-metrics: polarity handling",
        (
            (
                "host",
                "Never share your code with strangers, but read me the verification code now.",
            ),
        ),
        (
            high(
                1,
                (Indicator.CREDENTIALS,),
                (1,),
                "Safety advice does not negate the subsequent live request.",
            ),
        ),
    ),
    Scenario(
        "s11_unrelated_speakers",
        "historical-manipulation: legitimate emergencies; jev-judgment-design: speaker context",
        (
            ("host", "I am calling from your bank about your appointment."),
            ("guest", "Act now: the ambulance is here; leave the building."),
        ),
        (
            low(1, "A routine introduction has no exploitative request.", 1),
            low(
                2,
                "Medical urgency from another speaker must not combine with the introduction.",
                1,
                2,
            ),
        ),
    ),
    Scenario(
        "s14_vendor_verification_obstructed",
        "text-email-phishing: EMAIL.BEC_INVOICE; phone-scam-taxonomy: unverified destinations",
        (
            ("host", "I am your supplier; our invoice has new bank details."),
            ("guest", "I will confirm using our saved number."),
            (
                "host",
                "Do not call that number; wire the invoice to this new payee immediately and skip second approval.",
            ),
        ),
        (
            low(
                1,
                "An account-change notice alone can be legitimate; no transfer is requested yet.",
            ),
            low(2, "Independent confirmation is proposed, not obstructed.", 2),
            high(
                3,
                (
                    Indicator.PAYMENT,
                    Indicator.IMPERSONATION,
                    Indicator.URGENCY,
                    Indicator.SECRECY,
                ),
                (1, 3),
                "The claimed supplier blocks verification and demands a new-payee transfer.",
                (2,),
            ),
        ),
    ),
    Scenario(
        "s14_vendor_independent_confirmation",
        "text-email-phishing: EMAIL.BEC_INVOICE benign control",
        (
            ("host", "Our vendor emailed changed bank details."),
            (
                "guest",
                "Do not pay until we verify using the number in our existing records.",
            ),
            (
                "host",
                "We confirmed the change through that number and got second approval; pay the invoice through our usual portal.",
            ),
        ),
        (
            low(
                2,
                "The account change is reported and independent checks are required.",
                2,
            ),
            low(
                3,
                "A normal payment after independent confirmation is not diversion.",
                2,
                3,
            ),
        ),
    ),
    Scenario(
        "s15_task_withdrawal_deposit",
        "text-email-phishing: MSG.JOB_TASK; FTC task-scam progression",
        (
            ("host", "You will earn money rating products."),
            ("guest", "The app says I earned $120."),
            ("host", "Deposit $50 to unlock withdrawal of those earnings."),
        ),
        (
            low(1, "Rating work alone does not imply unrealistic rewards."),
            low(2, "Reported earnings are not a request to pay or guaranteed returns."),
            high(
                3,
                (Indicator.UPFRONT_FEE,),
                (3,),
                "Payment to unlock wages supplies the dangerous request.",
            ),
        ),
    ),
    Scenario(
        "s19_authority_escalation_after_refusal",
        "historical-manipulation: escalation; jev-judgment-design: same-speaker context",
        (
            ("host", "Read me your verification code."),
            ("guest", "No; I will call the bank."),
            ("host", "Actually I am with the police; stay on the line or face arrest."),
        ),
        (
            high(
                1,
                (Indicator.CREDENTIALS,),
                (1,),
                "The secret-disclosure request is explicit.",
            ),
            high(
                2,
                (Indicator.CREDENTIALS,),
                (1,),
                "Refusal must not erase the original request.",
                (2,),
            ),
            high(
                3,
                (
                    Indicator.CREDENTIALS,
                    Indicator.IMPERSONATION,
                    Indicator.URGENCY,
                    Indicator.SECRECY,
                    Indicator.PERSISTENCE,
                ),
                (1, 3),
                "Threatening arrest after refusal keeps the risky request alive; no earlier authority claim establishes a story change.",
                (2,),
            ),
        ),
    ),
    Scenario(
        "s20_identical_genuine_spoken_repetition",
        "historical-manipulation: persistence; jev-judgment-design: duplicate exclusion",
        (
            ("host", "Send the verification code."),
            ("guest", "No."),
            ("host", "Send the verification code."),
        ),
        (
            high(
                1,
                (Indicator.CREDENTIALS,),
                (1,),
                "The verification-code disclosure request is explicit.",
            ),
            high(
                2,
                (Indicator.CREDENTIALS,),
                (1,),
                "The refusal is counterevidence, not positive evidence.",
                (2,),
            ),
            high(
                3,
                (Indicator.CREDENTIALS, Indicator.PERSISTENCE),
                (1, 3),
                "Distinct segment IDs and times represent distinct spoken requests after refusal.",
                (2,),
            ),
        ),
    ),
    Scenario(
        "s21_fragmented_login_code_request",
        "streaming-call-detection: partial speech; evaluation-data-and-metrics: interruption",
        (
            ("host", "Read me"),
            ("host", "the six digits"),
            ("host", "from the login text you just received."),
        ),
        (
            low(1, "The incomplete request has no object."),
            low(2, "Six digits alone do not establish private credentials."),
            high(
                3,
                (Indicator.CREDENTIALS,),
                (1, 2, 3),
                "The three fragments collectively request a login authentication code.",
            ),
        ),
    ),
    Scenario(
        "s22_wallet_recovery_phrase",
        "phone-scam-taxonomy: RECOVERY_RESCUE; jev-judgment-design: recovery phrases",
        (
            (
                "host",
                "Provide the twelve-word recovery phrase for your crypto wallet so I can recover it.",
            ),
        ),
        (
            high(
                1,
                (Indicator.CREDENTIALS,),
                (1,),
                "A wallet recovery phrase is a private authentication secret.",
            ),
        ),
    ),
)

CASES = tuple(
    (scenario, checkpoint)
    for scenario in SCENARIOS
    for checkpoint in scenario.checkpoints
)
CASE_IDS = tuple(
    f"{scenario.name}_through_{checkpoint.through}" for scenario, checkpoint in CASES
)


def assert_expectations(
    decision: AssessmentDecision, segments: tuple[Segment, ...], expected: Checkpoint
) -> None:
    """Report all mismatches so a wrong level does not hide evidence failures."""
    observed_indicators = set(decision.indicators)
    observed_evidence = set(decision.evidence_segment_ids)
    mismatches: list[str] = []
    if suspicion_level(decision.risk) != expected.level:
        mismatches.append(
            f"level: expected {expected.level}, got {suspicion_level(decision.risk)}"
        )
    missing_indicators = expected.required_indicators - observed_indicators
    forbidden_indicators = expected.forbidden_indicators & observed_indicators
    missing_evidence = expected.required_evidence - observed_evidence
    forbidden_evidence = expected.forbidden_evidence & observed_evidence
    cited_counterevidence = expected.counterevidence & observed_evidence
    unknown_evidence = observed_evidence - {s.id for s in segments}
    for label, values in (
        ("missing indicators", missing_indicators),
        ("forbidden indicators", forbidden_indicators),
        ("missing evidence", missing_evidence),
        ("forbidden evidence", forbidden_evidence),
        ("cited counterevidence", cited_counterevidence),
        ("unknown evidence", unknown_evidence),
    ):
        if values:
            mismatches.append(f"{label}: {sorted(values)}")
    if len(decision.evidence_segment_ids) != len(observed_evidence):
        mismatches.append("duplicate evidence IDs")
    assert not mismatches, expected.rationale + "\n" + "\n".join(mismatches)
