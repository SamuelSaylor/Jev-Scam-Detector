import { defineConfig, devices } from "@playwright/test";

const apiPort = process.env.API_PORT ?? "8000";
const webPort = process.env.WEB_PORT ?? "5173";

export default defineConfig({
  testDir: "./tests",
  timeout: 90000,
  expect: { timeout: 20000 },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${webPort}`,
    permissions: ["microphone"],
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: `uv run uvicorn jev_scam_detector.app:app --host 127.0.0.1 --port ${apiPort}`,
      env: { FRONTEND_ORIGIN: `http://127.0.0.1:${webPort}` },
      cwd: "..",
      url: `http://127.0.0.1:${apiPort}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
    {
      command: `npm run dev -- --port ${webPort} --strictPort`,
      cwd: ".",
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
  ],
});
