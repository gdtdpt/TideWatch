import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getUserVersion, migrate, openDatabase } from './db.ts';
import { MIGRATIONS, SCHEMA_VERSION } from './migrations.ts';

const dirs: string[] = [];

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tidewatch-store-'));
  dirs.push(dir);
  return join(dir, 'tidewatch.db');
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('node:sqlite 可用性（M0 spike）', () => {
  it('WAL 生效、迁移到最新版本、可重复执行', () => {
    const file = tmpDbPath();
    const db = openDatabase(file);

    const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(String(mode.journal_mode).toLowerCase()).toBe('wal');

    expect(getUserVersion(db)).toBe(0);
    expect(migrate(db, MIGRATIONS)).toBe(SCHEMA_VERSION);
    // 幂等：再跑一次不重复执行
    expect(migrate(db, MIGRATIONS)).toBe(SCHEMA_VERSION);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => String((r as { name: string }).name));
    expect(tables).toContain('tasks');
    expect(tables).toContain('sessions');

    db.close();
  });

  it('STRICT 表与唯一索引真的在起作用', () => {
    const db = openDatabase(':memory:');
    migrate(db, MIGRATIONS);
    const now = new Date().toISOString();
    const insert = db.prepare(
      'INSERT INTO tasks (id, kind, url, platform, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insert.run('t1', 'live', 'https://example.com/live/1', 'example', now, now);
    expect(() => insert.run('t2', 'live', 'https://example.com/live/1', 'example', now, now)).toThrow(/UNIQUE/);
    db.close();
  });

  it('迁移失败必须回滚，不带半套 schema', () => {
    const db = openDatabase(':memory:');
    expect(() =>
      migrate(db, [
        { version: 1, name: 'ok', up: (d) => d.exec('CREATE TABLE a (x INTEGER);') },
        {
          version: 2,
          name: 'broken',
          up: (d) => {
            d.exec('CREATE TABLE b (x INTEGER);');
            throw new Error('boom');
          },
        },
      ]),
    ).toThrow(/v2/);

    expect(getUserVersion(db)).toBe(1);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => String((r as { name: string }).name));
    expect(names).toEqual(['a']);
    db.close();
  });
});
