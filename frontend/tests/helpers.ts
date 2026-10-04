import { expect, type Page } from "@playwright/test";

// Contract demo sessions are used only by tests; production creates live rooms.
export async function createDemo(page: Page) {
  const response = await page.request.post("/api/sessions", {
    data: { mode: "demo" },
  });
  expect(response.ok()).toBe(true);
  const member: unknown = await response.json();
  await page.route(
    "**/api/sessions",
    (route) => route.fulfill({ json: member }),
    { times: 1 },
  );
  await page.getByRole("button", { name: "Create room" }).click();
  await expect(
    page.getByRole("button", { name: "Connect microphone" }),
  ).toBeEnabled();
  return (
    (await page.getByLabel("Room ID", { exact: true }).textContent()) ?? ""
  );
}

export async function endCall(page: Page) {
  await page.getByRole("button", { name: "End call for everyone" }).click();
  await page.getByRole("button", { name: "Confirm end call" }).click();
  await expect(
    page.getByRole("button", { name: "Back to rooms" }),
  ).toBeEnabled();
}
