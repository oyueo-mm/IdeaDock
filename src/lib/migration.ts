import type { Idea } from "./model";
import { type Folder, validateFolders, validateWorkspace } from "./folders";
import { FolderRepository } from "./folder-repository";
import { canonical, digest, imageNodes, validateIdeas } from "./integrity";
import { KeyValueStore, localDb } from "./local-db";
import { DriveRepository } from "./drive";

export type ImportSource = {
  id: string;
  label: string;
  ideas: Idea[];
  folders?: Folder[];
  raw?: unknown;
};
export type BackupImage = { path: string; data: string; sha256: string };
export type MigrationBackup = {
  schema: "ideadock-migration-v1" | "ideadock-migration-v2";
  id: string;
  sources: ImportSource[];
  images: BackupImage[];
};
export type MigrationProgress = {
  account: string;
  backup: string;
  verified: string[];
  state: "uploading" | "failed" | "verified";
  error?: string;
};
export interface ImportAdapter {
  readonly id: string;
  accepts(file: File): boolean;
  // Word adapters must return editable candidates, never upload directly.
  preview(file: File): Promise<ImportSource[]>;
}
export function jsonSources(value: unknown, source = "json"): ImportSource[] {
  const object = value as Partial<MigrationBackup> & { ideas?: unknown };
  if (
    object?.schema === "ideadock-migration-v1" ||
    object?.schema === "ideadock-migration-v2"
  ) {
    if (!Array.isArray(object.sources) || !Array.isArray(object.images))
      throw new Error("손상된 이전 백업입니다.");
    for (const s of object.sources) validateIdeas(s.ideas);
    return object.sources;
  }
  const ideas = Array.isArray(value) ? value : object?.ideas;
  validateIdeas(ideas);
  // Use the original owner namespace so reimporting an old export is stable.
  const owners = new Set(ideas.map((i) => i.user_id));
  return [...owners].map((owner) => ({
    id: owner === "demo" ? "demo" : `${source}:${owner}`,
    label: `JSON 백업 (${owner})`,
    ideas: ideas.filter((i) => i.user_id === owner),
    raw: value,
  }));
}
export const jsonImport: ImportAdapter = {
  id: "json",
  accepts: (file) => /\.json$/i.test(file.name),
  preview: async (file) => jsonSources(JSON.parse(await file.text())),
};
export const importAdapters: ImportAdapter[] = [jsonImport];

function validateSources(sources: ImportSource[]) {
  const ids = new Set<string>();
  const ideaIds = new Map<string, string>(),
    folderIds = new Map<string, string>();
  for (const source of sources) {
    if (
      !source ||
      typeof source.id !== "string" ||
      !source.id ||
      ids.has(source.id) ||
      typeof source.label !== "string"
    )
      throw new Error("이전 저장소 식별자 또는 이름이 잘못되었습니다.");
    ids.add(source.id);
    validateIdeas(source.ideas);
    validateWorkspace(source.ideas, source.folders ?? []);
    for (const i of source.ideas) {
      const value = canonical(i),
        old = ideaIds.get(i.id);
      if (old && old !== value)
        throw new Error("동일 ID의 서로 다른 원본이 있습니다.");
      ideaIds.set(i.id, value);
    }
    for (const f of source.folders ?? []) {
      const value = canonical(f),
        old = folderIds.get(f.id);
      if (old && old !== value)
        throw new Error("동일 ID의 서로 다른 폴더 원본이 있습니다.");
      folderIds.set(f.id, value);
    }
  }
}

export async function prepareBackup(
  sources: ImportSource[],
  read: (path: string) => Promise<Blob>,
  encode: (blob: Blob) => Promise<string>,
  db: KeyValueStore | null = localDb,
): Promise<MigrationBackup> {
  const snapshot: ImportSource[] = [];
  for (const source of structuredClone(
    sources.filter((s) => s.ideas.length || s.folders?.length),
  )) {
    validateSources([source]);
    const existing = snapshot.find((s) => s.id === source.id);
    if (!existing) {
      snapshot.push(source);
      continue;
    }
    for (const idea of source.ideas) {
      const previous = existing.ideas.find((i) => i.id === idea.id);
      if (previous && canonical(previous) !== canonical(idea))
        throw new Error(`동일 저장소에 서로 다른 원본이 있습니다: ${idea.id}`);
      if (!previous) existing.ideas.push(idea);
    }
    if (source.folders?.length) {
      const folders = new Map((existing.folders ?? []).map((f) => [f.id, f]));
      for (const f of source.folders) {
        const old = folders.get(f.id);
        if (old && canonical(old) !== canonical(f))
          throw new Error("서로 다른 폴더 원본입니다.");
        folders.set(f.id, f);
      }
      existing.folders = [...folders.values()];
    }
    existing.raw = { snapshots: [existing.raw ?? null, source.raw ?? null] };
  }
  if (!snapshot.length) throw new Error("이전할 데이터가 없습니다.");
  validateSources(snapshot);
  if (new Set(snapshot.map((s) => s.id)).size !== snapshot.length)
    throw new Error("중복된 이전 저장소입니다.");
  const uniqueIdeas = new Map<string, string>();
  for (const source of snapshot) {
    validateIdeas(source.ideas);
    for (const idea of source.ideas) {
      const value = canonical(idea);
      const previous = uniqueIdeas.get(idea.id);
      if (previous && previous !== value)
        throw new Error(
          `동일 ID의 서로 다른 원본이 있습니다: ${idea.id}. 원본을 각각 검토해 주세요.`,
        );
      uniqueIdeas.set(idea.id, value);
    }
  }
  const images: BackupImage[] = [];
  for (const path of new Set(
    snapshot.flatMap((s) =>
      s.ideas.flatMap((i) => i.images.map((im) => im.storage_path)),
    ),
  )) {
    const blob = await read(path);
    images.push({ path, data: await encode(blob), sha256: await digest(blob) });
  }
  const payload = { sources: snapshot, images };
  const id = await digest(canonical(payload));
  const backup: MigrationBackup = {
    schema: snapshot.some((s) => s.folders?.length)
      ? "ideadock-migration-v2"
      : "ideadock-migration-v1",
    id,
    ...payload,
  };
  // An emergency manual download can still be produced if device storage is
  // full. Migration itself always persists and rereads its backup before writes.
  if (db) {
    await db.set(`backup:${id}`, backup);
    if (canonical(await db.get(`backup:${id}`)) !== canonical(backup))
      throw new Error("백업을 다시 읽어 검증하지 못했습니다.");
  }
  return backup;
}
export async function validateBackup(
  backup: MigrationBackup,
  decode: (data: string) => Promise<Blob>,
) {
  if (
    !["ideadock-migration-v1", "ideadock-migration-v2"].includes(
      backup.schema,
    ) ||
    !Array.isArray(backup.images) ||
    !Array.isArray(backup.sources)
  )
    throw new Error("지원하지 않는 백업입니다.");
  validateSources(backup.sources);
  if (
    (await digest(
      canonical({ sources: backup.sources, images: backup.images }),
    )) !== backup.id
  )
    throw new Error("백업 문서의 체크섬이 일치하지 않습니다.");
  const paths = new Set<string>();
  for (const image of backup.images) {
    if (paths.has(image.path)) throw new Error("중복된 백업 이미지입니다.");
    paths.add(image.path);
    if ((await digest(await decode(image.data))) !== image.sha256)
      throw new Error("백업 이미지의 체크섬이 일치하지 않습니다.");
  }
  for (const s of backup.sources)
    for (const i of s.ideas)
      for (const im of i.images)
        if (!paths.has(im.storage_path))
          throw new Error("백업에 이미지 원본이 누락되었습니다.");
}

// Recovery for the preserved release: explicit user action only, atomic setItem,
// no deletion, and no replacement of an existing divergent idea.
export async function restoreDemoBackup(
  backup: MigrationBackup,
  storage: Pick<Storage, "getItem" | "setItem">,
  decode: (data: string) => Promise<Blob>,
) {
  await validateBackup(backup, decode);
  const original = storage.getItem("ideadock:data:demo");
  const cached = original ? JSON.parse(original) : { ideas: [], pending: {} };
  validateIdeas(cached.ideas);
  const next: Idea[] = structuredClone(cached.ideas);
  const folderKey = "ideadock:folders:demo:v2";
  const originalFolders = storage.getItem(folderKey);
  const folderCache = originalFolders
    ? JSON.parse(originalFolders)
    : { folders: [], pending: {}, heads: {} };
  validateFolders(folderCache.folders);
  const nextFolders: Folder[] = structuredClone(folderCache.folders);
  for (const source of backup.sources)
    for (const value of source.folders ?? []) {
      const f = { ...value, user_id: "demo" };
      const old = nextFolders.find((x) => x.id === f.id);
      if (old && canonical(old) !== canonical(f))
        throw new Error("복구 폴더 ID 충돌");
      if (!old) nextFolders.push(f);
    }
  for (const value of Object.values(cached.pending ?? {}) as { idea: Idea }[]) {
    validateIdeas([value.idea]);
    const index = next.findIndex((i) => i.id === value.idea.id);
    if (index < 0) next.push(value.idea);
    else next[index] = value.idea;
  }
  const files = new Map(backup.images.map((image) => [image.path, image.data]));
  let imported = 0;
  for (const source of backup.sources)
    for (const value of source.ideas) {
      const idea = structuredClone(value);
      idea.user_id = "demo";
      for (const image of idea.images)
        image.storage_path = files.get(image.storage_path)!;
      for (const node of imageNodes(idea.content)) {
        const attrs = node.attrs as Record<string, unknown>;
        attrs.storage_path = files.get(String(attrs.storage_path))!;
      }
      const existing = next.find((i) => i.id === idea.id);
      if (existing && canonical(existing) !== canonical(idea))
        throw new Error(
          `체험 데이터와 ID가 겹칩니다: ${idea.title}. 기존 내용은 변경하지 않았습니다.`,
        );
      if (!existing) {
        next.push(idea);
        imported++;
      }
    }
  validateIdeas(next);
  validateWorkspace(next, nextFolders);
  // Preserve a recoverable copy of the exact demo cache before any merge.
  if (original) storage.setItem(`ideadock:recovery:${backup.id}`, original);
  if (originalFolders)
    storage.setItem(`ideadock:folder-recovery:${backup.id}`, originalFolders);
  // All folders precede ideas; interrupted recovery can leave extra folders,
  // never an idea referring to a folder that was not durably written.
  if (nextFolders.length)
    storage.setItem(
      folderKey,
      JSON.stringify({ ...folderCache, folders: nextFolders }),
    );
  storage.setItem(
    "ideadock:data:demo",
    JSON.stringify({ ...cached, ideas: next }),
  );
  return imported;
}
export async function migrate(
  backup: MigrationBackup,
  repo: DriveRepository,
  approved: { account: string; backup: string },
  decode: (data: string) => Promise<Blob>,
  onProgress: (progress: MigrationProgress) => void = () => {},
) {
  if (approved.account !== repo.account || approved.backup !== backup.id)
    throw new Error("이 계정과 백업에 대한 사용자 승인이 필요합니다.");
  await validateBackup(backup, decode);
  await repo.db.set(`backup:${backup.id}`, backup);
  if (canonical(await repo.db.get(`backup:${backup.id}`)) !== canonical(backup))
    throw new Error("이전 전 복구 백업을 확인하지 못했습니다.");
  const stateKey = `${repo.account}:migration:${backup.id}`;
  const progress: MigrationProgress = {
    account: repo.account,
    backup: backup.id,
    verified: [],
    state: "uploading",
  };
  const checkpoint = async () => {
    await repo.db.set(stateKey, progress);
    onProgress(structuredClone(progress));
  };
  await checkpoint();
  try {
    // A cloud copy of the self-contained recovery backup precedes idea writes.
    await repo.put(
      "backup",
      new Blob([canonical(backup)], { type: "application/json" }),
    );
    const imageMap = new Map<string, string>();
    const folderRepo = new FolderRepository(repo);
    const importedFolders = backup.sources.flatMap((s) =>
      (s.folders ?? []).map((f) => ({ ...f, user_id: repo.account })),
    );
    if (importedFolders.length) {
      const unique = [
        ...new Map(importedFolders.map((f) => [f.id, f])).values(),
      ];
      validateFolders(unique);
      const history = await folderRepo.revisions();
      // append complete immutable records; validation above checks the whole snapshot.
      for (const f of unique) {
        const old = history.filter((r) => r.revision.folder.id === f.id);
        if (
          old.length &&
          !old.some((r) => canonical(r.revision.folder) === canonical(f))
        )
          throw new Error("기존 Drive 폴더와 ID가 겹칩니다.");
        if (!old.length) await folderRepo.append(f, null);
      }
      const actual = await folderRepo.revisions(true);
      for (const f of unique)
        if (!actual.some((r) => canonical(r.revision.folder) === canonical(f)))
          throw new Error("폴더 이전 검증 실패");
    }
    for (const image of backup.images) {
      const { hash } = await repo.put("image", await decode(image.data));
      if (hash !== image.sha256)
        throw new Error("업로드된 이미지가 원본과 다릅니다.");
      imageMap.set(image.path, `drive-sha:${hash}`);
    }
    const expected: { idea: Idea; fingerprint: string }[] = [];
    for (const source of backup.sources)
      for (const original of source.ideas) {
        const fingerprint = await digest(canonical(original));
        const idea = structuredClone(original);
        idea.user_id = repo.account;
        idea.provenance = original.provenance ?? {
          source: source.id,
          source_id: original.id,
          original_owner: original.user_id,
          fingerprint,
        };
        for (const image of idea.images)
          image.storage_path = imageMap.get(image.storage_path)!;
        for (const node of imageNodes(idea.content)) {
          const attrs = node.attrs as Record<string, unknown>;
          attrs.storage_path = imageMap.get(String(attrs.storage_path))!;
        }
        // A restored modern backup keeps its original provenance and timestamps.
        if (!expected.some((e) => e.idea.id === idea.id))
          expected.push({ idea, fingerprint });
      }
    const history = await repo.revisions();
    for (const { idea } of expected) {
      const existing = history.filter((r) => r.revision.idea.id === idea.id);
      const identical = existing.find(
        (r) => canonical(r.revision.idea) === canonical(idea),
      );
      if (!identical) {
        if (existing.length)
          throw new Error(
            `기존 Drive 아이디어와 ID가 겹치거나 원본이 변경되었습니다: ${idea.title}. 기존 데이터는 보존했습니다.`,
          );
        const hash = await repo.append(idea, null);
        history.push({ revision: { schema: 1, idea, parent: null }, hash });
      }
      progress.verified.push(idea.id);
      await checkpoint();
    }
    // Full server reread; checkpoints alone never imply successful verification.
    const actual = await repo.revisions(true);
    for (const { idea } of expected) {
      if (!actual.some((r) => canonical(r.revision.idea) === canonical(idea)))
        throw new Error(`이전 결과 불일치: ${idea.id}`);
    }
    const remoteImages = await repo.remote.list("image");
    for (const image of backup.images) {
      const file = remoteImages.find(
        (f) => f.appProperties.key === image.sha256,
      );
      if (
        !file ||
        (await digest(await repo.remote.read(file.id))) !== image.sha256
      )
        throw new Error("이전 후 이미지 검증 실패");
    }
    if (progress.verified.length !== expected.length)
      throw new Error("아이디어 개수 불일치");
    progress.state = "verified";
    await checkpoint();
    return progress;
  } catch (error) {
    progress.state = "failed";
    progress.error = error instanceof Error ? error.message : "이전 실패";
    await checkpoint();
    throw error;
  }
}
