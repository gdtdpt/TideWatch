/**
 * stderr 分类与退避决策的回归锁（docs/03 §3）。
 *
 * 这些函数存在的唯一理由，是"断网被误判成下播"「连续失败变成热循环」这类事故
 * 不再依赖人肉记忆 —— 所以每条规则都要有一句可复现的断言。
 */
import { describe, expect, it } from 'vitest';
import {
  classifyLine,
  decideExit,
  FAIL_STREAK_LIMIT,
  primaryClass,
  reconnectDelayMs,
  resolveFault,
  shouldEndSessionOnFault,
  URL_LESS_FAST_DELAY_MS,
  URL_LESS_FAST_ROUNDS,
  type ErrorClass,
} from './classify.ts';

describe('stderr 分类', () => {
  const cases: [string, ErrorClass][] = [
    ['[http @ 0x1] HTTP error 403 Forbidden', 'url_expired'],
    ['Server returned 404 Not Found', 'url_expired'],
    ['Connection timed out', 'network'],
    ['Connection reset by peer', 'cdn_reset'],
    ['Stream ends prematurely at 1', 'stream_eof'],
    ['Input/output error', 'stream_eof'],
    ['No space left on device', 'disk'],
    ['Non-monotonous DTS in output stream', 'param_change'],
  ];

  for (const [line, expected] of cases) {
    it(`「${line}」→ ${expected}`, () => {
      expect(classifyLine(line)).toBe(expected);
    });
  }

  it('认不出的行返回 null（原文落 events，不猜分类）', () => {
    expect(classifyLine('frame= 100 fps=30 q=-1.0 size= 256kB')).toBeNull();
  });

  it('一次连接命中多条时按处置优先级取主根因：磁盘 > 过期 > 网络', () => {
    const primary = primaryClass(['cdn_reset', 'network', 'disk'] as ErrorClass[]);
    expect(primary).toBe('disk');
    expect(primaryClass(['stream_eof', 'url_expired'])).toBe('url_expired');
    expect(primaryClass([])).toBeNull();
  });
});

describe('退出决策', () => {
  it('退出码 0 且无信号 → graceful（交给 resolve 判定是否真下播）', () => {
    expect(decideExit({ code: 0, signal: null, classes: [] })).toEqual({ action: 'graceful', errorClass: null });
  });

  it('非 0 退出 → reconnect，即使已经落了不少段', () => {
    expect(decideExit({ code: 1, signal: null, classes: ['cdn_reset'] })).toEqual({
      action: 'reconnect',
      errorClass: 'cdn_reset',
    });
  });

  it('磁盘类错误优先于退出码：不重试', () => {
    expect(decideExit({ code: 0, signal: null, classes: ['disk'] }).action).toBe('disk');
  });

  it('被信号杀死也走重连（不是 graceful）', () => {
    expect(decideExit({ code: null, signal: 'SIGKILL', classes: [] })).toEqual({
      action: 'reconnect',
      errorClass: 'unknown',
    });
  });
});

describe('退避阶梯', () => {
  it('2 → 5 → 10 → 30 秒，且不超过轮询间隔', () => {
    expect([1, 2, 3, 4, 9].map((n) => reconnectDelayMs(n, 60))).toEqual([2_000, 5_000, 10_000, 30_000, 30_000]);
    expect(reconnectDelayMs(4, 15)).toBe(15_000);
    expect(reconnectDelayMs(1, 1)).toBe(1_000);
  });

  it('在播但拿不到流地址：前 6 轮走 5s 短退避', () => {
    expect(URL_LESS_FAST_ROUNDS).toBe(6);
    expect(URL_LESS_FAST_DELAY_MS).toBe(5_000);
    expect(FAIL_STREAK_LIMIT).toBe(5);
  });
});

describe('插件错误 → 状态与处置', () => {
  it('需要人办一件事的三类：换状态 + 专用事件', () => {
    expect(resolveFault('AUTH_REQUIRED')).toMatchObject({ kind: 'needs_auth', state: 'needs_auth' });
    expect(resolveFault('DEPENDENCY_MISSING')).toMatchObject({ kind: 'needs_dep', state: 'needs_dep' });
    expect(resolveFault('PLATFORM_UNSUPPORTED')).toMatchObject({ kind: 'unsupported', state: 'unsupported' });
  });

  it('限流/平台改版/网络 都属于"等一会儿再来"，不换状态', () => {
    for (const code of ['RATE_LIMITED', 'PLATFORM_CHANGED', 'NETWORK', 'TIMEOUT'] as const) {
      expect(resolveFault(code)).toMatchObject({ kind: 'other', state: 'error' });
    }
  });

  it('retryable=false 不等于"这一场到此为止"', () => {
    // 只有这三类才允许结束会话；RATE_LIMITED/PLATFORM_CHANGED 都还能再来
    expect(shouldEndSessionOnFault('AUTH_REQUIRED')).toBe(true);
    expect(shouldEndSessionOnFault('DEPENDENCY_MISSING')).toBe(true);
    expect(shouldEndSessionOnFault('PLATFORM_UNSUPPORTED')).toBe(true);
    expect(shouldEndSessionOnFault('PLATFORM_CHANGED')).toBe(false);
    expect(shouldEndSessionOnFault('RATE_LIMITED')).toBe(false);
    expect(shouldEndSessionOnFault('NETWORK')).toBe(false);
  });
});
