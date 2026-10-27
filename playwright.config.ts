import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  use: {
    baseURL:
      process.env.IDEADOCK_E2E_DRIVE === "1"
        ? "http://127.0.0.1:3001"
        : "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${process.env.IDEADOCK_E2E_DRIVE === "1" ? "3001" : "3000"}`,
    url:
      process.env.IDEADOCK_E2E_DRIVE === "1"
        ? "http://127.0.0.1:3001"
        : "http://127.0.0.1:3000",
    reuseExistingServer:
      !process.env.CI && process.env.IDEADOCK_E2E_DRIVE !== "1",
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
