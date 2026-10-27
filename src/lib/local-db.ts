// Separate from legacy storage. Never clears or upgrades a legacy database.
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  entries<T>(prefix: string): Promise<[string, T][]>;
}
export const DB_NAME = "ideadock-drive-v1";
export class LocalDatabase implements KeyValueStore {
  private db?: Promise<IDBDatabase>;
  private open() {
    return (this.db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("kv");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error("다른 탭의 저장소 연결을 닫고 다시 시도하세요."));
    }));
  }
  async get<T>(key: string): Promise<T | undefined> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readonly");
      const request = tx.objectStore("kv").get(key);
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  }
  async set<T>(key: string, value: T) {
    const db = await this.open();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(tx.error ?? new Error("기기 저장 실패"));
    });
  }
  async entries<T>(prefix: string): Promise<[string, T][]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const rows: [string, T][] = [];
      const tx = db.transaction("kv", "readonly");
      const request = tx.objectStore("kv").openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (String(cursor.key).startsWith(prefix))
          rows.push([String(cursor.key), cursor.value]);
        cursor.continue();
      };
      tx.oncomplete = () => resolve(rows);
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  }
}
export const localDb = new LocalDatabase();
