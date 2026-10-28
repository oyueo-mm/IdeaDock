import { beforeEach, describe, expect, it, vi } from "vitest";
import { digest } from "../src/lib/integrity";

const state = vi.hoisted(() => ({
  cache: new Map<string, unknown>(),
  repo: null as unknown as {
    account: string;
    remote: {
      list: (kind: string, key?: string) => Promise<unknown[]>;
      read: (id: string) => Promise<Blob>;
    };
  },
}));
vi.mock("../src/lib/drive", () => ({
  activeDriveRepository: () => state.repo,
}));
vi.mock("../src/lib/local-db", () => ({
  localDb: {
    get: async (key: string) => state.cache.get(key),
    set: async (key: string, value: unknown) => {
      state.cache.set(key, value);
    },
  },
}));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
import { readImage } from "../src/lib/images";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const png = (tag: string) =>
  new Blob([Uint8Array.from([137, 80, 78, 71, ...Buffer.from(tag)])], {
    type: "image/png",
  });
async function picture(tag: string) {
  const blob = png(tag);
  return {
    blob,
    hash: await digest(blob),
    path: `drive-sha:${await digest(blob)}`,
  };
}
const lists: { kind: string; key?: string }[] = [];
let reads = 0,
  active = 0,
  peak = 0,
  latency = 0,
  failures = 0;
const files = new Map<string, Blob>();
beforeEach(() => {
  state.cache.clear();
  files.clear();
  lists.length = 0;
  reads = active = peak = latency = failures = 0;
  state.repo = {
    account: "alice",
    remote: {
      list: async (kind, key) => {
        lists.push({ kind, key });
        return key && files.has(key)
          ? [{ id: key, appProperties: { key, kind } }]
          : [];
      },
      read: async (id) => {
        reads++;
        active++;
        peak = Math.max(peak, active);
        await delay(latency);
        active--;
        if (failures-- > 0) throw new Error("network");
        return files.get(id)!;
      },
    },
  };
});

describe("readImage", () => {
  it("shares one download between simultaneous requests for a picture", async () => {
    const p = await picture("shared");
    files.set(p.hash, p.blob);
    latency = 10;
    const blobs = await Promise.all(
      Array.from({ length: 10 }, () => readImage(p.path)),
    );
    expect(reads).toBe(1);
    expect(new Set(blobs).size).toBe(1);
    expect(lists).toEqual([{ kind: "image", key: p.hash }]); // not every image
  });

  it("reads from the device afterwards, still verifying the checksum", async () => {
    const p = await picture("cached");
    files.set(p.hash, p.blob);
    await readImage(p.path);
    expect(reads).toBe(1);
    await readImage(p.path);
    expect(reads).toBe(1);
    state.cache.set(`alice:image:${p.hash}`, png("damaged"));
    const again = await readImage(p.path);
    expect(reads).toBe(2); // the damaged copy is not trusted
    expect(await digest(again)).toBe(p.hash);
  });

  it("forgets a failure so the next attempt downloads again", async () => {
    const p = await picture("flaky");
    files.set(p.hash, p.blob);
    failures = 1;
    await expect(readImage(p.path)).rejects.toThrow("network");
    expect(await digest(await readImage(p.path))).toBe(p.hash);
    expect(reads).toBe(2);
  });

  it("refuses a download whose checksum does not match", async () => {
    const p = await picture("forged");
    files.set(p.hash, png("something else"));
    await expect(readImage(p.path)).rejects.toThrow("체크섬");
    expect(state.cache.size).toBe(0);
  });

  it("limits how many pictures download at once", async () => {
    latency = 10;
    const all = await Promise.all(
      Array.from({ length: 12 }, (_, i) => picture(`many-${i}`)),
    );
    for (const p of all) files.set(p.hash, p.blob);
    await Promise.all(all.map((p) => readImage(p.path)));
    expect(reads).toBe(12);
    expect(peak).toBe(4);
  });
});
