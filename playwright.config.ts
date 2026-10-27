import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  use: {
    baseURL:
      process.env.IDEADOCK_E2E_DRIVE === "1"
        ? "http://127.0.0.1:4174/IdeaDock/"
        : "http://127.0.0.1:4173/IdeaDock/",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      process.env.IDEADOCK_E2E_DRIVE === "1"
        ? "npm run build && npm run start -- --port 4174"
        : "npm run start -- --port 4173",
    url:
      process.env.IDEADOCK_E2E_DRIVE === "1"
        ? "http://127.0.0.1:4174/IdeaDock/"
        : "http://127.0.0.1:4173/IdeaDock/",
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
