import { defineConfig, devices } from "@playwright/test";
const port = Number(
  process.env.IDEADOCK_E2E_PORT ||
    (process.env.IDEADOCK_E2E_DRIVE === "1" ? "4174" : "4173"),
);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid IdeaDock E2E port");
const baseURL = `http://127.0.0.1:${port}/IdeaDock/`;
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      process.env.IDEADOCK_E2E_DRIVE === "1"
        ? `npm run build && npm run start -- --port ${port}`
        : `npm run start -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    env:
      process.env.IDEADOCK_E2E_DRIVE === "1"
        ? {
            NEXT_PUBLIC_GOOGLE_CLIENT_ID: "test-client-not-a-real-credential",
            NEXT_PUBLIC_STORAGE_BACKEND: "drive",
            NEXT_PUBLIC_GOOGLE_DRIVE_SPACE: "drive",
            NEXT_PUBLIC_SUPABASE_URL: "",
            NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
          }
        : {},
    timeout: 120000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
});
