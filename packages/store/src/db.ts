/**
 * SQLite 访问层：`node:sqlite`（Node 24/26 内建，SQLite 编进 node 二进制）。
 * 选它而非 better-sqlite3 的唯一理由：数据层零原生依赖，让"每平台一个 artifact"
 * 的平台相关面只剩 ffmpeg / python / keyring（见 docs/02 §8.4）。
 *
 * 迁移的**顺序**是正确性的一部分（回填 → 去重 → 建唯一索引），所以这里只提供
 * 最小原语，绝不抽象掉 SQL。
 */
import { DatabaseSync } from 'node:sqlite';

export interface Migration {
  readonly version: number;
  readonly name: string;
  up(db: DatabaseSync): void;
}

export interface OpenOptions {
  /** 只读打开（诊断包 / 恢复扫描的 dry-run 场景） */
  readOnly?: boolean;
}

export function openDatabase(file: string, opts: OpenOptions = {}): DatabaseSync {
  const db = new DatabaseSync(file, { readOnly: opts.readOnly ?? false });
  if (!opts.readOnly) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

export function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number | bigint } | undefined;
  return Number(row?.user_version ?? 0);
}

function setUserVersion(db: DatabaseSync, version: number): void {
  if (!Number.isInteger(version) || version < 0) throw new Error(`非法 schema 版本：${version}`);
  // PRAGMA 不接受参数绑定，只能拼字符串 —— 上面已做整数校验
  db.exec(`PRAGMA user_version = ${version}`);
}

/**
 * 顺序执行未应用的迁移，每个迁移一个事务。
 * 失败即回滚并抛出，绝不带着半套 schema 继续跑。
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[]): number {
  const pending = [...migrations].sort((a, b) => a.version - b.version);
  let current = getUserVersion(db);

  for (const m of pending) {
    if (m.version <= current) continue;
    db.exec('BEGIN');
    try {
      m.up(db);
      setUserVersion(db, m.version);
      db.exec('COMMIT');
      current = m.version;
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`迁移 v${m.version} (${m.name}) 失败：${(err as Error).message}`, { cause: err });
    }
  }
  return current;
}
