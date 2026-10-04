import {
  test,
  expect,
  type BrowserContext,
  type Page,
  type WebSocketRoute,
} from "@playwright/test";

import { createDemo, endCall } from "./helpers";

declare global {
  interface Window {
    __peers: RTCPeerConnection[];
    __releaseMic?: () => void;
    __micTrack?: MediaStreamTrack;
  }
}

async function participant(context: BrowserContext) {
  await context.addInitScript(() => {
    window.__peers = [];
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
        super(...args);
        window.__peers.push(this);
      }
    };
  });
  const page = await context.newPage();
  await page.goto("/");
  return page;
}

async function send(page: Page, text: string) {
  await page.getByLabel("Add a typed line").fill(text);
  await page.getByRole("button", { name: "Add typed line" }).click();
  await expect(
    page.locator(".timeline li").filter({ hasText: text }),
  ).toHaveCount(1);
}

async function inboundAudio(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        for (const peer of window.__peers) {
          if (peer.connectionState !== "connected") continue;
          const stats = await peer.getStats();
          for (const report of stats.values()) {
            if (
              report.type === "inbound-rtp" &&
              report.kind === "audio" &&
              report.packetsReceived > 0 &&
              report.bytesReceived > 0
            )
              return true;
          }
        }
        return false;
      }),
    )
    .toBe(true);
}

async function remoteTrack(page: Page) {
  await expect
    .poll(() =>
      page
        .getByLabel("Remote participant audio")
        .evaluate(
          (element) =>
            element instanceof HTMLAudioElement &&
            element.srcObject instanceof MediaStream &&
            element.srcObject
              .getAudioTracks()
              .some((track) => track.readyState === "live"),
        ),
    )
    .toBe(true);
}

test("browser produces a closed WebM clip", async ({ page }) => {
  await page.goto("/");
  const clip = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    try {
      const recorder = new MediaRecorder(stream, {
        mimeType: "audio/webm;codecs=opus",
      });
      const parts: Blob[] = [];
      recorder.ondataavailable = (event) => parts.push(event.data);
      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });
      recorder.start();
      await new Promise((resolve) => setTimeout(resolve, 300));
      recorder.stop();
      await stopped;
      const blob = new Blob(parts, { type: "audio/webm" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return {
        size: blob.size,
        mime: blob.type,
        header: [...bytes.slice(0, 4)],
      };
    } finally {
      stream.getTracks().forEach((track) => track.stop());
    }
  });
  expect(clip.mime).toBe("audio/webm");
  expect(clip.header).toEqual([26, 69, 223, 163]);
  expect(clip.size).toBeGreaterThan(100);
});

test("late microphone permission cannot enable a later call", async ({
  browser,
}) => {
  const context = await browser.newContext({ permissions: ["microphone"] });
  await context.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = (constraints) =>
      new Promise<MediaStream>((resolve, reject) => {
        window.__releaseMic = () =>
          original(constraints).then((stream) => {
            window.__micTrack = stream.getAudioTracks()[0];
            resolve(stream);
          }, reject);
      });
  });
  try {
    const page = await participant(context);
    await createDemo(page);
    await page.getByRole("button", { name: "Connect microphone" }).click();
    await expect(
      page.getByRole("button", { name: "Requesting microphone" }),
    ).toBeVisible();
    await endCall(page);
    await page.getByRole("button", { name: "Back to rooms" }).click();
    await createDemo(page);
    await page.evaluate(() => window.__releaseMic?.());
    await expect
      .poll(() => page.evaluate(() => window.__micTrack?.readyState))
      .toBe("ended");
    await expect(
      page.getByRole("button", { name: "Connect microphone" }),
    ).toBeVisible();
    await expect(page.locator(".people .person").first()).toContainText(
      "Microphone off",
    );
    await endCall(page);
  } finally {
    await context.close();
  }
});

test("two browsers connect real audio, share transcript and retain the ended record", async ({
  browser,
}) => {
  const hostContext = await browser.newContext({ permissions: ["microphone"] });
  const guestContext = await browser.newContext({
    permissions: ["microphone"],
  });
  try {
    const host = await participant(hostContext);
    const guest = await participant(guestContext);
    const id = await createDemo(host);
    await guest.getByLabel("Room ID, if joining").fill(id);
    await guest.getByRole("button", { name: "Join room" }).click();
    for (const page of [host, guest])
      await expect(page.getByRole("status")).toContainText(
        "Audio peer connected",
      );
    await expect(
      guest.getByRole("button", { name: "Start live transcription" }),
    ).toHaveCount(0);
    await guest.getByRole("button", { name: "Reconnect to room" }).click();
    for (const page of [host, guest])
      await expect(page.getByRole("status")).toContainText(
        "Audio peer connected",
      );
    await host.getByRole("button", { name: "Connect microphone" }).click();
    await guest.getByRole("button", { name: "Connect microphone" }).click();
    for (const page of [host, guest]) {
      await remoteTrack(page);
      await inboundAudio(page);
    }
    await host.getByRole("button", { name: "Mute microphone" }).click();
    await expect(
      host.getByRole("button", { name: "Unmute microphone" }),
    ).toBeVisible();
    await host.getByRole("button", { name: "Unmute microphone" }).click();
    await send(host, "Send the code now");
    await send(guest, "I will call the bank myself");
    for (const [page, hostLabel, guestLabel] of [
      [host, "You (host)", "Guest"],
      [guest, "Host", "You (guest)"],
    ] satisfies Array<[Page, string, string]>) {
      await expect(
        page
          .locator(".timeline li")
          .filter({ hasText: "Send the code now" })
          .locator(".speaker"),
      ).toHaveText(hostLabel);
      await expect(
        page
          .locator(".timeline li")
          .filter({ hasText: "I will call the bank myself" })
          .locator(".speaker"),
      ).toHaveText(guestLabel);
      await expect(page.locator(".likelihood-value")).toHaveText("80%");
      await expect(page.locator(".mode-indicator")).toHaveText("DEMO");
      await expect(page.locator(".timeline")).toContainText("Typed");
      await expect(page.getByText("Referenced evidence")).toBeVisible();
      await page.getByRole("button", { name: /Send the code now/ }).click();
      await expect(page.locator(".timeline li").first()).toBeFocused();
      await expect(page.locator(".timeline li").first()).toHaveClass(
        /evidence-highlight/,
      );
    }
    await guest.getByRole("button", { name: "Reconnect to room" }).click();
    for (const page of [host, guest]) {
      await expect(page.getByRole("status")).toContainText(
        "Audio peer connected",
      );
      await remoteTrack(page);
      await inboundAudio(page);
    }
    await endCall(guest);
    await expect(
      host.getByRole("region", { name: "SESSION ENDED" }),
    ).toContainText("ended or expired");
    for (const page of [host, guest]) {
      await expect(page.locator(".timeline")).toContainText(
        "Send the code now",
      );
      await expect(page.locator(".risk-state")).toHaveText("SESSION ENDED");
      await expect(page.locator(".historical-score")).toContainText("80%");
      await expect(
        page.getByRole("button", { name: "Add typed line" }),
      ).toBeDisabled();
      await page.getByRole("button", { name: "Back to rooms" }).click();
      await expect(
        page.getByRole("button", { name: "Create room" }),
      ).toBeVisible();
    }
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});

test("full room and missing room show recoverable errors", async ({
  browser,
}) => {
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ]);
  try {
    const [host, guest, visitor] = await Promise.all(contexts.map(participant));
    if (!host || !guest || !visitor)
      throw new Error("Three browser contexts required");
    await visitor.getByLabel("Room ID, if joining").fill("missing-room");
    await visitor.getByRole("button", { name: "Join room" }).click();
    await expect(visitor.getByRole("alert")).toContainText(
      /not found|expired/i,
    );
    const id = await createDemo(host);
    for (const page of [guest, visitor]) {
      await page.getByLabel("Room ID, if joining").fill(id);
      await page.getByRole("button", { name: "Join room" }).click();
    }
    await expect(visitor.getByRole("alert")).toContainText(/full|claimed/i);
    await endCall(host);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("transcript preserves reading position and announces newly appended lines", async ({
  browser,
}) => {
  const hostContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const guestContext = await browser.newContext();
  try {
    const host = await participant(hostContext);
    const guest = await participant(guestContext);
    const id = await createDemo(host);
    await guest.getByLabel("Room ID, if joining").fill(id);
    await guest.getByRole("button", { name: "Join room" }).click();
    await expect(guest.locator(".people .person").last()).toContainText(
      "In room",
    );
    await send(host, "Send the code now");
    for (let index = 0; index < 12; index++)
      await send(
        index % 2 ? guest : host,
        index === 3
          ? `Long line ${"unbroken-word".repeat(100)}`
          : `Message ${index}`,
      );
    const viewport = host.getByRole("region", { name: "Shared transcript" });
    await expect
      .poll(() =>
        viewport.evaluate((node) =>
          Math.round(node.scrollHeight - node.scrollTop - node.clientHeight),
        ),
      )
      .toBeLessThan(8);
    await viewport.focus();
    await host.keyboard.press("PageUp");
    await expect(
      host.getByRole("button", { name: "Latest messages" }),
    ).toBeVisible();
    const position = await viewport.evaluate((node) => node.scrollTop);
    await send(guest, "An appended line while reading");
    await expect(
      host.getByRole("button", { name: /1 new line.*Latest messages/ }),
    ).toBeVisible();
    expect(await viewport.evaluate((node) => node.scrollTop)).toBeCloseTo(
      position,
      0,
    );
    await host.getByRole("button", { name: /Send the code now/ }).click();
    await expect(host.locator(".timeline li").first()).toBeFocused();
    await expect(host.locator(".timeline li").first()).toHaveClass(
      /evidence-highlight/,
    );
    await expect(host.locator(".timeline li").first()).not.toHaveClass(
      /evidence-highlight/,
      { timeout: 5000 },
    );
    await host.getByRole("button", { name: /Latest messages/ }).click();
    await expect
      .poll(() =>
        viewport.evaluate((node) =>
          Math.round(node.scrollHeight - node.scrollTop - node.clientHeight),
        ),
      )
      .toBeLessThan(8);
    await host.setViewportSize({ width: 1366, height: 768 });
    expect(
      await viewport.evaluate((node) => node.clientHeight),
    ).toBeGreaterThanOrEqual(300);
    await expect
      .poll(() =>
        viewport.evaluate((node) =>
          Math.round(node.scrollHeight - node.scrollTop - node.clientHeight),
        ),
      )
      .toBeLessThan(8);
    expect(
      await host.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(1366);
    await endCall(host);
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});

test("provider outage and recovery do not revive cached current risk", async ({
  page,
}) => {
  let events: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/sessions/*/events", (socket) => {
    events = socket;
    const server = socket.connectToServer();
    server.onMessage((message) => socket.send(message));
  });
  await page.goto("/");
  await createDemo(page);
  await expect(page.locator(".risk-state")).toHaveText("UNASSESSED");
  await send(page, "Hello, how are you?");
  await expect(page.locator(".likelihood-value")).toHaveText("20%");
  await expect(page.locator(".recommendation .review-description")).toHaveCount(
    0,
  );
  await send(page, "Send the code now");
  await expect(page.locator(".likelihood-value")).toHaveText("80%");
  if (!events) throw new Error("Real session socket required");
  events.send(
    JSON.stringify({
      type: "provider_status",
      provider: "assessment",
      status: "unavailable",
    }),
  );
  await expect(page.locator(".risk-state")).toHaveText("UNAVAILABLE");
  await expect(page.locator(".likelihood-fill")).toHaveCount(0);
  await expect(
    page.getByText("Referenced evidence", { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".historical-score")).toContainText(
    "Historical only",
  );
  events.send(
    JSON.stringify({
      type: "provider_status",
      provider: "assessment",
      status: "available",
    }),
  );
  await expect(page.locator(".risk-state")).toHaveText("REVIEW PENDING");
  await expect(page.locator(".likelihood-fill")).toHaveCount(0);
  await send(page, "I will verify independently.");
  await expect(page.locator(".likelihood-value")).toHaveText("80%");
  await endCall(page);
});
