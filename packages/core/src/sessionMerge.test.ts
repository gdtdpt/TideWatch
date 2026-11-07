/**
 * 跨会话合并：规划（纯函数）与执行（ffmpeg 替身）两侧。
 *
 * 重点锁三件容易悄悄退化的事：
 * ① 分组按 layoutHash，而不是"按场"——一场内部换码率也要分开；
 * ② 跨场空档必须被记录，拼接会把时间空洞抹平；
 * ③ 失败只动 `.tmp-`，源分段与已有产物都不许碰。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { CaptureHandle, CaptureSpec } from './engine.ts';
import type { Draft } from './copy.ts';
import { joinPath } from './layout.ts';
import { planCrossSessionMerge, SessionMerger, type SessionSource } from './sessionMerge.ts';
import type { MergeSegment } from './merge.ts';
import { makeHarness, fingerprintOf, type Harness } from './test-support.ts';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

function seg(partNo: number, layout: string, durationS = 60, integrity: MergeSegment['integrity'] = 'ok'): MergeSegment {
  return {
    id: `s${String(partNo)}`,
    path: `/out/a_part${String(partNo)}.ts`,
    partNo,
    durationS,
    sizeBytes: 1024,
    layoutHash: layout,
    integrity,
    height: 1080,
  };
}

function source(over: Partial<SessionSource> & { id: string }): SessionSource {
  return {
    startedAt: new Date(2026, 10, 1, 20, 0, 0).toISOString(),
    endedAt: new Date(2026, 10, 1, 21, 0, 0).toISOString(),
    outputDir: '/out/主播A/20261101-200000_new_aaaaaaaa',
    streamerName: '主播A',
    segments: [seg(1, 'L1')],
    ...over,
  };
}

describe('跨会话合并：规划', () => {
  it('两场同 layout → 一个产物，名字带 _join，顺序按开始时间', () => {
    const a = source({ id: 'a' });
    const b = source({
      id: 'b',
      startedAt: new Date(2026, 10, 1, 21, 5, 0).toISOString(),
      endedAt: new Date(2026, 10, 1, 22, 0, 0).toISOString(),
      segments: [seg(1, 'L1'), seg(2, 'L1')],
    });
    // 故意逆序传入：合并顺序只认开始时间
    const plan = planCrossSessionMerge({ sessions: [b, a], faststart: false });
    expect(plan.skipped).toBeNull();
    expect(plan.outputs).toHaveLength(1);
    expect(plan.outputs[0]?.path).toBe(joinPath(a.outputDir, '主播A_20261101_200000_join.mp4'));
    expect(plan.outputs[0]?.parts.map((p) => p.partNo)).toEqual([1, 1, 2]);
    expect(plan.outputs[0]?.sessionIds).toEqual(['a', 'b']);
    expect(plan.totalSegments).toBe(3);
    expect(plan.totalDurationS).toBe(180);
  });

  it('layout 变了就分组，文件名带 _gN', () => {
    const plan = planCrossSessionMerge({
      sessions: [
        source({ id: 'a', segments: [seg(1, 'avc-1080')] }),
        source({
          id: 'b',
          startedAt: new Date(2026, 10, 1, 21, 0, 30).toISOString(),
          segments: [seg(1, 'hevc-720'), seg(2, 'hevc-720')],
        }),
      ],
      faststart: false,
    });
    expect(plan.outputs.map((o) => o.path.split('/').pop())).toEqual([
      '主播A_20261101_200000_join_g1.mp4',
      '主播A_20261101_200000_join_g2.mp4',
    ]);
    expect(plan.outputs.map((o) => o.parts.length)).toEqual([1, 2]);
    expect(plan.outputs[1]?.sessionIds).toEqual(['b']);
  });

  it('同一场内部换 layout 也拆开（分组单位是段，不是场）', () => {
    const plan = planCrossSessionMerge({
      sessions: [source({ id: 'a', segments: [seg(1, 'L1'), seg(2, 'L2')] })],
      faststart: false,
    });
    expect(plan.outputs).toHaveLength(2);
  });

  it('跨场空档进 gaps；相邻（≤1s）不算缺口', () => {
    const a = source({ id: 'a', endedAt: new Date(2026, 10, 1, 20, 30, 0).toISOString(), segments: [seg(1, 'L1'), seg(2, 'L2')] });
    const b = source({
      id: 'b',
      startedAt: new Date(2026, 10, 1, 20, 32, 0).toISOString(),
      endedAt: new Date(2026, 10, 1, 21, 0, 0).toISOString(),
      segments: [seg(1, 'L1')],
    });
    const c = source({
      id: 'c',
      startedAt: new Date(2026, 10, 1, 21, 0, 0.5).toISOString(),
      segments: [seg(1, 'L1')],
    });
    const plan = planCrossSessionMerge({ sessions: [a, b, c], faststart: false });
    expect(plan.gaps).toHaveLength(1);
    expect(plan.gaps[0]).toMatchObject({ afterSessionId: 'a', beforeSessionId: 'b', afterPartNo: 2 });
    expect(plan.gaps[0]?.durationS).toBe(120);
  });

  it('没有可用分段 → skipped；空间不够 → skipped(insufficient_disk)', () => {
    const empty = planCrossSessionMerge({
      sessions: [source({ id: 'a', segments: [] }), source({ id: 'b', segments: [] })],
      faststart: false,
    });
    expect(empty.skipped?.reason).toBe('no_usable_segment');

    const tight = planCrossSessionMerge({
      sessions: [source({ id: 'a' }), source({ id: 'b' })],
      faststart: false,
      freeBytes: 1024,
    });
    expect(tight.skipped?.reason).toBe('insufficient_disk');
    expect(tight.outputs).toHaveLength(0);
  });

  it('有残缺段 → 整组重封装（混源 concat 必崩）', () => {
    const plan = planCrossSessionMerge({
      sessions: [source({ id: 'a', segments: [seg(1, 'L1')] }), source({ id: 'b', segments: [seg(1, 'L1', 60, 'partial')] })],
      faststart: false,
    });
    expect(plan.outputs[0]?.normalize).toBe(true);
  });
});

/** 假 ffmpeg：把产物写到最后一个参数，可选吐进度、可选失败 */
class SimCapture {
  fail = false;
  readonly invoked: string[][] = [];

  constructor(private readonly h: Harness) {}

  async start(spec: CaptureSpec): Promise<CaptureHandle> {
    this.invoked.push(spec.args);
    const out = spec.args[spec.args.length - 1] ?? '';
    for (const line of ['out_time_us=30000000', 'out_time_us=60000000']) spec.onStdoutLine?.(line);
    if (out.length > 0) this.h.fs.put(out, 4096);
    const code = this.fail ? 1 : 0;
    return {
      pid: undefined,
      write: () => undefined,
      kill: () => undefined,
      stop: async () => undefined,
      wait: async () => ({ code, signal: null }),
    };
  }
}

function scenario(): {
  h: Harness;
  capture: SimCapture;
  merger: SessionMerger;
  drafts: Draft[];
  jobId: string;
  sessionIds: string[];
  outputDir: string;
} {
  const h = makeHarness();
  harnesses.push(h);
  const task = h.store.addTask({ url: 'https://live.bilibili.com/1', platform: 'bilibili', streamerName: '主播A' });
  const outputDir = '/out/主播A/20261101-200000_new_aaaaaaaa';
  const sessionIds: string[] = [];
  const layouts = ['L1', 'L1'];
  for (let i = 0; i < 2; i += 1) {
    const startedAt = new Date(2026, 10, 1, 20 + i, 0, 0).toISOString();
    const id = h.store.createSession({ taskId: task.id, startedAt, outputDir, origin: 'new' });
    // 上一场正好在一小时处结束、下一场整点开始 → 无空档
    h.store.endSession(id, 'offline', new Date(2026, 10, 1, 21 + i, 0, 0).toISOString());
    const path = joinPath(outputDir, `aaaaaaaa_part${String(i + 1).padStart(3, '0')}.ts`);
    h.fs.put(path, 1024);
    h.store.insertSegment({
      sessionId: id,
      path,
      partNo: 1,
      startedAt,
      durationS: 60,
      sizeBytes: 1024,
      integrity: 'ok',
      video: { codec: 'h264', profile: 'High', width: 1920, height: 1080, pixFmt: 'yuv420p', layoutHash: layouts[i] ?? 'L1' },
      audio: { codec: 'aac', sampleRate: 44_100, channels: 2 },
    });
    sessionIds.push(id);
  }

  const drafts: Draft[] = [];
  const capture = new SimCapture(h);
  const merger = new SessionMerger({
    store: h.store,
    fs: h.fs,
    capture,
    probe: h.probe,
    onDraft: (d) => drafts.push(d),
  });
  const job = h.store.createMergeJob(sessionIds);
  return { h, capture, merger, drafts, jobId: job.id, sessionIds, outputDir };
}

describe('跨会话合并：执行', () => {
  it('拼接成功：进度到 1、产物入库到任务行、发完成通知', async () => {
    const { h, merger, drafts, jobId, outputDir } = scenario();
    h.probe.fallback = () => fingerprintOf(1920, 1080, 120);

    const result = await merger.run(jobId);
    expect(result.status).toBe('completed');

    const job = h.store.getMergeJob(jobId);
    expect(job?.status).toBe('completed');
    expect(job?.progress).toBe(1);
    expect(job?.done).toBe(1);
    expect(job?.outputs).toHaveLength(1);
    expect(job?.outputs[0]?.segmentCount).toBe(2);
    expect(job?.outputs[0]?.durationS).toBe(120);
    expect(job?.gaps).toHaveLength(0);

    const out = joinPath(outputDir, '主播A_20261101_200000_join.mp4');
    expect(h.fs.files.has(out)).toBe(true);
    expect(h.fs.files.has(joinPath(outputDir, '.tmp-主播A_20261101_200000_join.mp4'))).toBe(false);
    // 源分段永不动
    expect(h.fs.files.has(joinPath(outputDir, 'aaaaaaaa_part001.ts'))).toBe(true);

    expect(drafts.map((d) => d.kind)).toContain('sessions_merged');
    const events = h.store.listEvents({ limit: 50 }).map((e) => e.kind);
    expect(events).toContain('merge.job_started');
    expect(events).toContain('merge.job_progress');
    expect(events).toContain('merge.job_completed');
  });

  it('ffmpeg 失败：状态 failed，半截产物改名 .failed.mp4，源分段保留', async () => {
    const { h, merger, capture, jobId, outputDir } = scenario();
    capture.fail = true;
    h.probe.fallback = () => fingerprintOf(1920, 1080, 120);

    const result = await merger.run(jobId);
    expect(result.status).toBe('failed');
    const job = h.store.getMergeJob(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.message).toContain('ffmpeg concat 失败');

    const out = joinPath(outputDir, '主播A_20261101_200000_join.mp4');
    expect(h.fs.files.has(out)).toBe(false);
    expect(h.fs.files.has(joinPath(outputDir, '.tmp-主播A_20261101_200000_join.mp4.failed.mp4'))).toBe(true);
    expect(h.fs.files.has(joinPath(outputDir, 'aaaaaaaa_part001.ts'))).toBe(true);
  });

  it('两场 layout 不同 → 两个产物，任务行 message 说明分组', async () => {
    const { h, merger, jobId, sessionIds } = scenario();
    // 把第二场改成 hevc
    const second = h.store.listSegments(sessionIds[1] ?? '');
    expect(second).toHaveLength(1);
    h.store.insertSegment({
      sessionId: sessionIds[1] ?? '',
      path: second[0]?.path ?? '',
      partNo: 1,
      startedAt: new Date(2026, 10, 1, 21, 0, 0).toISOString(),
      durationS: 60,
      sizeBytes: 1024,
      integrity: 'ok',
      video: { codec: 'hevc', profile: 'Main', width: 1280, height: 720, pixFmt: 'yuv420p', layoutHash: 'L2' },
      audio: { codec: 'aac', sampleRate: 44_100, channels: 2 },
    });
    h.probe.fallback = () => fingerprintOf(1920, 1080, 60);

    const result = await merger.run(jobId);
    expect(result.status).toBe('completed');
    const job = h.store.getMergeJob(jobId);
    expect(job?.outputs).toHaveLength(2);
    expect(job?.outputs.map((o) => o.group)).toEqual([1, 2]);
    expect(job?.message).toContain('2 个文件');
  });

  it('会话还在录 → 直接失败，不跑 ffmpeg', async () => {
    const { h, merger, capture, jobId, sessionIds } = scenario();
    const open = h.store.createSession({
      taskId: h.store.listTasks()[0]?.id ?? '',
      startedAt: new Date(2026, 10, 1, 22, 0, 0).toISOString(),
      outputDir: '/out/open',
      origin: 'new',
    });
    const job = h.store.createMergeJob([...(sessionIds.slice(0, 1) ?? []), open]);
    expect(job.id).not.toBe(jobId);

    const result = await merger.run(job.id);
    expect(result.status).toBe('failed');
    expect(result.message).toContain('还在录制');
    expect(capture.invoked).toHaveLength(0);
    expect(h.store.getMergeJob(job.id)?.status).toBe('failed');
  });

  it('同一会话被占用时返回 busy，不并发写同一个盘', async () => {
    const { merger, jobId } = scenario();
    const first = merger.run(jobId);
    const second = merger.run(jobId);
    const results = await Promise.all([first, second]);
    expect(results.some((r) => r.status === 'busy')).toBe(true);
  });
});
