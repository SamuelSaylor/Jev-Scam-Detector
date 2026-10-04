import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import type { Defense, Event, Snapshot } from "../src/protocol";

const reasons = [
  "Pressure to act urgently or keep the conversation secret.",
  "A request for payment or a money transfer.",
  "A request for passwords, verification codes, or personal information.",
];
function view(risk = 0.45, tier: Defense["tier"] = "monitor"): Snapshot {
  return {
    sessionId: "test-defense-room",
    role: "host",
    mode: "live",
    createdAt: "2026-01-01T00:00:00Z",
    peer: { role: "guest", joined: false, connected: false },
    segments: [1, 2, 3].map((index) => ({
      id: `seg_${index}`,
      speaker: "guest",
      clientSeq: index,
      text: `Suspicious request ${index}: transfer money and send the code now`,
      source: "manual",
      createdAt: "2026-01-01T00:00:02Z",
      startMs: 2000,
      endMs: 2000,
    })),
    assessments: [
      {
        id: `asm_${risk}`,
        status: "ready",
        mode: "live",
        provider: "jev",
        risk,
        rawRisk: 0.99,
        confidence: 0.95,
        indicators: [],
        evidenceSegmentIds: ["seg_1", "seg_2", "seg_3"],
        throughSegmentId: "seg_3",
        createdAt: "2026-01-01T00:00:05Z",
        startMs: 2000,
        endMs: 2000,
      },
    ],
    currentRisk: risk,
    providerStatus: { transcription: "available", assessment: "available" },
    defense: {
      tier,
      reasons,
      trustedContact: null,
      lockout: null,
      overrides: [],
    },
  };
}
function defenseOf(snapshot: Snapshot): Defense {
  if (!snapshot.defense) throw new Error("Defense fixture required");
  return snapshot.defense;
}
async function setup(page: Page) {
  let state = view();
  let socket: WebSocketRoute | undefined;
  let overrides = 0;
  await page.route("**/api/sessions", (route) =>
    route.fulfill({
      json: {
        sessionId: state.sessionId,
        participantToken: "test-token",
        role: "host",
        mode: "live",
      },
    }),
  );
  await page.route("**/api/sessions/test-defense-room/leave", (route) =>
    route.fulfill({ status: 204 }),
  );
  await page.route(
    "**/api/sessions/test-defense-room/defense/contact",
    async (route) => {
      const body: unknown = route.request().postDataJSON();
      if (!body || typeof body !== "object" || !("contact" in body))
        throw new Error("contact input required");
      const { defense } = await import("../src/protocol");
      const next = defense.parse({
        ...defenseOf(state),
        trustedContact: body.contact,
      });
      state = { ...state, defense: next };
      await route.fulfill({ json: next });
    },
  );
  await page.route(
    "**/api/sessions/test-defense-room/defense/overrides",
    async (route) => {
      overrides++;
      const current = defenseOf(state);
      if (!current.lockout) throw new Error("hold required");
      const next: Defense = {
        ...current,
        lockout: null,
        overrides: [
          ...current.overrides,
          {
            lockoutId: current.lockout.id,
            assessmentId: current.lockout.assessmentId,
            role: "host",
            createdAt: new Date().toISOString(),
          },
        ],
      };
      state = { ...state, defense: next };
      await route.fulfill({ json: next });
    },
  );
  await page.routeWebSocket(
    "**/api/sessions/test-defense-room/events",
    (ws) => {
      socket = ws;
      ws.onMessage(() =>
        ws.send(
          JSON.stringify({ type: "snapshot", snapshot: state } satisfies Event),
        ),
      );
    },
  );
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);
      window.__micTrack = stream.getAudioTracks()[0];
      return stream;
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Create room" }).click();
  await expect(
    page.getByRole("button", { name: "Connect microphone" }),
  ).toBeEnabled();
  return {
    update(next: Snapshot) {
      state = next;
      socket?.send(
        JSON.stringify({ type: "snapshot", snapshot: state } satisfies Event),
      );
    },
    event(event: Event) {
      socket?.send(JSON.stringify(event));
    },
    get overrides() {
      return overrides;
    },
    get state() {
      return state;
    },
  };
}

test("tiers are quiet below 50 and prepare a user-controlled trusted-contact draft", async ({
  page,
}) => {
  const session = await setup(page);
  await expect(page.locator(".defense-warning")).toHaveCount(0);
  session.update(view(0.55, "caution"));
  await expect(
    page.getByRole("heading", { name: "POSSIBLE SCAM" }),
  ).toBeVisible();
  await expect(page.locator(".defense-warning")).toContainText(
    reasons[0] ?? "",
  );
  session.update(view(0.75, "contact"));
  await expect(
    page.getByRole("heading", { name: "ASK SOMEONE YOU TRUST" }),
  ).toBeVisible();
  await page.locator(".contact-settings summary").click();
  await page.getByLabel("Name", { exact: true }).fill("Trusted friend");
  await page.getByLabel("Email", { exact: true }).fill("friend@example.com");
  await page.getByRole("button", { name: "Save contact" }).click();
  await expect(
    page.getByRole("link", { name: "Prepare email to Trusted friend" }),
  ).toHaveAttribute("href", /^mailto:friend%40example.com/);
  await expect(page.locator(".defense-warning small")).toContainText(
    "Nothing is sent automatically",
  );
});

for (const width of [320, 390, 1280]) {
  test(`five-second hold pauses audio and requires explicit acknowledgment at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const session = await setup(page);
    await page.getByRole("button", { name: "Connect microphone" }).click();
    await expect(
      page.getByRole("button", { name: "Mute microphone" }),
    ).toBeVisible();
    const locked = view(0.9, "lockout");
    const created = new Date().toISOString();
    locked.defense = {
      ...defenseOf(locked),
      lockout: {
        id: "hold_1",
        assessmentId: "asm_0.9",
        risk: 0.9,
        confidence: 0.95,
        reasons,
        evidenceSegmentIds: ["seg_1", "seg_2", "seg_3"],
        createdAt: created,
        readyAt: new Date(Date.now() + 5000).toISOString(),
      },
    };
    const start = Date.now();
    session.update(locked);
    await expect(
      page.getByRole("dialog", { name: "REVIEW BEFORE CONTINUING" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "REVIEW BEFORE CONTINUING" }),
    ).toBeFocused();
    await expect(
      page.getByRole("dialog", { name: "REVIEW BEFORE CONTINUING" }),
    ).toContainText("Cited conversation");
    expect(
      await page
        .locator(".safety-review")
        .evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await expect(page.getByLabel("Add a typed line")).toBeDisabled();
    await expect
      .poll(() => page.evaluate(() => window.__micTrack?.enabled))
      .toBe(false);
    await expect(page.getByLabel("Remote participant audio")).toHaveJSProperty(
      "muted",
      true,
    );
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "REVIEW BEFORE CONTINUING" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Review for/ }),
    ).toBeDisabled();
    expect(session.overrides).toBe(0);
    session.event({
      type: "provider_status",
      provider: "assessment",
      status: "unavailable",
    });
    await expect(
      page.getByRole("dialog", { name: "REVIEW BEFORE CONTINUING" }),
    ).toBeVisible();
    const proceed = page.getByRole("button", {
      name: "I understand the risks · Continue conversation",
    });
    await expect(proceed).toBeEnabled({ timeout: 7000 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(4900);
    await proceed.click();
    await expect(page.locator(".safety-review")).toHaveCount(0);
    expect(session.overrides).toBe(1);
    await expect
      .poll(() => page.evaluate(() => window.__micTrack?.enabled))
      .toBe(true);
    await expect(page.getByLabel("Remote participant audio")).toHaveJSProperty(
      "muted",
      false,
    );
    await expect(
      page.getByRole("button", { name: "Start live transcription" }),
    ).toBeVisible();
    session.update(session.state);
    await expect(page.locator(".safety-review")).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    const firstHold = locked.defense.lockout;
    if (!firstHold) throw new Error("Initial hold required");
    const pausedAgain = {
      ...session.state,
      defense: {
        ...defenseOf(session.state),
        lockout: {
          ...firstHold,
          id: "hold_2",
          assessmentId: "asm_new",
          createdAt: new Date().toISOString(),
          readyAt: new Date(Date.now() + 5000).toISOString(),
        },
      },
    };
    await page.getByRole("button", { name: "Mute microphone" }).click();
    session.update(pausedAgain);
    await expect(
      page.getByRole("dialog", { name: "REVIEW BEFORE CONTINUING" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Review for/ }),
    ).toBeDisabled();
    await page
      .locator(".safety-review")
      .getByRole("button", { name: "End call for everyone" })
      .click();
    await expect(
      page.getByRole("heading", { name: "SESSION ENDED" }),
    ).toBeVisible();
  });
}

test("continuing preserves a microphone the user had muted", async ({
  page,
}) => {
  const session = await setup(page);
  await page.getByRole("button", { name: "Connect microphone" }).click();
  await page.getByRole("button", { name: "Mute microphone" }).click();
  const locked = view(0.9, "lockout");
  locked.defense = {
    ...defenseOf(locked),
    lockout: {
      id: "hold_muted",
      assessmentId: "asm_1",
      risk: 0.9,
      confidence: 0.95,
      reasons,
      evidenceSegmentIds: ["seg_1"],
      createdAt: new Date().toISOString(),
      readyAt: new Date(Date.now() + 5000).toISOString(),
    },
  };
  session.update(locked);
  const proceed = page.getByRole("button", {
    name: "I understand the risks · Continue conversation",
  });
  await expect(proceed).toBeEnabled({ timeout: 7000 });
  await proceed.click();
  await expect(page.locator(".safety-review")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Unmute microphone" }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__micTrack?.enabled))
    .toBe(false);
});

test("a delayed acknowledgment cannot dismiss a newer hold", async ({
  page,
}) => {
  const session = await setup(page);
  const initial = view(0.9, "lockout");
  const first = {
    id: "hold_first",
    assessmentId: "asm_1",
    risk: 0.9,
    confidence: 0.95,
    reasons,
    evidenceSegmentIds: ["seg_1"],
    createdAt: new Date().toISOString(),
    readyAt: new Date(Date.now() + 5000).toISOString(),
  };
  initial.defense = { ...defenseOf(initial), lockout: first };
  session.update(initial);
  let release: (() => void) | undefined;
  const delay = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: (() => void) | undefined;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(
    "**/api/sessions/test-defense-room/defense/overrides",
    async (route) => {
      started?.();
      await delay;
      await route.fulfill({
        json: {
          ...defenseOf(initial),
          lockout: null,
          overrides: [
            {
              lockoutId: first.id,
              assessmentId: first.assessmentId,
              role: "host",
              createdAt: new Date().toISOString(),
            },
          ],
        },
      });
    },
  );
  const continueButton = page.getByRole("button", {
    name: "I understand the risks · Continue conversation",
  });
  await expect(continueButton).toBeEnabled({ timeout: 7000 });
  await continueButton.click();
  await requestStarted;
  session.update({
    ...initial,
    defense: {
      ...defenseOf(initial),
      lockout: {
        ...first,
        id: "hold_new",
        assessmentId: "asm_new",
        createdAt: new Date().toISOString(),
        readyAt: new Date(Date.now() + 5000).toISOString(),
      },
    },
  });
  await expect(page.getByRole("button", { name: /Review for/ })).toBeDisabled();
  release?.();
  await expect(page.locator(".safety-review")).toBeVisible();
  await expect(page.getByLabel("Add a typed line")).toBeDisabled();
  await expect(page.getByRole("button", { name: /Review for/ })).toBeDisabled();
});

test("risk presentation interpolates and reduced motion skips animation", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const session = await setup(page);
  await expect(page.locator(".likelihood-value")).toHaveText("45%");
  session.update(view(0.55, "caution"));
  const immediate = parseInt(
    await page.locator(".likelihood-value").innerText(),
    10,
  );
  expect(immediate).toBeGreaterThanOrEqual(45);
  expect(immediate).toBeLessThan(55);
  await expect(page.locator(".likelihood-value")).toHaveText("55%");
  await page.emulateMedia({ reducedMotion: "reduce" });
  session.update(view(0.65, "caution"));
  await expect(page.locator(".likelihood-value")).toHaveText("65%");
});
