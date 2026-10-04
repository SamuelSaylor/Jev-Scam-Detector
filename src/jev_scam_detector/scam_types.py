"""Possible scam patterns, distinct from suspicion and warning signs."""

from dataclasses import dataclass
from enum import StrEnum


class ScamType(StrEnum):
    CREDENTIAL_THEFT = "credential_theft"
    TECH_SUPPORT_REFUND = "tech_support_refund"
    PAYMENT_DIVERSION = "payment_diversion"
    TASK_JOB = "task_job"
    ADVANCE_FEE_PRIZE = "advance_fee_prize"
    INVESTMENT = "investment"
    NO_APPARENT_SCAM = "no_apparent_scam"
    INSUFFICIENT_CONTEXT = "insufficient_context"
    OTHER_MIXED = "other_mixed"


@dataclass(frozen=True)
class ScamClassification:
    scam_type: ScamType
    confidence: float


SCAM_TYPE_CRITERIA: dict[str, str] = {
    ScamType.CREDENTIAL_THEFT: "A live request to disclose private authentication secrets or identity information, including login codes and wallet recovery phrases. Use when no more specific scheme explains the request.",
    ScamType.TECH_SUPPORT_REFUND: "Unsolicited or deceptive support, device-access or refund requests, including alleged overpayments. Exclude user-initiated independently verified support.",
    ScamType.PAYMENT_DIVERSION: "A request to redirect funds to a supposed safe account, a new unverified invoice payee, gift cards, crypto or a courier. Exclude ordinary verified payments and gifts.",
    ScamType.TASK_JOB: "A job or task offer used to extract money or secrets, especially deposits to unlock task earnings or withdrawals. Exclude ordinary work and realistic earnings alone.",
    ScamType.ADVANCE_FEE_PRIZE: "Payment required to obtain an unexpected prize, inheritance, grant, loan or recovery of lost funds. Exclude ordinary disclosed service charges; task earnings belong to task_job.",
    ScamType.INVESTMENT: "Investment solicitation using guaranteed, risk-free or implausibly large returns to obtain money. Exclude realistic investment discussion or warnings about such offers.",
    ScamType.NO_APPARENT_SCAM: "The transcript has a plausible benign purpose with no concrete exploitative request. Includes safety advice, quotations and credible clarifications that resolve ambiguity.",
    ScamType.INSUFFICIENT_CONTEXT: "The transcript is incomplete or ambiguous and does not yet support either a specific exploitative scheme or a clear benign explanation. Do not guess from isolated words.",
    ScamType.OTHER_MIXED: "Concrete exploitative requests support a different scheme or multiple equally supported schemes with no dominant type. Do not use merely because context is missing.",
}
