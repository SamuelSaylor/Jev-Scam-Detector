import { test, expect, type WebSocketRoute } from "@playwright/test";
import { createDemo, endCall } from "./helpers";
import { decodeEvent, type Event } from "../src/protocol";

for (const size of [
  { width: 320, height: 844 },
  { width: 390, height: 844 },
  { width: 768, height: 900 },
  { width: 1024, height: 768 },
  { width: 1366, height: 768 },
]) {
  test(`layout and 44px controls fit at ${size.width}px`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize(size);
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    await expect(
      page.getByRole("heading", { name: "UNMASK THE SCAM." }),
    ).toBeFocused();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(size.width);
    await createDemo(page);
    await page.evaluate(() => document.fonts.ready);
    await expect(
      page.getByRole("heading", { name: "CONVERSATION REVIEW" }),
    ).toBeFocused();
    const before = await page
      .locator(".text-form")
      .evaluate((node) => node.getBoundingClientRect().top + scrollY);
    await page.getByLabel("Add a typed line").fill("Send the code now");
    await page.getByRole("button", { name: "Add typed line" }).click();
    await expect(page.locator(".likelihood-value")).toHaveText("80%");
    await page.getByRole("button", { name: "Copy room ID" }).click();
    await expect(page.locator(".feedback-slot")).not.toBeEmpty();
    const after = await page
      .locator(".text-form")
      .evaluate((node) => node.getBoundingClientRect().top + scrollY);
    expect(Math.abs(after - before)).toBeLessThan(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(size.width);
    const tooSmall = await page.locator("button").evaluateAll((buttons) =>
      buttons
        .filter((button) => {
          const rect = button.getBoundingClientRect();
          return rect.width > 0 && (rect.width < 44 || rect.height < 44);
        })
        .map((button) => button.textContent),
    );
    expect(tooSmall).toEqual([]);
    const contrast = await page
      .locator(".controls .danger")
      .evaluate((button) => {
        const style = getComputedStyle(button);
        function luminance(rgb: string) {
          const values = (rgb.match(/\d+/g) ?? [])
            .slice(0, 3)
            .map(Number)
            .map((value) => {
              const channel = value / 255;
              return channel <= 0.04045
                ? channel / 12.92
                : ((channel + 0.055) / 1.055) ** 2.4;
            });
          return (
            (values[0] ?? 0) * 0.2126 +
            (values[1] ?? 0) * 0.7152 +
            (values[2] ?? 0) * 0.0722
          );
        }
        const foreground = luminance(style.color),
          background = luminance(style.backgroundColor);
        return (
          (Math.max(foreground, background) + 0.05) /
          (Math.min(foreground, background) + 0.05)
        );
      });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    if (size.width >= 768)
      expect(
        await page
          .getByRole("region", { name: "Shared transcript" })
          .evaluate((node) => node.clientHeight),
      ).toBeGreaterThanOrEqual(300);
    else
      expect(
        await page
          .locator(".likelihood")
          .evaluate((node) => node.getBoundingClientRect().top),
      ).toBeLessThan(size.height);
    const fill = page.locator(
      size.width < 768
        ? ".likelihood-fill.horizontal"
        : ".likelihood-fill.vertical",
    );
    expect(
      await fill.evaluate((node) => getComputedStyle(node).transitionDuration),
    ).toBe("0s");
    await page.screenshot({
      path: test.info().outputPath("call.png"),
      fullPage: true,
      animations: "disabled",
    });
    await endCall(page);
  });
}

test("newer drafts survive a delayed send", async ({ page }) => {
  await page.goto("/");
  await createDemo(page);
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/sessions/*/transcripts", async (route) => {
    await pending;
    await route.continue();
  });
  const input = page.getByLabel("Add a typed line");
  await input.fill("First message");
  await page.getByRole("button", { name: "Add typed line" }).click();
  await input.fill("New unsent draft");
  release();
  await expect(page.locator(".timeline")).toContainText("First message");
  await expect(
    page.getByRole("button", { name: "Add typed line" }),
  ).toBeEnabled();
  await expect(input).toHaveValue("New unsent draft");
  await endCall(page);
});

test("a completed request from a closed room cannot alter the next draft", async ({
  page,
}) => {
  await page.goto("/");
  await createDemo(page);
  let release = () => {};
  let finished = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  await page.route("**/api/sessions/*/transcripts", async (route) => {
    await pending;
    await route.fulfill({ status: 200, json: {} });
    finished();
  });
  await page.getByLabel("Add a typed line").fill("Old room draft");
  await page.getByRole("button", { name: "Add typed line" }).click();
  await endCall(page);
  await page.getByRole("button", { name: "Back to rooms" }).click();
  await createDemo(page);
  await page.getByLabel("Add a typed line").fill("Next room draft");
  release();
  await done;
  await expect(page.getByLabel("Add a typed line")).toHaveValue(
    "Next room draft",
  );
  await expect(
    page.getByRole("button", { name: "Add typed line" }),
  ).toBeEnabled();
  await endCall(page);
});

test("clipboard fallback and end confirmation support keyboard navigation", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await createDemo(page);
  await page.getByRole("button", { name: "Copy room ID" }).click();
  await expect(page.locator(".feedback-slot")).toContainText(
    "Select the room ID to copy.",
  );
  expect(errors).toEqual([]);
  await page.getByRole("button", { name: "End call for everyone" }).click();
  await expect(
    page.getByRole("button", { name: "Keep call open" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "End call for everyone" }),
  ).toBeFocused();
  await endCall(page);
  await expect(
    page.getByRole("heading", { name: "SESSION ENDED" }),
  ).toBeFocused();
});

test("microphone denial leaves typed input working", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException("Denied", "NotAllowedError"));
  });
  await page.goto("/");
  await createDemo(page);
  await page.getByRole("button", { name: "Connect microphone" }).click();
  await expect(page.locator(".feedback-slot")).toContainText(
    "denied or unavailable",
  );
  await page.getByLabel("Add a typed line").fill("Typed without microphone");
  await page.getByRole("button", { name: "Add typed line" }).click();
  await expect(page.locator(".timeline")).toContainText(
    "Typed without microphone",
  );
  await endCall(page);
});

test("reconnect keeps prior risk historical until the authoritative snapshot", async ({
  page,
}) => {
  let socket: WebSocketRoute | undefined;
  let holdSnapshots = false;
  await page.routeWebSocket("**/api/sessions/*/events", (ws) => {
    socket = ws;
    const server = ws.connectToServer();
    server.onMessage((message) => {
      if (
        typeof message === "string" &&
        holdSnapshots &&
        decodeEvent(message).type === "snapshot"
      )
        return;
      ws.send(message);
    });
  });
  await page.goto("/");
  await createDemo(page);
  await page.getByLabel("Add a typed line").fill("Send the code now");
  await page.getByRole("button", { name: "Add typed line" }).click();
  await expect(page.locator(".likelihood-value")).toHaveText("80%");
  holdSnapshots = true;
  await socket?.close({ code: 4000, reason: "Test disconnect" });
  await expect(page.locator(".risk-state")).toHaveText("CONNECTION ISSUE");
  await expect(page.locator(".likelihood-value")).not.toContainText("%");
  await expect(page.locator(".historical-score")).toContainText("80%");
  await page.getByLabel("Add a typed line").fill("Draft while reconnecting");
  await expect(
    page.getByRole("button", { name: "Add typed line" }),
  ).toBeDisabled();
  holdSnapshots = false;
  await page.getByRole("button", { name: "Reconnect to room" }).click();
  await expect(page.getByRole("status")).toContainText("Room connected");
  await expect(page.locator(".likelihood-value")).toHaveText("80%");
  await expect(page.getByLabel("Add a typed line")).toHaveValue(
    "Draft while reconnecting",
  );
  await endCall(page);
});

test("pending and provider-unavailable states do not stop transcript submission", async ({
  page,
}) => {
  let socket: WebSocketRoute | undefined;
  let hold = true;
  const reviews: Event[] = [];
  await page.routeWebSocket("**/api/sessions/*/events", (ws) => {
    socket = ws;
    const server = ws.connectToServer();
    server.onMessage((message) => {
      if (typeof message === "string") {
        const event = decodeEvent(message);
        if (hold && event.type === "assessment") {
          reviews.push(event);
          return;
        }
      }
      ws.send(message);
    });
  });
  await page.goto("/");
  await createDemo(page);
  await page.getByLabel("Add a typed line").fill("Send the code now");
  await page.getByRole("button", { name: "Add typed line" }).click();
  await expect(page.locator(".risk-state")).toHaveText("REVIEW PENDING");
  await expect(page.locator(".historical-score")).toHaveCount(0);
  await expect.poll(() => reviews.length).toBeGreaterThan(0);
  hold = false;
  for (const review of reviews.splice(0)) socket?.send(JSON.stringify(review));
  await expect(page.locator(".likelihood-value")).toHaveText("80%");
  hold = true;
  await page
    .getByLabel("Add a typed line")
    .fill("New line awaiting assessment");
  await page.getByRole("button", { name: "Add typed line" }).click();
  await expect(page.locator(".risk-state")).toHaveText("REVIEW PENDING");
  await expect(page.locator(".historical-score")).toContainText(
    "Historical only",
  );
  socket?.send(
    JSON.stringify({
      type: "provider_status",
      provider: "assessment",
      status: "unavailable",
    } satisfies Event),
  );
  await expect(page.locator(".risk-state")).toHaveText("UNAVAILABLE");
  await page
    .getByLabel("Add a typed line")
    .fill("Still usable during provider outage");
  await page.getByRole("button", { name: "Add typed line" }).click();
  await expect(page.locator(".timeline")).toContainText(
    "Still usable during provider outage",
  );
  await endCall(page);
});

test("a failed end request does not claim server-confirmed termination", async ({
  page,
}) => {
  await page.goto("/");
  await createDemo(page);
  await page.route("**/api/sessions/*/leave", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: "provider_unavailable",
          message: "The server could not complete that request.",
        },
      },
    }),
  );
  await endCall(page);
  await expect(
    page.getByRole("region", { name: "SESSION ENDED" }),
  ).toContainText("server did not confirm");
  await expect(
    page.getByRole("button", { name: "Add typed line" }),
  ).toBeDisabled();
});

test("minimal UI omits helper commentary but retains risk qualification", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.locator(".intro-note, .entry-description, footer"),
  ).toHaveCount(0);
  await createDemo(page);
  await expect(page.locator(".assessment-limits, .risk-band")).toHaveCount(0);
  await expect(page.locator(".likelihood .qualification")).toContainText(
    "not a confirmed scam verdict",
  );
  await page.getByLabel("Add a typed line").fill("Send the code now");
  await page.getByRole("button", { name: "Add typed line" }).click();
  await expect(page.locator(".likelihood-value")).toHaveText("80%");
  await expect(page.locator(".review-description")).toHaveCount(0);
  await expect(page.locator(".assessment-time time")).toBeVisible();
  await endCall(page);
});

test("joining an empty ID gives validation feedback", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Join room" }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter a room ID to join.");
});
