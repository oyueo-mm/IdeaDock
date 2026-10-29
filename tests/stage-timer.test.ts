import { describe, expect, it } from "vitest";
import {
  describeStages,
  seconds,
  StageTimer,
  type DriveStats,
} from "../src/lib/stage-timer";
import { describeProgress, type MigrationProgress } from "../src/lib/migration";

describe("StageTimer", () => {
  it("records time and the Drive requests made during each stage", async () => {
    let clock = 1000;
    const stats: DriveStats = { requests: 5, ms: 400 };
    const timer = new StageTimer(
      () => ({ ...stats }),
      () => clock,
    );
    await timer.run("저장", async () => {
      clock += 2500;
      stats.requests += 30;
      stats.ms += 2400; // requests overlapped: more request-time than wall time
    });
    await expect(
      timer.run("검증", async () => {
        clock += 100;
        stats.requests += 2;
        stats.ms += 160;
        throw new Error("fails");
      }),
    ).rejects.toThrow("fails");
    expect(timer.stages).toEqual([
      { stage: "저장", ms: 2500, requests: 30, driveMs: 2400 },
      { stage: "검증", ms: 100, requests: 2, driveMs: 160 },
    ]);
  });

  it("works with a remote that does not count requests", async () => {
    const timer = new StageTimer(
      () => undefined,
      () => 0,
    );
    await timer.run("local", async () => {});
    expect(timer.stages[0]).toMatchObject({ requests: 0, driveMs: 0 });
  });

  it("describes stages with the average response time", () => {
    expect(
      describeStages([
        { stage: "아이디어 저장", ms: 6100, requests: 84, driveMs: 6720 },
        { stage: "폴더 저장", ms: 0, requests: 0, driveMs: 0 },
      ]),
    ).toEqual([
      "아이디어 저장 · 6.1초 · 요청 84회 · 평균 응답 80ms",
      "폴더 저장 · 0.0초 · 요청 0회",
    ]);
    expect(seconds(43000)).toBe("43초");
    expect(seconds(1200)).toBe("1.2초");
  });
});

describe("describeProgress", () => {
  const base: MigrationProgress = {
    account: "a",
    backup: "b",
    verified: ["1", "2", "3"],
    state: "uploading",
    total: 27,
    stage: "아이디어 저장",
  };
  it("shows saved of total and the current step", () => {
    expect(describeProgress(base)).toBe("3/27개 저장 완료 · 아이디어 저장");
    expect(describeProgress({ ...base, stage: undefined })).toBe(
      "3/27개 저장 완료 · 준비 중",
    );
  });
  it("says how far a failed run got and that it can be retried", () => {
    expect(describeProgress({ ...base, state: "failed" })).toBe(
      "3/27개 저장 완료 · 실패 지점부터 재시도할 수 있습니다.",
    );
  });
  it("keeps the completion wording and copes with an unknown total", () => {
    expect(describeProgress({ ...base, state: "verified" })).toContain(
      "이전 및 서버 재조회 검증 완료",
    );
    expect(describeProgress({ ...base, total: undefined })).toBe(
      "3개 저장 완료 · 아이디어 저장",
    );
  });
});
