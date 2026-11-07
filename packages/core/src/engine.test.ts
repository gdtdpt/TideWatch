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
import { fmtHm } from './schedule.ts';
import type { SessionManifest } from './manifest.ts';
import {
  fingerprintOf,
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

  it(
    '段轮转后运行态跟着走：第 1 段封口就变成「正在录第 2 段」',
    async () => {
      const { h, engine, taskId } = setup();
      h.capture.plans = [
        {
          segments: [
            { durationS: 3600, sizeBytes: 1024 },
            { durationS: 60, sizeBytes: 1024 },
          ],
          // 第 1 段刚封口、第 2 段还在写：这正是默认分段 1 小时时的现场
          sealedCount: 1,
        },
      ];
      h.resolver.queue = [liveOutcome()];

      engine.start();
      await waitFor(() => h.store.listSessions().length === 1, '会话建立');
      const taskIdNow = taskId;
      // 建连接时确实是第 1 段
      await waitFor(
        () => h.store.getRuntime(taskIdNow)?.detail === '正在录第 1 段',
        '初始文案',
      );

      // 回归点：detail 原来只在建连接时写一次，段轮转后仍是「第 1 段」，
      // 一直要拖到这场结束才纠正。
      await waitFor(
        () => h.store.getRuntime(taskIdNow)?.detail === '正在录第 2 段',
        '轮转后的文案',
        15_000,
      );
      const sessionId = h.store.listSessions()[0]?.id ?? '';
      expect(h.store.listSegments(sessionId)).toHaveLength(1);
      // 这场还没结束
      expect(h.store.listSessions()[0]?.endedAt).toBeNull();
    },
    20_000,
  );

  it('一次断流只记一条缺口：中间那些"拉起来就死"的重连不重复记账', async () => {
    const { h, engine, ended, taskId } = setup();
    h.capture.plans = [
      // 段时长必须足够短：缺口按"墙钟/单调钟"算，段时长 60s 会让时间轴跑到未来
      // （替身是瞬间写完的），缺口就会被夹成 0
      { segments: [{ durationS: 0.01, sizeBytes: 1024 }], exit: { code: 1, afterMs: 60 } },
      // 第二次连接什么都没录到就退出（等同于拉起就死）
      { segments: [], exit: { code: 1, afterMs: 20 } },
      { segments: [{ durationS: 0.01, sizeBytes: 1024 }] },
    ];
    h.resolver.queue = [liveOutcome()];

    engine.start();
    await waitFor(() => h.capture.handles.length >= 3, '第三次连接', 10_000);
    await engine.requestStop(taskId);
    await waitFor(() => ended.length === 1, '收尾');

    const gaps = h.store.listEvents({ limit: 200 }).filter((e) => e.kind === 'recording.gap');
    // 回归点：早先每轮重连都 append 一条，一次断流能记出 4 条 after_part 相同的缺口
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.payload['after_part']).toBe(1);

    const sessionId = h.store.listSessions()[0]?.id ?? '';
    const manifest = await manifestOf(h, h.store.listSessions()[0]?.outputDir ?? '');
    expect(manifest.gaps).toHaveLength(1);
    expect(h.store.listSegments(sessionId).map((s) => s.partNo)).toEqual([1, 2]);
  }, 20_000);

  it('重连时接管盘上未封口的残段：登记 recovered、段号往后推，不覆盖', async () => {
    const { h, engine } = setup();
    h.capture.plans = [
      { segments: [{ durationS: 60, sizeBytes: 1024 }], exit: { code: 1, afterMs: 400 } },
      { segments: [{ durationS: 60, sizeBytes: 1024 }] },
    ];
    h.resolver.queue = [liveOutcome()];

    engine.start();
    await waitFor(() => h.store.listSessions().length === 1, '会话建立');
    const session = h.store.listSessions()[0];
    // 模拟：ffmpeg 已经开了 part002 并写了一半就被杀 —— seglist 里没有这一行
    h.fs.put(joinPath(session?.outputDir ?? '', `${session?.id ?? ''}_part002.ts`), 4096);

    await waitFor(() => h.capture.handles.length >= 2, '重连', 10_000);

    const recovered = h.store.listSegments(session?.id ?? '').find((s) => s.integrity === 'recovered');
    expect(recovered?.partNo).toBe(2);

    // 回归点：不接管就会用同一个 part 号重开，把残段截断覆盖（真机丢过 70MB）
    const args = h.capture.starts[1]?.args ?? [];
    expect(args[args.indexOf('-segment_start_number') + 1]).toBe('3');
  });

  it('系统时钟被往前拨一小时，看门狗不能误杀正在录的进程', async () => {
    let skewMs = 0;
    const anchor = new Date('2026-11-02T00:00:00Z').getTime();
    const t0 = Date.now();
    const clock = {
      now: (): Date => new Date(anchor + (Date.now() - t0) + skewMs),
      sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
    };
    // 阈值放到 10 分钟：墙钟跳变会凭空多出 3600 秒，单调时钟不会
    const { h, engine } = setup({ clock, stallS: 600, startGraceS: 0 });
    h.capture.plans = [{ segments: [{ durationS: 60, sizeBytes: 1024 }] }];
    h.resolver.queue = [liveOutcome()];

    engine.start();
    await waitFor(() => h.capture.handles.length === 1, '开始录制');
    skewMs = 3_600_000;
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(h.capture.handles[0]?.killed).toBe(false);
    expect(h.store.listEvents({ limit: 100 }).some((e) => e.kind === 'recording.stalled')).toBe(false);
  });

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

describe('画质可见性与流参数漂移', () => {
  it('实际画质写回任务；同一档位重复解析不重复记账，降级只通知一次', async () => {
    const { h, engine, drafts, ended, taskId } = setup();
    const degraded = liveOutcome({
      qualityActual: { qn: 150, label: '高清', codec: 'avc', format: 'flv', requested: '原画', degraded: true },
    });
    h.capture.plans = [{ segments: [{ durationS: 60, sizeBytes: 1024 }], exit: { code: 0, afterMs: 20 } }];
    // 第一次：#runTask 的轮询解析；第二次：#runSession 段间的重新解析（同一档位）
    h.resolver.queue = [degraded, degraded, offlineOutcome()];

    engine.start();
    await waitFor(() => ended.length === 1, '会话收尾');

    const task = h.store.getTask(taskId);
    expect(task?.qualityActual).toEqual({
      qn: 150,
      label: '高清',
      codec: 'avc',
      format: 'flv',
      requested: '原画',
      degraded: true,
    });
    const kinds = h.store.listEvents({ limit: 200 }).map((e) => e.kind);
    // 两次 resolve 都成功、档位一样 → 只记一条
    expect(kinds.filter((k) => k === 'quality.resolved')).toHaveLength(1);
    expect(drafts.filter((d) => d.kind === 'quality_degraded')).toHaveLength(1);
  });

  it('没降级就不发通知，但实际画质照样落库', async () => {
    const { h, engine, drafts, ended, taskId } = setup();
    h.capture.plans = [{ segments: [{ durationS: 60, sizeBytes: 1024 }], exit: { code: 0, afterMs: 20 } }];
    h.resolver.queue = [
      liveOutcome({
        qualityActual: { qn: 10_000, label: '原画', codec: 'hevc', format: 'flv', requested: '原画', degraded: false },
      }),
      offlineOutcome(),
    ];

    engine.start();
    await waitFor(() => ended.length === 1, '会话收尾');

    expect(h.store.getTask(taskId)?.qualityActual?.label).toBe('原画');
    expect(drafts.filter((d) => d.kind === 'quality_degraded')).toHaveLength(0);
  });

  it('段间流参数变化：报一次 layout_changed，分段照常入库', async () => {
    const { h, engine, drafts, ended } = setup();
    // 第 2 段分辨率变了（模拟平台中途切换线路 / 主播改推流参数）
    h.probe.fallback = (file) =>
      file.includes('part002') ? fingerprintOf(1280, 720) : fingerprintOf(1920, 1080);
    h.capture.plans = [
      { segments: [{ durationS: 60, sizeBytes: 1024 }, { durationS: 60, sizeBytes: 1024 }], exit: { code: 0, afterMs: 20 } },
    ];
    h.resolver.queue = [liveOutcome(), offlineOutcome()];

    engine.start();
    await waitFor(() => ended.length === 1, '会话收尾');

    const sessionId = h.store.listSessions()[0]?.id ?? '';
    const segments = h.store.listSegments(sessionId);
    expect(segments.map((s) => s.partNo)).toEqual([1, 2]);
    expect(segments[1]?.width).toBe(1280);

    const changed = h.store.listEvents({ limit: 200 }).filter((e) => e.kind === 'recording.layout_changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]?.payload['from']).toContain('1920x1080');
    expect(changed[0]?.payload['to']).toContain('1280x720');
    const note = drafts.find((d) => d.kind === 'layout_changed');
    expect(note?.body).toContain('1920×1080');
  });

  it('参数一致的多个分段不报 layout_changed', async () => {
    const { h, engine, drafts, ended } = setup();
    h.capture.plans = [
      { segments: [{ durationS: 60, sizeBytes: 1024 }, { durationS: 60, sizeBytes: 1024 }], exit: { code: 0, afterMs: 20 } },
    ];
    h.resolver.queue = [liveOutcome(), offlineOutcome()];

    engine.start();
    await waitFor(() => ended.length === 1, '会话收尾');

    expect(h.store.listSegments(h.store.listSessions()[0]?.id ?? '')).toHaveLength(2);
    expect(drafts.filter((d) => d.kind === 'layout_changed')).toHaveLength(0);
  });
});

describe('监控时段与轮询节奏', () => {
  const fail = (code: 'NOT_LIVE' | 'RESTRICTED', message: string, retryAfterS?: number): ResolveOutcome => ({
    ok: false,
    error: { code, message, retryable: true, ...(retryAfterS === undefined ? {} : { retryAfterS }) },
  });

  /** 把窗口放在"再过 minutes 分钟才开始"，构造一个此刻窗外的任务 */
  const windowInFuture = (taskId: string, store: Harness['store'], minutes = 2): void => {
    const now = new Date();
    const start = (now.getHours() * 60 + now.getMinutes() + minutes) % 1440;
    store.patchTask(taskId, {
      monitorWindows: [{ start: fmtHm(start), end: fmtHm((start + 60) % 1440) }],
    });
  };

  it('窗外一次请求都不发：状态 paused，并写明几点恢复', async () => {
    const { h, engine, taskId } = setup();
    windowInFuture(taskId, h.store);

    engine.start();
    await waitFor(() => h.store.getRuntime(taskId)?.state === 'paused', '进入暂停');

    expect(h.resolver.calls).toBe(0);
    expect(h.store.getRuntime(taskId)?.detail ?? '').toMatch(/\d{2}:\d{2} 恢复/);
    const kinds = h.store.listEvents({ limit: 50 }).map((e) => e.kind);
    expect(kinds).toContain('task.monitor_window');
    expect(kinds).not.toContain('plugin.resolve_err');
  });

  it('用户点「检查」时无视时段：窗外也能立刻解析', async () => {
    const { h, engine, taskId } = setup();
    windowInFuture(taskId, h.store);
    h.resolver.queue = [offlineOutcome()];

    engine.start();
    await waitFor(() => h.store.getRuntime(taskId)?.state === 'paused', '进入暂停');
    expect(h.resolver.calls).toBe(0);

    h.store.patchTask(taskId, { checkNow: true });
    await waitFor(() => h.resolver.calls > 0, '手动检查放行');
    await waitFor(() => h.store.getRuntime(taskId)?.state === 'waiting', '解析完成');
  });

  it('主播没开播（NOT_LIVE）按等待处理，不记错误事件', async () => {
    const { h, engine, taskId } = setup();
    h.store.putSettings({ pollIntervalS: 5 }); // 基准间隔压到 5s，两轮才跑得完
    h.resolver.queue = [fail('NOT_LIVE', 'Exception: 直播已结束')];

    engine.start();
    await waitFor(() => h.store.getRuntime(taskId)?.state === 'waiting', '等待开播');
    await waitFor(() => h.resolver.calls >= 2, '至少问了两轮', 20_000);

    const kinds = h.store.listEvents({ limit: 100 }).map((e) => e.kind);
    expect(kinds).not.toContain('plugin.resolve_err');
    expect(kinds).not.toContain('task.state_changed_error');
    expect(h.store.getRuntime(taskId)?.detail).toBe('主播未开播');
  });

  it('平台拒绝进房（RESTRICTED）→ blocked 状态 + 一条通知', async () => {
    const { h, engine, drafts, taskId } = setup();
    h.resolver.queue = [fail('RESTRICTED', '你不在主播设置的可见范围内，无法进入TA的直播间', 1800)];

    engine.start();
    await waitFor(() => h.store.getRuntime(taskId)?.state === 'blocked', '进入 blocked');

    expect(h.store.getRuntime(taskId)?.detail).toContain('观看范围');
    const note = drafts.find((d) => d.kind === 'view_restricted');
    expect(note?.title).toBe('无法进房');
    expect(note?.body).toContain('半小时');
  });
});
