import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "typescript/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:18765",
    viewport: { width: 1440, height: 1000 },
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `node dist/cli.js --port 18765 --enable-hid --hid-backend simulated --data-dir work/e2e-data-${Date.now()}`,
    url: "http://127.0.0.1:18765/api/status",
    reuseExistingServer: false,
    timeout: 15000,
  },
  reporter: [
    ["list"],
    ["html", { outputFolder: "work/playwright-report", open: "never" }],
  ],
  outputDir: "work/playwright-results",
});
