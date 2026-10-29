import { canonical, digest } from "./integrity";
import type { ImmutableRemote, RemoteFile } from "./drive";
import type { KeyValueStore } from "./local-db";

export type Loaded<R> = { revision: R; hash: string };
type Options<R> = {
  remote: ImmutableRemote;
  db: KeyValueStore;
  kind: string;
  cacheKey: (hash: string) => string;
  /** Number of uploads of this kind so far; a changed value ends request sharing. */
  writes: () => number;
  /** Throws on a malformed or foreign document. Runs once per verified revision. */
  check: (value: unknown) => R;
  /** Error message when downloaded bytes do not match the file's content hash. */
  corrupt: string;
};
/** Drive allows far more, but a burst on a phone connection helps nobody. */
export const READ_CONCURRENCY = 6;

export async function mapLimit<T, U>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/**
 * Loads immutable, content-addressed revisions. A revision's file key IS its
 * SHA-256, so once its bytes (or its device-cache copy) have been verified
 * against that key the result cannot change. Later syncs therefore reuse the
 * verified object instead of re-reading, re-hashing and re-writing every
 * revision; only files not seen before are verified. A forced load discards all
 * of this and verifies every file from the remote again.
 */
export class RevisionLoader<R> {
  private verified = new Map<string, R>();
  private flight?: { writes: number; promise: Promise<Loaded<R>[]> };
  constructor(private readonly options: Options<R>) {}
  /** A revision this device just uploaded and read back successfully. */
  async remember(hash: string, revision: R) {
    await this.options.db.set(this.options.cacheKey(hash), revision);
    this.verified.set(hash, revision);
  }
  /**
   * Re-reads exactly these revisions from the remote and checks each against
   * its hash: a server-side verification of data this device just wrote that
   * does not download every other revision. Throws if one is missing.
   */
  async verifyRemote(hashes: string[]): Promise<Map<string, R>> {
    const files = new Map<string, RemoteFile>();
    for (const file of await this.options.remote.list(this.options.kind))
      if (!files.has(file.appProperties.key))
        files.set(file.appProperties.key, file);
    const verified = new Map<string, R>();
    await mapLimit([...new Set(hashes)], READ_CONCURRENCY, async (hash) => {
      const file = files.get(hash);
      if (!file)
        throw new Error(
          `서버에서 저장한 문서를 찾지 못했습니다: ${hash.slice(0, 12)}`,
        );
      const blob = await this.options.remote.read(file.id);
      if ((await digest(blob)) !== hash) throw new Error(this.options.corrupt);
      verified.set(hash, this.options.check(JSON.parse(await blob.text())));
    });
    return verified;
  }
  load(force = false): Promise<Loaded<R>[]> {
    if (force) return this.run(true);
    const writes = this.options.writes();
    // Concurrent syncs share one listing, but never one that started before an
    // upload: it could miss the new head and send the next edit a stale parent.
    if (this.flight && this.flight.writes === writes)
      return this.flight.promise;
    const promise = this.run(false).finally(() => {
      if (this.flight?.promise === promise) this.flight = undefined;
    });
    this.flight = { writes, promise };
    return promise;
  }
  private async run(force: boolean) {
    const unique = new Map<string, RemoteFile>();
    for (const file of await this.options.remote.list(this.options.kind))
      if (!unique.has(file.appProperties.key))
        unique.set(file.appProperties.key, file);
    return mapLimit([...unique.values()], READ_CONCURRENCY, (file) =>
      this.verify(file, force),
    );
  }
  private async verify(file: RemoteFile, force: boolean): Promise<Loaded<R>> {
    const hash = file.appProperties.key;
    const known = force ? undefined : this.verified.get(hash);
    if (known) return { revision: known, hash };
    const cacheKey = this.options.cacheKey(hash);
    const cached = force ? undefined : await this.options.db.get<R>(cacheKey);
    let revision: R;
    let fetched = false;
    if (cached && (await digest(canonical(cached))) === hash)
      revision = this.options.check(cached);
    else {
      const blob = await this.options.remote.read(file.id);
      if ((await digest(blob)) !== hash) throw new Error(this.options.corrupt);
      revision = this.options.check(JSON.parse(await blob.text()));
      fetched = true;
    }
    if (fetched || force) await this.options.db.set(cacheKey, revision);
    this.verified.set(hash, revision);
    return { revision, hash };
  }
}
