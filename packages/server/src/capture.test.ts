/**
 * `describeBinary` 是"ffmpeg 能不能用、是哪个版本"的唯一判定点：
 * 健康页、preflight 提示、版本漂移排查都读它。这里用桩监督器锁住解析规则。
 */
import { describe, expect, it } from 'vitest';
import type { ProcessSupervisor } from '@tidewatch/host-adapter';
import { describeBinary } from './capture.ts';

interface FakeResult {
  code: number | null;
  stdout?: string[];
  stderr?: string[];
}

/** 只实现 runCommand 用到的部分：spawn → 逐行回调 → wait */
function fakeSupervisor(result: FakeResult): ProcessSupervisor {
  return {
    spawn: (opts: { onLine?: (stream: 'stdout' | 'stderr', line: string) => void }) => {
      for (const line of result.stdout ?? []) opts.onLine?.('stdout', line);
      for (const line of result.stderr ?? []) opts.onLine?.('stderr', line);
      return {
        pid: 1,
        write: () => undefined,
        closeStdin: () => undefined,
        stop: () => Promise.resolve(),
        kill: () => Promise.resolve(),
        wait: () => Promise.resolve({ code: result.code, signal: null }),
      };
    },
  } as unknown as ProcessSupervisor;
}

const VERSION_LINE =
  'ffmpeg version 9.0.2 Copyright (c) 2000-2026 the FFmpeg developers\n' +
  'built with Apple clang version 16.0.0';

describe('describeBinary', () => {
  it('从 `ffmpeg -version` 首行取出版本，ok=true', async () => {
    const info = await describeBinary(fakeSupervisor({ code: 0, stdout: [VERSION_LINE] }), 'ffmpeg');
    expect(info).toEqual({ ok: true, version: '9.0.2' });
  });

  it('第三方构建把自家站点拼进版本号时切掉尾巴（只留 9.0.2）', async () => {
    const info = await describeBinary(
      fakeSupervisor({ code: 0, stdout: ['ffprobe version 9.0.2-https://example.org Copyright (c) 2007-2026'] }),
      'ffprobe',
    );
    expect(info.version).toBe('9.0.2');
    expect(info.ok).toBe(true);
  });

  it('退出码非 0 → ok=false；版本可能仍能解析出来（stderr 里也有版本串）', async () => {
    const info = await describeBinary(fakeSupervisor({ code: 127, stderr: ['sh: ffmpeg: command not found'] }), 'ffmpeg');
    expect(info.ok).toBe(false);
    expect(info.version).toBeNull();
  });

  it('版本串缺失时 version=null，而不是空字符串', async () => {
    const info = await describeBinary(fakeSupervisor({ code: 0, stdout: ['something else entirely'] }), 'ffmpeg');
    expect(info).toEqual({ ok: true, version: null });
  });
});
