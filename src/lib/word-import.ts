import { type WordPreview } from "./docx";
import { type Idea } from "./model";
import { type Folder, validateWorkspace, folderTrashed } from "./folders";
import { FolderRepository } from "./folder-repository";
import { canonical, digest, imageNodes, validateIdeas } from "./integrity";
import { type DriveRepository } from "./drive";
import {
  prepareBackup,
  validateBackup,
  type MigrationBackup,
} from "./migration";
import { dataUrl, readImage } from "./images";

export type WordImportProgress = {
  done: string[];
  total: number;
  state: "uploading" | "failed" | "verified";
  error?: string;
};
type PlanItem = { idea: Idea; parent: string | null; already?: boolean };
type Plan = {
  items: PlanItem[];
  recovery: MigrationBackup;
  importBackup: MigrationBackup;
};
export async function importWord(
  preview: WordPreview,
  ideas: Idea[],
  folders: Folder[],
  repo: DriveRepository,
  approval: {
    account: string;
    file: string;
    warnings: boolean;
    merge: boolean;
  },
  onProgress: (p: WordImportProgress) => void = () => {},
) {
  if (approval.account !== repo.account || approval.file !== preview.fileHash)
    throw new Error("파일과 대상 계정에 대한 승인이 필요합니다.");
  if (
    !/^data:application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document;base64,[A-Za-z0-9+/=]+$/.test(
      preview.original,
    ) ||
    (await digest(await (await fetch(preview.original)).blob())) !==
      preview.fileHash
  )
    throw new Error("Word 원본 파일 체크섬이 일치하지 않습니다.");
  const selected = preview.candidates.filter(
    (c) => c.selected && c.action !== "skip",
  );
  if (!selected.length) throw new Error("가져올 항목을 선택하세요.");
  if (
    (preview.warnings.length || selected.some((c) => c.warnings.length)) &&
    !approval.warnings
  )
    throw new Error("지원하지 않는 내용 또는 이미지 경고를 확인하세요.");
  if (selected.some((c) => c.action === "merge") && !approval.merge)
    throw new Error("기존 아이디어 병합은 별도 승인이 필요합니다.");
  validateIdeas(ideas);
  validateWorkspace(ideas, folders);
  if (
    ideas.some((i) => i.user_id !== repo.account) ||
    folders.some((f) => f.user_id !== repo.account)
  )
    throw new Error("다른 계정의 스냅샷입니다.");
  const planId = await digest(
    canonical({ file: preview.fileHash, candidates: selected }),
  );
  const key = `${repo.account}:word-plan:${planId}`;
  let plan = await repo.db.get<Plan>(key);
  if (!plan) {
    const remote = await repo.list();
    const remoteFolders = await new FolderRepository(repo).list();
    if (
      remote.length !== ideas.length ||
      remoteFolders.length !== folders.length ||
      folders.some(
        (f) => !remoteFolders.some((r) => canonical(r.folder) === canonical(f)),
      )
    )
      throw new Error("최신 폴더와 아이디어를 먼저 동기화하세요.");
    // Never back up an old view and then silently merge into a newer version.
    for (const idea of ideas)
      if (!remote.some((r) => canonical(r.idea) === canonical(idea)))
        throw new Error("Drive의 최신 내용을 먼저 동기화한 후 가져오세요.");
    let recovery: MigrationBackup;
    if (ideas.length || folders.length)
      recovery = await prepareBackup(
        [{ id: repo.account, label: "Word 가져오기 전 복구", ideas, folders }],
        readImage,
        dataUrl,
        repo.db,
      );
    else {
      const payload = { sources: [], images: [] };
      recovery = {
        schema: "ideadock-migration-v1",
        id: await digest(canonical(payload)),
        ...payload,
      };
      await repo.db.set(`backup:${recovery.id}`, recovery);
    }
    const items: PlanItem[] = [];
    const snapshots: Idea[] = [];
    const targets = new Set<string>();
    for (const c of selected) {
      let idea = structuredClone(c.idea);
      idea.user_id = repo.account;
      idea.folder_id = c.folder;
      if (folderTrashed(folders, c.folder))
        throw new Error("휴지통 폴더로 가져올 수 없습니다.");
      validateWorkspace([idea], folders);
      validateIdeas([idea]);
      snapshots.push(idea);
      const marker = { file_hash: preview.fileHash, item_id: c.key };
      const markers = [...new Set([c.key, ...(c.sourceKeys ?? [])])].map(
        (item_id) => ({ file_hash: preview.fileHash, item_id }),
      );
      if (c.action === "merge") {
        if (targets.has(c.mergeId))
          throw new Error(
            "한 번에 같은 기존 아이디어에 여러 항목을 병합할 수 없습니다. 순서대로 검토하세요.",
          );
        targets.add(c.mergeId);
        const current = remote.find((r) => r.idea.id === c.mergeId);
        if (!current) throw new Error("병합 대상이 없습니다.");
        if (
          current.idea.imports?.some(
            (h) =>
              h.file_hash === marker.file_hash && h.item_id === marker.item_id,
          )
        ) {
          items.push({
            idea: current.idea,
            parent: current.head,
            already: true,
          });
          continue;
        }
        if (current.idea.images.length + idea.images.length > 12)
          throw new Error("병합 후 이미지가 12장을 넘습니다.");
        idea = {
          ...current.idea,
          content: {
            type: "doc",
            content: [
              ...(current.idea.content.content as unknown[]),
              { type: "horizontalRule" },
              ...(idea.content.content as unknown[]),
            ],
          },
          plain_text: [current.idea.plain_text, idea.plain_text]
            .filter(Boolean)
            .join("\n"),
          images: [...current.idea.images, ...idea.images],
          links: [
            ...current.idea.links,
            ...idea.links.filter(
              (l) => !current.idea.links.some((old) => old.url === l.url),
            ),
          ],
          imports: [...(current.idea.imports ?? []), ...markers],
          updated_at: new Date().toISOString(),
        };
        items.push({ idea, parent: current.head });
      } else {
        const previous = remote.find((r) => r.idea.id === idea.id);
        if (previous) {
          if (
            previous.idea.provenance?.source !== idea.provenance?.source ||
            previous.idea.provenance?.source_id !== idea.provenance?.source_id
          )
            throw new Error("기존 ID와 충돌합니다.");
          items.push({
            idea: previous.idea,
            parent: previous.head,
            already: true,
          });
        } else {
          idea.imports = markers;
          items.push({ idea, parent: null });
        }
      }
    }
    const importBackup = await prepareBackup(
      [
        {
          id: `docx:${preview.fileHash}`,
          label: preview.fileName,
          ideas: snapshots,
          folders,
          raw: {
            name: preview.fileName,
            sha256: preview.fileHash,
            originalDocx: preview.original,
            warnings: preview.warnings,
          },
        },
      ],
      readImage,
      dataUrl,
      repo.db,
    );
    plan = { items, recovery, importBackup };
    await repo.db.set(key, plan);
    if (canonical(await repo.db.get(key)) !== canonical(plan))
      throw new Error("가져오기 계획 보관 실패");
  }
  await validateBackup(plan.recovery, readImage);
  await validateBackup(plan.importBackup, readImage);
  const progress: WordImportProgress = {
    done: [],
    total: plan.items.length,
    state: "uploading",
  };
  const publish = async () => {
    await repo.db.set(`${key}:progress`, progress);
    onProgress(structuredClone(progress));
  };
  await publish();
  try {
    await repo.put(
      "backup",
      new Blob([canonical(plan.recovery)], { type: "application/json" }),
    );
    await repo.put(
      "backup",
      new Blob([canonical(plan.importBackup)], { type: "application/json" }),
    );
    for (const item of plan.items) {
      if (item.already) {
        const reread = await repo.revisions(true);
        if (
          !reread.some(
            (r) => canonical(r.revision.idea) === canonical(item.idea),
          )
        )
          throw new Error(
            "기존 가져오기 문서를 재조회하여 확인하지 못했습니다.",
          );
        for (const image of item.idea.images) {
          const hash = image.storage_path.slice(10),
            file = (await repo.remote.list("image")).find(
              (f) => f.appProperties.key === hash,
            );
          if (!file || (await digest(await repo.remote.read(file.id))) !== hash)
            throw new Error("기존 가져오기 이미지 검증 실패");
        }
        progress.done.push(item.idea.id);
        await publish();
        continue;
      }
      const idea = structuredClone(item.idea),
        paths = new Map<string, string>();
      for (const image of idea.images) {
        if (image.storage_path.startsWith("drive-sha:")) continue;
        const blob = await readImage(image.storage_path),
          { hash } = await repo.put("image", blob);
        paths.set(image.storage_path, `drive-sha:${hash}`);
        await repo.db.set(`${repo.account}:image:${hash}`, blob);
        image.storage_path = `drive-sha:${hash}`;
      }
      for (const node of imageNodes(idea.content)) {
        const a = node.attrs as Record<string, unknown>;
        a.storage_path = paths.get(String(a.storage_path)) ?? a.storage_path;
      }
      const saved = await repo.save(idea, item.parent);
      const actual = (await repo.revisions(true)).find(
        (r) => r.hash === saved.head,
      );
      if (!actual || canonical(actual.revision.idea) !== canonical(saved.idea))
        throw new Error("가져온 문서를 재조회하여 검증하지 못했습니다.");
      for (const image of saved.idea.images) {
        const hash = image.storage_path.slice(10),
          file = (await repo.remote.list("image")).find(
            (f) => f.appProperties.key === hash,
          );
        if (!file || (await digest(await repo.remote.read(file.id))) !== hash)
          throw new Error("이미지 재조회 검증 실패");
      }
      progress.done.push(idea.id);
      await publish();
    }
    progress.state = "verified";
    await publish();
    return progress;
  } catch (e) {
    progress.state = "failed";
    progress.error = e instanceof Error ? e.message : String(e);
    await publish();
    throw e;
  }
}
