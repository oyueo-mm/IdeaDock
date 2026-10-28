import type { KeyValueStore } from "../../src/lib/local-db";
import type { ImmutableRemote, RemoteFile } from "../../src/lib/drive";
export class MemoryDb implements KeyValueStore {
  rows = new Map<string, unknown>();
  async get<T>(key: string) {
    return structuredClone(this.rows.get(key)) as T | undefined;
  }
  async set<T>(key: string, value: T) {
    this.rows.set(key, structuredClone(value));
  }
  async entries<T>(prefix: string) {
    return [...this.rows].filter(([key]) => key.startsWith(prefix)) as [
      string,
      T,
    ][];
  }
}
export class MemoryRemote implements ImmutableRemote {
  files = new Map<string, RemoteFile & { blob: Blob }>();
  creates = 0;
  failAt = 0;
  lostReply = false;
  async list(kind: string) {
    return [...this.files.values()].filter(
      (f) => f.appProperties.kind === kind,
    );
  }
  async allocate() {
    return crypto.randomUUID();
  }
  async read(id: string) {
    const f = this.files.get(id);
    if (!f) throw new Error("missing");
    return f.blob;
  }
  async create(id: string, key: string, kind: string, blob: Blob) {
    this.creates++;
    if (this.creates === this.failAt) throw new Error("offline");
    if (this.files.has(id))
      throw Object.assign(new Error("exists"), { status: 409 });
    this.files.set(id, { id, appProperties: { key, kind }, blob });
    if (this.lostReply) {
      this.lostReply = false;
      throw new Error("response lost");
    }
  }
}
