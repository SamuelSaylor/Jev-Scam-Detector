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
    for (const risk of [0, 0.2, 0.5, 0.755, 0.8, 1]) {
      events.send(JSON.stringify({ type: "snapshot", snapshot: readySnapshot(risk) }));
      const likelihood = `${Math.round(risk * 100)}%`;
      await expect(page.locator(".likelihood-value")).toHaveText(likelihood);
      await expect(page.locator(".recommendation p")).toHaveText(`Jev estimates a ${likelihood} likelihood of a scam.`);
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
    events.send(JSON.stringify({ type: "provider_status", provider: "assessment", status: "unavailable" }));
    await expect(page.locator(".likelihood-value")).toHaveText("Unavailable");
    await expect(page.locator(".likelihood-marker")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Earlier evidence" })).toBeVisible();
    await expect(page.locator(".recommendation p")).toHaveText("Review unavailable.");
    events.send(JSON.stringify({ type: "snapshot", snapshot: {
      ...readySnapshot(0.8), currentRisk: null,
      segments: [...readySnapshot(0.8).segments,
        ...readySnapshot(0.8).segments.map((segment) => ({
          ...segment, id: "seg_2", clientSeq: 2,
        })),
      ],
    } }));
    await expect(page.locator(".likelihood-value")).toHaveText("Earlier review");
    await expect(page.locator(".likelihood-marker")).toHaveCount(0);
    await expect(page.locator(".recommendation p")).toHaveText("New lines await review.");
  });
}

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
