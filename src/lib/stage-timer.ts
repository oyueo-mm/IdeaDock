export type DriveStats = { requests: number; ms: number };
export type StageTiming = {
  stage: string;
  /** Wall-clock time of the stage in milliseconds. */
  ms: number;
  /** Drive requests sent during the stage (retries included). */
  requests: number;
  /** Sum of the time every Drive request took; above `ms` when requests overlap. */
  driveMs: number;
};

export const seconds = (ms: number) =>
  `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}초`;
/** One line per finished stage: "아이디어 저장 · 6.1초 · 요청 134회 · 평균 응답 82ms". */
export function describeStages(stages: StageTiming[] = []) {
  return stages.map((s) => {
    const average = s.requests
      ? ` · 평균 응답 ${Math.round(s.driveMs / s.requests)}ms`
      : "";
    return `${s.stage} · ${seconds(s.ms)} · 요청 ${s.requests}회${average}`;
  });
}

/**
 * Times the stages of a long operation and counts the Drive requests in each.
 * The Drive counters come from the remote (`GoogleDrive.stats`); a remote
 * without counters reports zero requests.
 */
export class StageTimer {
  readonly stages: StageTiming[] = [];
  constructor(
    private readonly stats: () => DriveStats | undefined,
    private readonly now: () => number = () => performance.now(),
  ) {}
  async run<T>(stage: string, task: () => Promise<T>): Promise<T> {
    const before = this.stats(),
      started = this.now();
    try {
      return await task();
    } finally {
      const after = this.stats();
      this.stages.push({
        stage,
        ms: Math.round(this.now() - started),
        requests: (after?.requests ?? 0) - (before?.requests ?? 0),
        driveMs: Math.round((after?.ms ?? 0) - (before?.ms ?? 0)),
      });
    }
  }
}
