/**
 * 录制引擎（M1/M2 的核心）：每个任务一条 runner，runner 内是"解析 → 录制 → 重连 → 收尾"。
 *
 * 纪律：
 * - runner 表是进程内的，跨进程互斥交给 host-adapter 的 lease；
 * - 一切子进程受监督（CapturePort），退出必回收；
 * - UI 只是事件消费者：emit 失败不影响录制（这里的事件写库失败只告警）。
 */
import { randomUUID } from 'node:crypto';
import type { EndReason, PollPlan, QualityActual, SessionOrigin, Store, Task } from '@tidewatch/store';
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
  isCandidateTs,
  joinPath,
  MANIFEST_NAME,
  parsePartNo,
  renderHeaders,
  segmentListName,
  sessionDirName,
} from './layout.ts';
import { emptyManifest, parseManifest, type GapCause, type SessionManifest } from './manifest.ts';
import { hourAffinity, inWindows, nextOpenAt, planPoll } from './schedule.ts';

// ── 端口 ────────────────────────────────────────────────────────────────────

/** 本地 HH:MM（监控时段的"恢复时间"给用户看，必须用本地时区） */
const fmtClock = (d: Date): string =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

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
  /**
   * 生效的二进制版本（`ffmpeg -version` 的第一行里那段，例如 `9.0.2`）。
   * 版本会改变 stderr 的措辞（8.1.3 起 `Frame changed from size` 就没了），
   * 而错误分类靠关键词表 —— 所以"用户装了哪个版本"必须能被看到。
   */
  version?: string;
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
  /**
   * 这次解析**实际**选中的档位。平台会静默降级（B站未登录时请求原画只回高清，
   * 且 `code` 仍是 0），所以"请求的"（`Task.quality`）与"给的"必须分开记录。
   * 插件没提供时为 null（老插件 / 直链）。
   */
  qualityActual: QualityActual | null;
  cookiesOut: string | null;
}

export interface ResolveFailure {
  code:
    | 'AUTH_REQUIRED'
    | 'DEPENDENCY_MISSING'
    | 'RATE_LIMITED'
    | 'PLATFORM_CHANGED'
    | 'PLATFORM_UNSUPPORTED'
    | 'UNSUPPORTED_URL'
    | 'NOT_LIVE'
    | 'RESTRICTED'
    | 'NETWORK'
    | 'INTERNAL'
    | 'TIMEOUT';
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
  /**
   * 单调时钟（毫秒）。看门狗、单场上限、缺口计时一律用它，**不要用墙钟**：
   * 系统时钟被手动/NTP 往前拨一小时，墙钟差值会凭空多出 3600 秒，
   * 看门狗就会把一条健康的录制当成"卡死"杀掉（2026-11-01 真机踩过）。
   */
  mono?: () => number;
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

/**
 * 每场最多记多少条原始 stderr。错误流一旦刷起来是每秒几十行，
 * 全量入库会让"事件表"变成一份 ffmpeg 日志，真正要看的收尾/合并记录反而被埋掉。
 * 到顶后只补一条汇总，保留"压掉了多少"这个事实。
 */
const STDERR_EVENT_CAP = 100;

export class Engine {
  readonly #d: Required<Pick<EngineDeps, 'tickMs' | 'stopGraceMs' | 'stallS' | 'startGraceS'>> & EngineDeps;
  readonly #clock: EngineClock;
  readonly #mono: () => number;
  readonly #runners = new Map<string, Runner>();
  /** 各任务的轮询节奏计数：连续未开播轮数 / 连续解析失败轮数（开播或成功即清零） */
  readonly #pacing = new Map<string, { idle: number; error: number }>();
  /** 历史开播热度的缓存：每小时重算一次就够，不必每 30 秒查一遍库 */
  readonly #affinity = new Map<string, { at: number; buckets: number[] }>();
  /** 已经报过"流参数变了"的会话（同一场只说一次，收尾时清掉） */
  readonly #layoutNotified = new Set<string>();
  /**
   * 最近一次**真正落库**的投影（state + detail）。轮询每轮都会调 `#runtime`，
   * 但"主播没开播"连续十轮的投影文本一模一样 —— 一样就不该再写一遍库、
   * 更不该给用户的时间线添一条事件（一天上万条里 95% 是这么来的）。
   */
  readonly #projected = new Map<string, string>();
  /** 每个会话已经记了几条原始 stderr（错误流可能一秒几十行，全记等于淹没事件表） */
  readonly #stderrSeen = new Map<string, number>();
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
    this.#mono = deps.mono ?? (() => performance.now());
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

      // 监控时段：窗外一次请求都不发。用户手动点「检查」/「录制」时放行 ——
      // 点了按钮却因为"不在时段"没反应，是最难解释的一种交互。
      if (!task.checkNow && !task.recordRequested && task.monitorWindows.length > 0) {
        const now = this.#clock.now();
        if (!inWindows(task.monitorWindows, now)) {
          const resume = nextOpenAt(task.monitorWindows, now);
          this.#runtime(
            taskId,
            'paused',
            resume === null ? '不在监控时段' : `不在监控时段，${fmtClock(resume)} 恢复`,
          );
          this.#emit('task.monitor_window', { resume_at: resume?.toISOString() ?? null }, taskId, null);
          const waitMs =
            resume === null ? this.#pollIntervalMs() : Math.max(1_000, resume.getTime() - now.getTime());
          await this.#waitPoll(taskId, waitMs);
          continue;
        }
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
        await this.#waitPoll(taskId, this.#planFor(task, this.#clock.now()).delayMs);
        continue;
      }

      if (this.#d.store.takeCheckNow(taskId)) {
        this.#emit('task.check_now', {}, taskId, null);
      }

      // 中间态：投影也不写。几百毫秒的"解析中"没人需要，写进去只是每轮多两条记录
      this.#runtime(taskId, 'resolving', task.streamerName ?? task.url, { transient: true });
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
        const pace = this.#pace(taskId);

        // 主播没开播是**正常状态**，不是故障：抖音下播时抛异常而不是返回空数据，
        // 之前兜底成 error → 下播期间每 30 秒记一条"出错"（2026-11-04 实测 61 条）。
        if (fault.kind === 'not_live') {
          pace.idle += 1;
          pace.error = 0;
          urlLessRounds = 0;
          this.#runtime(taskId, 'waiting', '主播未开播');
          await this.#waitPoll(taskId, this.#planFor(task, this.#clock.now()).delayMs);
          continue;
        }

        pace.error += 1;
        // 平台原文（"你不在主播设置的可见范围内，无法进入TA的直播间"）不放进卡片：
        // 卡片只有一行，截断后只剩半句"可见范围"，反而看不清该干嘛。原始错误进事件表。
        const detail =
          fault.kind === 'restricted' ? '主播限制了观看范围，半小时后再试' : outcome.error.message;
        // 同一个错误连续十几轮（网络没恢复、cookie 没换）只记第一条：
        // 投影没变就说明"还是同一个问题"，重复记只是把表撑大
        const changed = this.#runtime(taskId, fault.state, detail);
        if (changed) {
          this.#emit(fault.eventKind, { code: outcome.error.code, message: outcome.error.message }, taskId, null);
        }
        if (fault.kind === 'needs_auth') this.#draft(copy.needsAuth({ streamer: task.streamerName }), taskId, null);
        if (fault.kind === 'restricted') {
          // 主播设了观看范围：通知一次，之后按 retry_after（半小时）退避，别持续撞门
          pace.idle += 1;
          this.#draft(copy.viewRestricted({ streamer: task.streamerName }), taskId, null);
        }
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
            : this.#planFor(task, this.#clock.now()).delayMs;
        await this.#waitPoll(taskId, waitMs);
        continue;
      }

      const data = outcome.data;
      const pace = this.#pace(taskId);
      pace.error = 0;
      this.#applyQuality(task, data);
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
        pace.idle += 1;
        if (task.skipCurrentLive) this.#d.store.patchTask(taskId, { skipCurrentLive: false });
        this.#runtime(taskId, 'waiting', data.anchorName ?? '等待开播');
        await this.#waitPoll(taskId, this.#planFor(task, this.#clock.now()).delayMs);
        continue;
      }

      pace.idle = 0;

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
        await this.#waitPoll(taskId, this.#planFor(task, this.#clock.now()).delayMs);
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
        await this.#waitPoll(taskId, this.#planFor(task, this.#clock.now()).delayMs);
        continue;
      }
      if (outcomeSession.reason === 'degraded' || outcomeSession.reason === 'error') {
        this.#runtime(taskId, 'waiting', '连续失败，退避后重试');
        await this.#waitPoll(taskId, this.#planFor(task, this.#clock.now()).delayMs);
        continue;
      }
      if (outcomeSession.reason === 'disk') {
        this.#runtime(taskId, 'error', '磁盘空间不足或写入失败');
        await this.#waitPoll(taskId, this.#planFor(task, this.#clock.now()).delayMs);
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
    /** 上一段内容的结束点（单调时钟毫秒），缺口一律基于它算，不受墙钟调整影响 */
    let lastConnEndMono: number | null = null;
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
        this.#applyQuality(task, res);
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
      const connStartMono = this.#mono();

      // 上一轮连接可能留下没封口的残段（ffmpeg 被杀/崩时 csv 里没有它，文件却在盘上）。
      // 不接管就直接从同一个 part 号重开，`-segment_start_number` 会把那个文件截断覆盖
      // —— 2026-11-01 老猫鱼那场这样白丢了 70MB（约 8 分钟）。
      const adopted = await this.#adoptDanglingParts(sessionId, outputDir, nextPartNo, task.id);
      nextPartNo = adopted.nextPartNo;
      if (adopted.salvagedS > 0 && lastConnEndMono !== null) {
        // 抢救回来的残段本来就在时间轴上，接上它，缺口才不会把它算成"断流"
        lastConnEndMono += adopted.salvagedS * 1000;
      }

      // 缺口先"记账待定"：这一轮重连如果又什么都没录到（拉起就死），
      // 就不该单独记一条缺口 —— 早先每次尝试都 append 一次，
      // 一次断流能记出 4 条 after_part 相同的缺口、gap_s 虚高到 4 倍。
      // 真正录到东西之后（collect 里 added > 0）才落地这一条。
      let pendingGap: { afterPart: number; gapS: number; cause: GapCause } | null = null;
      if (lastConnEndMono !== null && nextPartNo > 1) {
        const gap = Math.max(0, (connStartMono - lastConnEndMono) / 1000);
        if (gap > 0.001) {
          pendingGap = { afterPart: nextPartNo - 1, gapS: gap, cause: lastCause };
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

      // 「第 N 段起」容易被读成"已经录了 N 段"，改成明确的"正在录第 N 段"
      this.#runtime(task.id, 'recording', `正在录第 ${String(nextPartNo)} 段`);
      this.#emit('recording.started', { part: nextPartNo }, task.id, sessionId);
      this.#emit('recording.segment_started', { part: nextPartNo }, task.id, sessionId);

      /** 这条连接开始前已有的段数：收尾时用它判断"这一轮到底录到没有" */
      const partsBefore = this.#d.store.listSegments(sessionId).length;

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
      if (collected.lastEndS > 0) lastConnEndMono = connStartMono + collected.lastEndS * 1000;
      // 这一轮到底有没有录到东西，按"库里多了几段"判断：
      // 段可能是在连接中途那次低频 collect 就登记了，收尾这次 add 数会是 0。
      const produced = this.#d.store.listSegments(sessionId).length > partsBefore;
      // 真录到了，前面那段空档才算数（见 pendingGap 的注释）
      if (pendingGap !== null && produced) {
        gapTotal += pendingGap.gapS;
        manifest.gaps.push({
          after_part: pendingGap.afterPart,
          duration_s: pendingGap.gapS,
          cause: pendingGap.cause,
        });
        this.#emit(
          'recording.gap',
          { after_part: pendingGap.afterPart, gap_s: pendingGap.gapS, cause: pendingGap.cause },
          task.id,
          sessionId,
        );
      }
      connFaults = produced ? 0 : connFaults + 1;
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
    this.#layoutNotified.delete(sessionId);
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

    this.#stderrSeen.delete(sessionId);
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
    // 看门狗必须用单调时钟：墙钟被往前拨（手动改时间/NTP 跳变）会让
    // "多久没增长"凭空变大一小时，健康的录制会被当成卡死杀掉。
    let lastGrowthMono = this.#mono();
    const monoStart = lastGrowthMono;
    // 当前正在写的段号：连接开始时由 startPartNo 给出，段轮转后跟着变，
    // 用于把"正在录第 N 段"这条运行态维持成最新（见下面的低频 collect）。
    let currentPartNo = input.startPartNo;

    const exitPromise = input.handle.wait();
    let exited = false;
    void exitPromise.then(() => {
      exited = true;
    });

    while (!exited) {
      await this.#sleep(200);
      const monoNow = this.#mono();

      if (input.runner.shutdown || input.runner.stopRequested) {
        manualStop = true;
        await input.handle.stop(this.#d.stopGraceMs);
        break;
      }

      const size = await this.#sumTsSize(input.outputDir);
      if (size > lastSize) {
        lastSize = size;
        lastGrowthMono = monoNow;
      }

      const elapsedS = (monoNow - monoStart) / 1000;
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
        (monoNow - lastGrowthMono) / 1000 >= this.#d.stallS
      ) {
        stalled = true;
        input.handle.kill();
        this.#emit(
          'recording.stalled',
          {
            part: input.startPartNo,
            stall_s: (monoNow - lastGrowthMono) / 1000,
            size,
            path: input.outputDir,
          },
          input.task.id,
          input.sessionId,
        );
        break;
      }

      // 低频把已完成的段登记进库（最后一个可能还在写）
      if (Math.round(elapsedS) % 5 === 0) {
        const collected = await this.#collectSegments({
          sessionId: input.sessionId,
          outputDir: input.outputDir,
          startPartNo: input.startPartNo,
          connStartMs: input.connStartMs,
          final: false,
          abnormal: false,
          classes,
          manifest: input.manifest,
        }).catch(() => undefined);

        // 段轮转后必须跟着改文案：`recording` 的 detail 原来只在建连接时写一次，
        // 默认分段是 1 小时，于是第一条连接里录到第 2、3 段，卡上仍停在
        // 「正在录第 1 段」，要等这场结束才纠正。
        // `nextPartNo` 是"最后一段封口的 +1"，正好等于 ffmpeg 正在写的段号。
        if (collected !== undefined && collected.nextPartNo > currentPartNo) {
          currentPartNo = collected.nextPartNo;
          this.#runtime(input.task.id, 'recording', `正在录第 ${String(currentPartNo)} 段`);
          this.#emit('recording.segment_started', { part: currentPartNo }, input.task.id, input.sessionId);
        }
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
        const seen = this.#stderrSeen.get(sessionId) ?? 0;
        if (seen < STDERR_EVENT_CAP) {
          this.#stderrSeen.set(sessionId, seen + 1);
          this.#emit('recording.stderr', { line: line.slice(0, 500) }, taskId, sessionId);
        } else if (seen === STDERR_EVENT_CAP) {
          this.#stderrSeen.set(sessionId, seen + 1);
          this.#emit('recording.stderr_capped', { kept: STDERR_EVENT_CAP }, taskId, sessionId);
        }
      }
      return;
    }
    if (!classes.has(cls)) {
      classes.add(cls);
      this.#emit('recording.error_class', { class: cls, line: line.slice(0, 300) }, taskId, sessionId);
    }
  }

  // ── 分段登记 ──────────────────────────────────────────────────────────────

  /**
   * 接管"盘上有、库里没有"的段。
   *
   * 场景：ffmpeg 被杀/崩溃时，正在写的段没有写进 seglist（ffmpeg 只在段封口后
   * 才追加一行），所以库里查不到；下一轮连接从 `nextPartNo` 起又开始写同名文件，
   * 直接把这段内容覆盖掉。这里先 ffprobe 一遍，能解析就登记成 `recovered`
   * （和崩溃恢复同一种完整性标记），并把段号往后推。
   *
   * 返回推进后的下一个段号，以及抢救到的总时长（用于把缺口算准）。
   */
  async #adoptDanglingParts(
    sessionId: string,
    outputDir: string,
    nextPartNo: number,
    taskId: string,
  ): Promise<{ nextPartNo: number; salvagedS: number }> {
    const registered = this.#d.store.listSegments(sessionId);
    const used = new Set(registered.map((s) => s.partNo));
    let maxPart = registered.reduce((m, s) => Math.max(m, s.partNo), nextPartNo - 1);

    let files: string[];
    try {
      files = await this.#d.fs.listFiles(outputDir);
    } catch {
      return { nextPartNo: maxPart + 1, salvagedS: 0 };
    }

    let salvagedS = 0;
    for (const file of files) {
      const name = baseName(file);
      if (!isCandidateTs(name)) continue;
      if (this.#d.store.getSegmentByPath(file) !== undefined) continue;

      let partNo = parsePartNo(name) ?? maxPart + 1;
      while (used.has(partNo)) partNo += 1;

      const size = await this.#d.fs.statSize(file);
      const fp = size > 0 ? await this.#d.probe.probe(file) : null;
      if (fp === null || fp.video === null || fp.durationS <= 0) continue;

      used.add(partNo);
      maxPart = Math.max(maxPart, partNo);
      salvagedS += fp.durationS;
      this.#d.store.insertSegment({
        sessionId,
        path: file,
        partNo,
        startedAt: this.#clock.now().toISOString(),
        durationS: fp.durationS,
        sizeBytes: size,
        integrity: 'recovered',
        errorClass: null,
        video: fp.video,
        audio: fp.audio,
      });
      this.#emit(
        'recording.segment_recovered',
        { part: partNo, duration_s: fp.durationS, size_bytes: size },
        taskId,
        sessionId,
      );
    }

    return { nextPartNo: maxPart + 1, salvagedS };
  }

  async #collectSegments(
    ctx: ConnectionContext,
  ): Promise<{ added: number; lastEndS: number; nextPartNo: number }> {
    const base = { added: 0, lastEndS: 0, nextPartNo: ctx.startPartNo };
    const csv = await this.#d.fs.readText(joinPath(ctx.outputDir, segmentListName(ctx.sessionId)));
    if (csv === null) return base;
    // ffmpeg 的 csv 段列表只在段「关闭」之后追加一行（+live 只是让列表随切片重写，
    // 不会为正在写的段先占一行）。所以录制中也能取全部条目。
    // 早先这里固定丢掉最后一条，本意是"最后一段可能还在写"，实际丢掉的是
    // 最近一条**已经封口**的段 —— 于是录制期间永远少一段：默认分段 1 小时时，
    // 表现为"录了一个多小时，界面上还是 0 段"，直到这场结束才补出来。
    // 少数版本若先写一条时长 0 的占位行，用 end > start 过滤掉。
    const entries = parseSegList(csv).filter((e) => e.end > e.start);
    if (entries.length === 0) return base;
    let added = 0;
    let lastEndS = 0;
    // seglist 会跨连接累积（同一文件被下一个 ffmpeg 进程继续追加），
    // 所以编号不能写成 `startPartNo + i` —— 那只对第一条连接成立。
    // 文件名里的 part 号是 ffmpeg 自己给的，最可靠；没有则顺延。
    let maxPart = ctx.startPartNo - 1;
    for (const row of this.#d.store.listSegments(ctx.sessionId)) maxPart = Math.max(maxPart, row.partNo);

    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (entry === undefined) continue;
      // seglist 里通常只有文件名；万一给了绝对路径也照用
      const path = /^[A-Za-z]:[\\/]|^\//.test(entry.file)
        ? entry.file
        : joinPath(ctx.outputDir, baseName(entry.file));
      const isLast = i === entries.length - 1;
      const existing = this.#d.store.getSegmentByPath(path);
      if (existing !== undefined) {
        // 录制中登记的段按当时情况判了 ok；收尾时如果它就是最后一段、且连接异常
        // （崩溃、被强杀、stalled），要把完整性改判成 truncated，
        // 否则崩溃丢掉的那截会一直显示"完好"。
        if (ctx.final && isLast && ctx.abnormal && existing.integrity === 'ok') {
          this.#d.store.setSegmentIntegrity(existing.id, 'truncated', primaryClass(ctx.classes));
          this.#emit(
            'recording.segment_integrity',
            { part: existing.partNo, integrity: 'truncated' },
            undefined,
            ctx.sessionId,
          );
        }
        lastEndS = Math.max(lastEndS, entry.end);
        continue;
      }
      const size = await this.#d.fs.statSize(path);
      if (size <= 0) continue;
      const fp = await this.#d.probe.probe(path);
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
      this.#noteLayoutDrift(ctx.sessionId, partNo, fp?.video?.layoutHash ?? null);
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
    // 长等待（窗外可能是 11 小时）不该每 250ms 查一次库：分片随总时长放大，
    // 但压到 2 秒以内 —— 用户点「检查」的响应延迟就是这个量级。
    const slice = Math.min(2_000, Math.max(SLICE_MS, ms / 60));
    const seen = this.#d.store.getTask(taskId);
    // 时段被改过就提前醒来重算：否则用户把窗口调成"现在应该监控"，还要等到
    // 原来那个 11 小时的 deadline 才生效 —— 看起来像保存没生效。
    const windowsKey = JSON.stringify(seen?.monitorWindows ?? []);
    while (Date.now() < deadline) {
      if (!this.#running) return;
      const task = this.#d.store.getTask(taskId);
      if (task === undefined) return;
      if (task.checkNow) {
        // 不在这里消费：主循环的 takeCheckNow 要负责发 `task.check_now` 事件，
        // 而且窗口判断也要靠这个标记放行（否则点了「检查」被时段挡住，用户以为按钮坏了）。
        return;
      }
      if (JSON.stringify(task.monitorWindows) !== windowsKey) return;
      if (!task.monitorEnabled && !task.recordRequested) return;
      await this.#sleep(slice);
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

  /**
   * 段间流参数漂移：与**本会话最早一段**的 layoutHash 比，不同就提醒一次。
   *
   * 不提醒的话，用户只会在"合并失败"时看到一个 ffmpeg 退出码；而不同 layout 的
   * TS 直接 concat 一定在拼接点崩，正是 2026-11-01 那场排查了很久的原因。
   * 每个会话只发一次：漂移之后的段大概率一直是新参数，重复提醒没有增量信息。
   */
  #noteLayoutDrift(sessionId: string, partNo: number, layout: string | null): void {
    if (layout === null || this.#layoutNotified.has(sessionId)) return;
    const ref = this.#d.store
      .listSegments(sessionId)
      .filter((s) => s.layoutHash !== null && s.partNo !== partNo)
      .sort((a, b) => a.partNo - b.partNo)[0];
    if (ref === undefined || ref.layoutHash === null || ref.layoutHash === layout) return;

    this.#layoutNotified.add(sessionId);
    const taskId = this.#d.store.getSession(sessionId)?.taskId ?? null;
    this.#emit(
      'recording.layout_changed',
      { part: partNo, from: ref.layoutHash, to: layout, ref_part: ref.partNo },
      taskId,
      sessionId,
    );
    if (taskId === null) return;
    const streamer = this.#d.store.getTask(taskId)?.streamerName ?? null;
    this.#draft(
      copy.layoutChanged({ streamer, part: partNo, from: ref.layoutHash, to: layout }),
      taskId,
      sessionId,
    );
  }

  #pollIntervalS(): number {
    return Math.min(Math.max(this.#d.store.getSettings().pollIntervalS, 5), 3600);
  }

  #pollIntervalMs(): number {
    return this.#pollIntervalS() * 1000;
  }

  // ── 轮询节奏 ──────────────────────────────────────────────────────────────

  /** 该任务的"连续未开播 / 连续失败"计数（进程内，重启归零可以接受） */
  #pace(taskId: string): { idle: number; error: number } {
    let p = this.#pacing.get(taskId);
    if (p === undefined) {
      p = { idle: 0, error: 0 };
      this.#pacing.set(taskId, p);
    }
    return p;
  }

  /** 历史开播热度（24 桶）。按小时缓存：一场 30 秒查一次库没有意义。 */
  #affinityOf(taskId: string, now: Date): number[] {
    const bucketKey = Math.floor(now.getTime() / 3_600_000);
    const hit = this.#affinity.get(taskId);
    if (hit !== undefined && hit.at === bucketKey) return hit.buckets;
    const buckets = hourAffinity(this.#d.store.listSessionStarts(taskId), now);
    this.#affinity.set(taskId, { at: bucketKey, buckets });
    return buckets;
  }

  /** 下一轮等多久：窗外等到点，窗内看冷热 / 失败退避 / 久未开播 */
  #planFor(task: Task, now: Date): PollPlan {
    const pace = this.#pace(task.id);
    return planPoll({
      now,
      windows: task.monitorWindows,
      affinity: this.#affinityOf(task.id, now),
      idleRounds: pace.idle,
      errorStreak: pace.error,
      baseMs: this.#pollIntervalMs(),
    });
  }

  /**
   * 把"这次解析实际选中的档位"写回任务，并在**首次降级**时发事件 + 通知。
   *
   * 去重是必须的：resolve 每轮都跑（默认 30s 一次），降级事实不变时不能每轮
   * 刷一条通知；另外 `patchTask` 会更新 `updated_at`，而任务卡按它排序 ——
   * 每轮无条件写库会让列表顺序一直抖。
   */
  #applyQuality(task: Task, data: ResolveResult): void {
    const actual = data.qualityActual;
    if (actual === null || actual === undefined) return;
    const prev = this.#d.store.getTask(task.id)?.qualityActual ?? null;
    const same =
      prev !== null &&
      prev.qn === actual.qn &&
      prev.label === actual.label &&
      prev.codec === actual.codec &&
      prev.requested === actual.requested &&
      prev.degraded === actual.degraded;
    if (same) return;

    try {
      this.#d.store.patchTask(task.id, { qualityActual: actual });
    } catch (err) {
      this.#logWarn('实际画质写入失败', err);
      return;
    }
    this.#emit(
      'quality.resolved',
      {
        qn: actual.qn,
        label: actual.label,
        codec: actual.codec,
        format: actual.format,
        requested: actual.requested,
        degraded: actual.degraded,
      },
      task.id,
      null,
    );
    if (actual.degraded && (prev === null || !prev.degraded)) {
      this.#draft(
        copy.qualityDegraded({
          streamer: data.anchorName ?? task.streamerName,
          requested: actual.requested,
          label: actual.label,
          codec: actual.codec,
        }),
        task.id,
        null,
      );
    }
  }

  /**
   * 写运行态投影。
   *
   * - `transient`：整条跳过（不写投影、不落事件）。`resolving` 每轮都会闪一下，
   *   写它只会在库里制造"解析中→未开播→解析中"的来回，而 UI 又收不到提示
   *   （事件少了就没有重拉信号）—— 写进去纯属噪声。
   * 非 transient：state 与 detail 跟上次落库的一样就跳过。这是写入侧的大头：
   *   一次轮询两条、一天上万条，绝大多数是"主播未开播"重复了十遍。
   *
   * 返回"这次是否真的变了"—— 调用方据此决定要不要记一条同因的错误事件。
   */
  #runtime(
    taskId: string,
    state: Parameters<Store['setRuntime']>[1],
    detail: string | null,
    opts: { transient?: boolean } = {},
  ): boolean {
    if (opts.transient === true) return false;
    const key = `${state}\u0000${detail ?? ''}`;
    if (this.#projected.get(taskId) === key) return false;
    this.#projected.set(taskId, key);
    try {
      this.#d.store.setRuntime(taskId, state, detail);
      this.#emit('task.state_changed', { state, detail }, taskId, null);
      return true;
    } catch (err) {
      this.#logWarn('运行态写入失败', err);
      return false;
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
