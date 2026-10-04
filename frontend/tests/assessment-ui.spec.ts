import { expect, test, type WebSocketRoute } from "@playwright/test";
import type { Snapshot } from "../src/protocol";

function readySnapshot(risk: number): Snapshot {
  return {
    sessionId: "simulated-live-room",
    role: "host",
    mode: "live",
    createdAt: "2026-01-01T00:00:00Z",
    peer: { role: "guest", joined: true, connected: true },
    segments: [{
      id: "seg_1", speaker: "guest", clientSeq: 1,
      text: "Send the code now", source: "manual",
      createdAt: "2026-01-01T00:00:00Z", startMs: 0, endMs: 1000,
    }],
    assessments: [{
      id: "asm_1", status: "ready", mode: "live", provider: "jev", risk,
      confidence: 0.7,
      suspicionLevel: risk >= 0.7 ? "high" : risk >= 0.35 ? "moderate" : "low",
      indicators: ["credentials"],
      summary: "Requests for private credentials or verification codes.",
      scamType: "credential_theft",
      scamTypeConfidence: 0.85,
      evidenceSegmentIds: ["seg_1"], throughSegmentId: "seg_1",
      createdAt: "2026-01-01T00:00:01Z", startMs: 0, endMs: 1000,
    }],
    currentRisk: risk,
    providerStatus: { transcription: "available", assessment: "available" },
  };
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`simulated live assessments render current and neutral states at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route("**/api/sessions", (route) => route.fulfill({ json: {
      sessionId: "simulated-live-room", participantToken: "simulated-host-token",
      role: "host", mode: "live",
    } }));
    let events: WebSocketRoute | undefined;
    await page.routeWebSocket("**/api/sessions/simulated-live-room/events", (socket) => {
      events = socket;
      socket.onMessage(() => {});
      socket.send(JSON.stringify({ type: "snapshot", snapshot: {
        ...readySnapshot(0), segments: [], assessments: [], currentRisk: null,
      } }));
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Create room" }).click();
    await expect(page.locator(".likelihood-value")).toHaveText("Unassessed");
    await expect.poll(() => Boolean(events)).toBe(true);
    if (!events) throw new Error("Simulated event stream did not connect");
    events.send(JSON.stringify({
      type: "transcript", segment: readySnapshot(0).segments[0],
    }));
    await expect(page.locator(".likelihood-value")).toHaveText("Pending");
    await expect(page.locator(".likelihood-marker")).toHaveCount(0);
    for (const risk of [0, 0.2, 0.5, 0.755, 0.8, 1]) {
      events.send(JSON.stringify({ type: "snapshot", snapshot: readySnapshot(risk) }));
      const likelihood = `${Math.round(risk * 100)}%`;
      await expect(page.locator(".likelihood-value")).toHaveText(likelihood);
      await expect(page.locator(".recommendation > p strong")).toHaveText(`${likelihood} scam suspicion`);
      await expect(page.getByText("Likely scam type", { exact: true })).toBeVisible();
      await expect(page.locator(".recommendation p").filter({ hasText: "Likely scam type" })).toContainText("Credential theft");
      await expect(page.getByRole("heading", { name: "Scam suspicion", exact: true })).toBeVisible();
      await expect(page.getByText("Classification confidence", { exact: true })).toHaveCount(0);
      await expect(page.locator(".recommendation")).not.toContainText("85%");
      await expect(page.locator(".likelihood-marker")).toBeVisible();
      expect(await page.locator(".likelihood-marker").evaluate((element) =>
        getComputedStyle(element).getPropertyValue("--risk-position"),
      )).toBe(`${risk * 100}%`);
      await expect(page.locator(".evidence button")).toContainText('“Send the code now”');
      await page.locator(".evidence button").click();
      await expect(page.locator('[data-segment-id="seg_1"]')).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      if (risk === 0.8) await page.screenshot({ path: test.info().outputPath("live-ready.png"), fullPage: true, animations: "disabled" });
    }
    const example = readySnapshot(0.97);
    events.send(JSON.stringify({ type: "snapshot", snapshot: {
      ...example,
      assessments: example.assessments.map((assessment) => ({
        ...assessment, scamType: "tech_support_refund", scamTypeConfidence: 0.96,
      })),
    } }));
    await expect(page.getByRole("heading", { name: "RECOMMENDATION", exact: true })).toBeVisible();
    await expect(page.locator(".recommendation > p strong")).toHaveText("97% scam suspicion");
    await expect(page.locator(".recommendation p").filter({ hasText: "Likely scam type" })).toContainText("Tech support / refund scam");
    await expect(page.getByText("Classification confidence", { exact: true })).toHaveCount(0);
    await expect(page.locator(".recommendation")).not.toContainText("96%");
    await expect(page.getByText("Based on the conversation context, not definitive proof of fraud.", { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("recommendation-copy.png"), fullPage: true, animations: "disabled" });
    events.send(JSON.stringify({ type: "snapshot", snapshot: readySnapshot(1) }));
    await expect(page.locator(".recommendation > p strong")).toHaveText("100% scam suspicion");
    const marker = await page.locator(".likelihood-marker").elementHandle();
    if (!marker) throw new Error("Expected the last successful meter marker");
    const originalSegment = readySnapshot(1).segments[0];
    if (!originalSegment) throw new Error("Expected an original transcript line");
    for (const sequence of [2, 3]) {
      const segment = {
        ...originalSegment,
        id: `seg_${sequence}`, clientSeq: sequence,
        speaker: "guest", text: `New transcript ${sequence}`,
      } satisfies Snapshot["segments"][number];
      events.send(JSON.stringify({ type: "transcript", segment }));
      await expect(page.locator(".likelihood-value")).toHaveText("100%");
      await expect(page.locator(".likelihood-marker")).toBeVisible();
      await expect(page.locator(".assessment-note")).toHaveText("Updating. Showing the previous assessment.");
      await expect(page.locator(".recommendation p").filter({ hasText: "Likely scam type" })).toContainText("Credential theft");
      expect(await marker.evaluate((element) => element.isConnected)).toBe(true);
      expect(await marker.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("--risk-position"),
      )).toBe("100%");
    }
    const updated = readySnapshot(0.2).assessments[0];
    if (!updated) throw new Error("Expected a new assessment");
    events.send(JSON.stringify({ type: "assessment", assessment: {
      ...updated, id: "asm_3", throughSegmentId: "seg_3",
    } }));
    await expect(page.locator(".likelihood-value")).toHaveText("20%");
    await expect(page.locator(".assessment-note")).toHaveCount(0);
    expect(await marker.evaluate((element) => element.isConnected)).toBe(true);
    expect(await marker.evaluate((element) =>
      getComputedStyle(element).getPropertyValue("--risk-position"),
    )).toBe("20%");
    events.send(JSON.stringify({ type: "provider_status", provider: "assessment", status: "unavailable" }));
    await expect(page.locator(".likelihood-value")).toHaveText("Unavailable");
    await expect(page.locator(".likelihood-marker")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Earlier evidence" })).toBeVisible();
    await expect(page.locator(".recommendation > p")).toHaveText("Review unavailable.");
    await expect(page.getByText("Likely scam type", { exact: true })).toHaveCount(0);
    events.send(JSON.stringify({ type: "snapshot", snapshot: {
      ...readySnapshot(0.8), currentRisk: null,
      segments: [...readySnapshot(0.8).segments,
        ...readySnapshot(0.8).segments.map((segment) => ({
          ...segment, id: "seg_2", clientSeq: 2,
        })),
      ],
    } }));
    await expect(page.locator(".likelihood-value")).toHaveText("80%");
    await expect(page.locator(".likelihood-marker")).toBeVisible();
    await expect(page.locator(".assessment-note")).toHaveText("Updating. Showing the previous assessment.");
    await expect(page.locator(".recommendation > p strong")).toHaveText("80% scam suspicion");
    await expect(page.getByText("Likely scam type", { exact: true })).toBeVisible();
  });
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`only evidence scrolls as it grows at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route("**/api/sessions", (route) => route.fulfill({ json: {
      sessionId: "simulated-live-room", participantToken: "simulated-host-token",
      role: "host", mode: "live",
    } }));
    let events: WebSocketRoute | undefined;
    await page.routeWebSocket("**/api/sessions/simulated-live-room/events", (socket) => {
      events = socket;
      socket.onMessage(() => {});
      socket.send(JSON.stringify({ type: "snapshot", snapshot: readySnapshot(0.8) }));
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Create room" }).click();
    await expect(page.locator(".recommendation > p strong")).toHaveText("80% scam suspicion");
    await expect(page.getByRole("button", { name: "Stop live transcription" })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.locator(".explanation").scrollIntoViewIfNeeded();
    const recommendation = page.locator(".recommendation");
    const before = await recommendation.boundingBox();
    const snapshot = readySnapshot(0.8);
    const segments = Array.from({ length: 40 }, (_, index) => ({
      ...snapshot.segments[0], id: `evidence_${index}`, clientSeq: index + 1,
      text: `Evidence ${index}: Send the code now. Do not contact your bank.`,
    }));
    if (!events) throw new Error("Simulated event stream did not connect");
    events.send(JSON.stringify({ type: "snapshot", snapshot: {
      ...snapshot, segments,
      assessments: snapshot.assessments.map((assessment) => ({
        ...assessment, evidenceSegmentIds: segments.map((segment) => segment.id),
        throughSegmentId: "evidence_39",
      })),
    } }));
    await expect(page.locator(".evidence li")).toHaveCount(40);
    expect(await recommendation.boundingBox()).toEqual(before);
    const scrolling = await page.locator(".evidence").evaluate((element) => {
      element.scrollTop = 200;
      return { top: element.scrollTop, height: element.clientHeight, content: element.scrollHeight };
    });
    expect(scrolling.content).toBeGreaterThan(scrolling.height);
    expect(scrolling.top).toBeGreaterThan(0);
    expect(await recommendation.boundingBox()).toEqual(before);
    expect(await page.locator(".explanation").evaluate((element) => ({
      top: element.scrollTop, overflow: getComputedStyle(element).overflowY,
    }))).toEqual({ top: 0, overflow: "hidden" });
  });
}

for (const role of ["host", "guest"]) {
  test(`live ${role} starts transcription automatically and can stop and restart it`, async ({ page }) => {
    await page.route("**/api/sessions**", (route) => route.fulfill({ json: {
      sessionId: "simulated-live-room", participantToken: "simulated-token", role, mode: "live",
    } }));
    await page.routeWebSocket("**/api/sessions/simulated-live-room/events", (socket) => {
      socket.onMessage(() => {});
      socket.send(JSON.stringify({ type: "snapshot", snapshot: readySnapshot(0.8) }));
    });
    await page.goto("/");
    if (role === "guest") await page.getByLabel("Room ID, if joining").fill("simulated-live-room");
    await page.getByRole("button", { name: role === "host" ? "Create room" : "Join room" }).click();
    await expect(page.getByRole("img", { name: "Microphone on", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Stop live transcription" }).click();
    await page.getByRole("button", { name: "Start live transcription" }).click();
    await expect(page.getByRole("button", { name: "Stop live transcription" })).toBeVisible();
  });
}

test("denied automatic microphone access allows a retry that starts transcription", async ({ page }) => {
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let denied = false;
    navigator.mediaDevices.getUserMedia = (constraints) => {
      if (!denied) {
        denied = true;
        return Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
      }
      return original(constraints);
    };
  });
  await page.route("**/api/sessions", (route) => route.fulfill({ json: {
    sessionId: "simulated-live-room", participantToken: "simulated-token", role: "host", mode: "live",
  } }));
  await page.routeWebSocket("**/api/sessions/simulated-live-room/events", (socket) => {
    socket.onMessage(() => {});
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Create room" }).click();
  await expect(page.getByRole("alert")).toContainText("Microphone access was denied or unavailable");
  await expect(page.getByLabel("Add a typed line")).toBeEnabled();
  await expect(page.getByRole("button", { name: "Start live transcription" })).toBeDisabled();
  await page.getByRole("button", { name: "Connect microphone" }).click();
  await expect(page.getByRole("button", { name: "Stop live transcription" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("live creation displays an actionable provider configuration error", async ({ page }) => {
  await page.route("**/api/sessions", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ mode: "live" });
    await route.fulfill({ status: 503, json: { error: {
      code: "live_not_configured", message: "Live providers are not configured",
    } } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Create room" }).click();
  await expect(page.getByRole("alert")).toHaveText("Live providers are not configured");
  await expect(page.getByRole("button", { name: "Create room" })).toBeEnabled();
});
