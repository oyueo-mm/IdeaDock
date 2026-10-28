import { ImportSource } from "./migration";
import { validateIdeas } from "./integrity";
import { DB_NAME } from "./local-db";
import { supabase } from "./supabase";
import type { Idea } from "./model";
import { validateWorkspace } from "./folders";

export type Inspection = {
  label: string;
  state: "found" | "empty" | "unavailable" | "invalid";
  detail: string;
  source?: ImportSource;
};
function sourceFromCache(
  raw: unknown,
  id: string,
  label: string,
): ImportSource {
  const cached = raw as {
    ideas: unknown;
    pending?: Record<string, { idea: Idea; seq: number }>;
  };
  validateIdeas(cached?.ideas);
  const ideas = structuredClone(cached.ideas);
  for (const pending of Object.values(cached.pending ?? {})) {
    validateIdeas([pending.idea]);
    const index = ideas.findIndex((i) => i.id === pending.idea.id);
    if (index < 0) ideas.push(pending.idea);
    else ideas[index] = pending.idea;
  }
  validateIdeas(ideas);
  return { id, label, ideas, raw };
}
export async function inspectLegacy(): Promise<Inspection[]> {
  const results: Inspection[] = [];
  try {
    const keys = Array.from({ length: localStorage.length }, (_, i) =>
      localStorage.key(i)!,
    ).filter((k) => k.startsWith("ideadock:data:"));
    if (!keys.length)
      results.push({
        label: "체험 모드 / localStorage",
        state: "empty",
        detail:
          "현재 사이트에서 기존 저장 키를 찾지 못했습니다. 다른 주소·브라우저의 데이터는 확인할 수 없습니다.",
      });
    for (const key of keys) {
      const label = key.endsWith(":demo")
        ? "체험 모드"
        : `기존 기기 초안 (${key.slice(14)})`;
      try {
        const owner = key.slice("ideadock:data:".length);
        const source = sourceFromCache(
          JSON.parse(localStorage.getItem(key)!),
          owner === "demo" ? "demo" : `local:${owner}`,
          label,
        );
        if (owner === "demo") {
          const folderRaw = localStorage.getItem("ideadock:folders:demo:v2");
          if (folderRaw) {
            source.folders = JSON.parse(folderRaw).folders;
            validateWorkspace(source.ideas, source.folders ?? []);
            source.raw = { ideas: source.raw, folders: JSON.parse(folderRaw) };
          }
        }
        results.push({
          label,
          state:
            source.ideas.length || source.folders?.length ? "found" : "empty",
          detail: `${source.ideas.length}개 (휴지통 포함)`,
          source,
        });
      } catch (error) {
        results.push({ label, state: "invalid", detail: String(error) });
      }
    }
  } catch (error) {
    results.push({
      label: "localStorage",
      state: "unavailable",
      detail: String(error),
    });
  }
  try {
    if (!indexedDB.databases)
      throw new Error(
        "이 브라우저에서는 데이터베이스 목록 조회를 지원하지 않습니다.",
      );
    const databases = (await indexedDB.databases()).filter(
      (d) => d.name && /ideadock/i.test(d.name) && d.name !== DB_NAME,
    );
    if (!databases.length)
      results.push({
        label: "기존 IndexedDB",
        state: "empty",
        detail: "IdeaDock 데이터베이스가 없습니다.",
      });
    for (const database of databases) {
      // Do not create a database if it disappears between enumeration and open.
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(database.name!);
        request.onupgradeneeded = () => {
          request.transaction?.abort();
          reject(new Error("기존 데이터베이스가 없어졌습니다."));
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () =>
          reject(new Error("다른 탭의 IndexedDB 연결을 확인하세요."));
        request.onsuccess = () => resolve(request.result);
      });
      try {
        for (const store of Array.from(db.objectStoreNames)) {
          const label = `IndexedDB ${database.name}/${store}`;
          try {
            const rows = await new Promise<unknown[]>((resolve, reject) => {
              const tx = db.transaction(store, "readonly");
              const request = tx.objectStore(store).getAll();
              tx.oncomplete = () => resolve(request.result);
              tx.onerror = tx.onabort = () => reject(tx.error);
            });
            if (!rows.length) {
              results.push({ label, state: "empty", detail: "레코드 없음" });
              continue;
            }
            let source: ImportSource;
            if (
              rows.every(
                (r) =>
                  r && typeof r === "object" && "id" in r && "content" in r,
              )
            ) {
              validateIdeas(rows);
              source = {
                id: `indexeddb:${database.name}:${store}`,
                label,
                ideas: rows,
                raw: rows,
              };
            } else if (
              rows.length === 1 &&
              rows[0] &&
              typeof rows[0] === "object" &&
              "ideas" in rows[0]
            ) {
              source = sourceFromCache(
                rows[0],
                `indexeddb:${database.name}:${store}`,
                label,
              );
            } else
              throw new Error(
                "자동 인식할 수 없는 저장 형식입니다. 원본을 보존하고 JSON으로 내보내 검토하세요.",
              );
            results.push({
              label,
              state: source.ideas.length ? "found" : "empty",
              detail: `${source.ideas.length}개`,
              source,
            });
          } catch (error) {
            results.push({ label, state: "invalid", detail: String(error) });
          }
        }
      } finally {
        db.close();
      }
    }
  } catch (error) {
    results.push({
      label: "기존 IndexedDB",
      state: "unavailable",
      detail: String(error),
    });
  }
  if (!supabase)
    results.push({
      label: "Supabase",
      state: "unavailable",
      detail:
        "기존 연결 설정이 없어 실제 데이터 존재 여부를 확인하지 못했습니다.",
    });
  else {
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      if (!data.session)
        throw new Error("기존 Supabase 계정 로그인이 필요합니다.");
      const { data: rows, error: failure } = await supabase.rpc("list_ideas");
      if (failure) throw failure;
      validateIdeas(rows ?? []);
      const source = {
        id: `supabase:${process.env.NEXT_PUBLIC_SUPABASE_URL}:${data.session.user.id}`,
        label: "Supabase",
        ideas: (rows ?? []) as Idea[],
      };
      results.push({
        label: "Supabase",
        state: source.ideas.length ? "found" : "empty",
        detail: `${source.ideas.length}개`,
        source,
      });
    } catch (error) {
      results.push({
        label: "Supabase",
        state: "unavailable",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  results.push({
    label: "JSON 백업 파일",
    state: "unavailable",
    detail:
      "파일 선택으로 확인하세요. 파일을 선택하지 않은 상태는 데이터 없음으로 간주하지 않습니다.",
  });
  return results;
}
