import { DriveRepository } from "./drive";
import { canonical, digest } from "./integrity";
import { type Folder, validateFolders } from "./folders";
import { RevisionLoader } from "./revision-loader";

export type FolderRevision = {
  schema: 1;
  parent: string | null;
  merged?: string[];
  folder: Folder;
};
export type FolderRow = {
  folder: Folder;
  head: string;
  conflicts: FolderRevision[];
};
// Repositories are created per call, so the verified-revision memory lives with
// the (shared) DriveRepository instead.
const loaders = new WeakMap<DriveRepository, RevisionLoader<FolderRevision>>();
const snapshots = new WeakMap<
  DriveRepository,
  { key: string; rows: FolderRow[] }
>();
function checkFolderRevision(
  ideas: DriveRepository,
  revision: FolderRevision,
): FolderRevision {
  if (
    !revision ||
    revision.schema !== 1 ||
    !(revision.parent === null || typeof revision.parent === "string") ||
    (revision.merged !== undefined &&
      (!Array.isArray(revision.merged) ||
        revision.merged.some((h) => typeof h !== "string")))
  )
    throw new Error("폴더 리비전 형식 오류");
  // Validate one record without requiring its ancestors in this revision.
  validateFolders([{ ...revision.folder, parent_id: null }]);
  if (
    revision.folder.user_id !== ideas.account ||
    !(
      revision.folder.parent_id === null ||
      typeof revision.folder.parent_id === "string"
    )
  )
    throw new Error("폴더 계정 또는 상위 관계 오류");
  return revision;
}
// Logical folders are separate immutable documents, never physical Drive folders.
export class FolderRepository {
  constructor(readonly ideas: DriveRepository) {}
  private get loader() {
    let loader = loaders.get(this.ideas);
    if (!loader) {
      const ideas = this.ideas;
      loader = new RevisionLoader<FolderRevision>({
        remote: ideas.remote,
        db: ideas.db,
        kind: "folder-revision",
        cacheKey: (hash) =>
          `${ideas.account}:folder-revision:${ideas.remote.storageNamespace ?? "default"}:${hash}`,
        writes: () => ideas.uploadCount("folder-revision"),
        corrupt: "폴더 리비전 체크섬 오류",
        check: (value) => checkFolderRevision(ideas, value as FolderRevision),
      });
      loaders.set(ideas, loader);
    }
    return loader;
  }
  async revisions(force = false) {
    return this.loader.load(force);
  }
  /** Rows are shared between calls while the set of revisions is unchanged. */
  async list(): Promise<FolderRow[]> {
    const all = await this.revisions();
    const key = all
      .map((r) => r.hash)
      .sort()
      .join(",");
    const known = snapshots.get(this.ideas);
    if (known?.key === key) return known.rows;
    const byHash = new Map(all.map((r) => [r.hash, r]));
    const parents = new Set<string | null>();
    const byFolder = new Map<string, typeof all>();
    for (const r of all) {
      for (const p of [r.revision.parent, ...(r.revision.merged ?? [])].filter(
        Boolean,
      ) as string[]) {
        if (byHash.get(p)?.revision.folder.id !== r.revision.folder.id)
          throw new Error("폴더 이력 관계 누락");
        parents.add(p);
      }
      const group = byFolder.get(r.revision.folder.id) ?? [];
      group.push(r);
      byFolder.set(r.revision.folder.id, group);
    }
    const rows = [...byFolder.values()].map((group) => {
      const heads = group
        .filter((r) => !parents.has(r.hash))
        .sort((a, b) => a.hash.localeCompare(b.hash));
      if (!heads.length) throw new Error("폴더 이력 순환 오류");
      return {
        folder: heads[0].revision.folder,
        head: heads[0].hash,
        conflicts: heads.length > 1 ? heads.map((h) => h.revision) : [],
      };
    });
    snapshots.set(this.ideas, { key, rows });
    return rows;
  }
  async append(folder: Folder, parent: string | null, merged?: string[]) {
    if (folder.user_id !== this.ideas.account)
      throw new Error("폴더 계정 불일치");
    validateFolders([{ ...folder, parent_id: null }]);
    const revision: FolderRevision = {
      schema: 1,
      parent,
      folder,
      ...(merged ? { merged: [...merged].sort() } : {}),
    };
    const { hash } = await this.ideas.put(
      "folder-revision",
      new Blob([canonical(revision)], { type: "application/json" }),
    );
    await this.loader.remember(hash, revision);
    return hash;
  }
  /** Appends complete folder records in one batch; see DriveRepository.putMany. */
  async appendMany(folders: Folder[], options: { readBack?: boolean } = {}) {
    const revisions = folders.map((folder): FolderRevision => {
      if (folder.user_id !== this.ideas.account)
        throw new Error("폴더 계정 불일치");
      validateFolders([{ ...folder, parent_id: null }]);
      return { schema: 1, parent: null, folder };
    });
    const blobs = revisions.map(
      (r) => new Blob([canonical(r)], { type: "application/json" }),
    );
    const hashes = await Promise.all(blobs.map((blob) => digest(blob)));
    await this.ideas.putMany("folder-revision", blobs, {
      readBack: options.readBack,
      onDone: async (hash) =>
        this.loader.remember(hash, revisions[hashes.indexOf(hash)]),
    });
    return hashes;
  }
  /** Re-reads exactly these folder revisions from Drive and checks their hashes. */
  async verifyRevisions(hashes: string[]) {
    return this.loader.verifyRemote(hashes);
  }
  async save(folder: Folder, parent: string | null) {
    const rows = await this.list();
    const current = rows.find((r) => r.folder.id === folder.id);
    const saved = { ...folder, version: folder.version + 1 };
    const intended = await digest(
      canonical({ schema: 1, parent, folder: saved }),
    );
    if (current?.head === intended && !current.conflicts.length)
      return { folder: saved, head: intended };
    if ((current?.head ?? null) !== parent || current?.conflicts.length)
      throw new Error("VERSION_CONFLICT");
    validateFolders([
      ...rows.filter((r) => r.folder.id !== folder.id).map((r) => r.folder),
      saved,
    ]);
    return { folder: saved, head: await this.append(saved, parent) };
  }
  async join(row: FolderRow, folder: Folder) {
    const merged = await Promise.all(
      row.conflicts.map((r) => digest(canonical(r))),
    );
    validateFolders(
      (await this.list()).map((r) =>
        r.folder.id === folder.id ? folder : r.folder,
      ),
    );
    return { folder, head: await this.append(folder, row.head, merged) };
  }
}
