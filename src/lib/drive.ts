import { KeyValueStore, localDb } from "./local-db";
import { canonical, digest, validateIdeas } from "./integrity";
import type { Idea } from "./model";
import { mapLimit, READ_CONCURRENCY, RevisionLoader } from "./revision-loader";
import { runPool, type PoolOptions } from "./upload-pool";

export type GoogleUser = {
  id: string;
  email: string;
  user_metadata: { full_name: string };
};
type TokenReply = {
  access_token: string;
  expires_in: number;
  error?: string;
  scope: string;
};
type GoogleIdentity = {
  accounts: {
    oauth2: {
      initTokenClient(options: {
        client_id: string;
        scope: string;
        callback: (response: TokenReply) => void;
        error_callback: (error: { type: string }) => void;
        login_hint?: string;
      }): { requestAccessToken(options: { prompt: string }): void };
    };
  };
};
declare global {
  interface Window {
    google?: GoogleIdentity;
  }
}
export const driveConfigured = !!process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
export const driveSpace =
  process.env.NEXT_PUBLIC_GOOGLE_DRIVE_SPACE === "appDataFolder"
    ? "appDataFolder"
    : "drive";
export const driveScope = `https://www.googleapis.com/auth/${driveSpace === "drive" ? "drive.file" : "drive.appdata"}`;
export const driveCacheKey = (account: string) =>
  driveSpace === "appDataFolder"
    ? `${account}:cache`
    : `${account}:cache:drive.file`;
type Session = { token: string; expires: number; user: GoogleUser };
// Auth persistence (security review in docs/AUTH.md):
// - accountKey (localStorage) keeps only the non-secret identity of the last
//   workspace, so cached drafts can open offline and reconnects skip the
//   account chooser. Explicit sign-out removes it.
// - sessionKey (sessionStorage) keeps the short-lived access token so a reload
//   in the same tab stays connected. It is per tab, never outlives Google's
//   expires_in (<= 1 hour), and is dropped on sign-out, 401 or account mismatch.
const accountKey = "ideadock:drive-account";
const sessionKey = "ideadock:drive-session";
let session: Session | undefined;
let restored = false;
let loading: Promise<void> | undefined;
let expiry: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
export class DriveAuthError extends Error {
  constructor() {
    super(
      "Google Drive 연결이 필요합니다. 다시 연결하면 기기에 보관된 변경 내용을 저장합니다.",
    );
  }
}
function isUser(value: unknown): value is GoogleUser {
  const user = value as GoogleUser | null;
  return (
    typeof user?.id === "string" &&
    user.id.startsWith("google:") &&
    typeof user.email === "string" &&
    typeof user.user_metadata?.full_name === "string"
  );
}
function storage(kind: "localStorage" | "sessionStorage") {
  try {
    return typeof window === "undefined" ? undefined : window[kind];
  } catch {
    return undefined;
  }
}
function read(kind: "localStorage" | "sessionStorage", key: string) {
  try {
    return JSON.parse(storage(kind)?.getItem(key) || "null") as unknown;
  } catch {
    return null;
  }
}
export function rememberedDriveUser(): GoogleUser | null {
  const value = read("localStorage", accountKey);
  return isUser(value) ? value : null;
}
export function rememberDriveUser(user: GoogleUser) {
  const { id, email, user_metadata } = user;
  try {
    storage("localStorage")?.setItem(
      accountKey,
      JSON.stringify({ id, email, user_metadata }),
    );
  } catch {
    // Without storage the workspace simply asks to sign in after a reload.
  }
}
// quiet: called from a render-time snapshot, where listeners must not fire.
function setSession(next: Session | undefined, quiet = false) {
  session = next;
  if (expiry) clearTimeout(expiry);
  expiry = undefined;
  try {
    if (next)
      storage("sessionStorage")?.setItem(sessionKey, JSON.stringify(next));
    else storage("sessionStorage")?.removeItem(sessionKey);
  } catch {
    // The in-memory session still works for this page.
  }
  if (next)
    expiry = setTimeout(
      () => setSession(undefined),
      Math.min(next.expires - Date.now(), 2 ** 31 - 1),
    );
  if (!quiet) listeners.forEach((listener) => listener());
}
function current() {
  if (!restored && typeof window !== "undefined") {
    restored = true;
    const saved = read("sessionStorage", sessionKey) as Session | null;
    if (
      saved &&
      typeof saved.token === "string" &&
      typeof saved.expires === "number" &&
      saved.expires > Date.now() &&
      isUser(saved.user) &&
      saved.user.id === rememberedDriveUser()?.id
    )
      setSession(saved, true);
    else if (saved) setSession(undefined, true);
  }
  if (session && session.expires <= Date.now()) setSession(undefined, true);
  return session;
}
/** Account id of the usable access token, or null when a reconnect is needed. */
export function driveSessionAccount() {
  return current()?.user.id ?? null;
}
export function subscribeDriveSession(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
export function loadGoogle() {
  return (loading ??= new Promise<void>((resolve, reject) => {
    if (window.google) return resolve();
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loading = undefined;
      reject(new Error("Google 로그인 스크립트를 불러오지 못했습니다."));
    };
    document.head.appendChild(script);
  }));
}
/**
 * Must run from a user gesture: Google's token model opens a popup and has no
 * refresh token. With a hint, a returning user who already consented gets a
 * token without the account chooser; without one, the chooser is shown.
 */
export async function connectDrive(
  options: { hint?: GoogleUser } = {},
): Promise<GoogleUser> {
  if (!driveConfigured)
    throw new Error("Google OAuth 클라이언트 ID 설정이 필요합니다.");
  await loadGoogle();
  const hint = options.hint?.id.slice("google:".length);
  const reply = await new Promise<TokenReply>((resolve, reject) => {
    window
      .google!.accounts.oauth2.initTokenClient({
        client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID!,
        scope: `openid email profile ${driveScope}`,
        callback: (r) => (r.error ? reject(new Error(r.error)) : resolve(r)),
        error_callback: (e) => reject(new Error(`Google 로그인: ${e.type}`)),
        ...(hint ? { login_hint: hint } : {}),
      })
      .requestAccessToken({ prompt: hint ? "" : "select_account" });
  });
  if (!reply.scope.split(" ").includes(driveScope))
    throw new Error("Drive 저장 권한에 동의해야 연결할 수 있습니다.");
  const response = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { Authorization: `Bearer ${reply.access_token}` } },
  );
  if (!response.ok) throw new Error("Google 계정 확인에 실패했습니다.");
  const profile = (await response.json()) as {
    sub: string;
    email: string;
    name: string;
  };
  if (!profile.sub) throw new Error("Google 계정 식별자가 없습니다.");
  const user = {
    id: `google:${profile.sub}`,
    email: profile.email,
    user_metadata: { full_name: profile.name },
  };
  setSession({
    token: reply.access_token,
    expires: Date.now() + Math.min(reply.expires_in, 3600) * 1000 - 30000,
    user,
  });
  return user;
}
/** Drops the access token. The remembered workspace stays for a reconnect. */
export function disconnectDrive() {
  restored = true;
  setSession(undefined);
}
/** Sign-out: forget the token and the remembered workspace on this device. */
export function forgetDriveUser() {
  shared = undefined;
  disconnectDrive();
  try {
    storage("localStorage")?.removeItem(accountKey);
  } catch {
    // Nothing to forget.
  }
}
export function driveAccount() {
  return current()?.user.id;
}
export type RemoteFile = {
  id: string;
  appProperties: { key: string; kind: string };
};
export interface ImmutableRemote {
  readonly storageNamespace?: string;
  /** `key` narrows the listing to one content hash; filtering again is harmless. */
  list(kind: string, key?: string): Promise<RemoteFile[]>;
  /** Many ids in one request, when the remote supports it. */
  allocateMany?(count: number): Promise<string[]>;
  /** Requests sent so far and the time they took, when the remote counts them. */
  stats?(): { requests: number; ms: number };
  allocate(): Promise<string>;
  read(id: string): Promise<Blob>;
  create(id: string, key: string, kind: string, blob: Blob): Promise<void>;
}
// The account is captured on construction. A late response cannot cross accounts.
export class GoogleDrive implements ImmutableRemote {
  readonly storageNamespace = driveSpace;
  private folderPromise?: Promise<string>;
  private tally = { requests: 0, ms: 0 };
  constructor(readonly account: string) {}
  stats() {
    return { ...this.tally };
  }
  private async request(path: string, init: RequestInit = {}, upload = false) {
    const active = current();
    if (!active || active.user.id !== this.account) throw new DriveAuthError();
    const url = `https://www.googleapis.com/${upload ? "upload/" : ""}drive/v3/${path}`;
    const send = async () => {
      const started = performance.now();
      try {
        return await fetch(url, {
          ...init,
          headers: { ...init.headers, Authorization: `Bearer ${active.token}` },
        });
      } finally {
        this.tally.requests++;
        this.tally.ms += performance.now() - started;
      }
    };
    let response = await send();
    // Reads are idempotent: ride out Drive's rate limiting and brief outages.
    for (
      let attempt = 0;
      attempt < 2 &&
      (init.method ?? "GET") === "GET" &&
      (response.status === 429 || response.status === 503);
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
      response = await send();
    }
    if (response.status === 401) {
      // Revoked or expired early: forget the token, keep the local drafts.
      if (session === active) setSession(undefined);
      throw new DriveAuthError();
    }
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      const reason = detail?.error?.errors?.[0]?.reason;
      const safeReason =
        typeof reason === "string" && /^[a-zA-Z_]+$/.test(reason)
          ? ` · ${reason}`
          : "";
      const error = new Error(
        `Drive 요청 실패 (${response.status}${safeReason}). 연결과 저장 공간을 확인하고 재시도하세요.`,
      );
      Object.assign(error, {
        status: response.status,
        reason: typeof reason === "string" ? reason : undefined,
      });
      throw error;
    }
    return response;
  }
  // The set of IdeaDock root folders only changes when a device first uses an
  // empty Drive, so it is re-queried at most every 30 s instead of per listing.
  private roots?: { at: number; rows: { id: string }[] };
  private async folders(): Promise<{ id: string }[]> {
    if (this.roots && Date.now() - this.roots.at < 30000)
      return this.roots.rows;
    const rows = await this.queryFolders();
    this.roots = { at: Date.now(), rows };
    return rows;
  }
  private async queryFolders(): Promise<{ id: string }[]> {
    const rows: { id: string }[] = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        spaces: "drive",
        q: "trashed = false and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='ideadockRoot' and value='v1' }",
        fields: "nextPageToken,files(id)",
        pageSize: "1000",
        ...(pageToken ? { pageToken } : {}),
      });
      const result = await (await this.request(`files?${params}`)).json();
      rows.push(...result.files);
      pageToken = result.nextPageToken || "";
    } while (pageToken);
    return rows.sort((a, b) => a.id.localeCompare(b.id));
  }
  async ensureFolder(): Promise<string> {
    if (driveSpace === "appDataFolder") return "appDataFolder";
    if (this.folderPromise) return this.folderPromise;
    this.folderPromise = this.createFolder().catch((error) => {
      this.folderPromise = undefined;
      throw error;
    });
    return this.folderPromise;
  }
  private async createFolder() {
    const existing = await this.queryFolders();
    if (existing.length) return existing[0].id;
    this.roots = undefined; // the root created below must be seen by the next listing
    const key = `${this.account}:drive.file:root`;
    let id = await localDb.get<string>(key);
    if (!id) {
      id = await this.allocate();
      await localDb.set(key, id);
    }
    try {
      await this.request("files?fields=id", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          name: "IdeaDock",
          mimeType: "application/vnd.google-apps.folder",
          appProperties: { ideadockRoot: "v1" },
        }),
      });
    } catch (error) {
      if ((error as { status?: number }).status !== 409) throw error;
      const metadata = await (
        await this.request(
          `files/${encodeURIComponent(id)}?fields=id,mimeType,appProperties,trashed`,
        )
      ).json();
      if (
        metadata.trashed ||
        metadata.mimeType !== "application/vnd.google-apps.folder" ||
        metadata.appProperties?.ideadockRoot !== "v1"
      )
        throw new Error(
          "기존 IdeaDock 폴더를 확인하지 못했습니다. 원본은 변경하지 않았습니다.",
        );
    }
    return id;
  }
  async list(kind: string, key?: string) {
    if (key !== undefined && !/^[a-f0-9]{64}$/.test(key))
      throw new Error("잘못된 Drive 파일 키입니다.");
    const keyQuery = key
      ? ` and appProperties has { key='key' and value='${key}' }`
      : "";
    const rows: RemoteFile[] = [];
    const folders = driveSpace === "drive" ? await this.folders() : [];
    if (driveSpace === "drive" && !folders.length) return rows;
    if (folders.some((f) => !/^[a-zA-Z0-9_-]+$/.test(f.id)))
      throw new Error("잘못된 Drive 폴더 식별자입니다.");
    const parentQuery = folders.length
      ? ` and (${folders.map((f) => `'${f.id}' in parents`).join(" or ")})`
      : "";
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        spaces: driveSpace,
        q: `trashed = false and appProperties has { key='kind' and value='${kind}' }${keyQuery}${parentQuery}`,
        fields: "nextPageToken,files(id,appProperties)",
        pageSize: "1000",
        ...(pageToken ? { pageToken } : {}),
      });
      const result = await (await this.request(`files?${params}`)).json();
      rows.push(...result.files);
      pageToken = result.nextPageToken || "";
    } while (pageToken);
    return rows;
  }
  async allocate() {
    const result = await (
      await this.request(
        `files/generateIds?count=1&space=${driveSpace}&type=files`,
      )
    ).json();
    return result.ids[0] as string;
  }
  /** Drive hands out up to 1000 ids per request. */
  async allocateMany(count: number) {
    const ids: string[] = [];
    while (ids.length < count) {
      const batch = Math.min(1000, count - ids.length);
      const result = await (
        await this.request(
          `files/generateIds?count=${batch}&space=${driveSpace}&type=files`,
        )
      ).json();
      if (!Array.isArray(result.ids) || result.ids.length !== batch)
        throw new Error("Drive가 파일 ID를 모두 발급하지 않았습니다.");
      ids.push(...result.ids);
    }
    return ids;
  }
  async read(id: string) {
    return (
      await this.request(`files/${encodeURIComponent(id)}?alt=media`)
    ).blob();
  }
  async create(id: string, key: string, kind: string, blob: Blob) {
    const parent = await this.ensureFolder();
    const start = await this.request(
      "files?uploadType=resumable&fields=id",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Upload-Content-Type": blob.type || "application/octet-stream",
          "X-Upload-Content-Length": String(blob.size),
        },
        body: JSON.stringify({
          id,
          name: `ideadock-${kind}-${key}`,
          parents: [parent],
          appProperties: { key, kind },
          mimeType: blob.type || "application/octet-stream",
        }),
      },
      true,
    );
    const location = start.headers.get("Location");
    if (!location) throw new Error("Drive 업로드 세션 주소가 없습니다.");
    const url = new URL(location);
    if (
      url.origin !== "https://www.googleapis.com" ||
      !url.pathname.startsWith("/upload/drive/v3/")
    )
      throw new Error("잘못된 Drive 업로드 주소입니다.");
    await this.request(
      `${url.pathname.slice("/upload/drive/v3/".length)}${url.search}`,
      {
        method: "PUT",
        body: blob,
        headers: { "Content-Type": blob.type || "application/octet-stream" },
      },
      true,
    );
  }
}
export type Revision = {
  schema: 1;
  parent: string | null;
  merged?: string[];
  idea: Idea;
};
export type DriveRow = { idea: Idea; head: string; conflicts: Revision[] };
export class DriveRepository {
  private uploads = new Map<string, number>();
  private snapshot?: { key: string; rows: DriveRow[] };
  private readonly loader: RevisionLoader<Revision>;
  constructor(
    readonly account: string,
    readonly remote: ImmutableRemote,
    readonly db: KeyValueStore = localDb,
  ) {
    this.loader = new RevisionLoader<Revision>({
      remote,
      db,
      kind: "revision",
      cacheKey: (hash) => this.revisionCacheKey(hash),
      writes: () => this.uploadCount("revision"),
      corrupt: "Drive 문서 무결성 검사에 실패했습니다.",
      check: (value) => this.checkRevision(value),
    });
  }
  /** Uploads completed so far for a kind; loaders use it to end shared listings. */
  uploadCount(kind: string) {
    return this.uploads.get(kind) ?? 0;
  }
  async put(kind: string, blob: Blob) {
    const hash = await digest(blob);
    const key = `${this.account}:upload:${this.remote.storageNamespace ? `${this.remote.storageNamespace}:` : ""}${kind}:${hash}`;
    // Search the server as well: a different device may already have uploaded it.
    const existing = (await this.remote.list(kind, hash))
      .filter((f) => f.appProperties.key === hash)
      .sort((a, b) => a.id.localeCompare(b.id));
    let id = existing[0]?.id ?? (await this.db.get<string>(key));
    if (!id) {
      id = await this.remote.allocate();
      await this.db.set(key, id); // Allocate and persist BEFORE sending bytes.
    }
    if (!existing.length) {
      try {
        await this.remote.create(id, hash, kind, blob);
      } catch (error) {
        // Only an ID conflict can be a successful retry after a lost response.
        if ((error as { status?: number }).status !== 409) throw error;
      }
    }
    if ((await digest(await this.remote.read(id))) !== hash)
      throw new Error("Drive 파일의 체크섬이 일치하지 않습니다.");
    this.uploads.set(kind, this.uploadCount(kind) + 1);
    return { id, hash };
  }
  private revisionCacheKey(hash: string) {
    return `${this.account}:revision:${this.remote.storageNamespace ?? "default"}:${hash}`;
  }
  /**
   * Stores many immutable files with one listing and one id request instead of
   * a lookup and an id request per file. Everything stays idempotent:
   * a file is named by its content hash, its Drive id is allocated and saved on
   * this device BEFORE any bytes are sent, an upload that may have reached Drive
   * is looked up by hash before it is repeated, and every file is read back and
   * its checksum compared. Failures that are likely to pass (rate limits, 5xx,
   * dropped connections) are retried with back-off. `onDone` runs as each
   * distinct file is stored.
   *
   * `readBack: false` leaves that comparison to the caller, which must verify
   * the files afterwards (`verifyRevisions`, `verifyImages`) before it reports
   * success. A file that was already on Drive is always read back and compared.
   */
  async putMany(
    kind: string,
    blobs: Blob[],
    options: {
      onDone?: (hash: string) => void | Promise<void>;
      pool?: PoolOptions;
      readBack?: boolean;
    } = {},
  ) {
    const hashes = await Promise.all(blobs.map((blob) => digest(blob)));
    const unique = new Map<string, Blob>();
    hashes.forEach((hash, i) => unique.has(hash) || unique.set(hash, blobs[i]));
    const found = new Map<string, string>();
    for (const file of [...(await this.remote.list(kind))].sort((a, b) =>
      a.id.localeCompare(b.id),
    ))
      if (!found.has(file.appProperties.key))
        found.set(file.appProperties.key, file.id);
    const space = this.remote.storageNamespace
      ? `${this.remote.storageNamespace}:`
      : "";
    const slot = (hash: string) =>
      `${this.account}:upload:${space}${kind}:${hash}`;
    const ids = new Map<string, string>();
    const unallocated: string[] = [];
    for (const hash of unique.keys()) {
      if (found.has(hash)) continue;
      const known = await this.db.get<string>(slot(hash));
      if (known) ids.set(hash, known);
      else unallocated.push(hash);
    }
    if (unallocated.length) {
      const fresh = this.remote.allocateMany
        ? await this.remote.allocateMany(unallocated.length)
        : await mapLimit(unallocated, 1, () => this.remote.allocate());
      for (const [i, hash] of unallocated.entries()) {
        ids.set(hash, fresh[i]);
        await this.db.set(slot(hash), fresh[i]); // persist BEFORE sending bytes
      }
    }
    await runPool(
      [...unique.keys()],
      async (hash, _index, attempt) => {
        let id = found.get(hash);
        let created = false;
        if (!id && attempt > 0) {
          // The earlier try may have reached Drive although its reply was lost.
          id = (await this.remote.list(kind, hash))
            .filter((f) => f.appProperties.key === hash)
            .sort((a, b) => a.id.localeCompare(b.id))[0]?.id;
        }
        if (!id) {
          id = ids.get(hash)!;
          try {
            await this.remote.create(id, hash, kind, unique.get(hash)!);
            created = true;
          } catch (error) {
            // Only an ID conflict can be a successful retry after a lost response.
            if ((error as { status?: number }).status !== 409) throw error;
          }
        }
        if (
          (!created || options.readBack !== false) &&
          (await digest(await this.remote.read(id))) !== hash
        )
          throw new Error("Drive 파일의 체크섬이 일치하지 않습니다.");
        this.uploads.set(kind, this.uploadCount(kind) + 1);
        await options.onDone?.(hash);
      },
      options.pool,
    );
    return hashes;
  }
  /** Appends new revisions of many ideas in one batch; see putMany. */
  async appendMany(
    items: { idea: Idea; parent: string | null }[],
    options: {
      onDone?: (index: number, hash: string) => void | Promise<void>;
      pool?: PoolOptions;
      readBack?: boolean;
    } = {},
  ) {
    const revisions = items.map(({ idea, parent }): Revision => {
      validateIdeas([idea]);
      if (idea.user_id !== this.account)
        throw new Error("다른 계정의 데이터입니다.");
      return { schema: 1, parent, idea };
    });
    const blobs = revisions.map(
      (r) => new Blob([canonical(r)], { type: "application/json" }),
    );
    const done = new Map<string, number[]>();
    const hashes = await Promise.all(blobs.map((blob) => digest(blob)));
    hashes.forEach((hash, i) => done.set(hash, [...(done.get(hash) ?? []), i]));
    await this.putMany("revision", blobs, {
      pool: options.pool,
      readBack: options.readBack,
      onDone: async (hash) => {
        const first = done.get(hash)![0];
        await this.loader.remember(hash, revisions[first]);
        for (const i of done.get(hash)!) await options.onDone?.(i, hash);
      },
    });
    return hashes;
  }
  /**
   * `save` for many ideas: one listing for the version check, then one batch.
   * An idea whose intended revision already exists is reported, not rewritten.
   */
  async saveMany(
    items: { idea: Idea; parent: string | null }[],
    options: {
      onDone?: (index: number) => void | Promise<void>;
      pool?: PoolOptions;
      readBack?: boolean;
    } = {},
  ) {
    const rows = await this.list();
    const saved = items.map(({ idea }) => ({
      ...idea,
      version: idea.version + 1,
    }));
    const todo: { idea: Idea; parent: string | null; index: number }[] = [];
    const heads = new Array<string>(items.length);
    for (const [index, { idea, parent }] of items.entries()) {
      const current = rows.find((r) => r.idea.id === idea.id);
      const intended = await digest(
        canonical({ schema: 1, parent, idea: saved[index] }),
      );
      if (current?.head === intended && !current.conflicts.length) {
        heads[index] = intended;
        await options.onDone?.(index);
      } else if (
        (current?.head ?? null) !== parent ||
        current?.conflicts.length
      )
        throw new Error("VERSION_CONFLICT");
      else todo.push({ idea: saved[index], parent, index });
    }
    const hashes = await this.appendMany(todo, {
      pool: options.pool,
      readBack: options.readBack,
      onDone: (i) => options.onDone?.(todo[i].index),
    });
    todo.forEach((t, i) => (heads[t.index] = hashes[i]));
    return saved.map((idea, i) => ({ idea, head: heads[i] }));
  }
  /** Re-reads exactly these revisions from Drive and checks their hashes. */
  async verifyRevisions(hashes: string[]) {
    return this.loader.verifyRemote(hashes);
  }
  /** Re-reads these pictures from Drive (one listing) and checks their hashes. */
  async verifyImages(hashes: string[]) {
    const files = new Map<string, string>();
    for (const file of await this.remote.list("image"))
      if (!files.has(file.appProperties.key))
        files.set(file.appProperties.key, file.id);
    await mapLimit([...new Set(hashes)], READ_CONCURRENCY, async (hash) => {
      const id = files.get(hash);
      if (!id || (await digest(await this.remote.read(id))) !== hash)
        throw new Error("이전 후 이미지 검증 실패");
    });
  }
  private checkRevision(value: unknown): Revision {
    const revision = value as Revision;
    if (
      !revision ||
      revision.schema !== 1 ||
      !(revision.parent === null || typeof revision.parent === "string")
    )
      throw new Error("지원하지 않는 Drive 문서입니다.");
    if (
      revision.merged !== undefined &&
      (!Array.isArray(revision.merged) ||
        revision.merged.some((hash) => typeof hash !== "string"))
    )
      throw new Error("잘못된 Drive 병합 이력입니다.");
    validateIdeas([revision.idea]);
    if (revision.idea.user_id !== this.account)
      throw new Error("Drive 문서의 계정이 일치하지 않습니다.");
    return revision;
  }
  /** Every call re-lists the remote; only unseen files are downloaded and hashed. */
  async revisions(
    forceRemote = false,
  ): Promise<{ revision: Revision; hash: string }[]> {
    return this.loader.load(forceRemote);
  }
  /** Rows are shared between calls while the set of revisions is unchanged. */
  async list(): Promise<DriveRow[]> {
    const revisions = await this.revisions();
    const key = revisions
      .map((r) => r.hash)
      .sort()
      .join(",");
    if (this.snapshot?.key === key) return this.snapshot.rows;
    const byHash = new Map(revisions.map((r) => [r.hash, r]));
    const parents = new Set<string | null>();
    const byIdea = new Map<string, typeof revisions>();
    for (const row of revisions) {
      for (const parent of [
        row.revision.parent,
        ...(row.revision.merged ?? []),
      ].filter(Boolean) as string[]) {
        if (byHash.get(parent)?.revision.idea.id !== row.revision.idea.id)
          throw new Error(
            "Drive 문서의 이전 버전이 누락되었거나 관계가 잘못되었습니다.",
          );
        parents.add(parent);
      }
      const group = byIdea.get(row.revision.idea.id) ?? [];
      group.push(row);
      byIdea.set(row.revision.idea.id, group);
    }
    const rows = [...byIdea.values()].map((group) => {
      const heads = group
        .filter((r) => !parents.has(r.hash))
        .sort((a, b) => a.hash.localeCompare(b.hash));
      if (!heads.length) throw new Error("Drive 문서 이력에 오류가 있습니다.");
      return {
        idea: heads[0].revision.idea,
        head: heads[0].hash,
        conflicts: heads.length > 1 ? heads.map((h) => h.revision) : [],
      };
    });
    this.snapshot = { key, rows };
    return rows;
  }
  async append(idea: Idea, parent: string | null) {
    validateIdeas([idea]);
    if (idea.user_id !== this.account)
      throw new Error("다른 계정의 데이터입니다.");
    const revision: Revision = { schema: 1, parent, idea };
    const result = await this.put(
      "revision",
      new Blob([canonical(revision)], { type: "application/json" }),
    );
    await this.loader.remember(result.hash, revision);
    return result.hash;
  }
  async save(idea: Idea, parent: string | null) {
    const saved = { ...idea, version: idea.version + 1 };
    const intended = await digest(
      canonical({ schema: 1, parent, idea: saved }),
    );
    const current = (await this.list()).find((r) => r.idea.id === idea.id);
    if (current?.head === intended && !current.conflicts.length)
      return { idea: saved, head: intended };
    if ((current?.head ?? null) !== parent || current?.conflicts.length)
      throw new Error("VERSION_CONFLICT");
    const head = await this.append(saved, parent);
    return { idea: saved, head };
  }
  async join(row: DriveRow) {
    const merged = await Promise.all(
      row.conflicts.map((r) => digest(canonical(r))),
    );
    const revision: Revision = {
      schema: 1,
      parent: row.head,
      merged: merged.sort(),
      idea: row.idea,
    };
    const { hash } = await this.put(
      "revision",
      new Blob([canonical(revision)], { type: "application/json" }),
    );
    row.head = hash;
  }
}
// Without a token this still names the remembered workspace, so cached images
// and drafts stay readable; network requests then raise DriveAuthError.
export function activeDriveRepository() {
  const account = current()?.user.id ?? rememberedDriveUser()?.id;
  if (!account) throw new Error("Google Drive 연결이 필요합니다.");
  return driveRepositoryFor(account);
}
// One repository per account keeps verified revisions in memory across syncs.
// It holds no token: requests read the live session.
let shared: DriveRepository | undefined;
export function driveRepositoryFor(account: string) {
  if (shared?.account !== account)
    shared = new DriveRepository(account, new GoogleDrive(account));
  return shared;
}
