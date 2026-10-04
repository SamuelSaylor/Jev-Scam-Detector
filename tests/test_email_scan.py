# pyright: reportAny=false

from fastapi.testclient import TestClient
from pytest import MonkeyPatch

from jev_scam_detector import app as backend
from jev_scam_detector.domain import AssessmentDecision, Segment

THREAD = {
    "lines": [
        {"id": "l1", "sender": "boss@example.com", "text": "Hi, are you at your desk?"},
        {
            "id": "l2",
            "sender": "boss@example.com",
            "text": "Send the code you just got.",
        },
    ]
}


class FakeAssessor:
    def __init__(self, decision: AssessmentDecision | None = None) -> None:
        self.decision: AssessmentDecision | None = decision
        self.seen: tuple[Segment, ...] = ()

    async def assess(self, segments: tuple[Segment, ...]) -> AssessmentDecision:
        self.seen = segments
        if self.decision is None:
            raise RuntimeError("provider down")
        return self.decision


def test_demo_rule_flags_the_suspicious_line(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(backend, "live_assessor", None)
    monkeypatch.delenv("EMAIL_SCAN_TOKEN", raising=False)
    with TestClient(backend.app) as client:
        response = client.post("/api/emails/scan", json=THREAD)
    assert response.status_code == 200
    assert response.json() == {
        "risk": 0.8,
        "evidenceIds": ["l2"],
        "provider": "demo-rule",
    }


def test_live_assessor_is_used_and_unknown_evidence_is_dropped(
    monkeypatch: MonkeyPatch,
) -> None:
    fake = FakeAssessor(AssessmentDecision(0.35, ("l1", "not-a-line")))
    monkeypatch.setattr(backend, "live_assessor", fake)
    monkeypatch.delenv("EMAIL_SCAN_TOKEN", raising=False)
    with TestClient(backend.app) as client:
        body = client.post("/api/emails/scan", json=THREAD).json()
    assert body == {"risk": 0.35, "evidenceIds": ["l1"], "provider": "jev"}
    assert [s.speaker for s in fake.seen] == ["host", "host"]
    assert fake.seen[1].text == "Send the code you just got."


def test_second_sender_is_the_guest(monkeypatch: MonkeyPatch) -> None:
    fake = FakeAssessor(AssessmentDecision(0.1, ()))
    monkeypatch.setattr(backend, "live_assessor", fake)
    monkeypatch.delenv("EMAIL_SCAN_TOKEN", raising=False)
    thread = {
        "lines": [
            {"id": "a", "sender": "Me@x.com", "text": "Question?"},
            {"id": "b", "sender": "them@y.com", "text": "Answer."},
            {"id": "c", "sender": "me@x.com", "text": "Thanks."},
        ]
    }
    with TestClient(backend.app) as client:
        assert client.post("/api/emails/scan", json=thread).status_code == 200
    assert [s.speaker for s in fake.seen] == ["host", "guest", "host"]


def test_token_is_required_when_configured(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(backend, "live_assessor", None)
    monkeypatch.setenv("EMAIL_SCAN_TOKEN", "secret")
    with TestClient(backend.app) as client:
        missing = client.post("/api/emails/scan", json=THREAD)
        wrong = client.post(
            "/api/emails/scan", json=THREAD, headers={"Authorization": "Bearer nope"}
        )
        good = client.post(
            "/api/emails/scan", json=THREAD, headers={"Authorization": "Bearer secret"}
        )
    assert missing.status_code == wrong.status_code == 401
    assert missing.json()["error"]["code"] == "invalid_token"
    assert good.status_code == 200


def test_invalid_input_is_rejected(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.delenv("EMAIL_SCAN_TOKEN", raising=False)
    line: dict[str, object] = {"id": "x", "sender": "a@b.c", "text": "hi"}
    bad_bodies: list[dict[str, object]] = [
        {"lines": []},
        {"lines": [line] * 31},
        {"lines": [{**line, "text": ""}]},
        {"lines": [{**line, "text": "x" * 1001}]},
        {"lines": [{**line, "extra": 1}]},
        {"lines": [line], "extra": 1},
    ]
    with TestClient(backend.app) as client:
        for body in bad_bodies:
            response = client.post("/api/emails/scan", json=body)
            assert response.status_code == 422, body
            assert response.json()["error"]["code"] == "invalid_input"


def test_provider_failure_is_not_a_safe_score(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.delenv("EMAIL_SCAN_TOKEN", raising=False)
    for assessor in (
        FakeAssessor(None),
        FakeAssessor(AssessmentDecision(float("nan"), ())),
        FakeAssessor(AssessmentDecision(1.5, ())),
    ):
        monkeypatch.setattr(backend, "live_assessor", assessor)
        with TestClient(backend.app) as client:
            response = client.post("/api/emails/scan", json=THREAD)
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "provider_unavailable"
