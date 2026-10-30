/**
 * 插件宿主（M3）回归锁：三道闸 + 两种收尸。
 *
 * 这里最重要的是"超时必 kill"与"进程先退出 → INTERNAL（不是 NETWORK）"：
 * 后者若被当成网络错误，引擎会按退避阶梯一直重试一个根本起不来的插件。
 */
import { describe, expect, it } from 'vitest';
import { PluginHost, type PluginProcess, type PluginSpawnInput } from './host.ts';
import type { LaunchPlan, PluginManifest } from './manifest.ts';

const manifest: PluginManifest = {
  name: 'streamget',
  version: '0.2.0',
  protocol: 2,
  exec: '{python}',
  args: ['main.py'],
  env: {},
  modes: ['oneshot'],
  urlPatterns: ['live.douyin.com'],
  platforms: ['douyin'],
  requires: {},
};

const plan: LaunchPlan = { command: '/usr/bin/python3', args: ['main.py'], env: {}, cwd: '/plugins/streamget' };

interface StubOptions {
  /** 收到请求后怎么回；返回 null = 永不回复 */
  reply?: (req: { id: string; action: string }) => string | null;
  /** 是否在回复后立刻退出（模拟短命进程正常收场） */
  exitAfterReply?: boolean;
  /** 不给回复直接退出 */
  exitImmediately?: boolean;
  delayMs?: number;
}

function stubSpawn(calls: { at: number; input: PluginSpawnInput }[], opts: StubOptions = {}) {
  return (input: PluginSpawnInput): PluginProcess => {
    calls.push({ at: Date.now(), input });
    let settleWait: (() => void) | null = null;
    let killed = false;
    const waited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      settleWait = () => resolve({ code: killed ? null : 0, signal: killed ? 'SIGKILL' : null });
    });
    const proc: PluginProcess = {
      write: (data: string) => {
        const req = JSON.parse(data) as { id: string; action: string; protocol?: number };
        if (opts.exitImmediately === true) {
          setTimeout(() => settleWait?.(), 0);
          return;
        }
        const reply = opts.reply?.(req) ?? null;
        if (reply === null) return;
        setTimeout(() => {
          input.onLine('stdout', reply);
          if (opts.exitAfterReply === true) settleWait?.();
        }, opts.delayMs ?? 0);
      },
      closeStdin: () => undefined,
      wait: () => waited,
      kill: () => {
        killed = true;
        settleWait?.();
      },
    };
    return proc;
  };
}

const entry = { manifest, dir: '/plugins/streamget' };

describe('一问一答', () => {
  it('请求是平铺 JSON Lines，响应按 id 匹配，数据原样返回', async () => {
    const calls: { at: number; input: PluginSpawnInput }[] = [];
    let sent = '';
    const host = new PluginHost({
      spawn: (input) => {
        const p = stubSpawn(calls, {
          reply: (req) => JSON.stringify({ id: req.id, ok: true, stream_url: 'https://cdn/x.flv', platform: 'douyin' }),
          exitAfterReply: true,
        })(input);
        return {
          ...p,
          write: (data: string) => {
            sent = data;
            p.write(data);
          },
        };
      },
    });

    const result = await host.call(entry, plan, { id: 'req-1', action: 'resolve', url: 'https://live.douyin.com/1' });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ stream_url: 'https://cdn/x.flv' });

    const req = JSON.parse(sent) as Record<string, unknown>;
    expect(req['id']).toBe('req-1');
    expect(req['action']).toBe('resolve');
    expect(req['url']).toBe('https://live.douyin.com/1');
    // 协议版本由宿主补上，插件不必自己记
    expect(req['protocol']).toBe(2);
    expect(sent.endsWith('\n')).toBe(true);
    expect(calls[0]?.input.command).toBe('/usr/bin/python3');
    expect(calls[0]?.input.cwd).toBe('/plugins/streamget');
  });

  it('插件回错误码时原样上抛（含 retry_after_s）', async () => {
    const host = new PluginHost({
      spawn: stubSpawn([], {
        reply: (req) =>
          JSON.stringify({
            id: req.id,
            ok: false,
            error: { code: 'RATE_LIMITED', message: '慢点', retryable: true, retry_after_s: 30 },
          }),
        exitAfterReply: true,
      }),
    });
    const result = await host.call(entry, plan, { id: 'r2', action: 'resolve' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'RATE_LIMITED', retryable: true, retry_after_s: 30 });
  });

  it('id 不匹配的响应被忽略（插件自己打印的 JSON 不会串台）', async () => {
    const host = new PluginHost({
      spawn: stubSpawn([], {
        reply: (req) =>
          [
            JSON.stringify({ id: 'someone-else', ok: true, stream_url: 'https://wrong' }),
            JSON.stringify({ id: req.id, ok: true, stream_url: 'https://right' }),
          ].join('\n'),
        exitAfterReply: true,
      }),
    });
    const result = await host.call(entry, plan, { id: 'r3', action: 'resolve' });
    expect(result.data?.['stream_url']).toBe('https://right');
  });
});

describe('收尸', () => {
  it('超时：kill 掉进程并回 NETWORK（可重试）', async () => {
    let killed = false;
    const host = new PluginHost({
      timeoutMs: 40,
      spawn: () => {
        let settle: (() => void) | null = null;
        const waited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
          settle = () => resolve({ code: null, signal: 'SIGKILL' });
        });
        return {
          write: () => undefined,
          closeStdin: () => undefined,
          wait: () => waited,
          kill: () => {
            killed = true;
            settle?.();
          },
        };
      },
    });
    const result = await host.call(entry, plan, { id: 'r4', action: 'probe' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NETWORK');
    expect(result.error?.message).toContain('超时');
    expect(killed).toBe(true);
  });

  it('没回响应就退出 → INTERNAL（不是 NETWORK，否则会被退避到天荒地老）', async () => {
    const host = new PluginHost({ spawn: stubSpawn([], { exitImmediately: true }) });
    const result = await host.call(entry, plan, { id: 'r5', action: 'probe' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INTERNAL');
  });
});

describe('闸门', () => {
  it('per-plugin 并发上限：串行执行，不并发拉起同类插件', async () => {
    const calls: { at: number; input: PluginSpawnInput }[] = [];
    const host = new PluginHost({
      concurrency: 1,
      minIntervalMs: 0,
      spawn: stubSpawn(calls, {
        delayMs: 30,
        reply: (req) => JSON.stringify({ id: req.id, ok: true }),
        exitAfterReply: true,
      }),
    });
    await Promise.all([
      host.call(entry, plan, { id: 'a', action: 'probe' }),
      host.call(entry, plan, { id: 'b', action: 'probe' }),
    ]);
    expect(calls).toHaveLength(2);
    expect((calls[1]?.at ?? 0) - (calls[0]?.at ?? 0)).toBeGreaterThanOrEqual(25);
  });

  it('per-platform 最小间隔是预约式：并发同时进来也会错开', async () => {
    const calls: { at: number; input: PluginSpawnInput }[] = [];
    const host = new PluginHost({
      concurrency: 2,
      minIntervalMs: 50,
      spawn: stubSpawn(calls, {
        reply: (req) => JSON.stringify({ id: req.id, ok: true }),
        exitAfterReply: true,
      }),
    });
    await Promise.all([
      host.call(entry, plan, { id: 'x', action: 'probe', platform: 'douyin' }),
      host.call(entry, plan, { id: 'y', action: 'probe', platform: 'douyin' }),
    ]);
    expect(calls).toHaveLength(2);
    const gap = (calls[1]?.at ?? 0) - (calls[0]?.at ?? 0);
    expect(gap).toBeGreaterThanOrEqual(40);
  });
});
