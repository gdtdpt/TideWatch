/**
 * M1 引擎回归锁：状态机的每一条出口都要能复现。
 *
 * 这些用例对应 tide-cap-master docs/03 的真机教训（见 docs/test-matrix.md 的
 * M1 段落）：断流不能当"下播"、连不上不能热循环、宿主退出必须走同一条收尾。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Draft } from './copy.ts';
import { Engine, type EngineDeps, type ResolveOutcome } from './engine.ts';
import { joinPath, MANIFEST_NAME } from './layout.ts';
import type { SessionManifest } from './manifest.ts';
import {
  liveOutcome,
  makeHarness,
  offlineOutcome,
  waitFor,
  type Harness,
} from './test-support.ts';

const harnesses: Harness[] = [];
const engines: Engine[] = [];

afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  for (const h of harnesses.splice(0)) h.cleanup();
});

function setup(overrides: Partial<EngineDeps> = {}): {
  h: Harness;
  engine: Engine;
  drafts: Draft[];
  ended: { sessionId: string; reason: string }[];
  taskId: string;
} {
  const h = makeHarness();
  harnesses.push(h);
  const drafts: Draft[] = [];
  const ended: { sessionId: string; reason: string }[] = [];
  const task = h.store.addTask({ url: 'https://live.douyin.com/123', platform: 'douyin', monitorEnabled: true });
  const engine = new Engine({
    store: h.store,
    fs: h.fs,
    capture: h.capture,
    probe: h.probe,
    resolver: h.resolver,
    outputRoot: '/out',
    tickMs: 20,
    stopGraceMs: 200,
    onDraft: (d) => drafts.push(d),
    onSessionEnded: (sessionId, _taskId, reason) => ended.push({ sessionId, reason }),
    ...overrides,
  });
  engines.push(engine);
  return { h, engine, drafts, ended, taskId: task.id };
}

async function manifestOf(h: Harness, outputDir: string): Promise<SessionManifest> {
  const text = await h.fs.readText(joinPath(outputDir, MANIFEST_NAME));
  expect(text).not.toBeNull();
  return JSON.parse(text ?? '{}') as SessionManifest;
}

describe('M1 引擎：一场完整录制', () => {
  it('退出非 0 但已落段 → 重新解析发现已下播 → 会话以 offline 收尾，分段/缺口/manifest 都对', async () => {
    const { h, engine, drafts, ended } = setup();
    h.capture.plans = [
      {
        segments: [
          { durationS: 60, sizeBytes: 1024 },
          { durationS: 60, sizeBytes: 1024 },
        ],
        exit: { code: 1, afterMs: 20 },
      },
    ];
    h.resolver.queue = [liveOutcome(), offlineOutcome()];

    engine.start();
    await waitFor(() => ended.length === 1, '会话收尾');

    const sessions = h.store.listSessions();
    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    expect(session?.endReason).toBe('offline');
    expect(session?.origin).toBe('new');

    const segments = h.store.listSegments(session?.id ?? '');
    expect(segments.map((s) => s.partNo)).toEqual([1, 2]);
    expect(segments.every((s) => s.durationS === 60)).toBe(true);

    const manifest = await manifestOf(h, session?.outputDir ?? '');
    expect(manifest.segments).toHaveLength(2);
    expect(manifest.ended_at).not.toBeNull();
    expect(manifest.end_reason).toBe('offline');

    const kinds = h.store.listEvents({ limit: 100 }).map((e) => e.kind);
    expect(kinds).toContain('session.started');
    expect(kinds).toContain('recording.segment_ended');
    expect(kinds).toContain('session.ended');

    expect(drafts.map((d) => d.kind)).toContain('recording_started');
    const end = drafts.find((d) => d.kind === 'recording_ended');
    expect(end?.body).toContain('时长');
    // 录完之后不能再挂着一场"这一场"的请求
    expect(h.store.listTasks()[0]?.recordRequested).toBe(false);
  });

  it(
    '录制中就把已封口的段登记进库（不等这场结束）',
    async () => {
      const { h, engine } = setup();
      h.capture.plans = [
        {
          segments: [
            { durationS: 60, sizeBytes: 1024 },
            { durationS: 60, sizeBytes: 1024 },
          ],
          // 只有第 1 段封口：第 2 段还在写，ffmpeg 不会为它写文件或 csv 行
          sealedCount: 1,
        },
      ];
      h.resolver.queue = [liveOutcome()];

      engine.start();
      await waitFor(() => h.store.listSessions().length === 1, '会话建立');
      const sessionId = h.store.listSessions()[0]?.id ?? '';

      // 回归点：早先固定丢掉 seglist 的最后一条，导致已封口的第 1 段
      // 迟迟不入库 —— 界面表现为"录了很久还是 0 段"。
      await waitFor(() => h.store.listSegments(sessionId).length > 0, '第 1 段入库', 9_000);

      const segments = h.store.listSegments(sessionId);
      expect(segments).toHaveLength(1);
      expect(segments[0]?.partNo).toBe(1);
      expect(segments[0]?.durationS).toBe(60);
      expect(h.store.listEvents({ limit: 100 }).map((e) => e.kind)).toContain('recording.segment_ended');
      // 这场还没结束，别再往下录第二段
      expect(h.store.listSessions()[0]?.endedAt).toBeNull();
    },
    15_000,
  );

  it('异常退出后同一会话续录，段号不重复，缺口如实记账', async () => {
    const { h, engine, ended } = setup();
    h.capture.plans = [
      // 第一段故意只有 0.01s：缺口按"墙钟"算，段时长必须短才会出现真实空档
      { segments: [{ durationS: 0.01, sizeBytes: 512 }], exit: { code: 1, afterMs: 30 } },
      { segments: [{ durationS: 0.01, sizeBytes: 512 }, { durationS: 0.01, sizeBytes: 512 }] },
    ];
    h.resolver.queue = [liveOutcome()];
    engine.start();

    await waitFor(() => h.capture.handles.length === 2, '第二次连接');
    const sessionId = h.store.listSessions()[0]?.id ?? '';

    // 正在写的最后一段不算"已落段"：先停，收尾时的那次 collect 才会把它登记进来
    await engine.requestStop(h.store.listTasks()[0]?.id ?? '');
    await waitFor(() => ended.length === 1, '手动停止收尾');
    await waitFor(() => h.store.listSegments(sessionId).length >= 3, '三段都登记');

    const segments = h.store.listSegments(sessionId).sort((a, b) => a.partNo - b.partNo);
    // 关键：seglist 跨连接累积，编号必须来自文件名，不能按 entries 下标推
    expect(segments.map((s) => s.partNo)).toEqual([1, 2, 3]);
    expect(new Set(segments.map((s) => s.partNo)).size).toBe(3);

    const gap = h.store.listEvents({ limit: 200 }).find((e) => e.kind === 'recording.gap');
    expect(gap).toBeDefined();
    expect(gap?.payload['after_part']).toBe(1);
    expect(Number(gap?.payload['gap_s'])).toBeGreaterThan(0);
  });

  it('手动停止这一场：监控仍开着 → skip_current_live，runner 转 snoozed 而不是退出监控', async () => {
    const { h, engine, ended, taskId } = setup();
    h.capture.plans = [{ segments: [{ durationS: 60, sizeBytes: 1024 }] }];
    h.resolver.queue = [liveOutcome()];
    engine.start();

    await waitFor(() => h.capture.handles.length === 1, '开始录制');
    await engine.requestStop(taskId);
    await waitFor(() => ended.length === 1, '手动收尾');

    const task = h.store.getTask(taskId);
    expect(task?.skipCurrentLive).toBe(true);
    expect(task?.monitorEnabled).toBe(true);
    await waitFor(() => h.store.getRuntime(taskId)?.state === 'snoozed', '转 snoozed');
  });
});

describe('M1 引擎：上限与异常', () => {
  it('体积到上限 → end_reason=capped，并在 1s 内以 origin=cap 开新场', async () => {
    const { h, engine, drafts, taskId } = setup();
    h.capture.plans = [{ segments: [{ durationS: 60, sizeBytes: 4096 }] }];
    h.resolver.queue = [liveOutcome()];
    h.store.patchTask(taskId, { maxSessionBytes: 1 });
    engine.start();

    await waitFor(() => h.store.listSessions().length >= 2, '第二场（cap）');
    const sessions = h.store.listSessions(); // 新→旧
    const first = sessions.find((s) => s.origin === 'new');
    const second = sessions.find((s) => s.origin === 'cap');
    expect(first?.endReason).toBe('capped');
    expect(second).toBeDefined();
    expect(drafts.map((d) => d.kind)).toContain('session_capped');
    // cap 不算"这一场结束"，不能把 record_requested 清掉
    expect(h.store.getTask(taskId)?.recordRequested).toBe(false);
  });

  it('磁盘写满 → 不重试，会话以 disk 收尾', async () => {
    const { h, engine, ended } = setup();
    h.capture.plans = [
      {
        segments: [{ durationS: 30, sizeBytes: 1024 }],
        stderr: ['av_interleaved_write_frame(): No space left on device'],
        exit: { code: 1, afterMs: 20 },
      },
    ];
    engine.start();
    await waitFor(() => ended.length === 1, '磁盘错误收尾');

    expect(h.store.listSessions()[0]?.endReason).toBe('disk');
    const ev = h.store.listEvents({ limit: 100 }).find((e) => e.kind === 'recording.error_class');
    expect(ev?.payload['class']).toBe('disk');
    // 不重试：只拉了一次 ffmpeg
    expect(h.capture.handles).toHaveLength(1);
  });

  it('卡死看门狗：启动宽限后零增长 → 硬杀（不是优雅停止）并记 stalled', async () => {
    const { h, engine, ended } = setup({ startGraceS: 0.05, stallS: 0.05 });
    h.capture.plans = [{ segments: [] }];
    h.resolver.queue = [liveOutcome(), offlineOutcome()];
    engine.start();

    await waitFor(() => ended.length === 1, '卡死收尾');
    expect(h.capture.handles[0]?.killed).toBe(true);
    expect(h.capture.handles[0]?.stopped).toBe(false);
    expect(h.store.listEvents({ limit: 100 }).map((e) => e.kind)).toContain('recording.stalled');
  });
});

describe('M1 引擎：解析失败与退出', () => {
  it('AUTH_REQUIRED → needs_auth 状态 + 一条通知；不建会话、监控不中断', async () => {
    const { h, engine, drafts, taskId } = setup();
    h.resolver.queue = [
      {
        ok: false,
        error: { code: 'AUTH_REQUIRED', message: '需要 Cookie', retryable: false },
      } satisfies ResolveOutcome,
    ];
    engine.start();

    await waitFor(() => h.store.getRuntime(taskId)?.state === 'needs_auth', 'await needs_auth');
    expect(h.store.listSessions()).toHaveLength(0);
    expect(drafts.map((d) => d.kind)).toContain('needs_auth');
    expect(h.store.getTask(taskId)?.monitorEnabled).toBe(true);
    // retryable=false 只表示"别拿同样参数立刻再问"，不是"这一场到此为止"
    expect(h.store.listEvents({ limit: 100 }).map((e) => e.kind)).toContain('plugin.auth_required');
  });

  it('缺 ffmpeg → needs_dep + 一条通知，且不拉起录制进程（不表现为无限重连）', async () => {
    const { h, engine, drafts, taskId } = setup();
    h.capture.preflightResult = { ok: false, detail: '找不到可用的 ffmpeg（ffmpeg）' };
    h.resolver.queue = [liveOutcome()];
    engine.start();

    await waitFor(() => h.store.getRuntime(taskId)?.state === 'needs_dep', 'needs_dep');
    expect(h.capture.handles).toHaveLength(0);
    expect(h.store.listSessions()).toHaveLength(0);
    expect(drafts.map((d) => d.kind)).toContain('needs_dependency');
    expect(h.store.listEvents({ limit: 50 }).map((e) => e.kind)).toContain('capture.dependency_missing');
  });

  it('宿主退出：会话以 shutdown 收尾、manifest 有 ended_at、不触发自动后处理', async () => {
    const { h, engine, ended } = setup();
    h.capture.plans = [{ segments: [{ durationS: 60, sizeBytes: 1024 }] }];
    h.resolver.queue = [liveOutcome()];
    engine.start();

    await waitFor(() => h.capture.handles.length === 1, '开始录制');
    const sessionId = h.store.listSessions()[0]?.id ?? '';
    await engine.stop();

    const session = h.store.getSession(sessionId);
    expect(session?.endedAt).not.toBeNull();
    expect(session?.endReason).toBe('shutdown');
    expect(ended[0]?.reason).toBe('shutdown');

    const manifest = await manifestOf(h, session?.outputDir ?? '');
    expect(manifest.ended_at).not.toBeNull();
    expect(manifest.end_reason).toBe('shutdown');
  });
});
