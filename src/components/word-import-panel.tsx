"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { parseDocx, duplicateCandidates, type WordPreview } from "@/lib/docx";
import { folderTrashed, folderPath, type Folder } from "@/lib/folders";
import { type Idea } from "@/lib/model";
import { digest } from "@/lib/integrity";
import { activeDriveRepository } from "@/lib/drive";
import { localDb } from "@/lib/local-db";
import { useDialogFocus } from "@/lib/use-dialog-focus";
import { importWord, type WordImportProgress } from "@/lib/word-import";
const nodeText = (n: Record<string, unknown>): string =>
  typeof n.text === "string"
    ? n.text
    : Array.isArray(n.content)
      ? n.content
          .map((child) => nodeText(child as Record<string, unknown>))
          .join("")
      : n.type === "hardBreak"
        ? "\n"
        : "";

export default function WordImportPanel({
  account,
  ideas,
  folders,
  pending,
  onRefresh,
}: {
  account?: string;
  ideas: Idea[];
  folders: Folder[];
  pending: number;
  onRefresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [preview, setPreview] = useState<WordPreview | null>(null),
    [saved, setSaved] = useState<WordPreview | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [warnings, setWarnings] = useState(false),
    [merge, setMerge] = useState(false),
    [progress, setProgress] = useState<WordImportProgress | null>(null);
  const dialog = useRef<HTMLElement>(null),
    disk = useRef(Promise.resolve());
  const [splitAt, setSplitAt] = useState<Record<string, number>>({});
  useDialogFocus(dialog, open);
  const owner = account ?? "demo",
    key = `${owner}:word-preview:v2`;
  useEffect(() => {
    setPreview(null);
    setSaved(null);
    setOpen(false);
    setProgress(null);
    setError("");
    void localDb
      .get<WordPreview>(key)
      .then((v) => setSaved(v ?? null))
      .catch((e) => setError(String(e)));
  }, [key]);
  function change(next: WordPreview) {
    setPreview(next);
    setProgress(null);
    disk.current = disk.current
      .catch(() => {})
      .then(() => localDb.set(key, next));
    void disk.current.catch((e) => setError(String(e)));
  }
  const active =
    preview?.candidates.filter((c) => c.selected && c.action !== "skip") ?? [];
  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button className="settings-button" onClick={() => setOpen(true)}>
        Word 가져오기
      </button>
      {open &&
        createPortal(
          <div
            className="modal-backdrop data-dialog-backdrop"
            onClick={() => {
              if (!busy) setOpen(false);
            }}
          >
            <section
              ref={dialog}
              className="modal data-dialog word-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="word-title"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  if (!busy) setOpen(false);
                }
              }}
            >
              <div className="modal-title">
                <h2 id="word-title">Word 가져오기</h2>
                <button
                  className="icon-button"
                  aria-label="Word 가져오기 닫기"
                  aria-disabled={busy}
                  onClick={() => {
                    if (!busy) setOpen(false);
                  }}
                >
                  <X size={19} />
                </button>
              </div>
              <label className="settings-button">
                Word 문서 선택
                <input
                  type="file"
                  accept=".docx"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file)
                      void run(async () => {
                        const existing = account
                          ? (await activeDriveRepository().list()).map(
                              (row) => row.idea,
                            )
                          : ideas;
                        const value = await parseDocx(file, owner, existing);
                        change(value);
                        setWarnings(false);
                        setMerge(false);
                      });
                    e.target.value = "";
                  }}
                />
              </label>
              {saved && !preview && (
                <button
                  className="settings-button"
                  onClick={() => change(saved)}
                >
                  저장된 Word 미리보기로 재개 · {saved.fileName}
                </button>
              )}
              {!account && (
                <p>
                  미리보기는 업로드하지 않습니다. 실제 가져오기는 Google Drive
                  연결 후 승인할 수 있습니다.
                </p>
              )}
              {preview && (
                <>
                  <p>
                    {preview.fileName} · {preview.candidates.length}개 · 선택{" "}
                    {active.length}개
                  </p>
                  {preview.warnings.map((w, i) => (
                    <p key={i} role="alert">
                      {w}
                    </p>
                  ))}
                  {preview.candidates.map((c, index) => {
                    const duplicates = duplicateCandidates(c.idea, ideas);
                    return (
                      <fieldset
                        className="word-candidate"
                        key={c.key}
                        disabled={busy}
                      >
                        <legend>
                          <label>
                            <input
                              type="checkbox"
                              checked={c.selected}
                              onChange={(e) =>
                                change({
                                  ...preview,
                                  candidates: preview.candidates.map((v) =>
                                    v.key === c.key
                                      ? { ...v, selected: e.target.checked }
                                      : v,
                                  ),
                                })
                              }
                            />
                            항목 {index + 1}
                          </label>
                        </legend>
                        <label>
                          제목
                          <input
                            aria-label={`항목 ${index + 1} 제목`}
                            disabled={c.action === "merge"}
                            value={c.idea.title}
                            maxLength={200}
                            onChange={(e) =>
                              change({
                                ...preview,
                                candidates: preview.candidates.map((v) =>
                                  v.key === c.key
                                    ? {
                                        ...v,
                                        idea: {
                                          ...v.idea,
                                          title: e.target.value,
                                        },
                                      }
                                    : v,
                                ),
                              })
                            }
                          />
                        </label>
                        <div className="word-body">
                          {c.idea.plain_text || "설명 없음"}
                        </div>
                        <div className="word-images">
                          {c.idea.images.map((im) => (
                            <img
                              key={im.id}
                              src={im.storage_path}
                              alt={im.original_filename}
                            />
                          ))}
                        </div>
                        <small>
                          이미지 {c.idea.images.length}개 · 중복 후보{" "}
                          {duplicates.length}개
                        </small>
                        {c.warnings.map((w, i) => (
                          <p key={i} role="alert">
                            {w}
                          </p>
                        ))}
                        <label>
                          <input
                            type="checkbox"
                            aria-label={`항목 ${index + 1} 완료`}
                            disabled={c.action === "merge"}
                            checked={c.idea.is_completed}
                            onChange={(e) =>
                              change({
                                ...preview,
                                candidates: preview.candidates.map((v) =>
                                  v.key === c.key
                                    ? {
                                        ...v,
                                        idea: {
                                          ...v.idea,
                                          is_completed: e.target.checked,
                                        },
                                      }
                                    : v,
                                ),
                              })
                            }
                          />
                          완료
                        </label>
                        <label>
                          가져올 폴더
                          <select
                            aria-label={`항목 ${index + 1} 폴더`}
                            disabled={c.action === "merge"}
                            value={c.folder ?? ""}
                            onChange={(e) =>
                              change({
                                ...preview,
                                candidates: preview.candidates.map((v) =>
                                  v.key === c.key
                                    ? { ...v, folder: e.target.value || null }
                                    : v,
                                ),
                              })
                            }
                          >
                            <option value="">미분류 (루트)</option>
                            {folders
                              .filter((f) => !folderTrashed(folders, f.id))
                              .map((f) => (
                                <option key={f.id} value={f.id}>
                                  {folderPath(folders, f.id)
                                    .map((p) => p.name)
                                    .join(" / ")}
                                </option>
                              ))}
                          </select>
                        </label>
                        <label>
                          중복 처리
                          <select
                            aria-label={`항목 ${index + 1} 중복 처리`}
                            value={c.action}
                            onChange={(e) =>
                              change({
                                ...preview,
                                candidates: preview.candidates.map((v) =>
                                  v.key === c.key
                                    ? {
                                        ...v,
                                        action: e.target
                                          .value as typeof c.action,
                                        mergeId:
                                          v.mergeId || duplicates[0]?.id || "",
                                      }
                                    : v,
                                ),
                              })
                            }
                          >
                            <option value="skip">건너뛰기</option>
                            <option value="add">별도 아이디어로 추가</option>
                            <option value="merge" disabled={!duplicates.length}>
                              기존 아이디어와 비교 후 병합
                            </option>
                          </select>
                        </label>
                        {c.action === "merge" && (
                          <>
                            <p>
                              병합은 기존 제목·폴더·완료 상태를 유지하고 원문과
                              이미지를 추가합니다.
                            </p>
                            <label>
                              병합 대상
                              <select
                                aria-label={`항목 ${index + 1} 병합 대상`}
                                value={c.mergeId}
                                onChange={(e) =>
                                  change({
                                    ...preview,
                                    candidates: preview.candidates.map((v) =>
                                      v.key === c.key
                                        ? { ...v, mergeId: e.target.value }
                                        : v,
                                    ),
                                  })
                                }
                              >
                                <option value="">대상 선택</option>
                                {duplicates.map((i) => (
                                  <option key={i.id} value={i.id}>
                                    {i.title}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <details>
                              <summary>기존 내용과 비교</summary>
                              <h3>기존 아이디어</h3>
                              <p className="word-body">
                                {ideas.find((i) => i.id === c.mergeId)
                                  ?.plain_text || "설명 없음"}
                              </p>
                              <h3>추가할 원문</h3>
                              <p className="word-body">
                                {c.idea.plain_text || "설명 없음"}
                              </p>
                            </details>
                          </>
                        )}
                        <label>
                          분리 시작 문단
                          <select
                            aria-label={`항목 ${index + 1} 분리 시작 문단`}
                            value={splitAt[c.key] ?? 2}
                            disabled={
                              (c.idea.content.content as unknown[]).length < 2
                            }
                            onChange={(e) =>
                              setSplitAt((prev) => ({
                                ...prev,
                                [c.key]: Number(e.target.value),
                              }))
                            }
                          >
                            {(
                              c.idea.content.content as Record<
                                string,
                                unknown
                              >[]
                            )
                              .slice(1)
                              .map((node, n) => (
                                <option key={n} value={n + 2}>
                                  {n + 2}.{" "}
                                  {node.type === "ideaImage"
                                    ? "이미지"
                                    : nodeText(node).slice(0, 60) || "빈 문단"}
                                </option>
                              ))}
                          </select>
                        </label>
                        <div className="word-structure-actions">
                          <button
                            disabled={
                              (c.idea.content.content as unknown[]).length < 2
                            }
                            onClick={() => {
                              const nodes = c.idea.content.content as Record<
                                string,
                                unknown
                              >[];
                              const cut = splitAt[c.key] ?? 2;
                              if (
                                !Number.isInteger(cut) ||
                                cut < 2 ||
                                cut > nodes.length
                              )
                                return;
                              void run(async () => {
                                const after = nodes.slice(cut - 1),
                                  before = nodes.slice(0, cut - 1),
                                  newKey = `${c.key}-split-${cut}`;
                                const ids = (ns: Record<string, unknown>[]) =>
                                  ns
                                    .filter((n) => n.type === "ideaImage")
                                    .map((n) => (n.attrs as { id: string }).id);
                                const nodeText = (
                                  n: Record<string, unknown>,
                                ): string =>
                                  typeof n.text === "string"
                                    ? n.text
                                    : Array.isArray(n.content)
                                      ? n.content
                                          .map((child) =>
                                            nodeText(
                                              child as Record<string, unknown>,
                                            ),
                                          )
                                          .join("")
                                      : n.type === "hardBreak"
                                        ? "\n"
                                        : "";
                                const plain = (ns: Record<string, unknown>[]) =>
                                  ns
                                    .filter((n) => n.type !== "ideaImage")
                                    .map(nodeText)
                                    .join("\n");
                                const title =
                                  window.prompt(
                                    "분리한 항목 제목",
                                    nodeText(after[0]).slice(0, 80) ||
                                      c.idea.title,
                                  ) || c.idea.title;
                                const next = {
                                  ...structuredClone(c),
                                  key: newKey,
                                  idea: {
                                    ...structuredClone(c.idea),
                                    id: `word-${preview.fileHash.slice(0, 24)}-${newKey}`,
                                    title,
                                    content: { type: "doc", content: after },
                                    plain_text: plain(after),
                                    images: c.idea.images.filter((i) =>
                                      ids(after).includes(i.id),
                                    ),
                                  },
                                };
                                next.idea.provenance = {
                                  ...next.idea.provenance!,
                                  source_id: newKey,
                                  fingerprint: await digest(
                                    JSON.stringify(after),
                                  ),
                                };
                                change({
                                  ...preview,
                                  candidates: preview.candidates.flatMap((v) =>
                                    v.key === c.key
                                      ? [
                                          {
                                            ...c,
                                            idea: {
                                              ...c.idea,
                                              content: {
                                                type: "doc",
                                                content: before,
                                              },
                                              plain_text: plain(before),
                                              images: c.idea.images.filter(
                                                (i) =>
                                                  ids(before).includes(i.id),
                                              ),
                                            },
                                          },
                                          next,
                                        ]
                                      : [v],
                                  ),
                                });
                              });
                            }}
                          >
                            항목 분리
                          </button>
                          {index < preview.candidates.length - 1 && (
                            <button
                              onClick={() => {
                                const next = preview.candidates[index + 1];
                                if (
                                  c.idea.images.length +
                                    next.idea.images.length >
                                  12
                                ) {
                                  setError(
                                    "합친 항목의 이미지가 12장을 넘습니다.",
                                  );
                                  return;
                                }
                                change({
                                  ...preview,
                                  candidates: preview.candidates
                                    .filter((v) => v.key !== next.key)
                                    .map((v) =>
                                      v.key === c.key
                                        ? {
                                            ...v,
                                            idea: {
                                              ...v.idea,
                                              content: {
                                                type: "doc",
                                                content: [
                                                  ...(v.idea.content
                                                    .content as unknown[]),
                                                  {
                                                    type: "paragraph",
                                                    content: [
                                                      {
                                                        type: "text",
                                                        text: next.idea.title,
                                                      },
                                                    ],
                                                  },
                                                  ...(next.idea.content
                                                    .content as unknown[]),
                                                ],
                                              },
                                              plain_text: [
                                                v.idea.plain_text,
                                                next.idea.title,
                                                next.idea.plain_text,
                                              ].join("\n"),
                                              images: [
                                                ...v.idea.images,
                                                ...next.idea.images,
                                              ],
                                              links: [
                                                ...v.idea.links,
                                                ...next.idea.links,
                                              ],
                                            },
                                            warnings: [
                                              ...v.warnings,
                                              ...next.warnings,
                                            ],
                                            sourceKeys: [
                                              ...new Set([
                                                ...(v.sourceKeys ?? [v.key]),
                                                ...(next.sourceKeys ?? [
                                                  next.key,
                                                ]),
                                              ]),
                                            ],
                                          }
                                        : v,
                                    ),
                                });
                              }}
                            >
                              다음 항목과 합치기
                            </button>
                          )}
                        </div>
                      </fieldset>
                    );
                  })}
                  {(preview.warnings.length > 0 ||
                    active.some((c) => c.warnings.length > 0)) && (
                    <label className="migration-source">
                      <input
                        type="checkbox"
                        checked={warnings}
                        disabled={busy}
                        onChange={(e) => setWarnings(e.target.checked)}
                      />
                      지원하지 않는 내용·이미지 경고를 확인했고, 원본 DOCX를
                      포함한 백업을 보관한 뒤 가져오는 데 동의합니다.
                    </label>
                  )}
                  {active.some((c) => c.action === "merge") && (
                    <label className="migration-source">
                      <input
                        type="checkbox"
                        checked={merge}
                        disabled={busy}
                        onChange={(e) => setMerge(e.target.checked)}
                      />
                      비교한 기존 아이디어에 원문을 추가 병합하도록 명시적으로
                      승인합니다.
                    </label>
                  )}
                  <button
                    className="primary"
                    disabled={busy || !account || pending > 0 || !active.length}
                    onClick={() =>
                      void run(async () => {
                        await disk.current;
                        const result = await importWord(
                          preview,
                          ideas,
                          folders,
                          activeDriveRepository(),
                          {
                            account: account!,
                            file: preview.fileHash,
                            warnings,
                            merge,
                          },
                          setProgress,
                        );
                        setProgress(result);
                        await onRefresh();
                      })
                    }
                  >
                    {progress?.state === "failed"
                      ? "실패 지점부터 Word 가져오기 재시도 승인"
                      : "복구 백업 생성 후 선택 항목 가져오기 승인"}
                  </button>
                  {pending > 0 && <p>미저장 변경 사항을 먼저 동기화하세요.</p>}
                </>
              )}
              {busy && (
                <p role="status">
                  처리 중입니다. 원본 파일은 변경하지 않습니다.
                </p>
              )}
              {progress && (
                <p role="status">
                  {progress.state === "verified"
                    ? "Drive 문서·이미지 재조회 검증 완료"
                    : progress.state === "failed"
                      ? "실패 · 복구 백업과 원본 보존"
                      : "업로드 중"}{" "}
                  · {progress.done.length}/{progress.total}개 확인
                </p>
              )}
              {error && <p role="alert">{error}</p>}
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
