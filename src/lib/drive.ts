import { KeyValueStore, localDb } from "./local-db";
import { canonical, digest, validateIdeas } from "./integrity";
import type { Idea } from "./model";

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
  list(kind: string): Promise<RemoteFile[]>;
  allocate(): Promise<string>;
  read(id: string): Promise<Blob>;
  create(id: string, key: string, kind: string, blob: Blob): Promise<void>;
}
// The account is captured on construction. A late response cannot cross accounts.
export class GoogleDrive implements ImmutableRemote {
  readonly storageNamespace = driveSpace;
  private folderPromise?: Promise<string>;
  constructor(readonly account: string) {}
  private async request(path: string, init: RequestInit = {}, upload = false) {
    const active = current();
    if (!active || active.user.id !== this.account) throw new DriveAuthError();
    const response = await fetch(
      `https://www.googleapis.com/${upload ? "upload/" : ""}drive/v3/${path}`,
      {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${active.token}` },
      },
    );
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
      Object.assign(error, { status: response.status });
      throw error;
    }
    return response;
  }
  private async folders(): Promise<{ id: string }[]> {
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
    const existing = await this.folders();
    if (existing.length) return existing[0].id;
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
  async list(kind: string) {
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
        q: `trashed = false and appProperties has { key='kind' and value='${kind}' }${parentQuery}`,
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
  constructor(
    readonly account: string,
    readonly remote: ImmutableRemote,
    readonly db: KeyValueStore = localDb,
  ) {}
  async put(kind: string, blob: Blob) {
    const hash = await digest(blob);
    const key = `${this.account}:upload:${this.remote.storageNamespace ? `${this.remote.storageNamespace}:` : ""}${kind}:${hash}`;
    // Search the server as well: a different device may already have uploaded it.
    const existing = (await this.remote.list(kind))
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
    return { id, hash };
  }
  private revisionCacheKey(hash: string) {
    return `${this.account}:revision:${this.remote.storageNamespace ?? "default"}:${hash}`;
  }
  async revisions(
    forceRemote = false,
  ): Promise<{ revision: Revision; hash: string }[]> {
    const rows: { revision: Revision; hash: string }[] = [];
    for (const file of await this.remote.list("revision")) {
      const key = this.revisionCacheKey(file.appProperties.key);
      let revision = forceRemote ? undefined : await this.db.get<Revision>(key);
      let hash = file.appProperties.key;
      if (!revision || (await digest(canonical(revision))) !== hash) {
        const blob = await this.remote.read(file.id);
        hash = await digest(blob);
        if (hash !== file.appProperties.key)
          throw new Error("Drive 문서 무결성 검사에 실패했습니다.");
        revision = JSON.parse(await blob.text()) as Revision;
      }
      if (
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
      await this.db.set(key, revision);
      if (!rows.some((r) => r.hash === hash)) rows.push({ revision, hash });
    }
    return rows;
  }
  async list(): Promise<DriveRow[]> {
    const revisions = await this.revisions();
    for (const row of revisions) {
      for (const parent of [
        row.revision.parent,
        ...(row.revision.merged ?? []),
      ].filter(Boolean)) {
        if (
          !revisions.some(
            (r) =>
              r.hash === parent && r.revision.idea.id === row.revision.idea.id,
          )
        )
          throw new Error(
            "Drive 문서의 이전 버전이 누락되었거나 관계가 잘못되었습니다.",
          );
      }
    }
    const parents = new Set(
      revisions.flatMap((r) => [
        r.revision.parent,
        ...(r.revision.merged ?? []),
      ]),
    );
    const ids = new Set(revisions.map((r) => r.revision.idea.id));
    return [...ids].map((id) => {
      const heads = revisions
        .filter((r) => r.revision.idea.id === id && !parents.has(r.hash))
        .sort((a, b) => a.hash.localeCompare(b.hash));
      if (!heads.length) throw new Error("Drive 문서 이력에 오류가 있습니다.");
      return {
        idea: heads[0].revision.idea,
        head: heads[0].hash,
        conflicts: heads.length > 1 ? heads.map((h) => h.revision) : [],
      };
    });
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
    await this.db.set(this.revisionCacheKey(result.hash), revision);
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
  return new DriveRepository(account, new GoogleDrive(account));
}
