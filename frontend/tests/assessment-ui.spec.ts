import { expect, test, type WebSocketRoute } from "@playwright/test";
import type { Event, Snapshot } from "../src/protocol";
import { endCall } from "./helpers";

function readySnapshot(risk: number): Snapshot {
  return {
    sessionId: "simulated-live-room",
    role: "host",
    mode: "live",
    createdAt: "2026-01-01T00:00:00Z",
    peer: { role: "guest", joined: false, connected: false },
    segments: [
      {
        id: "seg_1",
        speaker: "guest",
        clientSeq: 1,
        text: "Send the code now",
        source: "manual",
        createdAt: "2026-01-01T00:00:02Z",
        startMs: 2000,
        endMs: 2000,
      },
    ],
    assessments: [
      {
        id: `asm_${risk}`,
        status: "ready",
        mode: "live",
        provider: "jev",
        risk,
        evidenceSegmentIds: ["seg_1"],
        throughSegmentId: "seg_1",
        createdAt: "2026-01-01T00:00:05Z",
        startMs: 2000,
        endMs: 2000,
      },
    ],
    currentRisk: risk,
    providerStatus: { transcription: "available", assessment: "available" },
  };
}

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`test-only live events render honest states at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.route("**/api/sessions", (route) =>
      route.fulfill({
        json: {
          sessionId: "simulated-live-room",
          participantToken: "simulated-host-token",
          role: "host",
          mode: "live",
        },
      }),
    );
    await page.route("**/api/sessions/simulated-live-room/leave", (route) =>
      route.fulfill({ status: 204 }),
    );
    let events: WebSocketRoute | undefined;
    await page.routeWebSocket(
      "**/api/sessions/simulated-live-room/events",
      (socket) => {
        events = socket;
        socket.onMessage(() =>
          socket.send(
            JSON.stringify({
              type: "snapshot",
              snapshot: {
                ...readySnapshot(0),
                segments: [],
                assessments: [],
                currentRisk: null,
              },
            } satisfies Event),
          ),
        );
      },
    );
    await page.goto("/");
    await page.getByRole("button", { name: "Create room" }).click();
    await expect(page.locator(".risk-state")).toHaveText("UNASSESSED");
    await expect(page.locator(".mode-indicator")).toHaveText("LIVE");
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Start live transcription" }),
    ).toBeVisible();
    if (!events) throw new Error("Simulated event socket did not connect");
    for (const risk of [0, 0.2, 0.5, 0.755, 0.8, 1]) {
      events.send(
        JSON.stringify({
          type: "snapshot",
          snapshot: readySnapshot(risk),
        } satisfies Event),
      );
      const likelihood = `${Math.round(risk * 100)}%`;
      await expect(page.locator(".likelihood-value")).toHaveText(likelihood);
      await expect(
        page.locator(".recommendation .review-description"),
      ).toHaveCount(0);
      await expect(page.getByRole("meter")).toHaveAttribute(
        "aria-valuenow",
        String(Math.round(risk * 100)),
      );
      const fill = page.locator(
        viewport.width < 768
          ? ".likelihood-fill.horizontal"
          : ".likelihood-fill.vertical",
      );
      if (risk > 0) await expect(fill).toBeVisible();
      else await expect(fill).toBeAttached();
      const amount = await fill.evaluate(
        (element, horizontal) =>
          horizontal ? element.style.width : element.style.height,
        viewport.width < 768,
      );
      expect(amount).toBe(`${risk * 100}%`);
      await expect(page.locator(".assessment-time time")).toHaveAttribute(
        "datetime",
        "2026-01-01T00:00:05Z",
      );
      await page.locator(".evidence button").click();
      await expect(page.locator('[data-segment-id="seg_1"]')).toBeFocused();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(viewport.width);
    }
    events.send(
      JSON.stringify({
        type: "provider_status",
        provider: "assessment",
        status: "unavailable",
      } satisfies Event),
    );
    await expect(page.locator(".risk-state")).toHaveText("UNAVAILABLE");
    await expect(page.locator(".likelihood-fill")).toHaveCount(0);
    await expect(page.locator(".historical-score")).toContainText("100%");
    events.send(
      JSON.stringify({
        type: "snapshot",
        snapshot: {
          ...readySnapshot(0.8),
          currentRisk: null,
          segments: [
            ...readySnapshot(0.8).segments,
            ...readySnapshot(0.8).segments.map(
              (segment): Snapshot["segments"][number] => ({
                ...segment,
                id: "seg_2",
                clientSeq: 2,
                source: "openai",
              }),
            ),
          ],
        },
      } satisfies Event),
    );
    await expect(page.locator(".risk-state")).toHaveText("REVIEW PENDING");
    await expect(page.locator(".likelihood-fill")).toHaveCount(0);
    await expect(page.locator(".recommendation h3")).toHaveText(
      "Historical result · 80%",
    );
    await expect(page.locator(".timeline")).toContainText("Transcribed audio");
    await endCall(page);
    await expect(page.locator(".risk-state")).toHaveText("SESSION ENDED");
  });
}

test("live creation gives a server-configuration error without offering demo", async ({
  page,
}) => {
  await page.route("**/api/sessions", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ mode: "live" });
    await route.fulfill({
      status: 503,
      json: {
        error: {
          code: "live_not_configured",
          message: "Live providers are not configured",
        },
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Create room" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Ask the server operator",
  );
  await expect(page.getByRole("button", { name: "Create room" })).toBeEnabled();
  await expect(page.getByRole("radio")).toHaveCount(0);
});
