"""Behavioral specification for the demo assessor; known failures stay failures.

These research expectations do not certify real calls or live Jev semantics.
"""

import asyncio

import pytest

from jev_scam_detector.providers import DemoAssessor

from .research_scam_cases import (
    CASE_IDS,
    CASES,
    SCENARIOS,
    Checkpoint,
    Scenario,
    assert_expectations,
)


@pytest.mark.parametrize("scenario,checkpoint", CASES, ids=CASE_IDS)
def test_demo_research_scenario(scenario: Scenario, checkpoint: Checkpoint) -> None:
    segments = scenario.segments(checkpoint.through)
    assert checkpoint.required_evidence.isdisjoint(checkpoint.counterevidence)
    assert checkpoint.counterevidence <= checkpoint.forbidden_evidence
    decision = asyncio.run(DemoAssessor().assess(segments))
    assert_expectations(decision, segments, checkpoint)


def test_demo_s20_duplicate_delivery_is_not_spoken_persistence() -> None:
    scenario = next(
        scenario
        for scenario in SCENARIOS
        if scenario.name == "s20_identical_genuine_spoken_repetition"
    )
    # Re-delivery of the same ID/time is different from a new spoken turn.
    original = scenario.segments(1)[0]
    segments = (original, original)
    decision = asyncio.run(DemoAssessor().assess(segments))
    assert_expectations(decision, segments, scenario.checkpoints[0])
