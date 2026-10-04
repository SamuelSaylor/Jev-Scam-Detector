import { expect, test, type WebSocketRoute } from "@playwright/test";
import type { Assessment, Event, Segment, Snapshot } from "../src/protocol";

for (const mode of ["demo", "live"] as const) {
  test(`${mode} retains the score and summary through updates, failure, and reconnect`, async ({ page }) => {
    const segment: Segment = {
      id: "seg_1", speaker: "guest", clientSeq: 1,
      text: "Read me your verification code", source: "manual",
      createdAt: "2026-01-01T00:00:00Z", startMs: 0, endMs: 0,
    };
    const assessment: Assessment = {
      id: "asm_1", status: "ready", mode,
      provider: mode === "demo" ? "demo-rule" : "jev",
      risk: 0.9, confidence: mode === "demo" ? null : 0.91,
      suspicionLevel: "high", indicators: ["credentials"],
      summary: "High suspicion: requests for private credentials or verification codes.",
      evidenceSegmentIds: ["seg_1"], throughSegmentId: "seg_1",
      createdAt: "2026-01-01T00:00:05Z", startMs: 0, endMs: 0,
    };
    let state: Snapshot = {
      sessionId: "test-session", role: "host", mode,
      createdAt: "2026-01-01T00:00:00Z",
      peer: { role: "guest", joined: true, connected: false },
      segments: [], assessments: [], currentRisk: null,
      providerStatus: { transcription: "unavailable", assessment: "available" },
    };
    const connections: WebSocketRoute[] = [];
    await page.route("**/api/sessions", (route) => route.fulfill({ json: {
      sessionId: "test-session", participantToken: "test-token", role: "host", mode,
    } }));
    await page.routeWebSocket("**/api/sessions/test-session/events", (socket) => {
      connections.push(socket);
      socket.onMessage(() => socket.send(JSON.stringify({ type: "snapshot", snapshot: state })));
    });
    function send(event: Event) {
      const socket = connections.at(-1);
      if (!socket) throw new Error("Expected an authenticated event socket");
      socket.send(JSON.stringify(event));
    }
    await page.goto("http://127.0.0.1:5173/");
    if (mode === "live") {
      await page.getByRole("radio", { name: "Live, requires server providers" }).check();
    }
    await page.getByRole("button", { name: "Create room" }).click();
    await expect.poll(() => connections.length).toBe(1);
    await expect(page.locator(".risk-reading")).toHaveText("Awaiting assessment");
    state = { ...state, segments: [segment], assessments: [assessment], currentRisk: 0.9 };
    send({ type: "transcript", segment });
    send({ type: "assessment", assessment });
    await expect(page.locator(".risk-reading")).toHaveText("High");
    await expect(page.locator(".suspicion-summary")).toHaveText(assessment.summary);
    const confidenceText = mode === "demo" ? "Demo suspicion score: 90 / 100" : "91% judgment confidence";
    await expect(page.locator(".judgment-confidence")).toHaveText(confidenceText);

    for (let i = 2; i <= 5; i++) {
      const newer: Segment = { ...segment, id: `seg_${i}`, clientSeq: i, text: "Please wait" };
      state = { ...state, segments: [...state.segments, newer] };
      send({ type: "transcript", segment: newer });
      await expect(page.locator(".risk-reading")).toHaveText("High");
      await expect(page.locator(".judgment-confidence")).toHaveText(confidenceText);
      await expect(page.locator(".assessment-note")).toHaveText("Updating. Showing the previous assessment.");
    }
    state = { ...state, providerStatus: { ...state.providerStatus, assessment: "unavailable" } };
    send({ type: "provider_status", provider: "assessment", status: "unavailable" });
    await expect(page.locator(".assessment-note")).toContainText("Review failed. Showing the previous assessment");
    await expect(page.locator(".suspicion-summary")).toHaveText(assessment.summary);
    const warningSize = await page.locator(".assessment-note").evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).fontSize),
    );
    expect(warningSize).toBeLessThanOrEqual(13);
    await page.getByRole("button", { name: "Reconnect to room" }).click();
    await expect.poll(() => connections.length).toBe(2);
    await expect(page.locator(".risk-reading")).toHaveText("High");
    await expect(page.locator(".judgment-confidence")).toHaveText(confidenceText);
    await expect(page.locator(".suspicion-summary")).toHaveText(assessment.summary);
    await expect(page.locator(".assessment-note")).toContainText("Review failed");

    const recovered: Assessment = {
      ...assessment, id: "asm_5", risk: 0.1,
      confidence: mode === "demo" ? null : 0.95,
      suspicionLevel: "low", indicators: [], evidenceSegmentIds: [],
      throughSegmentId: "seg_5",
      summary: "Low suspicion: no clear scam indicators detected in the assessed conversation.",
    };
    send({ type: "assessment", assessment: recovered });
    send({ type: "provider_status", provider: "assessment", status: "available" });
    await expect(page.locator(".risk-reading")).toHaveText("Low");
    await expect(page.locator(".suspicion-summary")).toHaveText(recovered.summary);
    await expect(page.locator(".judgment-confidence")).toHaveText(
      mode === "demo" ? "Demo suspicion score: 10 / 100" : "95% judgment confidence",
    );
    await expect(page.locator(".assessment-note")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".suspicion-summary")).toBeVisible();
    await page.screenshot({ path: `test-results/${mode}-assessment-phone.png`, fullPage: true });
  });
}
