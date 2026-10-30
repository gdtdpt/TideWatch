/**
 * 录制引擎（M1/M2 的核心）：每个任务一条 runner，runner 内是"解析 → 录制 → 重连 → 收尾"。
 *
 * 纪律：
 * - runner 表是进程内的，跨进程互斥交给 host-adapter 的 lease；
 * - 一切子进程受监督（CapturePort），退出必回收；
 * - UI 只是事件消费者：emit 失败不影响录制（这里的事件写库失败只告警）。
 */
import { randomUUID } from 'node:crypto';
import type { EndReason, SessionOrigin, Store, Task } from '@tidewatch/store';
import { effectiveMaxSessionBytes, effectiveMaxSessionS, originAfter } from '@tidewatch/store';
import {
  classifyLine,
  decideExit,
  FAIL_STREAK_LIMIT,
  primaryClass,
  reconnectDelayMs,
  resolveFault,
  URL_LESS_FAST_DELAY_MS,
  URL_LESS_FAST_ROUNDS,
  type ErrorClass,
} from './classify.ts';
import * as copy from './copy.ts';
import type { Draft } from './copy.ts';
import { parseSegList, recordArgs, type Fingerprint } from './ffmpeg.ts';
import {
  baseName,
  joinPath,
  MANIFEST_NAME,
  parsePartNo,
  renderHeaders,
  segmentListName,
  sessionDirName,
} from './layout.ts';
import { emptyManifest, parseManifest, type GapCause, type SessionManifest } from './manifest.ts';

// ── 端口 ────────────────────────────────────────────────────────────────────

export interface CaptureHandle {
  readonly pid: number | undefined;
  write(data: string): void;
  kill(): void;
  /** 优雅停止：先 'q'，宽限后硬杀 */
  stop(graceMs: number): Promise<void>;
  wait(): Promise<{ code: number | null; signal: string | null }>;
}

export interface CaptureSpec {
  args: string[];
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface CapturePort {
  start(spec: CaptureSpec): Promise<CaptureHandle>;
  /**
   * 可选择的前置检查：缺 ffmpeg 这类"人要装一下"的问题，
   * 不该表现为无限重连（状态栏只会写 unknown，用户永远不知道要装东西）。
   */
  preflight?(): Promise<CapturePreflight>;
}

export interface CapturePreflight {
  ok: boolean;
  /** 给人看的一句话：缺什么、期望放在哪 */
  detail?: string;
}

export interface ProbePort {
  probe(file: string): Promise<Fingerprint | null>;
}

export interface EngineFs {
  mkdirp(dir: string): Promise<void>;
  readText(file: string): Promise<string | null>;
  writeText(file: string, text: string): Promise<void>;
  statSize(file: string): Promise<number>;
  listFiles(dir: string): Promise<string[]>;
  freeBytes(dir: string): Promise<number | null>;
  exists(file: string): Promise<boolean>;
  remove(file: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
}

export interface ResolveResult {
  isLive: boolean;
  recordUrl: string | null;
  platform: string;
  anchorName: string | null;
  title: string | null;
  isOverseas: boolean;
  headers: Record<string, string>;
  qualityOptions: string[];
  cookiesOut: string | null;
}

export interface ResolveFailure {
  code: 'AUTH_REQUIRED' | 'DEPENDENCY_MISSING' | 'RATE_LIMITED' | 'PLATFORM_CHANGED' | 'PLATFORM_UNSUPPORTED' | 'UNSUPPORTED_URL' | 'NETWORK' | 'INTERNAL' | 'TIMEOUT';
  message: string;
  retryable: boolean;
  retryAfterS?: number;
}

export type ResolveOutcome = { ok: true; data: ResolveResult } | { ok: false; error: ResolveFailure };

export interface ResolverPort {
  resolve(task: Task): Promise<ResolveOutcome>;
}

export interface EngineClock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export interface EngineDeps {
  store: Store;
  fs: EngineFs;
  capture: CapturePort;
  probe: ProbePort;
  resolver: ResolverPort;
  /** 产物根（每次会话在其下建 `<主播>/<时间_origin_短id>/`） */
  outputRoot: string;
  clock?: EngineClock;
  tickMs?: number;
  stopGraceMs?: number;
  stallS?: number;
  startGraceS?: number;
  onDraft?: (draft: Draft, ctx: { taskId: string; sessionId: string | null }) => void;
  onSessionEnded?: (sessionId: string, taskId: string, reason: EndReason) => void;
  logger?: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
}

interface Runner {
  taskId: string;
  stopRequested: boolean;
  shutdown: boolean;
  done: Promise<void>;
}

interface ConnectionResult {
  code: number | null;
  signal: string | null;
  classes: Set<ErrorClass>;
  manualStop: boolean;
  capped: boolean;
  stalled: boolean;
  lastSize: number;
}

interface ConnectionContext {
  sessionId: string;
  outputDir: string;
  startPartNo: number;
  connStartMs: number;
  final: boolean;
  abnormal: boolean;
  classes: Set<ErrorClass>;
  manifest: SessionManifest;
}

const defaultClock: EngineClock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** sleep 切片：stop / check_now 能在一秒内被观察到 */
const SLICE_MS = 250;

export class Engine {
  readonly #d: Required<Pick<EngineDeps, 'tickMs' | 'stopGraceMs' | 'stallS' | 'startGraceS'>> & EngineDeps;
  readonly #clock: EngineClock;
  readonly #runners = new Map<string, Runner>();
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #stopped = false;

  constructor(deps: EngineDeps) {
    this.#d = {
      ...deps,
      tickMs: deps.tickMs ?? 500,
      stopGraceMs: deps.stopGraceMs ?? 15_000,
      stallS: deps.stallS ?? 20,
      startGraceS: deps.startGraceS ?? 30,
    };
    this.#clock = deps.clock ?? defaultClock;
  }

  get running(): boolean {
    return this.#running;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#stopped = false;
    this.#timer = setInterval(() => {
      void this.tick().catch((err: unknown) => this.#logWarn('tick 失败', err));
    }, this.#d.tickMs);
    void this.tick().catch((err: unknown) => this.#logWarn('tick 失败', err));
  }

  /** 每个 tick 把"需要 runner 但还没有"的任务补上 */
  async tick(): Promise<void> {
    if (!this.#running) return;
    const tasks = this.#d.store.listRunnableTasks();
    const wanted = new Set(tasks.map((t) => t.id));
    for (const id of [...this.#runners.keys()]) {
      if (!wanted.has(id)) {
        // 任务被删 / 监控与手动请求都撤了：让 runner 自己退出
        const runner = this.#runners.get(id);
        if (runner !== undefined) runner.stopRequested = true;
      }
    }
    for (const task of tasks) {
      if (this.#runners.has(task.id)) continue;
      const runner: Runner = {
        taskId: task.id,
        stopRequested: false,
        shutdown: false,
        done: Promise.resolve(),
      };
      this.#runners.set(task.id, runner);
      runner.done = this.#runTask(task.id, runner)
        .catch((err: unknown) => this.#logWarn(`任务 ${task.id} runner 异常退出`, err))
        .finally(() => {
          if (this.#runners.get(task.id) === runner) this.#runners.delete(task.id);
        });
    }
  }

  /** 停止"这一场"（监控仍开着时置 skip_current_live，否则清 record_requested） */
  async requestStop(taskId: string): Promise<void> {
    const task = this.#d.store.getTask(taskId);
    if (task === undefined) return;
    if (task.monitorEnabled) this.#d.store.patchTask(taskId, { skipCurrentLive: true });
    else this.#d.store.patchTask(taskId, { recordRequested: false, skipCurrentLive: false });
    const runner = this.#runners.get(taskId);
    if (runner !== undefined) runner.stopRequested = true;
  }

  /** 「立即检查」只唤醒已经在跑的 runner，不解锁 runner（docs/00 §3） */
  wake(taskId: string): void {
    this.#d.store.patchTask(taskId, { checkNow: true });
  }

  /** 宿主退出：与 SIGTERM 同一条收尾管道 */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#running = false;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    for (const runner of this.#runners.values()) {
      runner.shutdown = true;
      runner.stopRequested = true;
    }
    const budget = this.#d.stopGraceMs + 5_000;
    const all = [...this.#runners.values()].map((r) => r.done);
    await Promise.race([
      Promise.allSettled(all),
      this.#clock.sleep(budget).then(() => {
        this.#logWarn(`runner 收尾超时（${budget}ms），交给宿主硬停`);
      }),
    ]);
  }

  // ── runner ────────────────────────────────────────────────────────────────

  async #runTask(taskId: string, runner: Runner): Promise<void> {
    let lastEndReason: EndReason | null = null;
    let urlLessRounds = 0;

    while (this.#running && !runner.shutdown) {
      const task = this.#d.store.getTask(taskId);
      if (task === undefined) return;
      if (!task.monitorEnabled && !task.recordRequested) {
        this.#runtime(taskId, 'idle', null);
        return;
      }
      if (runner.stopRequested && !task.monitorEnabled && !task.recordRequested) {
        this.#runtime(taskId, 'idle', null);
        return;
      }

      // 本场已跳过：继续轮询只为等"房间下播"这个解除信号（docs/03 §2）
      if (task.skipCurrentLive && task.monitorEnabled) {
        this.#runtime(taskId, 'snoozed', '本场已跳过，等待下播');
        const check = await this.#d.resolver.resolve(task);
        if (check.ok && !check.data.isLive) {
          this.#d.store.patchTask(taskId, { skipCurrentLive: false });
          lastEndReason = null;
          continue;
        }
        if (runner.stopRequested) {
          runner.stopRequested = false;
        }
        await this.#waitPoll(taskId, this.#pollIntervalMs());
        continue;
      }

      if (this.#d.store.takeCheckNow(taskId)) {
        this.#emit('task.check_now', {}, taskId, null);
      }

      this.#runtime(taskId, 'resolving', task.streamerName ?? task.url);
      const outcome = await this.#d.resolver.resolve(task);
      if (runner.shutdown) return;
      if (runner.stopRequested) {
        runner.stopRequested = false;
        if (!task.monitorEnabled) return;
        this.#runtime(taskId, 'snoozed', '已停止本场');
        continue;
      }

      if (!outcome.ok) {
        const fault = resolveFault(outcome.error.code);
        this.#runtime(taskId, fault.state, outcome.error.message);
        this.#emit(fault.eventKind, { code: outcome.error.code, message: outcome.error.message }, taskId, null);
        if (fault.kind === 'needs_auth') this.#draft(copy.needsAuth({ streamer: task.streamerName }), taskId, null);
        if (fault.kind === 'needs_dep') {
          this.#draft(
            copy.needsDependency({ streamer: task.streamerName, runtime: 'Python / Node 运行时' }),
            taskId,
            null,
          );
        }
        if (fault.kind === 'unsupported') {
          this.#draft(
            copy.platformUnsupported({ url: task.url, platforms: '抖音、B站（可另放插件）' }),
            taskId,
            null,
          );
        }
        const waitMs =
          outcome.error.retryAfterS !== undefined
            ? Math.max(outcome.error.retryAfterS * 1000, 1_000)
            : this.#pollIntervalMs();
        await this.#waitPoll(taskId, waitMs);
        continue;
      }

      const data = outcome.data;
      if (data.platform.length > 0 && data.platform !== task.platform) {
        this.#d.store.patchTask(taskId, { platform: data.platform });
      }
      if (data.qualityOptions.length > 0) {
        this.#d.store.patchTask(taskId, { qualityOptions: data.qualityOptions });
      }
      if (data.anchorName !== null || data.title !== null) {
        this.#d.store.patchTask(taskId, {
          streamerName: data.anchorName ?? task.streamerName,
          title: data.title ?? task.title,
        });
      }

      if (!data.isLive) {
        urlLessRounds = 0;
        lastEndReason = null;
        if (task.skipCurrentLive) this.#d.store.patchTask(taskId, { skipCurrentLive: false });
        this.#runtime(taskId, 'waiting', data.anchorName ?? '等待开播');
        await this.#waitPoll(taskId, this.#pollIntervalMs());
        continue;
      }

      if (data.recordUrl === null || data.recordUrl.length === 0) {
        // 在播但拿不到流地址：前 6 轮 5s，之后回落到轮询间隔（不能紧循环）
        urlLessRounds += 1;
        const delay =
          urlLessRounds <= URL_LESS_FAST_ROUNDS ? URL_LESS_FAST_DELAY_MS : this.#pollIntervalMs();
        this.#runtime(taskId, 'error', `在播但未拿到流地址（第 ${urlLessRounds} 次，${delay / 1000}s 后重试）`);
        this.#emit(
          'plugin.resolve_url_missing',
          { streak: urlLessRounds, backoff_s: delay / 1000 },
          taskId,
          null,
        );
        await this.#waitPoll(taskId, delay);
        continue;
      }

      urlLessRounds = 0;

      // 起录前先问一句"运行环境就绪吗"：缺 ffmpeg 时立刻走 needs_dep，
      // 而不是拉起一个立刻退出的进程、连重连五次后报 unknown。
      const pre = await this.#d.capture.preflight?.();
      if (pre !== undefined && !pre.ok) {
        const detail = pre.detail ?? '录制环境未就绪';
        this.#runtime(taskId, 'needs_dep', detail);
        this.#emit('capture.dependency_missing', { detail }, taskId, null);
        this.#draft(copy.needsDependency({ streamer: task.streamerName, runtime: detail }), taskId, null);
        await this.#waitPoll(taskId, this.#pollIntervalMs());
        continue;
      }

      const outcomeSession = await this.#runSession(task, data, runner, lastEndReason);
      lastEndReason = outcomeSession.reason;
      if (runner.shutdown) return;

      if (outcomeSession.reason === 'capped') {
        // 立刻重进（origin=cap），不清 record_requested
        continue;
      }
      if (outcomeSession.reason === 'manual') {
        if (task.monitorEnabled) {
          this.#runtime(taskId, 'snoozed', '本场已停止，等待下播');
          continue;
        }
        return;
      }
      if (outcomeSession.reason === 'offline') {
        lastEndReason = null;
        this.#runtime(taskId, 'waiting', '等待下一场');
        await this.#waitPoll(taskId, this.#pollIntervalMs());
        continue;
      }
      if (outcomeSession.reason === 'degraded' || outcomeSession.reason === 'error') {
        this.#runtime(taskId, 'waiting', '连续失败，退避后重试');
        await this.#waitPoll(taskId, this.#pollIntervalMs());
        continue;
      }
      if (outcomeSession.reason === 'disk') {
        this.#runtime(taskId, 'error', '磁盘空间不足或写入失败');
        await this.#waitPoll(taskId, this.#pollIntervalMs());
        continue;
      }
      return;
    }
  }

  // ── 会话 ──────────────────────────────────────────────────────────────────

  async #runSession(
    task: Task,
    first: ResolveResult,
    runner: Runner,
    lastEndReason: EndReason | null,
  ): Promise<{ reason: EndReason }> {
    const startedAt = this.#clock.now();
    const sessionId = randomUUID().replace(/-/g, '');
    const origin: SessionOrigin = originAfter(lastEndReason);
    const streamer = first.anchorName ?? task.streamerName ?? 'livestream';
    const outputDir = joinPath(
      this.#d.outputRoot,
      streamer.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80),
      sessionDirName(startedAt, origin, sessionId),
    );
    await this.#d.fs.mkdirp(outputDir);

    const manifest = emptyManifest({
      sessionId,
      taskId: task.id,
      startedAt: startedAt.toISOString(),
      origin,
    });

    this.#d.store.createSession({
      id: sessionId,
      taskId: task.id,
      startedAt: startedAt.toISOString(),
      outputDir,
      origin,
    });
    this.#emit('session.started', { origin, output_dir: outputDir }, task.id, sessionId);
    this.#runtime(task.id, 'recording', `${streamer} · ${origin === 'cap' ? '承接上一场' : '新开一场'}`);
    this.#draft(copy.recordingStarted({ streamer }), task.id, sessionId);

    let res: ResolveResult | null = first;
    let nextPartNo = 1;
    let reconnects = 0;
    let gapTotal = 0;
    let lastConnEndMs: number | null = null;
    let faultStreak = 0;
    /** 连续"拉起来就死"的连接数：spawn 失败/立刻 EOF 不应该变成热循环 */
    let connFaults = 0;
    let reason: EndReason;
    let lastCause: GapCause = 'reconnect';

    while (true) {
      if (runner.shutdown) {
        reason = 'shutdown';
        break;
      }
      if (runner.stopRequested) {
        reason = 'manual';
        runner.stopRequested = false;
        break;
      }

      if (res === null) {
        // 段间重新解析：内部重试 3 次（1/2/4s），失败进会话退避阶梯
        const resolved = await this.#resolveWithRetries(task);
        if (!resolved.ok) {
          faultStreak += 1;
          lastCause = 'resolve_failed';
          this.#emit(
            'recording.resolve_failed',
            { fault_streak: faultStreak, code: resolved.error.code, message: resolved.error.message },
            task.id,
            sessionId,
          );
          if (faultStreak >= FAIL_STREAK_LIMIT) {
            reason = 'degraded';
            break;
          }
          this.#runtime(task.id, 'reconnecting', `解析失败（第 ${faultStreak} 次）`);
          await this.#sleep(reconnectDelayMs(faultStreak, this.#pollIntervalS()));
          continue;
        }
        res = resolved.data;
        if (!res.isLive || res.recordUrl === null) {
          reason = 'offline';
          break;
        }
      }

      const taskNow = this.#d.store.getTask(task.id) ?? task;
      const capS = effectiveMaxSessionS(taskNow);
      const capBytes = effectiveMaxSessionBytes(taskNow);
      const sumDuration = this.#d.store.sumSegmentDuration(sessionId);
      const remainingS = capS - sumDuration;
      if (remainingS <= 0) {
        reason = 'capped';
        this.#emit('session.capped', { max_session_s: capS, max_session_bytes: capBytes }, task.id, sessionId);
        break;
      }

      faultStreak = 0;
      const connStart = this.#clock.now();
      const connStartMs = connStart.getTime();

      if (lastConnEndMs !== null && nextPartNo > 1) {
        const gap = Math.max(0, (connStartMs - lastConnEndMs) / 1000);
        if (gap > 0.001) {
          gapTotal += gap;
          manifest.gaps.push({ after_part: nextPartNo - 1, duration_s: gap, cause: lastCause });
          this.#emit(
            'recording.gap',
            { after_part: nextPartNo - 1, gap_s: gap, cause: lastCause },
            task.id,
            sessionId,
          );
        }
      }

      const segmentTimeS = Math.max(10, Math.min(taskNow.segmentTimeS, Math.ceil(remainingS)));
      const headers = renderHeaders(res.headers);
      const args = recordArgs(
        {
          recordUrl: res.recordUrl ?? '',
          outputDir,
          sessionId,
          startNumber: nextPartNo,
          segmentTimeS,
          headers: res.headers,
          proxy: typeof taskNow.override['proxy'] === 'string' ? taskNow.override['proxy'] : null,
          overseas: res.isOverseas,
        },
        headers,
      );

      const classes = new Set<ErrorClass>();
      const connCtx: ConnectionContext = {
        sessionId,
        outputDir,
        startPartNo: nextPartNo,
        connStartMs,
        final: false,
        abnormal: false,
        classes,
        manifest,
      };

      this.#runtime(task.id, 'recording', `${streamer} · 第 ${nextPartNo} 段起`);
      this.#emit('recording.started', { part: nextPartNo }, task.id, sessionId);
      this.#emit('recording.segment_started', { part: nextPartNo }, task.id, sessionId);

      let handle: CaptureHandle;
      try {
        handle = await this.#d.capture.start({
          args,
          onStderrLine: (line) => {
            this.#onStderr(line, classes, task.id, sessionId);
          },
        });
      } catch (err) {
        // 拉起失败（二进制不可执行、权限不足）：会话到此为止，别把异常吞成"重连"
        const message = err instanceof Error ? err.message : String(err);
        this.#emit('recording.start_failed', { message }, task.id, sessionId);
        this.#runtime(task.id, 'error', `无法启动录制进程：${message}`);
        reason = 'error';
        break;
      }

      const conn = await this.#monitorConnection({
        handle,
        task,
        sessionId,
        outputDir,
        connStartMs,
        capS,
        capBytes,
        runner,
        startPartNo: nextPartNo,
        classes,
        manifest,
      });

      connCtx.final = true;
      connCtx.abnormal = conn.stalled || conn.code !== 0 || conn.signal !== null;
      const collected = await this.#collectSegments(connCtx);
      nextPartNo = collected.nextPartNo;
      if (collected.lastEndS > 0) lastConnEndMs = connStartMs + collected.lastEndS * 1000;
      connFaults = collected.added > 0 ? 0 : connFaults + 1;
      await this.#writeManifest(outputDir, manifest);

      if (conn.stalled) {
        this.#runtime(task.id, 'reconnecting', '流卡死，已硬杀并重新解析');
      } else if (runner.shutdown) {
        // 宿主退出优先于"这一场停止"：reason=shutdown 才会跳过自动后处理，
        // 否则在退出过程中拉起 ffmpeg 合并，收尾超时就被硬杀（留下 .tmp 残骸）
        reason = 'shutdown';
        break;
      } else if (conn.capped) {
        reason = 'capped';
        this.#emit('session.capped', { max_session_s: capS, max_session_bytes: capBytes }, task.id, sessionId);
        break;
      } else if (conn.manualStop) {
        reason = 'manual';
        break;
      }

      const decision = decideExit({ code: conn.code, signal: conn.signal, classes: conn.classes });
      if (decision.action === 'disk') {
        reason = 'disk';
        this.#emit('recording.error_class', { class: 'disk' }, task.id, sessionId);
        break;
      }

      if (decision.action === 'graceful') {
        // 可能真下播：一次解析确认；仍直播则续录（同会话新连接）
        const check = await this.#d.resolver.resolve(task);
        if (check.ok && !check.data.isLive) {
          reason = 'offline';
          break;
        }
        if (check.ok && check.data.isLive) {
          reconnects += 1;
          res = check.data;
          lastCause = 'reconnect';
          this.#runtime(task.id, 'reconnecting', '流结束但仍在直播，续录新分段');
          continue;
        }
        faultStreak += 1;
        lastCause = 'resolve_failed';
        res = null;
        await this.#sleep(reconnectDelayMs(faultStreak, this.#pollIntervalS()));
        continue;
      }

      // 异常退出 → 第二层重连
      reconnects += 1;
      lastCause = conn.stalled ? 'stall' : 'reconnect';
      res = null;
      if (!conn.stalled && connFaults >= FAIL_STREAK_LIMIT) {
        reason = 'error';
        this.#emit('recording.give_up', { fault_streak: connFaults }, task.id, sessionId);
        break;
      }
      this.#runtime(
        task.id,
        'reconnecting',
        `重连中（${primaryClass(conn.classes) ?? 'unknown'}）`,
      );
      // 连续失败之间必须退避：spawn 失败是毫秒级的，不退避就是热循环
      if (connFaults > 0) await this.#sleep(reconnectDelayMs(connFaults, this.#pollIntervalS()));
    }

    const endedAt = this.#clock.now();
    const durationS = this.#d.store.sumSegmentDuration(sessionId);
    const reconnectsFinal = Math.max(0, reconnects);
    this.#d.store.endSession(sessionId, reason, endedAt.toISOString());
    manifest.ended_at = endedAt.toISOString();
    manifest.end_reason = reason;
    await this.#writeManifest(outputDir, manifest);
    this.#emit(
      'session.ended',
      {
        end_reason: reason,
        duration_s: durationS,
        reconnects: reconnectsFinal,
        gap_s: gapTotal,
      },
      task.id,
      sessionId,
    );
    this.#draft(
      copy.recordingEnded({
        streamer,
        durationS:
          durationS > 0 ? durationS : Math.max(0, (endedAt.getTime() - startedAt.getTime()) / 1000),
        reconnects: reconnectsFinal,
        gapS: gapTotal,
        reason,
      }),
      task.id,
      sessionId,
    );
    if (reason === 'capped') this.#draft(copy.sessionCapped({ streamer, capS: effectiveMaxSessionS(task) }), task.id, sessionId);

    if (reason === 'manual') {
      if (task.monitorEnabled) this.#d.store.patchTask(task.id, { skipCurrentLive: true });
      else this.#d.store.patchTask(task.id, { recordRequested: false });
    } else if (reason !== 'capped') {
      this.#d.store.patchTask(task.id, { recordRequested: false });
    }

    try {
      this.#d.onSessionEnded?.(sessionId, task.id, reason);
    } catch (err) {
      this.#logWarn('会话收尾回调失败', err);
    }

    this.#runtime(task.id, reason === 'offline' ? 'waiting' : 'idle', `本场结束（${reason}）`);
    return { reason };
  }

  async #monitorConnection(input: {
    handle: CaptureHandle;
    task: Task;
    sessionId: string;
    outputDir: string;
    connStartMs: number;
    capS: number;
    capBytes: number;
    startPartNo: number;
    runner: Runner;
    classes: Set<ErrorClass>;
    manifest: SessionManifest;
  }): Promise<ConnectionResult> {
    const classes = input.classes;
    let manualStop = false;
    let capped = false;
    let stalled = false;
    let lastSize = 0;
    let lastGrowthAt = this.#clock.now().getTime();

    const exitPromise = input.handle.wait();
    let exited = false;
    void exitPromise.then(() => {
      exited = true;
    });

    while (!exited) {
      await this.#sleep(200);
      const nowMs = this.#clock.now().getTime();

      if (input.runner.shutdown || input.runner.stopRequested) {
        manualStop = true;
        await input.handle.stop(this.#d.stopGraceMs);
        break;
      }

      const size = await this.#sumTsSize(input.outputDir);
      if (size > lastSize) {
        lastSize = size;
        lastGrowthAt = nowMs;
      }

      const elapsedS = (nowMs - input.connStartMs) / 1000;
      if (!capped && (this.#d.store.sumSegmentDuration(input.sessionId) + elapsedS >= input.capS)) {
        capped = true;
        await input.handle.stop(this.#d.stopGraceMs);
        break;
      }
      const totalBytes = this.#d.store.sumSegmentBytes(input.sessionId) + size;
      if (!capped && totalBytes >= input.capBytes) {
        capped = true;
        await input.handle.stop(this.#d.stopGraceMs);
        break;
      }

      // 看门狗：启动宽限后连续 20s 零增长 → 硬杀（不是优雅停，卡住的进程不读 stdin）
      if (
        !stalled &&
        elapsedS > this.#d.startGraceS &&
        (nowMs - lastGrowthAt) / 1000 >= this.#d.stallS
      ) {
        stalled = true;
        input.handle.kill();
        this.#emit(
          'recording.stalled',
          { part: input.startPartNo, stall_s: (nowMs - lastGrowthAt) / 1000, size, path: input.outputDir },
          input.task.id,
          input.sessionId,
        );
        break;
      }

      // 低频把已完成的段登记进库（最后一个可能还在写）
      if (Math.round(elapsedS) % 5 === 0) {
        await this.#collectSegments({
          sessionId: input.sessionId,
          outputDir: input.outputDir,
          startPartNo: input.startPartNo,
          connStartMs: input.connStartMs,
          final: false,
          abnormal: false,
          classes,
          manifest: input.manifest,
        }).catch(() => undefined);
      }
    }

    const info = await exitPromise;
    return {
      code: info.code,
      signal: info.signal,
      classes,
      manualStop,
      capped,
      stalled,
      lastSize,
    };
  }

  #onStderr(line: string, classes: Set<ErrorClass>, taskId: string, sessionId: string): void {
    const cls = classifyLine(line);
    if (cls === null) {
      if (/error|warning/i.test(line)) {
        this.#emit('recording.stderr', { line: line.slice(0, 500) }, taskId, sessionId);
      }
      return;
    }
    if (!classes.has(cls)) {
      classes.add(cls);
      this.#emit('recording.error_class', { class: cls, line: line.slice(0, 300) }, taskId, sessionId);
    }
  }

  // ── 分段登记 ──────────────────────────────────────────────────────────────

  async #collectSegments(
    ctx: ConnectionContext,
  ): Promise<{ added: number; lastEndS: number; nextPartNo: number }> {
    const base = { added: 0, lastEndS: 0, nextPartNo: ctx.startPartNo };
    const csv = await this.#d.fs.readText(joinPath(ctx.outputDir, segmentListName(ctx.sessionId)));
    if (csv === null) return base;
    const entries = parseSegList(csv);
    if (entries.length === 0) return base;
    const upto = ctx.final ? entries.length : entries.length - 1;
    let added = 0;
    let lastEndS = 0;
    // seglist 会跨连接累积（同一文件被下一个 ffmpeg 进程继续追加），
    // 所以编号不能写成 `startPartNo + i` —— 那只对第一条连接成立。
    // 文件名里的 part 号是 ffmpeg 自己给的，最可靠；没有则顺延。
    let maxPart = ctx.startPartNo - 1;
    for (const row of this.#d.store.listSegments(ctx.sessionId)) maxPart = Math.max(maxPart, row.partNo);

    for (let i = 0; i < upto; i += 1) {
      const entry = entries[i];
      if (entry === undefined) continue;
      // seglist 里通常只有文件名；万一给了绝对路径也照用
      const path = /^[A-Za-z]:[\\/]|^\//.test(entry.file)
        ? entry.file
        : joinPath(ctx.outputDir, baseName(entry.file));
      if (this.#d.store.getSegmentByPath(path) !== undefined) {
        lastEndS = Math.max(lastEndS, entry.end);
        continue;
      }
      const size = await this.#d.fs.statSize(path);
      if (size <= 0) continue;
      const fp = await this.#d.probe.probe(path);
      const isLast = i === entries.length - 1;
      const integrity = ctx.final && isLast && ctx.abnormal
        ? ('truncated' as const)
        : primaryClass(ctx.classes) !== null
          ? ('partial' as const)
          : ('ok' as const);
      const partNo = parsePartNo(baseName(path)) ?? maxPart + 1;
      maxPart = Math.max(maxPart, partNo);
      this.#d.store.insertSegment({
        sessionId: ctx.sessionId,
        path,
        partNo,
        startedAt: new Date(ctx.connStartMs + entry.start * 1000).toISOString(),
        durationS: Math.max(0, entry.end - entry.start),
        sizeBytes: size,
        integrity,
        errorClass: primaryClass(ctx.classes),
        video: fp?.video ?? null,
        audio: fp?.audio ?? null,
      });
      ctx.manifest.segments.push({
        part_no: partNo,
        file: baseName(path),
        started_at: new Date(ctx.connStartMs + entry.start * 1000).toISOString(),
        duration_s: Math.max(0, entry.end - entry.start),
        size_bytes: size,
        video:
          fp?.video === null || fp?.video === undefined
            ? null
            : {
                codec: fp.video.codec,
                profile: fp.video.profile,
                width: fp.video.width,
                height: fp.video.height,
                pix_fmt: fp.video.pixFmt,
              },
        audio:
          fp?.audio === null || fp?.audio === undefined
            ? null
            : {
                codec: fp.audio.codec,
                sample_rate: fp.audio.sampleRate,
                channels: fp.audio.channels,
              },
        layout_hash: fp?.video?.layoutHash ?? null,
        integrity,
      });
      added += 1;
      lastEndS = Math.max(lastEndS, entry.end);
      this.#emit(
        'recording.segment_ended',
        {
          part: partNo,
          duration_s: Math.max(0, entry.end - entry.start),
          size_bytes: size,
          integrity,
          layout_hash: fp?.video?.layoutHash ?? null,
        },
        undefined,
        ctx.sessionId,
      );
    }
    return { added, lastEndS, nextPartNo: maxPart + 1 };
  }

  async #writeManifest(outputDir: string, manifest: SessionManifest): Promise<void> {
    try {
      await this.#d.fs.writeText(joinPath(outputDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
    } catch (err) {
      this.#logWarn('manifest 落盘失败', err);
    }
  }

  /** 合并器/恢复扫描的 manifest 兜底读取（M2） */
  async readManifest(outputDir: string): Promise<SessionManifest | null> {
    const text = await this.#d.fs.readText(joinPath(outputDir, MANIFEST_NAME));
    if (text === null) return null;
    try {
      return parseManifest(JSON.parse(text));
    } catch {
      return null;
    }
  }

  // ── 工具 ──────────────────────────────────────────────────────────────────

  async #resolveWithRetries(task: Task): Promise<ResolveOutcome> {
    let last: ResolveOutcome = {
      ok: false,
      error: { code: 'INTERNAL', message: '未发起解析', retryable: true },
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const outcome = await this.#d.resolver.resolve(task);
      if (outcome.ok) return outcome;
      last = outcome;
      if (!outcome.error.retryable) return outcome;
      if (attempt < 2) await this.#sleep([1_000, 2_000][attempt] ?? 2_000);
    }
    return last;
  }

  async #waitPoll(taskId: string, ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!this.#running) return;
      const task = this.#d.store.getTask(taskId);
      if (task === undefined) return;
      if (task.checkNow) {
        this.#d.store.takeCheckNow(taskId);
        return;
      }
      if (!task.monitorEnabled && !task.recordRequested) return;
      await this.#sleep(SLICE_MS);
    }
  }

  async #sleep(ms: number): Promise<void> {
    const step = Math.min(SLICE_MS, Math.max(1, ms));
    let left = ms;
    while (left > 0) {
      const chunk = Math.min(step, left);
      await this.#clock.sleep(chunk);
      left -= chunk;
    }
  }

  async #sumTsSize(dir: string): Promise<number> {
    const files = await this.#d.fs.listFiles(dir);
    let total = 0;
    for (const f of files) {
      if (!f.toLowerCase().endsWith('.ts')) continue;
      total += await this.#d.fs.statSize(f);
    }
    return total;
  }

  #pollIntervalS(): number {
    return Math.min(Math.max(this.#d.store.getSettings().pollIntervalS, 5), 3600);
  }

  #pollIntervalMs(): number {
    return this.#pollIntervalS() * 1000;
  }

  #runtime(taskId: string, state: Parameters<Store['setRuntime']>[1], detail: string | null): void {
    try {
      this.#d.store.setRuntime(taskId, state, detail);
      this.#emit('task.state_changed', { state, detail }, taskId, null);
    } catch (err) {
      this.#logWarn('运行态写入失败', err);
    }
  }

  #emit(
    kind: string,
    payload: Record<string, unknown>,
    taskId?: string | null,
    sessionId?: string | null,
  ): void {
    try {
      this.#d.store.insertEvent({
        kind,
        payload,
        taskId: taskId ?? null,
        sessionId: sessionId ?? null,
      });
    } catch (err) {
      this.#logWarn(`事件落库失败（${kind}）`, err);
    }
  }

  #draft(draft: Draft, taskId: string, sessionId: string | null): void {
    try {
      this.#d.onDraft?.(draft, { taskId, sessionId });
    } catch (err) {
      this.#logWarn('通知派生失败', err);
    }
  }

  #logWarn(msg: string, meta?: unknown): void {
    this.#d.logger?.warn(msg, meta);
  }
}
