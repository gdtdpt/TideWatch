/**
 * 保留期执行器：过期事件**先归档、再删除**。
 *
 * 顺序不能反：先删后归档，等于把用户的证据交给一段可能失败的代码去赌。
 * 归档写盘失败就整批不删（宁可库大一点），并把原因带回去给人看。
 *
 * 不自动 VACUUM：DELETE 只把页挂到 freelist，之后的新事件会复用这些页，
 * 文件大小自然停住；而 VACUUM 会长时间独占写锁，不能塞在巡检路径里。
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip, gzipSync } from 'node:zlib';
import type { EventRow } from './models.ts';
import { DEFAULT_RETENTION, retentionCutoffs, type RetentionPolicy } from './events.ts';
import type { Store } from './store.ts';

export interface RetentionLogger {
  warn(msg: string, meta?: unknown): void;
}

export interface RetentionOptions {
  store: Store;
  /** 归档文件放哪：`<dataRoot>/events` */
  archiveDir: string;
  policy?: RetentionPolicy;
  now?: () => Date;
  /** 每批行数：一批一个事务，避免长事务把库锁住 */
  batchSize?: number;
  /** 一次最多删几批；剩下的交给下一轮，宁可慢也不要卡顿 */
  maxBatches?: number;
  /** false = 直接删不归档（只在明确要求时用） */
  archive?: boolean;
  logger?: RetentionLogger;
}

export interface RetentionResult {
  deleted: { process: number; result: number };
  archived: { process: number; result: number };
  files: string[];
  /** 归档失败导致"该删没删"的原因 */
  skipped: { process: number; result: number };
  error: string | null;
  totalBefore: number;
  totalAfter: number;
  sizeBytes: number;
  freePages: number;
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

function archiveName(at: Date, cls: 'process' | 'result', seq: number): string {
  return `archive-${stamp(at)}-${cls}-${String(seq).padStart(3, '0')}.ndjson.gz`;
}

/** 归档行写成 gzip NDJSON：一行一条，`gunzip -c x | grep ...` 就能查 */
function writeArchive(dir: string, name: string, rows: readonly EventRow[]): string {
  mkdirSync(dir, { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const file = join(dir, name);
  writeFileSync(file, gzipSync(Buffer.from(body, 'utf8'), { level: 6 }));
  return file;
}

export interface ArchiveStats {
  dir: string;
  files: number;
  bytes: number;
  newestAt: string | null;
}

export function archiveStats(dir: string): ArchiveStats {
  if (!existsSync(dir)) return { dir, files: 0, bytes: 0, newestAt: null };
  let files = 0;
  let bytes = 0;
  let newest = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ndjson.gz')) continue;
    const st = statSync(join(dir, name));
    files += 1;
    bytes += st.size;
    newest = Math.max(newest, st.mtimeMs);
  }
  return { dir, files, bytes, newestAt: newest === 0 ? null : new Date(newest).toISOString() };
}

/** 读回归档（诊断/自测用）：逐行 yield 事件对象 */
export async function* readArchive(file: string): AsyncGenerator<EventRow> {
  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() === '') continue;
    yield JSON.parse(line) as EventRow;
  }
}

export async function runRetention(opts: RetentionOptions): Promise<RetentionResult> {
  const policy = opts.policy ?? DEFAULT_RETENTION;
  const batchSize = opts.batchSize ?? 2000;
  const maxBatches = opts.maxBatches ?? 20;
  const doArchive = opts.archive ?? true;
  const at = (opts.now ?? (() => new Date()))();
  const cut = retentionCutoffs(policy, at);

  const result: RetentionResult = {
    deleted: { process: 0, result: 0 },
    archived: { process: 0, result: 0 },
    files: [],
    skipped: { process: 0, result: 0 },
    error: null,
    totalBefore: 0,
    totalAfter: 0,
    sizeBytes: 0,
    freePages: 0,
  };

  result.totalBefore = opts.store.eventsInfo().total;

  const plan: { cls: 'process' | 'result'; before: string }[] = [
    { cls: 'process', before: cut.processBefore },
    { cls: 'result', before: cut.resultBefore },
  ];

  for (const { cls, before } of plan) {
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const rows = opts.store.listExpiredEvents(cls, before, batchSize);
      if (rows.length === 0) break;
      if (doArchive) {
        try {
          result.files.push(writeArchive(opts.archiveDir, archiveName(at, cls, batch), rows));
          result.archived[cls] += rows.length;
        } catch (err) {
          // 归档写不出去就不删：宁可库大，也不能把唯一证据弄丢
          result.error = err instanceof Error ? err.message : String(err);
          opts.logger?.warn(`事件归档失败，本批 ${String(rows.length)} 行保留在库里`, err);
          break;
        }
      }
      try {
        result.deleted[cls] += opts.store.deleteEventsByIds(rows.map((r) => r.id));
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
        opts.logger?.warn('过期事件删除失败', err);
        break;
      }
      // 这一批没删满 → 已经到底了
      if (rows.length < batchSize) break;
    }
    if (result.error !== null) {
      const rest = opts.store.listExpiredEvents(cls, before, 100_000).length;
      result.skipped[cls] = rest;
    }
  }

  const info = opts.store.eventsInfo();
  result.totalAfter = info.total;
  result.sizeBytes = opts.store.dbSizeBytes();
  result.freePages = opts.store.freePages();
  return result;
}

/** 给人和 UI 看的一行摘要 */
export function describeRetention(r: RetentionResult): string {
  const del = r.deleted.process + r.deleted.result;
  if (del === 0) return '没有过期事件';
  return `归档并删除 ${String(del)} 条（过程 ${String(r.deleted.process)} / 结果 ${String(r.deleted.result)}）`;
}
