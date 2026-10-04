import { test, expect, type BrowserContext, type Page } from "@playwright/test";

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
            ) {
              return true;
            }
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
      page.getByLabel("Remote participant audio").evaluate((element) => {
        if (!(element instanceof HTMLAudioElement)) return false;
        return (
          element.srcObject instanceof MediaStream &&
          element.srcObject.getAudioTracks().length > 0
        );
      }),
    )
    .toBe(true);
}

test("browser produces a closed WebM clip", async ({ page }) => {
  await page.goto("/");
  const clip = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    try {
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      const parts: Blob[] = [];
      recorder.ondataavailable = (event) => parts.push(event.data);
      const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
      recorder.start();
      await new Promise((resolve) => setTimeout(resolve, 300));
      recorder.stop();
      await stopped;
      const blob = new Blob(parts, { type: "audio/webm" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return { size: blob.size, mime: blob.type, header: [...bytes.slice(0, 4)] };
    } finally {
      stream.getTracks().forEach((track) => track.stop());
    }
  });
  expect(clip.mime).toBe("audio/webm");
  expect(clip.header).toEqual([26, 69, 223, 163]);
  expect(clip.size).toBeGreaterThan(100);
});

test("late microphone permission cannot enable a later call", async ({ browser }) => {
  const context = await browser.newContext({ permissions: ["microphone"] });
  await context.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) =>
      new Promise<MediaStream>((resolve, reject) => {
        window.__releaseMic = () => {
          original(constraints).then((stream) => {
            window.__micTrack = stream.getAudioTracks()[0];
            resolve(stream);
          }, reject);
        };
      });
  });
  try {
    const page = await context.newPage();
    await page.goto("/");
    await page.getByRole("button", { name: "Create room" }).click();
    await page.getByRole("button", { name: "Connect microphone" }).click();
    await expect(page.getByRole("button", { name: "Requesting microphone" })).toBeVisible();
    await page.getByRole("button", { name: "End call for everyone" }).click();
    await expect(page.getByRole("button", { name: "Create room" })).toBeVisible();
    await page.getByRole("button", { name: "Create room" }).click();
    await page.evaluate(() => window.__releaseMic?.());
    await expect.poll(() => page.evaluate(() => window.__micTrack?.readyState)).toBe("ended");
    await expect(page.getByRole("button", { name: "Connect microphone" })).toBeVisible();
    await expect(page.locator(".people .person").first()).toContainText("Microphone off");
  } finally {
    await context.close();
  }
});

test("two browsers connect audio, review typed lines, then end the shared room", async ({
  browser,
}) => {
  const hostContext = await browser.newContext({ permissions: ["microphone"] });
  const guestContext = await browser.newContext({
    permissions: ["microphone"],
  });
  try {
    const host = await participant(hostContext);
    const guest = await participant(guestContext);
    await host.getByRole("button", { name: "Create room" }).click();
    const sessionId = await host
      .getByLabel("Room ID", { exact: true })
      .textContent();
    expect(sessionId).toBeTruthy();
    await guest.getByLabel("Room ID, if joining").fill(sessionId ?? "");
    await guest.getByRole("button", { name: "Join room" }).click();
    await expect(host.getByRole("status")).toContainText(
      "Audio peer connected",
    );
    await expect(guest.getByRole("status")).toContainText(
      "Audio peer connected",
    );
    await guest.getByRole("button", { name: "Reconnect to room" }).click();
    await expect(host.getByRole("status")).toContainText(
      "Audio peer connected",
    );
    await expect(guest.getByRole("status")).toContainText(
      "Audio peer connected",
    );
    await host.getByRole("button", { name: "Connect microphone" }).click();
    await guest.getByRole("button", { name: "Connect microphone" }).click();
    await remoteTrack(host);
    await remoteTrack(guest);
    await inboundAudio(host);
    await inboundAudio(guest);
    for (const page of [host, guest]) {
      await expect
        .poll(() =>
          page.getByLabel("Remote participant audio").evaluate((element) => {
            if (
              !(element instanceof HTMLAudioElement) ||
              !(element.srcObject instanceof MediaStream)
            )
              return false;
            return element.srcObject
              .getAudioTracks()
              .some((track) => track.readyState === "live" && !track.muted);
          }),
        )
        .toBe(true);
    }
    await host.getByRole("button", { name: "Mute microphone" }).click();
    await expect(
      host.getByRole("button", { name: "Unmute microphone" }),
    ).toBeVisible();
    await host.getByRole("button", { name: "Unmute microphone" }).click();
    const submittedAt = Date.now();
    await host
      .getByLabel("Add a line to the shared timeline")
      .fill("Send the code now");
    await host.getByRole("button", { name: "Add typed line" }).click();
    await guest
      .getByLabel("Add a line to the shared timeline")
      .fill("I will call the bank myself");
    await guest.getByRole("button", { name: "Add typed line" }).click();
    for (const [page, hostLabel, guestLabel] of [
      [host, "You (host)", "Guest"],
      [guest, "Host", "You (guest)"],
    ] as const) {
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
      await expect(
        page.getByText("Send the code now", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("I will call the bank myself", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText("80%", { exact: true })).toBeVisible({
        timeout: 20000,
      });
      await expect(
        page.getByRole("button", { name: /Send the code now/ }),
      ).toBeVisible();
      await expect(page.getByText("Referenced evidence")).toBeVisible();
      const evidence = page.getByRole("button", { name: /Send the code now/ });
      const segmentId = await page
        .locator(".timeline li")
        .filter({ hasText: "Send the code now" })
        .getAttribute("data-segment-id");
      expect(segmentId).toBeTruthy();
      await evidence.click();
      await expect(page.locator(`[data-segment-id="${segmentId}"]`)).toBeFocused();
    }
    expect(Date.now() - submittedAt).toBeLessThan(15000);
    await guest.getByRole("button", { name: "Reconnect to room" }).click();
    await expect(host.getByRole("status")).toContainText(
      "Audio peer connected",
    );
    await expect(guest.getByRole("status")).toContainText(
      "Audio peer connected",
    );
    await remoteTrack(host);
    await remoteTrack(guest);
    await inboundAudio(host);
    await inboundAudio(guest);
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
    });
    try {
      const phonePage = await participant(phone);
      await phonePage.getByRole("button", { name: "Create room" }).click();
      await expect(phonePage.locator(".call-header .context")).toContainText("Demo mode");
      await expect(
        phonePage.getByRole("heading", { name: "What the text suggests" }),
      ).toBeVisible();
      const mobileBounds = await phonePage.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
      expect(mobileBounds.width).toBeLessThanOrEqual(mobileBounds.viewport);
      const mobileTranscript = phonePage.getByRole("region", { name: "Shared transcript" });
      expect(await mobileTranscript.evaluate((node) => node.clientHeight)).toBeGreaterThan(150);
      await phonePage.screenshot({
        path: "/tmp/jev-call-layout/call-mobile.png",
        fullPage: true,
        animations: "disabled",
      });
      await phonePage
        .getByRole("button", { name: "End call for everyone" })
        .click();
    } finally {
      await phone.close();
    }
    await guest.getByRole("button", { name: "End call for everyone" }).click();
    await expect(
      host.getByRole("button", { name: "Create room" }),
    ).toBeVisible();
    await expect(
      guest.getByRole("button", { name: "Create room" }),
    ).toBeVisible();
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});

test("full room and missing room show recoverable errors", async ({
  browser,
}) => {
  const owner = await browser.newContext();
  const second = await browser.newContext();
  const third = await browser.newContext();
  try {
    const host = await participant(owner);
    const guest = await participant(second);
    const visitor = await participant(third);
    await visitor.getByLabel("Room ID, if joining").fill("missing-room");
    await visitor.getByRole("button", { name: "Join room" }).click();
    await expect(visitor.getByRole("alert")).toContainText(
      /not found|expired/i,
    );
    await host.getByRole("button", { name: "Create room" }).click();
    const id = await host.getByLabel("Room ID", { exact: true }).textContent();
    await guest.getByLabel("Room ID, if joining").fill(id ?? "");
    await guest.getByRole("button", { name: "Join room" }).click();
    await visitor.getByLabel("Room ID, if joining").fill(id ?? "");
    await visitor.getByRole("button", { name: "Join room" }).click();
    await expect(visitor.getByRole("alert")).toContainText(/full|claimed/i);
    await host.getByRole("button", { name: "End call for everyone" }).click();
  } finally {
    await owner.close();
    await second.close();
    await third.close();
  }
});

test("transcript follows, preserves reading position, and keeps evidence jumps inside the viewport", async ({ browser }) => {
  const hostContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const host = await participant(hostContext);
    const guest = await participant(guestContext);
    await host.screenshot({ path: "/tmp/jev-call-layout/workspace-lobby.png", fullPage: true, animations: "disabled" });
    await host.getByRole("button", { name: "Create room" }).click();
    const id = await host.getByLabel("Room ID", { exact: true }).textContent();
    await guest.getByLabel("Room ID, if joining").fill(id ?? "");
    await guest.getByRole("button", { name: "Join room" }).click();
    await expect(guest.getByRole("status")).toContainText("Both browsers in room");
    const send = async (page: Page, text: string) => {
      await page.getByLabel("Add a line to the shared timeline").fill(text);
      await page.getByRole("button", { name: "Add typed line" }).click();
      await expect(page.locator(".timeline li").filter({ hasText: text })).toHaveCount(1);
    };
    await send(host, "Send the code now");
    await expect(host.getByText("80%", { exact: true })).toBeVisible({ timeout: 20000 });
    const viewport = host.getByRole("region", { name: "Shared transcript" });
    const long = "A long line " + "unbroken-word".repeat(100);
    for (let index = 0; index < 12; index++) await send(index % 2 ? guest : host, index === 3 ? long : `Message ${index} from the call`);
    await expect(host.locator(".timeline li")).toHaveCount(13);
    await expect(guest.locator(".timeline li")).toHaveCount(13);
    await expect(host.locator(".timeline li.local")).toHaveCount(7);
    await expect(guest.locator(".timeline li.local")).toHaveCount(6);
    const bounds = await host.evaluate(() => ({ page: document.documentElement.scrollHeight, width: document.documentElement.scrollWidth, viewport: innerWidth }));
    expect(bounds.page).toBeLessThanOrEqual(940);
    expect(bounds.width).toBeLessThanOrEqual(bounds.viewport);
    await expect.poll(() => viewport.evaluate((node) => Math.round(node.scrollHeight - node.scrollTop - node.clientHeight))).toBeLessThan(8);
    await viewport.focus();
    await host.keyboard.press("Home");
    await expect(host.getByRole("button", { name: "Latest messages" })).toBeVisible();
    await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeLessThan(200);
    const position = await viewport.evaluate((node) => node.scrollTop);
    const documentPosition = await host.evaluate(() => scrollY);
    await send(guest, "An appended line while reading");
    await expect(host.locator(".timeline li")).toHaveCount(14);
    expect(await viewport.evaluate((node) => node.scrollTop)).toBeCloseTo(position, 0);
    expect(await host.evaluate(() => scrollY)).toBe(documentPosition);
    await host.getByRole("button", { name: /Send the code now/ }).click();
    await expect(host.locator(".timeline li").first()).toBeFocused();
    expect(await host.evaluate(() => scrollY)).toBe(documentPosition);
    await host.getByRole("button", { name: "Latest messages" }).click();
    await expect(host.getByRole("button", { name: "Latest messages" })).toHaveCount(0);
    await host.screenshot({ path: "/tmp/jev-call-layout/workspace-desktop.png", fullPage: true, animations: "disabled" });
    await host.getByRole("button", { name: "End call for everyone" }).click();
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});
