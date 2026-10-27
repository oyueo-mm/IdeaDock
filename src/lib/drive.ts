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
let session: { token: string; expires: number; user: GoogleUser } | undefined;
let loading: Promise<void> | undefined;
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
export async function connectDrive(): Promise<GoogleUser> {
  if (!driveConfigured)
    throw new Error("Google OAuth 클라이언트 ID 설정이 필요합니다.");
  await loadGoogle();
  const reply = await new Promise<TokenReply>((resolve, reject) => {
    window
      .google!.accounts.oauth2.initTokenClient({
        client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID!,
        scope: `openid email profile ${driveScope}`,
        callback: (r) => (r.error ? reject(new Error(r.error)) : resolve(r)),
        error_callback: (e) => reject(new Error(`Google 로그인: ${e.type}`)),
      })
      .requestAccessToken({ prompt: "select_account" });
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
  session = {
    token: reply.access_token,
    expires: Date.now() + reply.expires_in * 1000 - 30000,
    user,
  };
  return user;
}
export function disconnectDrive() {
  session = undefined;
}
export function driveAccount() {
  return session?.user.id;
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
    if (
      !session ||
      session.user.id !== this.account ||
      session.expires <= Date.now()
    )
      throw new Error(
        "Google Drive에 다시 로그인해 주세요. 초안과 이전 진행 상황은 보존됩니다.",
      );
    const response = await fetch(
      `https://www.googleapis.com/${upload ? "upload/" : ""}drive/v3/${path}`,
      {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${session.token}` },
      },
    );
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
export function activeDriveRepository() {
  if (!session) throw new Error("Google Drive 연결이 필요합니다.");
  return new DriveRepository(session.user.id, new GoogleDrive(session.user.id));
}
