/**
 * 进程监督（唯一重平台点）：`spawn` 的每个孩子都进登记表，退出必回收。
 *
 * - Unix：`detached: true` 成进程组，`kill(-pid)` 连孙进程一起走；
 * - Windows：没有进程组信号，用 `taskkill /T`（优雅）与 `/T /F`（硬杀）。
 *
 * 这是全项目唯一允许出现 `process.platform` 分支的地方（docs/00 §3）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import type { Platform, ProcessSupervisor, SpawnOptions, SupervisedProcess } from './types.ts';

const isWindows = process.platform === 'win32';

function splitLines(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.length > 0) onLine(line);
    }
    if (buf.length > 64 * 1024) {
      onLine(buf);
      buf = '';
    }
  };
}

function taskkill(pid: number, force: boolean): Promise<void> {
  return new Promise((resolve) => {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    execFile('taskkill', args, () => resolve());
  });
}

class Supervised implements SupervisedProcess {
  readonly #child: ChildProcess;
  readonly #supervisor: ChildProcessSupervisor;
  readonly #exit: Promise<{ code: number | null; signal: string | null }>;
  #settled = false;

  constructor(child: ChildProcess, supervisor: ChildProcessSupervisor) {
    this.#child = child;
    this.#supervisor = supervisor;
    this.#exit = new Promise((resolve) => {
      const done = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (this.#settled) return;
        this.#settled = true;
        this.#supervisor.forget(this);
        resolve({ code, signal });
      };
      child.once('exit', (code, signal) => done(code, signal));
      child.once('error', () => done(null, null));
    });
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  get raw(): ChildProcess {
    return this.#child;
  }

  write(data: string): void {
    try {
      this.#child.stdin?.write(data);
    } catch {
      /* 进程已退出：忽略写失败 */
    }
  }

  closeStdin(): void {
    try {
      this.#child.stdin?.end();
    } catch {
      /* ignore */
    }
  }

  kill(): Promise<void> {
    const pid = this.#child.pid;
    if (pid === undefined || this.#settled) return Promise.resolve();
    if (isWindows) return taskkill(pid, true);
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        this.#child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    return Promise.resolve();
  }

  async stop(graceMs: number): Promise<void> {
    const pid = this.#child.pid;
    if (pid === undefined || this.#settled) return;
    if (isWindows) {
      await taskkill(pid, false);
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          this.#child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
    }
    const timedOut = await Promise.race([
      this.#exit.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), graceMs)),
    ]);
    if (timedOut) await this.kill();
  }

  wait(): Promise<{ code: number | null; signal: string | null }> {
    return this.#exit;
  }
}

export class ChildProcessSupervisor implements ProcessSupervisor {
  readonly #platform: Platform;
  readonly #live = new Set<Supervised>();

  constructor(platform: Platform = process.platform as Platform) {
    this.#platform = platform;
  }

  get platform(): Platform {
    return this.#platform;
  }

  spawn(opts: SpawnOptions): SupervisedProcess {
    const child = spawn(opts.command, [...opts.args], {
      cwd: opts.cwd,
      env: opts.env === undefined ? process.env : { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !isWindows,
      windowsHide: true,
    });

    if (opts.onLine !== undefined) {
      child.stdout?.on('data', splitLines((line) => opts.onLine?.('stdout', line)));
      child.stderr?.on('data', splitLines((line) => opts.onLine?.('stderr', line)));
    } else {
      child.stdout?.resume();
      child.stderr?.resume();
    }

    const supervised = new Supervised(child, this);
    this.#live.add(supervised);
    if (opts.onExit !== undefined) {
      void supervised.wait().then((info) => opts.onExit?.(info));
    }
    return supervised;
  }

  forget(proc: Supervised): void {
    this.#live.delete(proc);
  }

  /** 宿主退出前调用：确保所有孩子（含孙进程）都被回收 */
  async disposeAll(timeoutMs: number): Promise<void> {
    const all = [...this.#live];
    await Promise.all(all.map((p) => p.stop(timeoutMs)));
    await Promise.all(all.map((p) => p.kill()));
  }
}

export { Supervised };
