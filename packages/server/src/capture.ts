/**
 * CapturePort 的 ffmpeg 实现：所有子进程都走 host-adapter 的监督器，
 * 退出必回收（Windows Job Object / Unix 进程组）。
 */
import type { CaptureHandle, CapturePort, CapturePreflight, CaptureSpec } from '@tidewatch/core';
import type { ProcessSupervisor } from '@tidewatch/host-adapter';

export class FfmpegCapture implements CapturePort {
  readonly #supervisor: ProcessSupervisor;
  readonly #command: string;
  #checked: { at: number; result: CapturePreflight } | null = null;

  constructor(supervisor: ProcessSupervisor, command: string) {
    this.#supervisor = supervisor;
    this.#command = command;
  }

  get command(): string {
    return this.#command;
  }

  /**
   * `ffmpeg -version` 探一次就够（60s 缓存）。
   * 缺件时的提示要能直接指导用户：给路径、给环境变量名，不说"未知错误"。
   */
  async preflight(): Promise<CapturePreflight> {
    const now = Date.now();
    if (this.#checked !== null && now - this.#checked.at < 60_000) return this.#checked.result;
    const run = await runCommand(this.#supervisor, this.#command, ['-version'], 5_000);
    const result: CapturePreflight =
      run.code === 0
        ? { ok: true }
        : {
            ok: false,
            detail: `找不到可用的 ffmpeg（${this.#command}）：请安装 ffmpeg，或用 TIDEWATCH_FFMPEG 指定绝对路径`,
          };
    this.#checked = { at: now, result };
    return result;
  }

  async start(spec: CaptureSpec): Promise<CaptureHandle> {
    const proc = this.#supervisor.spawn({
      command: this.#command,
      args: spec.args,
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
