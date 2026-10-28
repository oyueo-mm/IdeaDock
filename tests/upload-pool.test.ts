import { describe, expect, it } from "vitest";
import {
  isRateLimit,
  isTransient,
  runPool,
  WRITE_CONCURRENCY,
} from "../src/lib/upload-pool";

const tick = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms));
const status = (code: number, reason?: string) =>
  Object.assign(new Error(`status ${code}`), { status: code, reason });
const instant = { sleep: async () => {}, random: () => 0 };

describe("error classes", () => {
  it("tells rate limits and server trouble from permanent failures", () => {
    expect(isRateLimit(status(429))).toBe(true);
    expect(isRateLimit(status(403, "userRateLimitExceeded"))).toBe(true);
    expect(isRateLimit(status(403, "forbidden"))).toBe(false);
    expect(isRateLimit(status(403))).toBe(false);
    expect(isTransient(status(503))).toBe(true);
    expect(isTransient(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransient(status(400))).toBe(false);
    expect(isTransient(status(404))).toBe(false);
    expect(isTransient(new Error("checksum"))).toBe(false);
  });
});

describe("runPool", () => {
  it("keeps results in order and never exceeds the concurrency", async () => {
    let active = 0,
      peak = 0;
    const out = await runPool(
      [6, 5, 4, 3, 2, 1, 0, 3],
      async (n) => {
        active++;
        peak = Math.max(peak, active);
        await tick(n);
        active--;
        return n * 10;
      },
      { concurrency: 3, ...instant },
    );
    expect(out).toEqual([60, 50, 40, 30, 20, 10, 0, 30]);
    expect(peak).toBe(3);
    expect(WRITE_CONCURRENCY).toBeLessThanOrEqual(4); // Drive throttles write bursts
  });

  it("retries transient failures with doubling, jittered back-off", async () => {
    const waits: number[] = [];
    let calls = 0;
    const out = await runPool(
      ["a"],
      async (_, __, attempt) => {
        calls++;
        if (attempt < 3) throw status(503);
        return "stored";
      },
      {
        baseDelay: 100,
        random: () => 0.5,
        sleep: async (ms) => void waits.push(ms),
      },
    );
    expect(out).toEqual(["stored"]);
    expect(calls).toBe(4);
    expect(waits).toEqual([150, 250, 450]); // 100·2^n + 0.5·100
  });

  it("gives up after the allowed attempts and reports the error", async () => {
    let calls = 0;
    await expect(
      runPool(
        ["a"],
        async () => {
          calls++;
          throw status(500);
        },
        { attempts: 3, ...instant },
      ),
    ).rejects.toMatchObject({ status: 500 });
    expect(calls).toBe(3);
  });

  it("does not retry a permanent failure", async () => {
    let calls = 0;
    await expect(
      runPool(
        ["a"],
        async () => {
          calls++;
          throw status(400);
        },
        instant,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toBe(1);
  });

  it("a rate limit halves the concurrency, which then grows back", async () => {
    let active = 0;
    const seen: number[] = [];
    let limited = false;
    const out = await runPool(
      Array.from({ length: 40 }, (_, i) => i),
      async (n) => {
        active++;
        seen.push(active);
        try {
          await tick();
          if (n === 4 && !limited) {
            limited = true;
            throw status(429);
          }
          return n;
        } finally {
          active--;
        }
      },
      { concurrency: 4, ...instant },
    );
    expect(out).toEqual(Array.from({ length: 40 }, (_, i) => i));
    const afterLimit = seen.slice(seen.length - 20);
    expect(Math.max(...seen)).toBe(4);
    // while throttled fewer run at once; eight successes later it recovers
    expect(Math.min(...seen.slice(8, 30))).toBeLessThanOrEqual(2);
    expect(afterLimit.some((n) => n >= 3)).toBe(true);
  });

  it("survives a burst of rate limits that only lets one request through", async () => {
    let active = 0;
    const attempts = new Map<number, number>();
    const out = await runPool(
      Array.from({ length: 12 }, (_, i) => i),
      async (n) => {
        attempts.set(n, (attempts.get(n) ?? 0) + 1);
        active++;
        try {
          await tick();
          if (active > 1) throw status(429); // Drive accepts one at a time
          return n;
        } finally {
          active--;
        }
      },
      { concurrency: 4, attempts: 12, ...instant },
    );
    expect(out).toHaveLength(12);
    expect([...attempts.values()].every((count) => count <= 12)).toBe(true);
  });

  it("stops starting work after a permanent failure but lets running tasks finish", async () => {
    const started: number[] = [];
    const finished: number[] = [];
    await expect(
      runPool(
        Array.from({ length: 10 }, (_, i) => i),
        async (n) => {
          started.push(n);
          await tick(n === 1 ? 1 : 15);
          if (n === 1) throw status(400);
          finished.push(n);
          return n;
        },
        { concurrency: 3, ...instant },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(started.length).toBeLessThan(10);
    expect(finished).toEqual(expect.arrayContaining([0, 2])); // none abandoned
  });

  it("handles no work", async () => {
    expect(await runPool([], async () => 1)).toEqual([]);
  });
});
