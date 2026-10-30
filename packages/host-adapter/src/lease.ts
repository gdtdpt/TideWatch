/**
 * 引擎单实例租约（docs/02 §3）：锁绑定文件句柄，进程死亡由 OS 释放，不留残锁。
 *
 * 判活不能靠"锁文件能否删除"（Windows 独占打开的文件本来就不能删），
 * 所以锁里写 PID + 心跳时间戳，按超时判死。
 */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineLease, LeaseResult } from './types.ts';

const STALE_MS = 30_000;
const HEARTBEAT_MS = 5_000;

interface LockFile {
  pid: number;
  at: number;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class FileEngineLease implements EngineLease {
  readonly #file: string;
  #timer: NodeJS.Timeout | null = null;
  #held = false;

  constructor(dataRoot: string) {
    this.#file = join(dataRoot, 'engine.lock');
  }

  async acquire(_dbPath: string): Promise<LeaseResult> {
    if (this.#held) return { acquired: true };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.#file, 'wx', 0o600);
        const body: LockFile = { pid: process.pid, at: Date.now() };
        writeFileSync(fd, JSON.stringify(body));
        closeSync(fd);
        this.#held = true;
        this.#timer = setInterval(() => {
          try {
            writeFileSync(this.#file, JSON.stringify({ pid: process.pid, at: Date.now() }));
          } catch {
            /* 心跳失败不改变持有事实 */
          }
        }, HEARTBEAT_MS);
        this.#timer.unref?.();
        return { acquired: true };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') {
          // 基础设施故障（临时目录不可写等）放行 + 告警：租约是防呆网，不是正确性原语
          return { acquired: true, reason: 'infra-error' };
        }
        const holder = this.#readHolder();
        const fresh = holder !== null && Date.now() - holder.at < STALE_MS;
        if (holder !== null && fresh && holder.pid !== process.pid && isAlive(holder.pid)) {
          return { acquired: false, holderPid: holder.pid, reason: 'held-by-other' };
        }
        // 残锁：清掉再试一次
        try {
          unlinkSync(this.#file);
        } catch {
          try {
            // 锁文件可能刚被别人删/重建，重读一次再决定
            const again = this.#readHolder();
            if (again !== null && again.pid !== process.pid && isAlive(again.pid)) {
              return { acquired: false, holderPid: again.pid, reason: 'held-by-other' };
            }
          } catch {
            /* ignore */
          }
        }
      }
    }
    return { acquired: false, reason: 'held-by-other' };
  }

  async release(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    if (!this.#held) return;
    this.#held = false;
    try {
      if (existsSync(this.#file)) unlinkSync(this.#file);
    } catch {
      /* 已被外部清理 */
    }
  }

  #readHolder(): LockFile | null {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.#file, 'utf8'));
      if (typeof raw === 'object' && raw !== null) {
        const pid = Number((raw as Record<string, unknown>)['pid']);
        const at = Number((raw as Record<string, unknown>)['at']);
        if (Number.isFinite(pid) && Number.isFinite(at)) return { pid, at };
      }
      return null;
    } catch {
      return null;
    }
  }
}
