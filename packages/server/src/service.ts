/**
 * 宿主装配（M1–M4）：租约 → 恢复扫描 → 引擎 → 后处理 → 通知。
 *
 * 所有"谁读什么配置、什么时候读"的接线都在这里，避免"UI 写得动、引擎读不到"。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  Engine,
  PostProcessor,
  runRecovery,
  type CapturePort,
  type EngineFs,
  type RecoverySummary,
} from '@tidewatch/core';
import type { HostAdapter } from '@tidewatch/host-adapter';
import { channelsFromConfig, NotificationDispatcher, type Channel, type Notification as NotifyPayload } from '@tidewatch/notify';
import { PluginHost } from '@tidewatch/protocol';
import { Store, type AppSettings, type NotificationRow } from '@tidewatch/store';
import { FfmpegCapture } from './capture.ts';
import { NodeEngineFs } from './fs.ts';
import { PluginManager } from './plugins.ts';
import { FfprobeProbe } from './probe.ts';
import { PluginResolver } from './resolver.ts';

export interface ServiceOptions {
  dataRoot: string;
  resourceRoot: string;
  host: HostAdapter;
  version: string;
  port: number;
  /** 测试/只读宿主：不启动引擎 */
  engine?: boolean;
  onNotify?: (row: NotificationRow) => void;
  logger?: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
}

export interface ServiceStatus {
  leaseAcquired: boolean;
  leaseNote: string | null;
  recovery: RecoverySummary | null;
  ffmpeg: BinaryRef;
  ffprobe: BinaryRef;
  python: string;
  cookieBackend: string;
}

/** 二进制从哪来的：环境变量覆盖 / 随包 vendor / 系统 PATH 回退 */
export type BinarySource = 'env' | 'vendor' | 'path';

export interface BinaryRef {
  command: string;
  source: BinarySource;
}

export interface BinaryStatus extends BinaryRef {
  ok: boolean;
  version: string | null;
}

function envPath(name: string, fallback: string): string {
  const v = process.env[name];
  return v !== undefined && v.length > 0 ? v : fallback;
}

/**
 * 三级解析：显式 env > vendor（随包）> PATH。
 * PATH 只作回退 —— ffmpeg 版本会改变 stderr 措辞，而错误分类靠关键词表，
 * 用户自装的版本会让同一份流归到不同错误码，所以"来源"必须能看见。
 */
function pickBinary(resourceRoot: string, envName: string, name: string): BinaryRef {
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined && fromEnv.length > 0) return { command: fromEnv, source: 'env' };
  const bundled = join(resourceRoot, 'vendor', 'ffmpeg', 'bin', name);
  if (existsSync(bundled)) return { command: bundled, source: 'vendor' };
  return { command: name, source: 'path' };
}

/**
 * 静态 ffmpeg（openssl 版）经常不带 CA 搜索路径，结果是**对任何 https 都报**
 * `certificate verify failed` —— 表现为"直播流一开就 EOF 重连"，看不出是证书问题。
 * 系统 CA bundle 存在时通过 SSL_CERT_FILE 注入（OpenSSL 认这个变量），
 * 用户自己设了就不动。
 */
function tlsEnv(): Readonly<Record<string, string>> | undefined {
  if (process.env['SSL_CERT_FILE'] !== undefined) return undefined;
  const candidates = [
    '/etc/ssl/cert.pem', // macOS / Alpine
    '/etc/ssl/certs/ca-certificates.crt', // Debian / Ubuntu
    '/etc/pki/tls/certs/ca-bundle.crt', // RHEL / Fedora
  ];
  const found = candidates.find((p) => existsSync(p));
  return found === undefined ? undefined : { SSL_CERT_FILE: found };
}

export class TidewatchService {
  readonly store: Store;
  readonly fs: EngineFs;
  readonly capture: CapturePort;
  readonly probe: FfprobeProbe;
  readonly manager: PluginManager;
  readonly resolver: PluginResolver;
  readonly engine: Engine;
  readonly post: PostProcessor;
  readonly outputRoot: string;
  #dispatcher: NotificationDispatcher;
  #status: ServiceStatus;
  #started = false;

  constructor(readonly opts: ServiceOptions) {
    mkdirSyncSafe(opts.dataRoot);
    this.store = new Store(join(opts.dataRoot, 'tidewatch.db'));
    this.fs = new NodeEngineFs();
    this.outputRoot = envPath('TIDEWATCH_OUTPUT', join(opts.dataRoot, 'downloads'));
    // 目录不存在时 statfs 查不出可用空间，健康页会误报"未知"
    mkdirSync(this.outputRoot, { recursive: true });

    const ffmpeg = pickBinary(opts.resourceRoot, 'TIDEWATCH_FFMPEG', 'ffmpeg');
    const ffprobe = pickBinary(opts.resourceRoot, 'TIDEWATCH_FFPROBE', 'ffprobe');

    this.capture = new FfmpegCapture(opts.host.processes, ffmpeg.command, tlsEnv());
    this.probe = new FfprobeProbe(opts.host.processes, ffprobe.command);

    this.manager = new PluginManager({
      dataRoot: opts.dataRoot,
      resourceRoot: opts.resourceRoot,
    });

    const pluginHost = new PluginHost({
      spawn: (input) => {
        const proc = opts.host.processes.spawn({
          command: input.command,
          args: input.args,
          env: input.env,
          cwd: input.cwd,
          onLine: (stream, line) => input.onLine(stream, line),
        });
        return {
          write: (data) => proc.write(data),
          closeStdin: () => proc.closeStdin?.(),
          wait: () => proc.wait(),
          kill: () => {
            void proc.kill();
          },
        };
      },
      timeoutMs: Number(envPath('TIDEWATCH_PLUGIN_TIMEOUT_MS', '30000')),
      concurrency: Number(envPath('TIDEWATCH_PLUGIN_CONCURRENCY', '2')),
      minIntervalMs: Number(envPath('TIDEWATCH_PLUGIN_MIN_INTERVAL_MS', '1000')),
    });

    this.resolver = new PluginResolver({
      manager: this.manager,
      host: pluginHost,
      credentials: opts.host.credentials,
      store: this.store,
      ...(opts.logger === undefined ? {} : { logger: opts.logger }),
    });

    this.engine = new Engine({
      store: this.store,
      fs: this.fs,
      capture: this.capture,
      probe: this.probe,
      resolver: this.resolver,
      outputRoot: this.outputRoot,
      onDraft: (draft, ctx) => {
        void this.#dispatcher.dispatch({
          ...draft,
          taskId: ctx.taskId,
          sessionId: ctx.sessionId,
        });
      },
      onSessionEnded: (sessionId, _taskId, reason) => {
        const session = this.store.getSession(sessionId);
        const task = session === undefined ? undefined : this.store.getTask(session.taskId);
        if (task === undefined) return;
        if (reason === 'shutdown' || task.postprocess === 'manual') return;
        void this.post.processSession(sessionId).catch((err: unknown) => {
          opts.logger?.warn('后处理异常', err);
        });
      },
      ...(opts.logger === undefined ? {} : { logger: opts.logger }),
    });

    this.post = new PostProcessor({
      store: this.store,
      fs: this.fs,
      capture: this.capture,
      probe: this.probe,
      onDraft: (draft, ctx) => {
        void this.#dispatcher.dispatch({
          ...draft,
          taskId: ctx.taskId,
          sessionId: ctx.sessionId,
        });
      },
      ...(opts.logger === undefined ? {} : { logger: opts.logger }),
    });

    this.#dispatcher = this.#makeDispatcher(this.store.getSettings());
    this.#status = {
      leaseAcquired: false,
      leaseNote: null,
      recovery: null,
      ffmpeg,
      ffprobe,
      python: this.manager.pythonPath,
      cookieBackend: opts.host.credentials.describeBackend(),
    };
  }

  /**
   * 当前生效的 ffmpeg/ffprobe：路径、来源、是否可用、版本。
   * `ffmpeg -version` 有 60s 缓存，健康页可以安全地反复问（装完不用重启就自愈）。
   */
  async binaries(): Promise<{ ffmpeg: BinaryStatus; ffprobe: BinaryStatus }> {
    const [ffmpegInfo, ffprobeInfo] = await Promise.all([
      this.capture.preflight?.() ?? Promise.resolve(undefined),
      this.probe.describe(),
    ]);
    return {
      ffmpeg: {
        ...this.#status.ffmpeg,
        ok: ffmpegInfo?.ok ?? false,
        version: ffmpegInfo?.version ?? null,
      },
      ffprobe: {
        ...this.#status.ffprobe,
        ok: ffprobeInfo.ok,
        version: ffprobeInfo.version,
      },
    };
  }

  get status(): ServiceStatus {
    return this.#status;
  }

  get settings(): AppSettings {
    return this.store.getSettings();
  }

  #makeDispatcher(settings: AppSettings): NotificationDispatcher {
    const channels: Channel[] = channelsFromConfig(settings.notify);
    return new NotificationDispatcher({
      channels,
      record: (n: NotifyPayload) => {
        const id = this.store.insertNotification({
          kind: n.kind,
          level: n.level,
          title: n.title,
          body: n.body,
          taskId: n.taskId ?? null,
          sessionId: n.sessionId ?? null,
        });
        this.store.pruneNotifications(500);
        const row: NotificationRow = {
          id,
          ts: new Date().toISOString(),
          kind: n.kind,
          level: n.level,
          title: n.title,
          body: n.body,
          taskId: n.taskId ?? null,
          sessionId: n.sessionId ?? null,
          readAt: null,
        };
        this.opts.onNotify?.(row);
      },
      ...(this.opts.logger === undefined ? {} : { logger: { warn: (m, meta) => this.opts.logger?.warn(m, meta) } }),
    });
  }

  /** 设置页改通知渠道后立刻生效（不必重启） */
  applySettings(settings: AppSettings): AppSettings {
    const saved = this.store.putSettings(settings);
    this.#dispatcher = this.#makeDispatcher(saved);
    return saved;
  }

  async sendTestNotification(channelId?: string): Promise<{ id: string; ok: boolean; reason?: string }[]> {
    const channels = channelsFromConfig(this.store.getSettings().notify);
    const picked = channelId === undefined ? channels : channels.filter((c) => c.id === channelId);
    if (picked.length === 0) return [];
    const results: { id: string; ok: boolean; reason?: string }[] = [];
    for (const c of picked) {
      const r = await c.send({
        kind: 'test',
        level: 'warn',
        title: 'TideWatch 测试消息',
        body: '看到这条说明渠道配置可用。',
      });
      results.push({ id: c.id, ok: r.ok, ...(r.reason === undefined ? {} : { reason: r.reason }) });
    }
    return results;
  }

  async init(): Promise<void> {
    const lease = await this.opts.host.lease.acquire(join(this.opts.dataRoot, 'tidewatch.db'));
    this.#status.leaseAcquired = lease.acquired;
    if (!lease.acquired) {
      this.#status.leaseNote = `另一个 TideWatch 实例（pid ${String(lease.holderPid ?? '?')}）正在使用同一数据根，本实例降级为只读`;
      this.opts.logger?.warn(this.#status.leaseNote);
    }

    await this.manager.scan();
    this.#status.recovery = await runRecovery({
      store: this.store,
      fs: this.fs,
      probe: this.probe,
      ...(this.opts.logger === undefined ? {} : { logger: this.opts.logger }),
    });

    if (lease.acquired && this.opts.engine !== false) {
      this.engine.start();
      this.#started = true;
    }
  }

  async stop(): Promise<void> {
    if (this.#started) {
      await this.engine.stop();
      this.#started = false;
    }
    await this.opts.host.processes.disposeAll(5_000);
    await this.opts.host.lease.release();
    this.store.close();
  }

  async refreshPlugins(): Promise<{ count: number; warnings: string[] }> {
    return this.manager.refresh();
  }
}

function mkdirSyncSafe(dir: string): void {
  // Store 打开前必须存在；同步版本让构造函数保持简单
  mkdirSync(dir, { recursive: true });
}
