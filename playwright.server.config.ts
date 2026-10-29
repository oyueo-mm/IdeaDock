import { defineConfig, devices } from "@playwright/test";
// Server sign-in mode against the local mock Cloudflare deployment. One
// worker: the tests share the mock server's clock.
const port = Number(process.env.IDEADOCK_E2E_SERVER_PORT || "4186");
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid IdeaDock server E2E port");
process.env.IDEADOCK_E2E_SERVER = "1";
process.env.IDEADOCK_E2E_SERVER_PORT = String(port);
const baseURL = `http://localhost:${port}/IdeaDock/`;
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /server-auth\.spec\.ts$/,
  workers: 1,
  use: { baseURL, trace: "retain-on-failure" },
  webServer: {
    command: `node scripts/build-cloudflare.mjs && node scripts/serve-cloudflare-mock.mjs --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 240_000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
});
