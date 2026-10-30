/**
 * CapturePort 的 ffmpeg 实现：所有子进程都走 host-adapter 的监督器，
 * 退出必回收（Windows Job Object / Unix 进程组）。
 */
import type { CaptureHandle, CapturePort, CapturePreflight, CaptureSpec } from '@tidewatch/core';
import type { ProcessSupervisor } from '@tidewatch/host-adapter';

/**
 * `ffmpeg -version` 首行形如 `ffmpeg version 9.0.2 Copyright (c) ...`。
 * 自编译版会写成 `N-118658-g1a2b3c`，照样原样取；
 * 但有些第三方构建把自家站点拼进版本号（`9.0.2-https://www.martin-riedl.de`），
 * 那种尾巴只会在 UI 里碍事，切掉。
 */
function parseVersion(output: string): string | undefined {
  const m = /(?:ffmpeg|ffprobe) version (\S+)/i.exec(output);
  if (m?.[1] === undefined) return undefined;
  return m[1].replace(/-https?:\/\/.*$/i, '');
}

export interface BinaryInfo {
  ok: boolean;
  version: string | null;
}

/** 探一次二进制是否可用并取版本；ffmpeg 与 ffprobe 共用（两者的 `-version` 形状一致） */
export async function describeBinary(
  supervisor: ProcessSupervisor,
  command: string,
  timeoutMs = 5_000,
): Promise<BinaryInfo> {
  const run = await runCommand(supervisor, command, ['-version'], timeoutMs);
  const version = parseVersion(run.stdout + run.stderr);
  return { ok: run.code === 0, version: version ?? null };
}

export class FfmpegCapture implements CapturePort {
  readonly #supervisor: ProcessSupervisor;
  readonly #command: string;
  readonly #env: Readonly<Record<string, string>> | undefined;
  #checked: { at: number; result: CapturePreflight } | null = null;

  constructor(
    supervisor: ProcessSupervisor,
    command: string,
    env?: Readonly<Record<string, string>> | undefined,
  ) {
    this.#supervisor = supervisor;
    this.#command = command;
    this.#env = env;
  }

  get command(): string {
    return this.#command;
  }

  /**
   * `ffmpeg -version` 探一次就够（60s 缓存）。
   * 缺件时的提示要能直接指导用户：给路径、给环境变量名，不说"未知错误"。
   * 顺便把版本号带出去 —— 版本会改变 stderr 措辞，错误分类依赖关键词表。
   */
  async preflight(): Promise<CapturePreflight> {
    const now = Date.now();
    if (this.#checked !== null && now - this.#checked.at < 60_000) return this.#checked.result;
    const info = await describeBinary(this.#supervisor, this.#command);
    const result: CapturePreflight = info.ok
      ? { ok: true, ...(info.version === null ? {} : { version: info.version }) }
      : {
          ok: false,
          detail:
            `找不到可用的 ffmpeg（${this.#command}）：` +
            '跑 tools/fetch-ffmpeg.sh 装到 vendor/，或安装系统 ffmpeg，' +
            '或用 TIDEWATCH_FFMPEG 指定绝对路径',
        };
    this.#checked = { at: now, result };
    return result;
  }

  async start(spec: CaptureSpec): Promise<CaptureHandle> {
    const proc = this.#supervisor.spawn({
      command: this.#command,
      args: spec.args,
      ...(this.#env === undefined ? {} : { env: this.#env }),
      onLine: (stream, line) => {
        if (stream === 'stderr') spec.onStderrLine?.(line);
        else spec.onStdoutLine?.(line);
      },
    });
    const exit = proc.wait();

    return {
      pid: proc.pid,
      write: (data) => proc.write(data),
      kill: () => {
        void proc.kill();
      },
      stop: async (graceMs) => {
        // ffmpeg 的优雅停止是向 stdin 写 'q'；卡在网络的进程读不到它 → 宽限后硬杀
        proc.write('q');
        const timedOut = await Promise.race([
          exit.then(() => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(true), graceMs)),
        ]);
        if (timedOut) {
          await proc.stop(1_000);
          await proc.kill();
        }
      },
      wait: () => exit,
    };
  }
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** 短命命令（ffprobe）：有超时、有收尸、保留输出 */
export async function runCommand(
  supervisor: ProcessSupervisor,
  command: string,
  args: string[],
  timeoutMs = 15_000,
): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  const proc = supervisor.spawn({
    command,
    args,
    onLine: (stream, line) => {
      if (stream === 'stdout') {
        stdout += `${line}\n`;
        if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000);
      } else {
        stderr += `${line}\n`;
        if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
      }
    },
  });
  const timedOut = await Promise.race([
    proc.wait().then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), timeoutMs)),
  ]);
  if (timedOut) {
    await proc.kill();
    return { code: null, stdout, stderr, timedOut: true };
  }
  const info = await proc.wait();
  return { code: info.code, stdout, stderr, timedOut: false };
}
