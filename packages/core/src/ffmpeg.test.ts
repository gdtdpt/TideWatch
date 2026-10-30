/**
 * ffmpeg 命令行的回归锁（docs/03 §4）。
 *
 * 参数是"逐字节复用"的资产：`-headers` 挪到 `-i` 之后、布尔选项丢了值、
 * `-progress` 换成 `out_time_ms`，任何一种都会以"看起来在录、其实没画面"
 * 或"进度永远 0"的方式出现。这里把三条踩过的坑钉成断言。
 */
import { describe, expect, it } from 'vitest';
import {
  concatArgs,
  fingerprintFromProbe,
  parseProgressLine,
  parseSegList,
  probeArgs,
  recordArgs,
  remuxArgs,
  verifyArgs,
  type RecordSpec,
} from './ffmpeg.ts';
import { parsePartNo, renderHeaders } from './layout.ts';
import { concatListContent, durationAcceptable, resolveFaststart } from './merge.ts';

const base: RecordSpec = {
  recordUrl: 'https://cdn.example.com/live.flv?token=1',
  outputDir: '/out/主播/20261029-101010_new_abcd1234',
  sessionId: 'abcd1234',
  startNumber: 3,
  segmentTimeS: 1800,
};

const indexOf = (args: string[], flag: string): number => args.indexOf(flag);

describe('录制参数', () => {
  it('请求头必须出现在 -i 之前，且逐条带 CRLF', () => {
    const headers = renderHeaders({ Referer: 'https://live.bilibili.com/', 'User-Agent': 'UA/1.0' });
    const args = recordArgs({ ...base, headers: { Referer: 'https://live.bilibili.com/' } }, headers);
    expect(headers).toBe('Referer: https://live.bilibili.com/\r\nUser-Agent: UA/1.0\r\n');
    expect(indexOf(args, '-headers')).toBeGreaterThan(0);
    expect(indexOf(args, '-headers')).toBeLessThan(indexOf(args, '-i'));
  });

  it('空头不产生 -headers：没写头的平台命令行与机制引入前完全一致', () => {
    expect(renderHeaders({})).toBeNull();
    expect(renderHeaders(null)).toBeNull();
    const args = recordArgs(base, null);
    expect(args).not.toContain('-headers');
  });

  it('布尔选项一律显式给值（裸写会把下一个参数吞掉）', () => {
    const args = recordArgs(base, null);
    for (const flag of ['-reconnect_streamed', '-reconnect_at_eof', '-correct_ts_overflow']) {
      const i = indexOf(args, flag);
      expect(i).toBeGreaterThan(-1);
      expect(args[i + 1]).toMatch(/^[01]$/);
    }
  });

  it('分段从续录编号开始，seglist 与输出模式都带会话 id', () => {
    const args = recordArgs(base, null);
    expect(args[indexOf(args, '-segment_start_number') + 1]).toBe('3');
    expect(args[indexOf(args, '-segment_time') + 1]).toBe('1800');
    expect(args[indexOf(args, '-segment_list') + 1]).toBe(
      '/out/主播/20261029-101010_new_abcd1234/.abcd1234.seglist.csv',
    );
    expect(args[args.length - 1]).toBe('/out/主播/20261029-101010_new_abcd1234/abcd1234_part%03d.ts');
    expect(args[indexOf(args, '-progress') + 1]).toBe('pipe:1');
  });

  it('零转码、只留音视频、按 mpegts 切段', () => {
    const args = recordArgs(base, null);
    expect(args[indexOf(args, '-c:v') + 1]).toBe('copy');
    expect(args[indexOf(args, '-c:a') + 1]).toBe('copy');
    expect(args[indexOf(args, '-segment_format') + 1]).toBe('mpegts');
    expect(args).toContain('-sn');
    expect(args).toContain('-dn');
    expect(args[indexOf(args, '-map') + 1]).toBe('0');
  });

  it('海外线路把超时与探测预算翻倍，代理只在有值时出现', () => {
    const domestic = recordArgs(base, null);
    const overseas = recordArgs({ ...base, overseas: true }, null);
    expect(domestic[indexOf(domestic, '-rw_timeout') + 1]).toBe('30000000');
    expect(overseas[indexOf(overseas, '-rw_timeout') + 1]).toBe('60000000');
    expect(overseas[indexOf(overseas, '-analyzeduration') + 1]).toBe('40000000');
    expect(domestic).not.toContain('-http_proxy');
    const proxied = recordArgs({ ...base, proxy: 'http://127.0.0.1:7890' }, null);
    expect(proxied[indexOf(proxied, '-http_proxy') + 1]).toBe('http://127.0.0.1:7890');
  });
});

describe('后处理参数', () => {
  it('concat 用 -c copy；faststart 是可选开关', () => {
    const plain = concatArgs({ listFile: '/out/list.txt', outFile: '/out/a.mp4', faststart: false });
    expect(plain[indexOf(plain, '-c') + 1]).toBe('copy');
    expect(plain).not.toContain('-movflags');
    const fast = concatArgs({ listFile: '/out/list.txt', outFile: '/out/a.mp4', faststart: true });
    expect(fast[indexOf(fast, '-movflags') + 1]).toBe('+faststart');
  });

  it('整组重封装保留时间戳归零，丢残帧', () => {
    const args = remuxArgs('/out/a.ts', '/out/a.fixed.ts');
    expect(args[indexOf(args, '-fflags') + 1]).toBe('+discardcorrupt');
    expect(args[indexOf(args, '-avoid_negative_ts') + 1]).toBe('make_zero');
    expect(args[args.length - 1]).toBe('/out/a.fixed.ts');
  });

  it('探测与抽查各自的最小参数', () => {
    expect(probeArgs('/out/a.ts')).toContain('-show_streams');
    expect(verifyArgs('/out/a.mp4')).toEqual(['-v', 'error', '-i', '/out/a.mp4', '-map', '0', '-f', 'null', '-']);
  });

  it('concat 清单里单引号要转义，否则文件名带引号就炸', () => {
    const text = concatListContent([
      { id: '1', path: "/out/it's.ts", partNo: 1, durationS: 1, sizeBytes: 1, layoutHash: null, integrity: 'ok', height: null },
    ]);
    expect(text).toBe("file '/out/it'\\''s.ts'\n");
  });
});

describe('记账解析', () => {
  it('seglist 跳过空行与残缺行，容忍 CRLF', () => {
    const parsed = parseSegList('a_0001.ts,0,60\n\nbroken\r\nb_0002.ts,60,120\r\n');
    expect(parsed).toEqual([
      { file: 'a_0001.ts', start: 0, end: 60 },
      { file: 'b_0002.ts', start: 60, end: 120 },
    ]);
  });

  it('progress 认 out_time_us（微秒），N/A 视为"还没有值"', () => {
    expect(parseProgressLine('out_time_us=1500000')).toEqual({ outTimeUs: 1_500_000 });
    expect(parseProgressLine('out_time_us=N/A')).toEqual({});
    expect(parseProgressLine('progress=end')).toEqual({ ended: true });
    expect(parseProgressLine('progress=continue')).toEqual({ ended: false });
  });

  it('文件名里的段号是唯一可靠的编号来源', () => {
    expect(parsePartNo('sess_part007.ts')).toBe(7);
    expect(parsePartNo('sess.ts')).toBeUndefined();
    expect(parsePartNo('sess_part000.ts')).toBeUndefined();
  });
});

describe('参数指纹', () => {
  it('同分辨率同编码得同一个 layout_hash；缺音轨也不同', () => {
    const withAudio = fingerprintFromProbe({
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p' },
        { codec_type: 'audio', codec_name: 'aac', sample_rate: '44100', channels: 2 },
      ],
      format: { duration: '60.5', size: '1024' },
    });
    const noAudio = fingerprintFromProbe({
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p' }],
      format: { duration: '60.5', size: '1024' },
    });
    expect(withAudio.video?.layoutHash).toBe('h264-1920x1080-yuv420p+aac-44100-2');
    expect(noAudio.video?.layoutHash).toBe('h264-1920x1080-yuv420p');
    expect(withAudio.durationS).toBe(60.5);
    expect(withAudio.audio).toEqual({ codec: 'aac', sampleRate: 44_100, channels: 2 });
  });
});

describe('合并判据', () => {
  it('产物时长容差 = max(2%, 1s)', () => {
    expect(durationAcceptable(60, 60)).toBe(true);
    expect(durationAcceptable(61, 60)).toBe(true);
    expect(durationAcceptable(63, 60)).toBe(false);
    expect(durationAcceptable(0, 60)).toBe(false);
  });

  it('faststart：auto 只在小文件上开启（整文件重写有代价）', () => {
    const mb = 1024 * 1024;
    expect(resolveFaststart('on', 999 * mb, 512)).toBe(true);
    expect(resolveFaststart('off', 1 * mb, 512)).toBe(false);
    expect(resolveFaststart('auto', 100 * mb, 512)).toBe(true);
    expect(resolveFaststart('auto', 600 * mb, 512)).toBe(false);
  });
});
