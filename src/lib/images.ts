import { activeDriveRepository } from "./drive";
import { digest } from "./integrity";
import { localDb } from "./local-db";
import { supabase } from "./supabase";
import { validateImage } from "./model";

// Thumbnails of the same picture, or the same picture in many ideas, share one
// read; a failure is forgotten so the next attempt starts fresh.
const reading = new Map<string, Promise<Blob>>();
const DOWNLOADS = 4;
let downloading = 0;
const waiting: (() => void)[] = [];
async function throttled<T>(task: () => Promise<T>): Promise<T> {
  while (downloading >= DOWNLOADS)
    await new Promise<void>((resolve) => waiting.push(resolve));
  downloading++;
  try {
    return await task();
  } finally {
    downloading--;
    waiting.shift()?.();
  }
}
export function readImage(path: string): Promise<Blob> {
  if (!path.startsWith("drive-sha:")) return readImageUncached(path);
  const key = `${activeDriveRepository().account}:${path}`;
  let read = reading.get(key);
  if (!read) {
    read = readImageUncached(path).finally(() => reading.delete(key));
    reading.set(key, read);
  }
  return read;
}
async function readImageUncached(path: string): Promise<Blob> {
  if (/^data:image\/(png|jpeg|webp|gif);base64,/.test(path)) {
    const response = await fetch(path);
    const blob = await response.blob();
    validateImage(blob);
    return blob;
  }
  if (path.startsWith("drive-sha:")) {
    const hash = path.slice(10);
    const repo = activeDriveRepository();
    const cached = await localDb.get<Blob>(`${repo.account}:image:${hash}`);
    if (cached && (await digest(cached)) === hash) return cached;
    return throttled(async () => {
      const file = (await repo.remote.list("image", hash)).find(
        (f) => f.appProperties.key === hash,
      );
      if (!file) throw new Error("Drive에서 첨부 이미지를 찾지 못했습니다.");
      const blob = await repo.remote.read(file.id);
      if ((await digest(blob)) !== hash) throw new Error("이미지 체크섬 오류");
      await localDb.set(`${repo.account}:image:${hash}`, blob);
      return blob;
    });
  }
  if (!supabase)
    throw new Error(
      "기존 이미지 원본을 읽으려면 Supabase 연결과 기존 계정 로그인이 필요합니다.",
    );
  const result = await supabase.storage.from("idea-images").download(path);
  if (result.error)
    throw new Error(`기존 이미지 다운로드 실패: ${result.error.message}`);
  validateImage(result.data);
  return result.data;
}
export async function imageUrl(path: string) {
  return URL.createObjectURL(await readImage(path));
}
export async function uploadDriveImage(blob: Blob) {
  validateImage(blob);
  const repo = activeDriveRepository();
  const { hash } = await repo.put("image", blob);
  await localDb.set(`${repo.account}:image:${hash}`, blob);
  return `drive-sha:${hash}`;
}
export function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
