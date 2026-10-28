import { defineConfig, devices } from "@playwright/test";
// Benchmarks run against the mock-Drive static build (`npm run bench`).
const port = Number(process.env.IDEADOCK_BENCH_PORT || 4391);
const baseURL = `http://127.0.0.1:${port}/IdeaDock/`;
export default defineConfig({
  testDir: "./tests/perf",
  testMatch: "**/*.perf.ts",
  workers: 1,
  use: { baseURL, ...devices["Desktop Chrome"] },
  webServer: {
    command: `npm run start -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120000,
  },
});
