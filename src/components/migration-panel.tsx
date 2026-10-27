"use client";
import { useEffect, useRef, useState } from "react";
import { inspectLegacy, Inspection } from "@/lib/discovery";
import { activeDriveRepository } from "@/lib/drive";
import { dataUrl, readImage } from "@/lib/images";
import { localDb } from "@/lib/local-db";
import {
  ImportSource,
  importAdapters,
  jsonSources,
  MigrationBackup,
  MigrationProgress,
  migrate,
  prepareBackup,
  restoreDemoBackup,
  validateBackup,
} from "@/lib/migration";

export function downloadJson(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function MigrationPanel({
  account,
  demo,
  pending,
  onRefresh,
}: {
  account?: string;
  demo: boolean;
  pending: number;
  onRefresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [inspection, setInspection] = useState<Inspection[]>([]);
  const [imports, setImports] = useState<ImportSource[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [backup, setBackup] = useState<MigrationBackup | null>(null);
  const [savedBackups, setSavedBackups] = useState<MigrationBackup[]>([]);
  const [progress, setProgress] = useState<MigrationProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [downloaded, setDownloaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [originalImport, setOriginalImport] = useState<unknown>();
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const currentAccount = useRef(account);
  currentAccount.current = account;
  const sources = [
    ...inspection.flatMap((i) => (i.source?.ideas.length ? [i.source] : [])),
    ...imports,
  ];
  const optionKey = (source: ImportSource, index: number) =>
    `${source.id}:${index}`;
  const count = new Set(
    sources
      .filter((s, index) => selected.includes(optionKey(s, index)))
      .flatMap((s) => s.ideas.map((i) => i.id)),
  ).size;
  async function scan() {
    const rows = await inspectLegacy();
    setInspection(rows);
    setSelected([]);
    setBackup(null);
    setDownloaded(false);
    setSavedBackups(
      (await localDb.entries<MigrationBackup>("backup:")).map(
        ([, value]) => value,
      ),
    );
    return rows;
  }
  useEffect(() => {
    setBackup(null);
    setDownloaded(false);
    setProgress(null);
    setError("");
    void scan()
      .then((rows) => {
        if (account && rows.some((r) => r.source?.ideas.length)) setOpen(true);
      })
      .catch((e) => setError(String(e)));
  }, [account]);
  async function task(run: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await run();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="migration-panel" aria-label="데이터 이전 및 복구">
      <button
        className="text-button"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen(!open)}
      >
        기존 데이터 이전 · 백업 · 가져오기
      </button>
      {open && (
        <div>
          <h2>기존 데이터를 안전하게 가져오기</h2>
          <p>
            체험 데이터와 휴지통을 포함해 조사합니다. 원본은 그대로 보존합니다.
            다른 사이트 주소나 브라우저의 데이터는 해당 환경에서 백업해
            가져오세요.
          </p>
          <button
            className="settings-button"
            disabled={busy}
            onClick={() =>
              void task(async () => {
                await scan();
              })
            }
          >
            저장소 다시 조사
          </button>
          {account && sources.some((s) => s.id === "demo") && (
            <button
              className="settings-button"
              disabled={busy}
              onClick={() =>
                void task(async () => {
                  const index = sources.findIndex((s) => s.id === "demo");
                  const trial = sources[index];
                  setSelected([optionKey(trial, index)]);
                  setBackup(await prepareBackup([trial], readImage, dataUrl));
                  setDownloaded(false);
                  setProgress(null);
                })
              }
            >
              체험 모드 데이터를 Google Drive로 이전
            </button>
          )}
          <ul>
            {inspection.map((row, index) => (
              <li key={index}>
                <strong>{row.label}</strong> ·{" "}
                {
                  {
                    found: "데이터 있음",
                    empty: "비어 있음",
                    unavailable: "확인 필요",
                    invalid: "검토 필요",
                  }[row.state]
                }
                <p>{row.detail}</p>
              </li>
            ))}
          </ul>
          <label className="settings-button">
            JSON 백업 파일 확인
            <input
              type="file"
              accept=".json,application/json"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                void task(async () => {
                  const value = JSON.parse(await file.text());
                  if (value.schema === "ideadock-migration-v1") {
                    await validateBackup(value, readImage);
                    await localDb.set(`backup:${value.id}`, value);
                    setBackup(value);
                    setDownloaded(false);
                  } else {
                    const adapter = importAdapters.find((a) => a.accepts(file));
                    if (!adapter)
                      throw new Error("지원하지 않는 가져오기 형식입니다.");
                    const preview = await adapter.preview(file);
                    setOriginalImport(value);
                    setDraft(
                      JSON.stringify(
                        preview.map((s) => ({ ...s, raw: undefined })),
                        null,
                        2,
                      ),
                    );
                    setBackup(null);
                    setDownloaded(false);
                  }
                });
                e.target.value = "";
              }}
            />
          </label>
          {draft && (
            <div>
              <label>
                가져오기 미리보기 · 제목, 본문, 상태와 항목 구성을 수정할 수
                있습니다.
                <textarea
                  aria-label="가져오기 미리보기"
                  rows={10}
                  value={draft}
                  disabled={busy}
                  onChange={(e) => setDraft(e.target.value)}
                />
              </label>
              <button
                disabled={busy}
                className="settings-button"
                onClick={() =>
                  void task(async () => {
                    const edited = JSON.parse(draft) as ImportSource[];
                    if (!Array.isArray(edited))
                      throw new Error("가져오기 항목 배열이 필요합니다.");
                    const accepted = edited.flatMap((s) =>
                      jsonSources({ ideas: s.ideas }, "json"),
                    );
                    setImports(
                      accepted.map((s) => ({ ...s, raw: originalImport })),
                    );
                    setSelected([]);
                    setBackup(null);
                    setDownloaded(false);
                    setDraft("");
                  })
                }
              >
                수정한 결과 확인
              </button>
            </div>
          )}
          {sources.map((source, index) => (
            <label className="migration-source" key={`${source.id}:${index}`}>
              <input
                type="checkbox"
                checked={selected.includes(optionKey(source, index))}
                disabled={busy}
                onChange={(e) => {
                  const key = optionKey(source, index);
                  setSelected((prev) =>
                    e.target.checked
                      ? [...prev, key]
                      : prev.filter((id) => id !== key),
                  );
                  setBackup(null);
                  setDownloaded(false);
                }}
              />
              {source.label} · {source.ideas.length}개 · 휴지통{" "}
              {source.ideas.filter((i) => i.deleted_at).length}개 · 이미지{" "}
              {source.ideas.reduce((n, i) => n + i.images.length, 0)}개
            </label>
          ))}
          <button
            className="settings-button"
            disabled={busy || count === 0}
            onClick={() =>
              void task(async () => {
                const prepared = await prepareBackup(
                  sources.filter((s, index) =>
                    selected.includes(optionKey(s, index)),
                  ),
                  readImage,
                  dataUrl,
                );
                setBackup(prepared);
                setDownloaded(false);
                setProgress(null);
                setSavedBackups(
                  (await localDb.entries<MigrationBackup>("backup:")).map(
                    ([, value]) => value,
                  ),
                );
              })
            }
          >
            선택한 {count}개 무결성 검사 및 복구 백업 만들기
          </button>
          {savedBackups.length > 0 && (
            <label>
              보관된 백업에서 재개
              <select
                aria-label="보관된 이전 백업"
                disabled={busy}
                value={backup?.id ?? ""}
                onChange={(e) => {
                  setBackup(
                    savedBackups.find((b) => b.id === e.target.value) ?? null,
                  );
                  setDownloaded(false);
                  setProgress(null);
                }}
              >
                <option value="">백업 선택</option>
                {savedBackups.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.id.slice(0, 12)} ·{" "}
                    {
                      new Set(
                        b.sources.flatMap((s) => s.ideas.map((i) => i.id)),
                      ).size
                    }
                    개
                  </option>
                ))}
              </select>
            </label>
          )}
          {backup && (
            <div>
              <p>
                이전할 아이디어{" "}
                <strong>
                  {
                    new Set(
                      backup.sources.flatMap((s) => s.ideas.map((i) => i.id)),
                    ).size
                  }
                  개
                </strong>{" "}
                · 이미지 원본 {backup.images.length}개 ·{" "}
                {account
                  ? `대상 계정: ${account}`
                  : "Google 로그인 후 이전할 수 있습니다."}
              </p>
              <button
                className="settings-button"
                disabled={busy}
                onClick={() => {
                  downloadJson(
                    backup,
                    `ideadock-recovery-${backup.id.slice(0, 12)}.json`,
                  );
                }}
              >
                이미지 포함 복구 백업 다운로드
              </button>
              <label className="migration-source">
                <input
                  type="checkbox"
                  checked={downloaded}
                  disabled={busy}
                  onChange={(e) => setDownloaded(e.target.checked)}
                />
                복구 백업 파일을 내려받아 보관했습니다.
              </label>
              {!account && (
                <button
                  className="settings-button"
                  disabled={busy || !downloaded || demo}
                  onClick={() =>
                    void task(async () => {
                      const count = await restoreDemoBackup(
                        backup,
                        localStorage,
                        readImage,
                      );
                      setRecoveryMessage(
                        `${count}개 복구 완료. 체험 모드를 나갔다가 다시 열면 확인할 수 있습니다. 기존 체험 아이디어는 보존되었습니다.`,
                      );
                    })
                  }
                >
                  복구 백업을 체험 모드에 병합 승인
                </button>
              )}
              {!account && demo && (
                <p>
                  체험 모드를 나간 후 복구할 수 있습니다. 복구 전에 다른
                  IdeaDock 탭을 닫아 주세요.
                </p>
              )}
              <button
                className="primary"
                disabled={busy || !account || !downloaded || pending > 0}
                onClick={() =>
                  void task(async () => {
                    const target = account!;
                    const result = await migrate(
                      backup,
                      activeDriveRepository(),
                      { account: target, backup: backup.id },
                      readImage,
                      (p) => {
                        if (currentAccount.current === target) setProgress(p);
                      },
                    );
                    if (currentAccount.current === target) {
                      setProgress(result);
                      await onRefresh();
                    }
                  })
                }
              >
                {progress?.state === "failed"
                  ? "이전 재시도 승인"
                  : "Google Drive로 데이터 이전 승인"}
              </button>
              {pending > 0 && (
                <p>현재 변경 내용을 먼저 저장한 후 이전하세요.</p>
              )}
            </div>
          )}
          {account && (
            <div className="migration-options">
              <button
                className="settings-button"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                이전하지 않고 기존 Google Drive 데이터 사용
              </button>
              <button
                className="settings-button"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                나중에 이전
              </button>
            </div>
          )}
          {busy && (
            <p role="status">
              백업 또는 이전을 진행 중입니다. 창을 닫지 마세요.
            </p>
          )}
          {progress && (
            <p role="status">
              {progress.state === "verified"
                ? "이전 및 서버 재조회 검증 완료. 원본과 복구 백업은 보존되었습니다. 다른 기기에서도 확인해 주세요."
                : `${progress.verified.length}개 확인 · ${progress.state === "failed" ? "실패 지점부터 재시도할 수 있습니다." : "진행 중"}`}
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          {recoveryMessage && <p role="status">{recoveryMessage}</p>}
          <small>
            Word 가져오기는 추후 제목·설명·이미지·구분선 분리 및 편집 가능한
            미리보기로 확장됩니다.
          </small>
        </div>
      )}
    </section>
  );
}
