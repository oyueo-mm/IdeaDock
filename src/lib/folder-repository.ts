import { DriveRepository } from "./drive";
import { canonical, digest } from "./integrity";
import { type Folder, validateFolders } from "./folders";

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
// Logical folders are separate immutable documents, never physical Drive folders.
export class FolderRepository {
  constructor(readonly ideas: DriveRepository) {}
  async revisions(force = false) {
    const rows: { revision: FolderRevision; hash: string }[] = [];
    for (const f of await this.ideas.remote.list("folder-revision")) {
      const key = `${this.ideas.account}:folder-revision:${this.ideas.remote.storageNamespace ?? "default"}:${f.appProperties.key}`;
      let revision = force
        ? undefined
        : await this.ideas.db.get<FolderRevision>(key);
      if (
        !revision ||
        (await digest(canonical(revision))) !== f.appProperties.key
      ) {
        const bytes = await this.ideas.remote.read(f.id);
        if ((await digest(bytes)) !== f.appProperties.key)
          throw new Error("폴더 리비전 체크섬 오류");
        revision = JSON.parse(await bytes.text());
      }
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
        revision.folder.user_id !== this.ideas.account ||
        !(
          revision.folder.parent_id === null ||
          typeof revision.folder.parent_id === "string"
        )
      )
        throw new Error("폴더 계정 또는 상위 관계 오류");
      await this.ideas.db.set(key, revision);
      if (!rows.some((r) => r.hash === f.appProperties.key))
        rows.push({ revision, hash: f.appProperties.key });
    }
    return rows;
  }
  async list(): Promise<FolderRow[]> {
    const all = await this.revisions();
    for (const r of all)
      for (const p of [r.revision.parent, ...(r.revision.merged ?? [])].filter(
        Boolean,
      ))
        if (
          !all.some(
            (x) =>
              x.hash === p && x.revision.folder.id === r.revision.folder.id,
          )
        )
          throw new Error("폴더 이력 관계 누락");
    const parents = new Set(
      all.flatMap((r) => [r.revision.parent, ...(r.revision.merged ?? [])]),
    );
    return [...new Set(all.map((r) => r.revision.folder.id))].map((id) => {
      const heads = all
        .filter((r) => r.revision.folder.id === id && !parents.has(r.hash))
        .sort((a, b) => a.hash.localeCompare(b.hash));
      if (!heads.length) throw new Error("폴더 이력 순환 오류");
      return {
        folder: heads[0].revision.folder,
        head: heads[0].hash,
        conflicts: heads.length > 1 ? heads.map((h) => h.revision) : [],
      };
    });
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
    return (
      await this.ideas.put(
        "folder-revision",
        new Blob([canonical(revision)], { type: "application/json" }),
      )
    ).hash;
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
