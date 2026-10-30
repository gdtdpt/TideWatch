/**
 * 插件宿主：发现/校验之后，真正拉起短命进程并完成一次一问一答。
 *
 * 三道闸（docs/04 §6）：
 * - per-plugin 信号量（默认 2）—— 一个插件不许拖垮全局；
 * - per-platform 请求间隔下限 1s —— 防风控，且必须是**预约式**（否则并发同时越闸）；
 * - 宿主侧超时必 kill 收尸，按 NETWORK/TIMEOUT 分类，而不是把宿主搞崩。
 */
import { decodeResponse, encodeRequest, LineSplitter, type PluginError, type PluginRequest } from './index.ts';
import type { LaunchPlan, PluginManifest } from './manifest.ts';

export interface PluginProcess {
  write(data: string): void;
  closeStdin(): void;
  wait(): Promise<{ code: number | null; signal: string | null }>;
  kill(): void;
}

export interface PluginSpawnInput {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  onLine: (stream: 'stdout' | 'stderr', line: string) => void;
}

export type PluginSpawnFn = (input: PluginSpawnInput) => PluginProcess;

export interface PluginHostOptions {
  spawn: PluginSpawnFn;
  timeoutMs?: number;
  concurrency?: number;
  minIntervalMs?: number;
}

export interface PluginCallResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: PluginError;
}

class Semaphore {
  #active = 0;
  readonly #limit: number;
  readonly #queue: (() => void)[] = [];

  constructor(limit: number) {
    this.#limit = Math.max(1, limit);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit) {
      await new Promise<void>((resolve) => this.#queue.push(resolve));
    }
    this.#active += 1;
    try {
      return await fn();
    } finally {
      this.#active -= 1;
      this.#queue.shift()?.();
    }
  }
}

export class PluginHost {
  readonly #opts: Required<PluginHostOptions>;
  readonly #semaphores = new Map<string, Semaphore>();
  readonly #nextAt = new Map<string, number>();

  constructor(opts: PluginHostOptions) {
    this.#opts = {
      spawn: opts.spawn,
      timeoutMs: opts.timeoutMs ?? 30_000,
      concurrency: opts.concurrency ?? 2,
      minIntervalMs: opts.minIntervalMs ?? 1_000,
    };
  }

  async call(
    entry: { manifest: PluginManifest; dir: string },
    plan: LaunchPlan,
    request: Omit<PluginRequest, 'protocol'> & { protocol?: number },
  ): Promise<PluginCallResult> {
    const name = entry.manifest.name;
    const platform = typeof request['platform'] === 'string' && request['platform'].length > 0
      ? request['platform']
      : name;
    const sem = this.#semaphores.get(name) ?? new Semaphore(this.#opts.concurrency);
    this.#semaphores.set(name, sem);

    return sem.run(async () => {
      await this.#reserveInterval(platform);
      const normalized = {
        ...request,
        protocol: request.protocol ?? entry.manifest.protocol,
      } as PluginRequest;
      return this.#invoke(plan, normalized);
    });
  }

  /** 预约式间隔：第一个到点就把下一个可用时刻往后推，后续按预约时刻排队 */
  async #reserveInterval(platform: string): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.#nextAt.get(platform) ?? 0);
    this.#nextAt.set(platform, at + this.#opts.minIntervalMs);
    if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
  }

  async #invoke(plan: LaunchPlan, request: PluginRequest): Promise<PluginCallResult> {
    const splitter = new LineSplitter();
    let responseLine: string | null = null;
    let settle: ((value: PluginCallResult) => void) | null = null;
    const done = new Promise<PluginCallResult>((resolve) => {
      settle = resolve;
    });

    const proc = this.#opts.spawn({
      command: plan.command,
      args: plan.args,
      env: plan.env,
      cwd: plan.cwd,
      onLine: (stream, line) => {
        if (stream !== 'stdout') return;
        const lines = splitter.push(`${line}\n`);
        for (const l of lines) {
          if (responseLine !== null) continue;
          try {
            const decoded = decodeResponse(l);
            if (decoded.id !== request.id) continue;
            responseLine = l;
            if (decoded.ok) {
              settle?.({ ok: true, data: decoded.data });
            } else {
              settle?.({ ok: false, error: decoded.error });
            }
          } catch {
            /* 非协议行（插件误打印）：忽略，stderr 才是它的日志通道 */
          }
        }
      },
    });

    let settled = false;
    const settleOnce = (result: PluginCallResult): void => {
      if (settled) return;
      settled = true;
      settle?.(result);
    };

    const timer = setTimeout(() => {
      proc.kill();
      settleOnce({
        ok: false,
        error: { code: 'NETWORK', message: `插件超时（${this.#opts.timeoutMs}ms）`, retryable: true },
      });
    }, this.#opts.timeoutMs);

    // 进程先退出且没有响应 → 内部错误（不是网络错误，避免"退避到天荒地老"）
    void proc.wait().then(() => {
      settleOnce({
        ok: false,
        error: { code: 'INTERNAL', message: '插件未响应就退出', retryable: true },
      });
    });

    try {
      proc.write(encodeRequest(request));
      proc.closeStdin();
      return await done;
    } finally {
      clearTimeout(timer);
      // 无论成功失败都收尸：插件是短命进程，不留僵尸
      void proc.wait().finally(() => proc.kill());
    }
  }
}
