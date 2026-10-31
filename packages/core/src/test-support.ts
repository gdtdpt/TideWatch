/**
 * 测试替身：把引擎依赖的四个外部世界换成可控实现。
 *
 * 只在测试里用（tsconfig 已把它排除出构建）。放这里而不是各测试文件各写一份，
 * 是因为引擎、后处理、恢复三套测试必须**共用同一种假文件系统语义**，
 * 否则"同一场景在三个测试里表现不同"会掩盖真实缺陷。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@tidewatch/store';
import type {
  CaptureHandle,
  CapturePort,
  CaptureSpec,
  EngineFs,
  ProbePort,
  ResolveOutcome,
  ResolverPort,
} from './engine.ts';
import type { Fingerprint } from './ffmpeg.ts';
import { baseName, dirName, joinPath } from './layout.ts';

export class FakeFs implements EngineFs {
  readonly files = new Map<string, { text: string | null; size: number }>();
  readonly dirs = new Set<string>();
  free: number | null = 1024 ** 3;

  /** 造一个媒体分段（引擎只关心大小与可读性） */
  put(file: string, sizeBytes: number): void {
    this.files.set(file, { text: null, size: sizeBytes });
  }

  async mkdirp(dir: string): Promise<void> {
    this.dirs.add(dir);
  }

  async readText(file: string): Promise<string | null> {
    return this.files.get(file)?.text ?? null;
  }

  async writeText(file: string, text: string): Promise<void> {
    this.files.set(file, { text, size: text.length });
  }

  async statSize(file: string): Promise<number> {
    return this.files.get(file)?.size ?? 0;
  }

  async listFiles(dir: string): Promise<string[]> {
    return [...this.files.keys()].filter((p) => dirName(p) === dir);
  }

  async freeBytes(): Promise<number | null> {
    return this.free;
  }

  async exists(file: string): Promise<boolean> {
    return this.files.has(file);
  }

  async remove(file: string): Promise<void> {
    this.files.delete(file);
  }

  async move(from: string, to: string): Promise<void> {
    const v = this.files.get(from);
    if (v === undefined) throw new Error(`ENOENT: ${from}`);
    this.files.delete(from);
    this.files.set(to, v);
  }
}

export interface ConnSegment {
  durationS: number;
  sizeBytes: number;
}

export interface ConnPlan {
  segments: ConnSegment[];
  /** 只"封口"前 n 段 —— 模拟正在录制、后面的段还没切片 */
  sealedCount?: number;
  /** 造完分段后自动退出；缺省 = 一直跑（等 stop/kill） */
  exit?: { code: number | null; signal?: string | null; afterMs?: number };
  stderr?: string[];
}

export class FakeHandle implements CaptureHandle {
  readonly pid: number | undefined = 1234;
  killed = false;
  stopped = false;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  #settle: ((v: { code: number | null; signal: string | null }) => void) | null = null;
  #done = false;

  constructor(private readonly plan: ConnPlan) {
    this.exited = new Promise((resolve) => {
      this.#settle = resolve;
    });
  }

  write(): void {
    /* 引擎不写 stdin；插件才走这条路 */
  }

  kill(): void {
    this.killed = true;
    this.#finish(null, 'SIGKILL');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.#finish(0, null);
  }

  wait(): Promise<{ code: number | null; signal: string | null }> {
    return this.exited;
  }

  /** 由测试推进：模拟 ffmpeg 自己崩掉 */
  exitNow(code: number | null): void {
    this.#finish(code, null);
  }

  #finish(code: number | null, signal: string | null): void {
    if (this.#done) return;
    this.#done = true;
    this.#settle?.({ code, signal });
  }

  get done(): boolean {
    return this.#done;
  }

  /** 按计划造出分段文件与 seglist（ffmpeg 的 `-segment_list +live` 记账） */
  materialize(fs: FakeFs, spec: CaptureSpec): void {
    const pattern = spec.args[spec.args.length - 1] ?? '';
    const m = /^(.*)[\\/]([^\\/]+)_part%03d\.ts$/.exec(pattern);
    if (m === null) return;
    const dir = m[1] ?? '';
    const sessionId = m[2] ?? '';
    const startIndex = spec.args.indexOf('-segment_start_number');
    const startNumber = startIndex >= 0 ? Number(spec.args[startIndex + 1] ?? '1') : 1;

    const listPath = joinPath(dir, `.${sessionId}.seglist.csv`);
    const existing = fs.files.get(listPath)?.text ?? '';
    let csv = existing;
    let cursor = 0;

    // ffmpeg 只在段关闭时往列表追加一行，所以"未封口"的段既没有文件也没有 csv 行
    const sealed = Math.min(this.plan.sealedCount ?? this.plan.segments.length, this.plan.segments.length);

    this.plan.segments.slice(0, sealed).forEach((seg, i) => {
      const partNo = startNumber + i;
      const file = joinPath(dir, `${sessionId}_part${String(partNo).padStart(3, '0')}.ts`);
      fs.put(file, seg.sizeBytes);
      csv += `${baseName(file)},${String(cursor)},${String(cursor + seg.durationS)}\n`;
      cursor += seg.durationS;
    });
    fs.files.set(listPath, { text: csv, size: csv.length });
  }
}

export class FakeCapture implements CapturePort {
  readonly starts: CaptureSpec[] = [];
  readonly handles: FakeHandle[] = [];
  /** null = 环境就绪；设值即模拟"缺 ffmpeg"这类前置失败 */
  preflightResult: { ok: boolean; detail?: string } | null = null;
  /** 第 n 次连接用第 n 个计划；超出则复用最后一个 */
  plans: ConnPlan[] = [{ segments: [{ durationS: 60, sizeBytes: 1024 }] }];

  constructor(private readonly fs: FakeFs) {}

  async preflight(): Promise<{ ok: boolean; detail?: string }> {
    return this.preflightResult ?? { ok: true };
  }

  async start(spec: CaptureSpec): Promise<CaptureHandle> {
    this.starts.push(spec);
    const plan = this.plans[Math.min(this.handles.length, this.plans.length - 1)] ?? {
      segments: [{ durationS: 60, sizeBytes: 1024 }],
    };
    const handle = new FakeHandle(plan);
    this.handles.push(handle);
    handle.materialize(this.fs, spec);
    for (const line of plan.stderr ?? []) spec.onStderrLine?.(line);
    if (plan.exit !== undefined) {
      const afterMs = plan.exit.afterMs ?? 10;
      setTimeout(() => {
        handle.exitNow(plan.exit?.code ?? 0);
      }, afterMs);
    }
    return handle;
  }
}

export class FakeProbe implements ProbePort {
  /** 返回 null = 解析不出来（进 orphan） */
  fallback: ((file: string) => Fingerprint | null) | null = null;

  async probe(file: string): Promise<Fingerprint | null> {
    if (this.fallback !== null) return this.fallback(file);
    return fingerprintOf(1920, 1080);
  }
}

export function fingerprintOf(width: number, height: number, durationS = 60): Fingerprint {
  return {
    video: {
      codec: 'h264',
      profile: 'High',
      width,
      height,
      pixFmt: 'yuv420p',
      layoutHash: `h264-${String(width)}x${String(height)}-yuv420p+aac-44100-2`,
    },
    audio: { codec: 'aac', sampleRate: 44_100, channels: 2 },
    durationS,
    sizeBytes: 1024,
  };
}

export function liveOutcome(overrides: Partial<Extract<ResolveOutcome, { ok: true }>['data']> = {}): ResolveOutcome {
  return {
    ok: true,
    data: {
      isLive: true,
      recordUrl: 'https://cdn.example.com/live.flv',
      platform: 'douyin',
      anchorName: '测试主播',
      title: '测试直播',
      isOverseas: false,
      headers: {},
      qualityOptions: ['origin'],
      cookiesOut: null,
      ...overrides,
    },
  };
}

export function offlineOutcome(): ResolveOutcome {
  return liveOutcome({ isLive: false, recordUrl: null });
}

export class FakeResolver implements ResolverPort {
  /** 依次消费；用完后一直复用最后一个 */
  queue: ResolveOutcome[] = [liveOutcome()];
  calls = 0;

  async resolve(): Promise<ResolveOutcome> {
    this.calls += 1;
    const idx = Math.min(this.calls - 1, this.queue.length - 1);
    return this.queue[idx] ?? liveOutcome();
  }
}

export interface Harness {
  store: Store;
  fs: FakeFs;
  capture: FakeCapture;
  probe: FakeProbe;
  resolver: FakeResolver;
  dir: string;
  cleanup(): void;
}

export function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'tidewatch-core-'));
  const store = new Store(join(dir, 'tidewatch.db'));
  const fs = new FakeFs();
  const capture = new FakeCapture(fs);
  const probe = new FakeProbe();
  const resolver = new FakeResolver();
  return {
    store,
    fs,
    capture,
    probe,
    resolver,
    dir,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function waitFor(cond: () => boolean, label = '条件', timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时：${label}`);
}
