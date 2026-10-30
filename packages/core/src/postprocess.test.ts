/**
 * M2 后处理回归锁：三条硬约束各自对应一条用例 ——
 * 「失败不毁产物」「源分段只在显式清理时删」「同会话并发返回 busy」。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { CaptureHandle, CaptureSpec } from './engine.ts';
import type { Draft } from './copy.ts';
import { joinPath, MANIFEST_NAME } from './layout.ts';
import { PostProcessor } from './postprocess.ts';
import { makeHarness, fingerprintOf, waitFor, type Harness } from './test-support.ts';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** 假 ffmpeg：把"产物"写到最后一个参数，按需失败 */
class SimCapture {
  fail = false;
  delayMs = 0;
  readonly invoked: string[][] = [];

  constructor(private readonly h: Harness) {}

  async start(spec: CaptureSpec): Promise<CaptureHandle> {
    this.invoked.push(spec.args);
    const out = spec.args[spec.args.length - 1] ?? '';
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    // 真实 ffmpeg 失败时也会留下半截产物：正因如此才必须先写 .tmp
    if (out.length > 0) this.h.fs.put(out, this.fail ? 128 : 4096);
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

function scenario(opts: { segments?: number; strategy?: 'merge' | 'per_segment' | 'manual' } = {}): {
  h: Harness;
  capture: SimCapture;
  post: PostProcessor;
  drafts: Draft[];
  sessionId: string;
  outputDir: string;
  paths: string[];
} {
  const h = makeHarness();
  harnesses.push(h);
  const task = h.store.addTask({
    url: 'https://live.douyin.com/1',
    platform: 'douyin',
    streamerName: '主播A',
    postprocess: opts.strategy ?? 'merge',
  });
  const outputDir = '/out/主播A/20261029-101010_new_abcd1234';
  const startedAt = new Date(2026, 9, 29, 10, 10, 10).toISOString();
  const sessionId = h.store.createSession({ taskId: task.id, startedAt, outputDir, origin: 'new' });
  h.store.endSession(sessionId, 'offline', startedAt);

  const paths: string[] = [];
  const count = opts.segments ?? 2;
  for (let i = 1; i <= count; i += 1) {
    const path = joinPath(outputDir, `abcd1234_part${String(i).padStart(3, '0')}.ts`);
    h.fs.put(path, 1024);
    h.store.insertSegment({
      sessionId,
      path,
      partNo: i,
      startedAt,
      durationS: 60,
      sizeBytes: 1024,
      integrity: 'ok',
      video: { codec: 'h264', profile: 'High', width: 1920, height: 1080, pixFmt: 'yuv420p', layoutHash: 'L1' },
      audio: { codec: 'aac', sampleRate: 44_100, channels: 2 },
    });
    paths.push(path);
  }

  const drafts: Draft[] = [];
  const capture = new SimCapture(h);
  const post = new PostProcessor({
    store: h.store,
    fs: h.fs,
    capture,
    probe: h.probe,
    onDraft: (d) => drafts.push(d),
  });
  return { h, capture, post, drafts, sessionId, outputDir, paths };
}

describe('后处理：合并成功', () => {
  it('先写 .tmp、校验后原子改名；产物入库；源分段保留', async () => {
    const { h, post, drafts, sessionId, outputDir, paths } = scenario();
    h.probe.fallback = () => fingerprintOf(1920, 1080, 120);

    const result = await post.processSession(sessionId);
    expect(result.status).toBe('completed');
    expect(result.outputs).toHaveLength(1);

    const out = joinPath(outputDir, '主播A_20261029_101010.mp4');
    expect(h.fs.files.has(out)).toBe(true);
    expect(h.fs.files.has(joinPath(outputDir, '.tmp-主播A_20261029_101010.mp4'))).toBe(false);

    const artifacts = h.store.listArtifacts(sessionId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.path).toBe(out);
    expect(artifacts[0]?.kind).toBe('merged');
    expect(artifacts[0]?.durationS).toBe(120);

    // 默认不删源：清理是唯一不可逆动作，必须显式开关
    for (const p of paths) expect(h.fs.files.has(p)).toBe(true);
    expect(drafts.map((d) => d.kind)).toContain('merge_completed');
    expect(h.store.listEvents({ limit: 50 }).map((e) => e.kind)).toContain('merge.started');
  });

  it('per_segment：每段一个产物，各成一条 artifact', async () => {
    const { h, post, sessionId } = scenario({ strategy: 'per_segment' });
    h.probe.fallback = () => fingerprintOf(1920, 1080, 60);
    const result = await post.processSession(sessionId);
    expect(result.status).toBe('completed');
    expect(result.outputs).toHaveLength(2);
    expect(h.store.listArtifacts(sessionId).map((a) => a.kind)).toEqual(['per_segment', 'per_segment']);
  });

  it('显式 cleanupSources 才删源，并把段标记为 cleaned', async () => {
    const { h, post, sessionId, paths } = scenario({ segments: 1 });
    const result = await post.processSession(sessionId, { cleanupSources: true });
    expect(result.status).toBe('completed');
    for (const p of paths) expect(h.fs.files.has(p)).toBe(false);
    expect(h.store.listSegments(sessionId)[0]?.integrity).toBe('cleaned');
    expect(h.store.listEvents({ limit: 50 }).map((e) => e.kind)).toContain('merge.cleanup');
  });
});

describe('后处理：失败与跳过', () => {
  it('合并失败：已有正式产物一字不动，tmp 改名为 .failed.mp4', async () => {
    const { h, capture, post, drafts, sessionId, outputDir } = scenario({ segments: 1 });
    const final = joinPath(outputDir, '主播A_20261029_101010.mp4');
    h.fs.put(final, 999);
    capture.fail = true;

    const result = await post.processSession(sessionId);
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('concat 失败');
    expect(h.fs.files.get(final)?.size).toBe(999);
    expect(h.fs.files.has(joinPath(outputDir, '.tmp-主播A_20261029_101010.mp4.failed.mp4'))).toBe(true);
    expect(drafts.map((d) => d.kind)).toContain('merge_failed');
    expect(h.store.listArtifacts(sessionId)).toHaveLength(0);
  });

  it('磁盘不足：整场跳过，不拉起 ffmpeg', async () => {
    const { h, capture, post, sessionId } = scenario();
    h.fs.free = 1024;
    const result = await post.processSession(sessionId);
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('insufficient_disk');
    expect(capture.invoked).toHaveLength(0);
  });

  it('manual 策略：不显式清理就跳过', async () => {
    const { h, post, sessionId } = scenario({ strategy: 'manual' });
    h.probe.fallback = () => fingerprintOf(1920, 1080, 120);
    const skipped = await post.processSession(sessionId);
    expect(skipped.status).toBe('skipped');
    expect(skipped.reason).toBe('manual');
    // 显式清理是"人点了这一下"，此时 manual 也照做
    const forced = await post.processSession(sessionId, { cleanupSources: true });
    expect(forced.status).toBe('completed');
    expect(h.store.listArtifacts(sessionId).length).toBeGreaterThan(0);
  });

  it('同一会话并发触发：第二次直接 busy（否则两个 ffmpeg 抢同一个输出）', async () => {
    const { capture, post, sessionId } = scenario({ segments: 1 });
    capture.delayMs = 80;
    const first = post.processSession(sessionId);
    const second = await post.processSession(sessionId);
    expect(second.status).toBe('busy');
    expect((await first).status).toBe('completed');
  });
});

describe('后处理：库丢了也能合', () => {
  it('库里没有分段记录时，用 manifest 补齐输入', async () => {
    const { h, post, sessionId, outputDir } = scenario({ segments: 0 });
    const path = joinPath(outputDir, 'abcd1234_part001.ts');
    h.fs.put(path, 1024);
    await h.fs.writeText(
      joinPath(outputDir, MANIFEST_NAME),
      JSON.stringify({
        protocol: 1,
        session_id: sessionId,
        task_id: 't',
        started_at: '2026-10-29T10:10:10.000Z',
        ended_at: null,
        segments: [
          {
            part_no: 1,
            file: 'abcd1234_part001.ts',
            started_at: '2026-10-29T10:10:10.000Z',
            duration_s: 60,
            size_bytes: 1024,
            video: { codec: 'h264', profile: 'High', width: 1920, height: 1080, pix_fmt: 'yuv420p' },
            audio: { codec: 'aac', sample_rate: 44_100, channels: 2 },
            layout_hash: 'L1',
            integrity: 'ok',
          },
        ],
        gaps: [],
      }),
    );
    const result = await post.processSession(sessionId);
    expect(result.status).toBe('completed');
    expect(result.outputs).toHaveLength(1);
  });

  it('并发之后队列不被卡住：后续会话仍能处理', async () => {
    const { post, sessionId, h } = scenario({ segments: 1 });
    await post.processSession(sessionId);
    await waitFor(() => h.store.listArtifacts(sessionId).length > 0, '产物入库');
    expect(post.isBusy(sessionId)).toBe(false);
  });
});
