from __future__ import annotations

import secrets
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Literal

from jev_scam_detector.domain import (
    AssessmentDecision,
    Indicator,
    IndicatorKind,
    Mode,
    Role,
    Segment,
)

type Tier = Literal["monitor", "caution", "contact", "lockout"]

# Product policy, not calibrated fraud thresholds. Keep independently testable.
WEIGHTS: dict[IndicatorKind, float] = {
    "urgency": 0.15,
    "payment": 0.25,
    "credentials": 0.30,
    "unverified_link": 0.20,
    "platform_switch": 0.10,
}
REASONS: dict[IndicatorKind, str] = {
    "urgency": "Pressure to act urgently or keep the conversation secret.",
    "payment": "A request for payment or a money transfer.",
    "credentials": "A request for passwords, verification codes, or personal information.",
    "unverified_link": "A link or account request without independent verification.",
    "platform_switch": "A request to move to an unverified communication platform.",
    "independent_verification": "The conversation proposes independent verification.",
}
THRESHOLDS: dict[Tier, float] = {
    "monitor": 0,
    "caution": 0.50,
    "contact": 0.70,
    "lockout": 0.85,
}


def utc_iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class DecisionRecord:
    through_id: str
    risk: float
    confidence: float | None
    indicators: tuple[Indicator, ...]


@dataclass
class RiskAccumulator:
    risk: float | None = None
    history: list[DecisionRecord] = field(default_factory=list)
    evidence: dict[tuple[str, IndicatorKind], Indicator] = field(default_factory=dict)
    assessed_ids: set[str] = field(default_factory=set)
    tier: Tier = "monitor"
    below_count: int = 0

    def apply(
        self, segments: tuple[Segment, ...], decision: AssessmentDecision, mode: Mode
    ) -> float:
        new_ids = {s.id for s in segments} - self.assessed_ids
        if not new_ids:
            return self.risk if self.risk is not None else decision.risk
        self.assessed_ids.update(new_ids)
        for indicator in decision.indicators:
            self.evidence[(indicator.segment_id, indicator.kind)] = indicator
        retained = {s.id for s in segments}
        self.evidence = {
            key: value for key, value in self.evidence.items() if key[0] in retained
        }
        if mode == "demo" or decision.confidence is None:
            value = decision.risk
        else:
            suspicious = [
                i
                for i in self.evidence.values()
                if i.kind in WEIGHTS and i.probability >= 0.7
            ]
            new_signals = [i for i in suspicious if i.segment_id in new_ids]
            new_lines = len({i.segment_id for i in new_signals})
            strongest: dict[IndicatorKind, float] = {
                kind: max(
                    (i.probability for i in suspicious if i.kind == kind), default=0
                )
                for kind in WEIGHTS
            }
            weighted = sum(
                WEIGHTS[kind] * probability for kind, probability in strongest.items()
            )
            distinct = len({i.segment_id for i in suspicious})
            weighted = min(1.0, weighted + min(0.35, 0.07 * max(0, distinct - 1)))
            target = 0.65 * decision.risk + 0.35 * weighted
            if any(
                i.kind == "independent_verification"
                and i.probability >= 0.9
                and i.segment_id in new_ids
                for i in decision.indicators
            ):
                target = max(0.0, target - 0.15 * decision.confidence)
            if self.risk is None:
                value = min(target, 0.45)
            elif target > self.risk:
                strong = (
                    decision.confidence >= 0.85
                    and len([i for i in new_signals if i.probability >= 0.9]) >= 3
                )
                cap = min(
                    0.20 if strong else 0.16, (0.12 if strong else 0.08) * new_lines
                )
                value = self.risk + min(
                    cap, (target - self.risk) * (0.25 + 0.35 * decision.confidence)
                )
            else:
                verification = decision.confidence >= 0.85 and any(
                    i.kind == "independent_verification"
                    and i.probability >= 0.9
                    and i.segment_id in new_ids
                    for i in decision.indicators
                )
                cap = min(
                    0.12 if verification else 0.08,
                    (0.06 if verification else 0.03) * len(new_ids),
                )
                value = self.risk - min(cap, (self.risk - target) * 0.25)
            distinct = len({i.segment_id for i in suspicious})
            if decision.confidence < 0.5 or distinct < 2:
                value = min(value, 0.69)
            if decision.confidence < 0.75 or distinct < 3:
                value = min(value, 0.84)
            # Confidence gating cannot itself force abrupt downward risk changes.
            if self.risk is not None and value < self.risk:
                verification = decision.confidence >= 0.85 and any(
                    i.kind == "independent_verification"
                    and i.probability >= 0.9
                    and i.segment_id in new_ids
                    for i in decision.indicators
                )
                value = max(
                    value,
                    self.risk
                    - min(
                        0.12 if verification else 0.08,
                        (0.06 if verification else 0.03) * len(new_ids),
                    ),
                )
        self.risk = round(max(0.0, min(1.0, value)), 6)
        self.history.append(
            DecisionRecord(
                segments[-1].id, self.risk, decision.confidence, decision.indicators
            )
        )
        self.history = self.history[-32:]
        eligible = self.eligible_band(
            self.risk, decision, mode, len({i.segment_id for i in self.suspicious()})
        )
        self.update_tier(eligible)
        return self.risk

    @staticmethod
    def eligible_band(
        risk: float, decision: AssessmentDecision, mode: Mode, distinct: int
    ) -> Tier:
        if mode == "demo" or decision.confidence is None:
            return "monitor"
        if decision.confidence < 0.5 or distinct < 2:
            return "caution" if risk >= 0.5 else "monitor"
        if decision.confidence < 0.75 or distinct < 3:
            return (
                "contact" if risk >= 0.7 else ("caution" if risk >= 0.5 else "monitor")
            )
        return RiskAccumulator.band(risk)

    @staticmethod
    def band(risk: float) -> Tier:
        if risk >= 0.85:
            return "lockout"
        if risk >= 0.70:
            return "contact"
        if risk >= 0.50:
            return "caution"
        return "monitor"

    def update_tier(self, candidate: Tier) -> None:
        if THRESHOLDS[candidate] >= THRESHOLDS[self.tier]:
            self.tier = candidate
            self.below_count = 0
        elif self.risk is not None and self.risk < THRESHOLDS[self.tier] - 0.03:
            self.below_count += 1
            if self.below_count >= 2:
                self.tier = candidate
                self.below_count = 0
        else:
            self.below_count = 0

    def suspicious(self) -> list[Indicator]:
        return [
            i
            for i in self.evidence.values()
            if i.kind in WEIGHTS and i.probability >= 0.7
        ]

    def reasons(self) -> list[str]:
        return [
            REASONS[kind]
            for kind in WEIGHTS
            if any(i.kind == kind for i in self.suspicious())
        ]


@dataclass(frozen=True)
class TrustedContact:
    name: str
    email: str

    def wire(self) -> dict[str, str]:
        return {"name": self.name, "email": self.email}


@dataclass(frozen=True)
class Hold:
    id: str
    assessment_id: str
    risk: float
    confidence: float
    reasons: tuple[str, ...]
    evidence_ids: tuple[str, ...]
    indicator_pairs: tuple[tuple[str, IndicatorKind], ...]
    created: datetime

    @property
    def ready(self) -> datetime:
        return self.created + timedelta(seconds=5)

    def wire(self) -> dict[str, object]:
        return {
            "id": self.id,
            "assessmentId": self.assessment_id,
            "risk": self.risk,
            "confidence": self.confidence,
            "reasons": list(self.reasons),
            "evidenceSegmentIds": list(self.evidence_ids),
            "createdAt": utc_iso(self.created),
            "readyAt": utc_iso(self.ready),
        }


@dataclass(frozen=True)
class OverrideRecord:
    lockout_id: str
    assessment_id: str
    role: Role
    created: datetime

    def wire(self) -> dict[str, str]:
        return {
            "lockoutId": self.lockout_id,
            "assessmentId": self.assessment_id,
            "role": self.role,
            "createdAt": utc_iso(self.created),
        }


@dataclass
class SeatDefense:
    contact: TrustedContact | None = None
    hold: Hold | None = None
    acknowledged: set[tuple[str, IndicatorKind]] = field(default_factory=set)
    overrides: list[OverrideRecord] = field(default_factory=list)

    def update(
        self,
        accumulator: RiskAccumulator,
        assessment_id: str,
        confidence: float | None,
        now: datetime,
    ) -> None:
        suspicious = accumulator.suspicious()
        new = {(i.segment_id, i.kind) for i in suspicious} - self.acknowledged
        if (
            self.hold
            or accumulator.tier != "lockout"
            or accumulator.risk is None
            or accumulator.risk < 0.85
            or not new
            or confidence is None
            or confidence < 0.75
            or len({i.segment_id for i in suspicious}) < 3
        ):
            return
        self.hold = Hold(
            "hold_" + secrets.token_urlsafe(18),
            assessment_id,
            accumulator.risk or 0,
            confidence,
            tuple(accumulator.reasons()),
            tuple(dict.fromkeys(i.segment_id for i in suspicious)),
            tuple((i.segment_id, i.kind) for i in suspicious),
            now,
        )

    def wire(self, accumulator: RiskAccumulator) -> dict[str, object]:
        return {
            "tier": accumulator.tier,
            "reasons": accumulator.reasons(),
            "trustedContact": self.contact.wire() if self.contact else None,
            "lockout": self.hold.wire() if self.hold else None,
            "overrides": [item.wire() for item in self.overrides],
        }
