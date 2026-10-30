/**
 * ffmpeg 命令行：**逐字节复用**原版参数（docs/03 §4）。
 * 这里只拼参数，不 spawn —— 进程由 host-adapter 的 ProcessSupervisor 管。
 *
 * 三条踩过的坑写死在此，不靠记忆：
 * ① 布尔选项必须显式给值（`-reconnect_streamed 1`），裸写会把下一个参数当值；
 * ② `-headers` 是输入侧选项，必须在 `-i` 之前；
 * ③ `-progress` 的 `out_time_us` 是微秒（`out_time_ms` 这个历史命名也是微秒）。
 */

export interface RecordSpec {
  recordUrl: string;
  /** 输出目录（绝对路径） */
  outputDir: string;
  /** 会话 id，用于文件名与 seglist */
  sessionId: string;
  /** 会话内下一个分段编号（换连接接续，不覆盖旧文件） */
  startNumber: number;
  segmentTimeS: number;
  /** 插件声明的请求头；空则完全不发 `-headers` */
  headers?: Readonly<Record<string, string>> | null;
  proxy?: string | null;
  /** 海外线路：超时与缓冲翻倍 */
  overseas?: boolean;
  /** 国内 30s / 海外 60s */
  rwTimeoutUs?: number;
}

export const PROTOCOL_WHITELIST = 'rtmp,crypto,file,http,https,tcp,tls,udp,rtp,httpproxy';

export function recordArgs(spec: RecordSpec, headers: string | null): string[] {
  const args: string[] = ['-hide_banner', '-loglevel', 'warning', '-nostats'];
  const timeout = spec.rwTimeoutUs ?? (spec.overseas === true ? 60_000_000 : 30_000_000);
  args.push('-rw_timeout', String(timeout));

  if (headers !== null && headers.length > 0) {
    args.push('-headers', headers);
  }
  if (spec.proxy !== null && spec.proxy !== undefined && spec.proxy.length > 0) {
    args.push('-http_proxy', spec.proxy);
  }

  args.push(
    '-protocol_whitelist',
    PROTOCOL_WHITELIST,
    '-thread_queue_size',
    '1024',
    '-analyzeduration',
    spec.overseas === true ? '40000000' : '20000000',
    '-probesize',
    spec.overseas === true ? '20000000' : '10000000',
    '-fflags',
    '+discardcorrupt+igndts',
    '-correct_ts_overflow',
    '1',
    '-reconnect_delay_max',
    '60',
    '-reconnect_streamed',
    '1',
    '-reconnect_at_eof',
    '1',
    '-i',
    spec.recordUrl,
    '-map',
    '0',
    '-c:v',
    'copy',
    '-c:a',
    'copy',
    '-sn',
    '-dn',
    '-f',
    'segment',
    '-segment_format',
    'mpegts',
    '-segment_time',
    String(Math.max(1, Math.floor(spec.segmentTimeS))),
    '-segment_start_number',
    String(Math.max(1, Math.floor(spec.startNumber))),
    '-segment_list',
    segmentListPath(spec.outputDir, spec.sessionId),
    '-segment_list_flags',
    '+live',
    '-mpegts_flags',
    '+resend_headers',
    '-muxdelay',
    '0',
    '-muxpreload',
    '0',
    '-reset_timestamps',
    '1',
    '-avoid_negative_ts',
    'make_zero',
    '-flush_packets',
    '1',
    '-progress',
    'pipe:1',
    outputPattern(spec.outputDir, spec.sessionId),
  );
  return args;
}

export function outputPattern(outputDir: string, sessionId: string): string {
  return `${outputDir.replace(/[\\/]+$/, '')}/${sessionId}_part%03d.ts`;
}

export function segmentListPath(outputDir: string, sessionId: string): string {
  return `${outputDir.replace(/[\\/]+$/, '')}/.${sessionId}.seglist.csv`;
}

export interface ConcatSpec {
  listFile: string;
  outFile: string;
  faststart: boolean;
}

/** 零转码拼接：`-c copy`；faststart 需整文件重写，默认按大小阈值决定 */
export function concatArgs(spec: ConcatSpec): string[] {
  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostats',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    spec.listFile,
    '-c',
    'copy',
  ];
  if (spec.faststart) args.push('-movflags', '+faststart');
  args.push('-y', spec.outFile);
  return args;
}

/** 整组同质化重封装：统一流顺序 + 丢残帧（docs/03 §8 实现注记） */
export function remuxArgs(input: string, output: string): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostats',
    '-i',
    input,
    '-map',
    '0',
    '-c',
    'copy',
    '-fflags',
    '+discardcorrupt',
    '-mpegts_flags',
    '+resend_headers',
    '-avoid_negative_ts',
    'make_zero',
    '-y',
    output,
  ];
}

export function probeArgs(input: string): string[] {
  return [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    input,
  ];
}

/** `--verify` 的抽查：解码整份产物，把错误行数作为证据留下 */
export function verifyArgs(input: string): string[] {
  return ['-v', 'error', '-i', input, '-map', '0', '-f', 'null', '-'];
}

/** ffprobe 输出的最小形状（宽容解析：缺字段不影响展示） */
export interface ProbeData {
  streams?: {
    codec_type?: string;
    codec_name?: string;
    profile?: string;
    width?: number;
    height?: number;
    pix_fmt?: string;
    sample_rate?: string;
    channels?: number;
  }[];
  format?: { duration?: string; size?: string };
}

export interface Fingerprint {
  video: {
    codec: string | null;
    profile: string | null;
    width: number | null;
    height: number | null;
    pixFmt: string | null;
    layoutHash: string | null;
  } | null;
  audio: { codec: string | null; sampleRate: number | null; channels: number | null } | null;
  durationS: number;
  sizeBytes: number;
}

export function fingerprintFromProbe(data: ProbeData): Fingerprint {
  const streams = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  const video =
    v === undefined
      ? null
      : {
          codec: v.codec_name ?? null,
          profile: v.profile ?? null,
          width: v.width ?? null,
          height: v.height ?? null,
          pixFmt: v.pix_fmt ?? null,
          layoutHash: layoutHashOf(v, a),
        };
  const audio =
    a === undefined
      ? null
      : {
          codec: a.codec_name ?? null,
          sampleRate: a.sample_rate === undefined ? null : Number(a.sample_rate),
          channels: a.channels ?? null,
        };
  return {
    video,
    audio,
    durationS: Number(data.format?.duration ?? 0),
    sizeBytes: Number(data.format?.size ?? 0),
  };
}

export function layoutHashOf(
  v: { codec_name?: string; width?: number; height?: number; pix_fmt?: string } | undefined,
  a: { codec_name?: string; sample_rate?: string; channels?: number } | undefined,
): string | null {
  if (v === undefined) return null;
  const vs = `${v.codec_name ?? '?'}-${v.width ?? 0}x${v.height ?? 0}-${v.pix_fmt ?? '?'}`;
  if (a === undefined) return vs;
  return `${vs}+${a.codec_name ?? '?'}-${a.sample_rate ?? '?'}-${a.channels ?? '?'}`;
}

/**
 * 分段账单（`-segment_list_flags +live`）：每行 `文件名,累计起点,累计终点`。
 * 这是 ffmpeg 的**独立记账**，不能拿"前面各段时长之和"反推 —— 那是同义反复。
 */
export interface SegListEntry {
  file: string;
  start: number;
  end: number;
}

export function parseSegList(text: string): SegListEntry[] {
  const out: SegListEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const cols = line.split(',');
    if (cols.length < 3) continue;
    const file = cols[0]?.trim() ?? '';
    const start = Number(cols[1]);
    const end = Number(cols[2]);
    if (file.length === 0 || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({ file, start, end });
  }
  return out;
}

/**
 * `-progress pipe:1` 的一行：认 `out_time_us`（微秒）。
 * `N/A` 是"还没有值"，不是 0。
 */
export function parseProgressLine(line: string): { outTimeUs?: number; ended?: boolean } {
  const [rawKey, rawValue] = line.split('=', 2);
  if (rawKey === undefined || rawValue === undefined) return {};
  const key = rawKey.trim();
  const value = rawValue.trim();
  if (key === 'out_time_us') {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? { outTimeUs: n } : {};
  }
  if (key === 'progress') return { ended: value === 'end' };
  return {};
}
