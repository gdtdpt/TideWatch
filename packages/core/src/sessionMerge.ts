/**
 * 跨会话合并：把"同一场直播被切成的好几场"按时间顺序拼回一个视频。
 *
 * 与 `postprocess.ts`（单场后处理）的区别只在**输入**，三条硬约束完全一致：
 * ① 产物先写 `.tmp-`，校验通过才 rename；② 源 TS 永不动；③ 同一会话不允许
 * 被两处同时读写。输入一旦跨会话，就多出两件事必须显式处理：
 *
 * - **流参数分组**：不同 layout 的 TS 直接 concat 会在段边界按流序号错配，
 *   报 `Error muxing a packet`。按 layoutHash 分组出多个文件，而不是硬拼。
 * - **缺口标注**：直播中途关闭/断流造成的时间空洞，拼接后会"凭空消失"，
 *   画面上看不出来。缺口时长必须作为元数据带出去给界面标注。
 */
import type { MergeGap, MergeJob, MergeOutput, Store } from '@tidewatch/store';
import type { CapturePort, EngineFs, ProbePort } from './engine.ts';
import { concatArgs, remuxArgs } from './ffmpeg.ts';
import { baseName, dirName, joinPath, outputBaseName } from './layout.ts';
import {
  concatListContent,
  durationAcceptable,
  estimateNeededBytes,
  resolveFaststart,
  type MergeSegment,
  type PlannedOutput,
} from './merge.ts';
import * as copy from './copy.ts';
import type { Draft } from './copy.ts';
import { loadSessionInputs } from './postprocess.ts';

export interface SessionSource {
  id: string;
  startedAt: string;
  endedAt: string | null;
  outputDir: string;
  streamerName: string | null;
  segments: readonly MergeSegment[];
}

export interface CrossMergePlanInput {
  sessions: readonly SessionSource[];
  faststart: boolean;
  /** null/undefined = 查不出来，一律放行 */
  freeBytes?: number | null;
}

export interface CrossMergeOutput extends PlannedOutput {
  group: number;
  sessionIds: string[];
}

export type CrossMergeSkipReason = 'no_usable_segment' | 'insufficient_disk';

export interface CrossMergePlan {
  outputs: CrossMergeOutput[];
  gaps: MergeGap[];
  skipped: { reason: CrossMergeSkipReason; neededBytes?: number; freeBytes?: number } | null;
  estimatedBytes: number;
  totalSegments: number;
  totalDurationS: number;
  /** 产物根目录 = 第一场的目录（跨任务合并时以此为准） */
  outputDir: string;
}

/** 缺口小于这个值视为时钟抖动，不报（跨场间隔 1 秒内没有可感知的内容丢失） */
const GAP_EPSILON_S = 1;

const ms = (iso: string | null): number | null => {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

function groupConsecutive(flat: readonly { seg: MergeSegment; sessionId: string }[]): { seg: MergeSegment; sessionId: string }[][] {
  const groups: { seg: MergeSegment; sessionId: string }[][] = [];
  let current: { seg: MergeSegment; sessionId: string }[] = [];
  let key: string | null = null;
  for (const item of flat) {
    const k = item.seg.layoutHash ?? 'unknown';
    if (current.length === 0 || k === key) {
      current.push(item);
      key = k;
      continue;
    }
    groups.push(current);
    current = [item];
    key = k;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** 相邻两场之间的空档（墙钟）：`下一场开始 - 上一场结束` */
export function crossSessionGaps(sessions: readonly SessionSource[]): MergeGap[] {
  const ordered = [...sessions].sort((a, b) => (ms(a.startedAt) ?? 0) - (ms(b.startedAt) ?? 0));
  const gaps: MergeGap[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1];
    const next = ordered[i];
    if (prev === undefined || next === undefined) continue;
    const endedAt = ms(prev.endedAt);
    const startedAt = ms(next.startedAt);
    if (endedAt === null || startedAt === null) continue;
    const gapS = (startedAt - endedAt) / 1000;
    if (gapS <= GAP_EPSILON_S) continue;
    const lastPart = prev.segments.reduce((max, s) => Math.max(max, s.partNo), 0);
    gaps.push({
      afterSessionId: prev.id,
      afterPartNo: lastPart,
      beforeSessionId: next.id,
      durationS: Math.round(gapS * 1000) / 1000,
    });
  }
  return gaps;
}

/**
 * 规划：**先按时间序展平，再按 layoutHash 分组**。
 *
 * 分组的单位是"连续的段"，不是"一场" —— 一场内部的流参数也可能中途变化
 * （切换码率、主播换推流设置），那时同样是两个文件。
 */
export function planCrossSessionMerge(input: CrossMergePlanInput): CrossMergePlan {
  const ordered = [...input.sessions].sort((a, b) => (ms(a.startedAt) ?? 0) - (ms(b.startedAt) ?? 0));
  const first = ordered[0];
  const outputDir = first?.outputDir ?? '';
  const empty: CrossMergePlan = {
    outputs: [],
    gaps: crossSessionGaps(ordered),
    skipped: { reason: 'no_usable_segment' },
    estimatedBytes: 0,
    totalSegments: 0,
    totalDurationS: 0,
    outputDir,
  };
  if (first === undefined) return empty;

  const flat: { seg: MergeSegment; sessionId: string }[] = [];
  for (const session of ordered) {
    for (const seg of session.segments) {
      if (seg.durationS <= 0) continue;
      flat.push({ seg, sessionId: session.id });
    }
  }
  if (flat.length === 0) return empty;

  const totalBytes = flat.reduce((sum, x) => sum + Math.max(x.seg.sizeBytes, 0), 0);
  const needed = estimateNeededBytes(totalBytes);
  if (input.freeBytes !== null && input.freeBytes !== undefined && input.freeBytes < needed) {
    return {
      ...empty,
      skipped: { reason: 'insufficient_disk', neededBytes: needed, freeBytes: input.freeBytes },
      estimatedBytes: needed,
    };
  }

  const groups = groupConsecutive(flat);
  const multi = groups.length > 1;
  const base = `${outputBaseName(first.streamerName, new Date(first.startedAt))}_join`;
  const dir = outputDir.replace(/[\\/]+$/, '');

  const outputs: CrossMergeOutput[] = groups.map((group, index) => {
    // 只在一组时不留后缀：`主播_时间_join.mp4` 比 `_join_g1` 干净
    const name = multi ? `${base}_g${String(index + 1)}.mp4` : `${base}.mp4`;
    const sessionIds: string[] = [];
    for (const item of group) {
      if (!sessionIds.includes(item.sessionId)) sessionIds.push(item.sessionId);
    }
    return {
      path: `${dir}/${name}`,
      tmpPath: `${dir}/.tmp-${name}`,
      parts: group.map((x) => x.seg),
      // 一组脏，整组同质化：混源 concat 必崩（docs/03 §8）
      normalize: group.some((x) => x.seg.integrity !== 'ok'),
      faststart: input.faststart,
      group: index + 1,
      sessionIds,
    };
  });

  return {
    outputs,
    gaps: crossSessionGaps(ordered),
    skipped: null,
    estimatedBytes: needed,
    totalSegments: flat.length,
    totalDurationS: flat.reduce((sum, x) => sum + x.seg.durationS, 0),
    outputDir,
  };
}

export interface SessionMergeDeps {
  store: Store;
  fs: EngineFs;
  capture: CapturePort;
  probe: ProbePort;
  onDraft?: (draft: Draft, ctx: { taskId: string | null; sessionId: string | null }) => void;
  logger?: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
}

export interface SessionMergeResult {
  status: 'completed' | 'failed' | 'skipped' | 'busy';
  outputs: MergeOutput[];
  message?: string;
}

export class SessionMerger {
  readonly #d: SessionMergeDeps;
  /** 会话级占位：同一场的源分段不许被两处同时读（另一个合并/后处理） */
  readonly #busy = new Set<string>();
  readonly #busyJobs = new Set<string>();
  #chain: Promise<unknown> = Promise.resolve();

  constructor(deps: SessionMergeDeps) {
    this.#d = deps;
  }

  isBusy(sessionId: string): boolean {
    return this.#busy.has(sessionId);
  }

  isJobBusy(jobId: string): boolean {
    return this.#busyJobs.has(jobId);
  }

  /** 排队执行：一次只跑一个合并（多个 ffmpeg 抢同一块盘只会互相拖慢） */
  run(jobId: string): Promise<SessionMergeResult> {
    const job = this.#d.store.getMergeJob(jobId);
    if (job === undefined) return Promise.resolve({ status: 'failed', outputs: [], message: '合并任务不存在' });
    if (this.#busyJobs.has(jobId)) {
      return Promise.resolve({ status: 'busy', outputs: [], message: '该任务已在合并中' });
    }
    const takeover = job.sessionIds.filter((id) => this.#busy.has(id));
    if (takeover.length > 0) {
      return Promise.resolve({ status: 'busy', outputs: [], message: '有源会话正在被其他任务使用' });
    }
    for (const id of job.sessionIds) this.#busy.add(id);
    this.#busyJobs.add(jobId);

    const run = this.#chain.then(() => this.#doMerge(jobId));
    this.#chain = run.catch(() => undefined);
    return run.finally(() => {
      for (const id of job.sessionIds) this.#busy.delete(id);
      this.#busyJobs.delete(jobId);
    });
  }

  async #doMerge(jobId: string): Promise<SessionMergeResult> {
    const job = this.#d.store.getMergeJob(jobId);
    if (job === undefined) return { status: 'failed', outputs: [], message: '合并任务不存在' };

    const startedAt = new Date().toISOString();
    this.#d.store.updateMergeJob(jobId, { status: 'running', startedAt, progress: 0, message: null });

    const sources: SessionSource[] = [];
    for (const sessionId of job.sessionIds) {
      const session = this.#d.store.getSession(sessionId);
      if (session === undefined) return this.#fail(jobId, `会话不存在：${sessionId}`);
      if (session.endedAt === null) return this.#fail(jobId, '有会话还在录制，先停止再合并');
      const task = this.#d.store.getTask(session.taskId);
      const segments = await loadSessionInputs(this.#d, session.id, session.outputDir);
      sources.push({
        id: session.id,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        outputDir: session.outputDir,
        streamerName: task?.streamerName ?? null,
        segments,
      });
    }

    const settings = this.#d.store.getSettings();
    const first = sources[0];
    const freeBytes = await this.#d.fs.freeBytes(first?.outputDir ?? '');
    const totalBytes = sources.reduce(
      (sum, s) => sum + s.segments.reduce((n, seg) => n + Math.max(seg.sizeBytes, 0), 0),
      0,
    );
    const faststart = resolveFaststart(settings.faststart, totalBytes, settings.faststartThresholdMb);

    const plan = planCrossSessionMerge({ sessions: sources, faststart, freeBytes });
    // 通知落在"第一场"上：用户点通知能跳到最相关的那一场
    const firstSession = first === undefined ? undefined : this.#d.store.getSession(first.id);
    const ctx: MergeCtx = {
      jobId,
      taskId: firstSession?.taskId ?? null,
      sessionId: first?.id ?? null,
    };

    this.#d.store.updateMergeJob(jobId, {
      planned: plan.outputs.length,
      gaps: plan.gaps,
      progress: 0,
    });

    if (plan.skipped !== null) {
      const message =
        plan.skipped.reason === 'insufficient_disk'
          ? `磁盘空间不足：需要约 ${String(plan.skipped.neededBytes ?? 0)} 字节，可用 ${String(plan.skipped.freeBytes ?? 0)} 字节`
          : '没有可用的源分段';
      this.#emit('merge.job_skipped', { merge_job_id: jobId, reason: plan.skipped.reason }, ctx);
      this.#d.store.updateMergeJob(jobId, {
        status: 'skipped',
        message,
        endedAt: new Date().toISOString(),
      });
      this.#draft(copy.sessionsMergeSkipped({ reason: plan.skipped.reason }), ctx);
      return { status: 'skipped', outputs: [], message };
    }

    this.#emit(
      'merge.job_started',
      {
        merge_job_id: jobId,
        sessions: sources.length,
        segments: plan.totalSegments,
        outputs: plan.outputs.length,
        gaps: plan.gaps.length,
      },
      ctx,
    );

    const produced: MergeOutput[] = [];
    const intermediates: string[] = [];
    let completedDurationS = 0;
    try {
      for (const output of plan.outputs) {
        const parts = output.normalize ? await this.#normalizeGroup(output.parts, intermediates) : output.parts;
        const listFile = joinPath(dirName(output.path), `.concat-${baseName(output.path)}.txt`);
        await this.#d.fs.writeText(listFile, concatListContent(parts));
        intermediates.push(listFile);

        const expected = parts.reduce((sum, p) => sum + p.durationS, 0);
        let lastEmit = 0;
        const run = await this.#run(
          concatArgs({ listFile, outFile: output.tmpPath, faststart: output.faststart, progress: true }),
          (line) => {
            const sec = progressSeconds(line);
            if (sec === null) return;
            const now = Date.now();
            // 进度事件每 3 秒一条：太密会把 events 表刷成大水表，太疏进度条不走
            if (now - lastEmit < 3000) return;
            lastEmit = now;
            const total = Math.max(plan.totalDurationS, 1);
            const ratio = Math.min(0.999, (completedDurationS + Math.min(sec, expected)) / total);
            this.#d.store.updateMergeJob(jobId, { progress: ratio });
            this.#emit(
              'merge.job_progress',
              { merge_job_id: jobId, progress: Math.round(ratio * 1000) / 1000, group: output.group },
              ctx,
            );
          },
        );
        if (run.code !== 0) throw new Error(`ffmpeg concat 失败（rc=${String(run.code)}）：${run.stderr.slice(-300)}`);

        const probed = await this.#d.probe.probe(output.tmpPath);
        if (probed !== null && !durationAcceptable(probed.durationS, expected)) {
          throw new Error(`产物时长异常（${probed.durationS.toFixed(2)}s vs ${expected.toFixed(2)}s）`);
        }

        await this.#d.fs.move(output.tmpPath, output.path);
        const size = await this.#d.fs.statSize(output.path);
        completedDurationS += probed?.durationS ?? expected;

        const record: MergeOutput = {
          path: output.path,
          group: output.group,
          sessionIds: output.sessionIds,
          segmentCount: output.parts.length,
          durationS: probed?.durationS ?? expected,
          sizeBytes: size,
          layout: output.parts[0]?.layoutHash ?? null,
        };
        produced.push(record);
        this.#d.store.updateMergeJob(jobId, {
          outputs: produced,
          done: produced.length,
          progress: Math.min(0.999, completedDurationS / Math.max(plan.totalDurationS, 1)),
        });
      }

      const endedAt = new Date().toISOString();
      const totalS = produced.reduce((n, o) => n + o.durationS, 0);
      this.#d.store.updateMergeJob(jobId, {
        status: 'completed',
        outputs: produced,
        done: produced.length,
        progress: 1,
        endedAt,
        message: plan.outputs.length > 1 ? `流参数不同，按组产出 ${String(plan.outputs.length)} 个文件` : null,
      });
      this.#emit(
        'merge.job_completed',
        { merge_job_id: jobId, outputs: produced.length, duration_s: totalS, gaps: plan.gaps.length },
        ctx,
      );
      this.#draft(
        copy.sessionsMerged({
          sessions: sources.length,
          files: produced.length,
          durationS: totalS,
          gapS: plan.gaps.reduce((n, g) => n + g.durationS, 0),
        }),
        ctx,
      );
      this.#logInfo(`跨会话合并完成：${String(produced.length)} 个产物`, { jobId });
      return { status: 'completed', outputs: produced };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const output of plan.outputs) {
        const tmp = output.tmpPath;
        if (await this.#d.fs.exists(tmp)) {
          try {
            await this.#d.fs.move(tmp, `${tmp}.failed.mp4`);
          } catch {
            await this.#d.fs.remove(tmp).catch(() => undefined);
          }
        }
      }
      this.#emit('merge.job_failed', { merge_job_id: jobId, message }, ctx);
      this.#d.store.updateMergeJob(jobId, {
        status: 'failed',
        message,
        outputs: produced,
        endedAt: new Date().toISOString(),
      });
      this.#draft(copy.sessionsMergeFailed({ reason: message }), ctx);
      return { status: 'failed', outputs: produced, message };
    } finally {
      if (this.#d.store.getSettings().cleanupIntermediate) {
        for (const f of intermediates) await this.#d.fs.remove(f).catch(() => undefined);
      }
    }
  }

  #fail(jobId: string, message: string): SessionMergeResult {
    this.#d.store.updateMergeJob(jobId, {
      status: 'failed',
      message,
      endedAt: new Date().toISOString(),
    });
    this.#emit('merge.job_failed', { merge_job_id: jobId, message }, { jobId, taskId: null, sessionId: null });
    return { status: 'failed', outputs: [], message };
  }

  async #normalizeGroup(parts: readonly MergeSegment[], intermediates: string[]): Promise<MergeSegment[]> {
    const out: MergeSegment[] = [];
    for (const part of parts) {
      const fixed = part.path.replace(/\.ts$/i, '.fixed.ts');
      const run = await this.#run(remuxArgs(part.path, fixed));
      if (run.code !== 0) throw new Error(`整组重封装失败（${baseName(part.path)}）：${run.stderr.slice(-300)}`);
      intermediates.push(fixed);
      out.push({ ...part, path: fixed });
    }
    return out;
  }

  async #run(
    args: string[],
    onStdoutLine?: (line: string) => void,
  ): Promise<{ code: number | null; stderr: string }> {
    let stderr = '';
    const handle = await this.#d.capture.start({
      args,
      ...(onStdoutLine === undefined ? {} : { onStdoutLine }),
      onStderrLine: (line) => {
        stderr += `${line}\n`;
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      },
    });
    const info = await handle.wait();
    return { code: info.code, stderr };
  }

  #emit(kind: string, payload: Record<string, unknown>, ctx: MergeCtx): void {
    try {
      this.#d.store.insertEvent({ kind, payload, taskId: ctx.taskId, sessionId: ctx.sessionId });
    } catch (err) {
      this.#logWarn(`事件落库失败（${kind}）`, err);
    }
  }

  #draft(draft: Draft, ctx: MergeCtx): void {
    try {
      this.#d.onDraft?.(draft, { taskId: ctx.taskId, sessionId: ctx.sessionId });
    } catch (err) {
      this.#logWarn('通知派生失败', err);
    }
  }

  #logInfo(msg: string, meta?: unknown): void {
    this.#d.logger?.info(msg, meta);
  }

  #logWarn(msg: string, meta?: unknown): void {
    this.#d.logger?.warn(msg, meta);
  }
}

interface MergeCtx {
  jobId: string;
  taskId: string | null;
  sessionId: string | null;
}

/** `-progress pipe:1` 的行 → 秒；`N/A` 返回 null（还没开始写） */
export function progressSeconds(line: string): number | null {
  const [rawKey, rawValue] = line.split('=', 2);
  if (rawKey === undefined || rawValue === undefined) return null;
  if (rawKey.trim() !== 'out_time_us') return null;
  const n = Number(rawValue.trim());
  return Number.isFinite(n) && n >= 0 ? n / 1_000_000 : null;
}

/** 便于 API 层与 UI 共用：任务里所有产物的总时长 */
export function jobDurationS(job: MergeJob): number {
  return job.outputs.reduce((n, o) => n + o.durationS, 0);
}
