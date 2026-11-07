/**
 * 后处理管线（M2）：校验 → 分组 → 整组同质化 → concat → 输出校验 → 原子替换。
 *
 * 三条硬约束（docs/03 §8）：
 * ① 产物先写 `.tmp-`，校验全过才 rename —— 重合并失败不许毁掉已有产物；
 * ② 源 TS 只在显式 `cleanupSources` 且全部成功时删除；
 * ③ 同一会话并发触发返回 busy（否则两个 ffmpeg 写同一个输出）。
 */
import type { Postprocess, Store } from '@tidewatch/store';
import type { CapturePort, EngineFs, ProbePort } from './engine.ts';
import * as copy from './copy.ts';
import type { Draft } from './copy.ts';
import { dirName, joinPath, MANIFEST_NAME, baseName } from './layout.ts';
import { parseManifest } from './manifest.ts';
import { concatArgs, remuxArgs } from './ffmpeg.ts';
import {
  concatListContent,
  durationAcceptable,
  planMerge,
  resolveFaststart,
  toMergeSegment,
  type MergeSegment,
} from './merge.ts';

export interface PostprocessDeps {
  store: Store;
  fs: EngineFs;
  capture: CapturePort;
  probe: ProbePort;
  onDraft?: (draft: Draft, ctx: { taskId: string | null; sessionId: string }) => void;
  logger?: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
}

export interface PostprocessOptions {
  /** 显式要求清理源分段（唯一不可逆操作，自动收尾恒不开启） */
  cleanupSources?: boolean;
  /** 显式指定 faststart；缺省按设置里的 auto/on/off */
  faststart?: boolean;
}

export type PostprocessStatus = 'completed' | 'failed' | 'skipped' | 'busy';

export interface PostprocessResult {
  status: PostprocessStatus;
  outputs: string[];
  reason?: string;
}

/**
 * 读一个会话的可用分段：`segments` 表为主，表里没有的由 manifest 补齐
 * （库丢了/恢复扫描没登记也能合），最后用磁盘上的真实大小核对一遍。
 *
 * 导出而非留在类里：跨会话合并要用同一份"什么算可用分段"的判断，
 * 两份实现早晚会在 `integrity` 的细节上分叉。
 */
export async function loadSessionInputs(
  deps: { store: Store; fs: EngineFs },
  sessionId: string,
  outputDir: string,
): Promise<MergeSegment[]> {
  const rows = deps.store.listSegments(sessionId);
  const byPath = new Map<string, MergeSegment>();
  for (const row of rows) byPath.set(row.path, toMergeSegment(row));

  const manifestText = await deps.fs.readText(joinPath(outputDir, MANIFEST_NAME));
  if (manifestText !== null) {
    try {
      const manifest = parseManifest(JSON.parse(manifestText));
      for (const s of manifest?.segments ?? []) {
        const path = /^[A-Za-z]:[\\/]|^\//.test(s.file) ? s.file : joinPath(outputDir, s.file);
        if (byPath.has(path)) continue;
        byPath.set(path, {
          id: `${sessionId}:${String(s.part_no)}`,
          path,
          partNo: s.part_no,
          durationS: s.duration_s,
          sizeBytes: s.size_bytes,
          layoutHash: s.layout_hash,
          integrity: s.integrity,
          height: s.video?.height ?? null,
        } satisfies MergeSegment);
      }
    } catch {
      /* manifest 坏了不阻断：以表为准 */
    }
  }

  const usable: MergeSegment[] = [];
  for (const seg of byPath.values()) {
    if (!(await deps.fs.exists(seg.path))) continue;
    const size = await deps.fs.statSize(seg.path);
    // 录制期记录的 size 与磁盘不符 → 按 partial 处理（先规范化再入列）
    usable.push({
      ...seg,
      sizeBytes: size,
      durationS: seg.durationS > 0 ? seg.durationS : 0,
      integrity: seg.integrity === 'ok' && seg.sizeBytes !== size ? 'partial' : seg.integrity,
    });
  }
  return usable.sort((a, b) => a.partNo - b.partNo);
}


export class PostProcessor {
  readonly #d: PostprocessDeps;
  readonly #busy = new Set<string>();
  #chain: Promise<unknown> = Promise.resolve();

  constructor(deps: PostprocessDeps) {
    this.#d = deps;
  }

  /** 同一会话重复触发 → 409（PostJobs 会话级占位） */
  isBusy(sessionId: string): boolean {
    return this.#busy.has(sessionId);
  }

  processSession(sessionId: string, opts: PostprocessOptions = {}): Promise<PostprocessResult> {
    if (this.#busy.has(sessionId)) {
      return Promise.resolve({ status: 'busy', outputs: [], reason: '该会话已有后处理在跑' });
    }
    this.#busy.add(sessionId);
    const run = this.#chain.then(() => this.#doProcess(sessionId, opts));
    this.#chain = run.catch(() => undefined);
    return run.finally(() => this.#busy.delete(sessionId));
  }

  async #doProcess(sessionId: string, opts: PostprocessOptions): Promise<PostprocessResult> {
    const session = this.#d.store.getSession(sessionId);
    if (session === undefined) return { status: 'failed', outputs: [], reason: '会话不存在' };
    const task = this.#d.store.getTask(session.taskId);
    const strategy: Postprocess = task?.postprocess ?? 'merge';
    if (strategy === 'manual' && opts.cleanupSources !== true) {
      this.#emit('postprocess.skipped', { reason: 'manual' }, session.taskId, sessionId);
      return { status: 'skipped', outputs: [], reason: 'manual' };
    }

    const inputs = await loadSessionInputs(this.#d, sessionId, session.outputDir);
    if (inputs.length === 0) {
      this.#emit('merge.skipped', { reason: 'no_usable_segment' }, session.taskId, sessionId);
      this.#draft(copy.mergeSkipped({ reason: 'no_usable_segment' }), session.taskId, sessionId);
      return { status: 'skipped', outputs: [], reason: 'no_usable_segment' };
    }

    const settings = this.#d.store.getSettings();
    const totalBytes = inputs.reduce((sum, s) => sum + s.sizeBytes, 0);
    const freeBytes = await this.#d.fs.freeBytes(session.outputDir);
    const faststart =
      opts.faststart ??
      resolveFaststart(settings.faststart, totalBytes, settings.faststartThresholdMb);

    const plan = planMerge({
      sessionId,
      streamerName: task?.streamerName ?? null,
      startedAt: new Date(session.startedAt),
      outputDir: session.outputDir,
      strategy,
      faststart,
      segments: inputs,
      freeBytes,
    });

    if (plan.skipped !== null) {
      this.#emit(
        'merge.skipped',
        {
          reason: plan.skipped.reason,
          needed_bytes: plan.skipped.neededBytes ?? null,
          free_bytes: plan.skipped.freeBytes ?? null,
        },
        session.taskId,
        sessionId,
      );
      this.#draft(
        copy.mergeSkipped({
          reason: plan.skipped.reason,
          neededBytes: plan.skipped.neededBytes ?? 0,
          freeBytes: plan.skipped.freeBytes ?? 0,
        }),
        session.taskId,
        sessionId,
      );
      return { status: 'skipped', outputs: [], reason: plan.skipped.reason };
    }

    this.#emit(
      'merge.started',
      {
        outputs: plan.outputs.length,
        segments: inputs.length,
        estimated_bytes: plan.estimatedBytes,
        faststart,
      },
      session.taskId,
      sessionId,
    );

    const produced: string[] = [];
    const intermediates: string[] = [];
    try {
      for (const output of plan.outputs) {
        let parts = output.parts;
        if (output.normalize) {
          parts = await this.#normalizeGroup(output.parts, intermediates);
        }
        const listFile = joinPath(dirName(output.path), `.concat-${baseName(output.path)}.txt`);
        await this.#d.fs.writeText(listFile, concatListContent(parts));
        intermediates.push(listFile);

        const expected = parts.reduce((sum, p) => sum + p.durationS, 0);
        const run = await this.#run(concatArgs({ listFile, outFile: output.tmpPath, faststart: output.faststart }));
        if (run.code !== 0) throw new Error(`ffmpeg concat 失败（rc=${String(run.code)}）：${run.stderr.slice(-300)}`);

        const probed = await this.#d.probe.probe(output.tmpPath);
        if (probed !== null && !durationAcceptable(probed.durationS, expected)) {
          throw new Error(`产物时长异常（${probed.durationS.toFixed(2)}s vs ${expected.toFixed(2)}s）`);
        }

        // 校验通过才原子替换正式文件
        await this.#d.fs.move(output.tmpPath, output.path);
        const size = await this.#d.fs.statSize(output.path);
        this.#d.store.upsertArtifact({
          sessionId,
          path: output.path,
          kind: strategy === 'per_segment' ? 'per_segment' : 'merged',
          durationS: probed?.durationS ?? expected,
          sizeBytes: size,
          createdAt: new Date().toISOString(),
        });
        produced.push(output.path);
        this.#emit(
          'merge.completed',
          { path: output.path, duration_s: probed?.durationS ?? expected, size_bytes: size },
          session.taskId,
          sessionId,
        );
        this.#draft(
          copy.mergeCompleted({
            file: baseName(output.path),
            durationS: probed?.durationS ?? expected,
            sizeBytes: size,
          }),
          session.taskId,
          sessionId,
        );
      }

      this.#logInfo(`合并完成：${String(produced.length)} 个产物`, { sessionId });

      if (opts.cleanupSources === true) {
        await this.#cleanupSources(sessionId, inputs);
      }
      return { status: 'completed', outputs: produced };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 失败只动 tmp：已有正式产物一滴不碰
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
      this.#emit('merge.failed', { message }, session.taskId, sessionId);
      this.#draft(copy.mergeFailed({ reason: message }), session.taskId, sessionId);
      return { status: 'failed', outputs: produced, reason: message };
    } finally {
      if (this.#d.store.getSettings().cleanupIntermediate) {
        for (const f of intermediates) await this.#d.fs.remove(f).catch(() => undefined);
      }
    }
  }

  async #normalizeGroup(parts: readonly MergeSegment[], intermediates: string[]): Promise<MergeSegment[]> {
    const out: MergeSegment[] = [];
    for (const part of parts) {
      const fixed = part.path.replace(/\.ts$/i, '.fixed.ts');
      const run = await this.#run(remuxArgs(part.path, fixed));
      if (run.code !== 0) {
        throw new Error(`整组重封装失败（${baseName(part.path)}）：${run.stderr.slice(-300)}`);
      }
      intermediates.push(fixed);
      out.push({ ...part, path: fixed });
    }
    return out;
  }

  async #cleanupSources(sessionId: string, inputs: readonly MergeSegment[]): Promise<void> {
    for (const input of inputs) {
      await this.#d.fs.remove(input.path).catch(() => undefined);
      this.#d.store.setSegmentIntegrity(input.id, 'cleaned');
    }
    this.#emit('merge.cleanup', { segments: inputs.length }, null, sessionId);
  }

  async #run(args: string[]): Promise<{ code: number | null; stderr: string }> {
    let stderr = '';
    const handle = await this.#d.capture.start({
      args,
      onStderrLine: (line) => {
        stderr += `${line}\n`;
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      },
    });
    const info = await handle.wait();
    return { code: info.code, stderr };
  }

  #emit(kind: string, payload: Record<string, unknown>, taskId: string | null, sessionId: string): void {
    try {
      this.#d.store.insertEvent({ kind, payload, taskId, sessionId });
    } catch (err) {
      this.#logWarn(`事件落库失败（${kind}）`, err);
    }
  }

  #draft(draft: Draft, taskId: string | null, sessionId: string): void {
    try {
      this.#d.onDraft?.(draft, { taskId, sessionId });
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

