/** Errors from Drive carry the HTTP status and, for 403, the error reason. */
type DriveError = { status?: number; reason?: string };
const RATE_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
]);
export function isRateLimit(error: unknown) {
  const e = error as DriveError;
  return (
    e?.status === 429 ||
    (e?.status === 403 && !!e.reason && RATE_REASONS.has(e.reason))
  );
}
/** Worth trying again later: rate limits, server errors and dropped connections. */
export function isTransient(error: unknown) {
  const e = error as DriveError;
  return (
    isRateLimit(error) ||
    (typeof e?.status === "number" && e.status >= 500) ||
    error instanceof TypeError // fetch() rejects with TypeError when the network drops
  );
}

export type PoolOptions = {
  /** Most tasks in flight at once. Drive throttles bursts of writes. */
  concurrency?: number;
  /** Tries per task, the first included. */
  attempts?: number;
  /** First back-off in ms; it doubles for every retry. */
  baseDelay?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};
export const WRITE_CONCURRENCY = 3;

/**
 * Runs tasks with a bounded number in flight and retries transient failures
 * with exponential back-off and jitter. Every attempt, retries included, takes
 * one of the allowed slots, so a retry never adds to a burst. A rate-limit
 * answer also halves the allowed concurrency; it grows back by one after eight
 * successes in a row. The first permanent failure stops new tasks from
 * starting; tasks already running finish, so no result that was produced is
 * lost.
 */
export async function runPool<T, R>(
  items: readonly T[],
  task: (item: T, index: number, attempt: number) => Promise<R>,
  options: PoolOptions = {},
): Promise<R[]> {
  const max = options.concurrency ?? WRITE_CONCURRENCY,
    attempts = options.attempts ?? 4,
    base = options.baseDelay ?? 500,
    sleep =
      options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))),
    random = options.random ?? Math.random;
  const results = new Array<R>(items.length);
  let limit = max,
    active = 0,
    next = 0,
    streak = 0;
  let failure: { error: unknown } | undefined;
  const waiting: (() => void)[] = [];
  async function acquire() {
    while (active >= limit)
      await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
  }
  function release() {
    active--;
    waiting.shift()?.();
  }
  async function run(index: number): Promise<R> {
    for (let attempt = 0; ; attempt++) {
      await acquire();
      try {
        const result = await task(items[index], index, attempt);
        if (++streak >= 8 && limit < max) {
          limit++;
          streak = 0;
          waiting.shift()?.();
        }
        return result;
      } catch (error) {
        // After a permanent failure elsewhere, stop trying again.
        if (failure || !isTransient(error) || attempt + 1 >= attempts)
          throw error;
        streak = 0;
        if (isRateLimit(error)) limit = Math.max(1, Math.floor(limit / 2));
      } finally {
        release();
      }
      await sleep(base * 2 ** attempt + random() * base);
    }
  }
  async function worker() {
    while (!failure && next < items.length) {
      const index = next++;
      try {
        results[index] = await run(index);
      } catch (error) {
        failure ??= { error };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(max, items.length) }, worker),
  );
  if (failure) throw failure.error;
  return results;
}
