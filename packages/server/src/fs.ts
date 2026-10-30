/**
 * EngineFs 的 Node 实现：把 `node:fs` 收在一个文件里，
 * 让 core 的引擎保持"零平台 API"，测试可以换成纯内存实现。
 */
import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineFs } from '@tidewatch/core';

export class NodeEngineFs implements EngineFs {
  async mkdirp(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  async readText(file: string): Promise<string | null> {
    try {
      return await readFile(file, 'utf8');
    } catch {
      return null;
    }
  }

  async writeText(file: string, text: string): Promise<void> {
    await writeFile(file, text, 'utf8');
  }

  async statSize(file: string): Promise<number> {
    try {
      return (await stat(file)).size;
    } catch {
      return 0;
    }
  }

  /** 只列文件（不递归）：恢复扫描按会话目录一层，深扫由调用方控制 */
  async listFiles(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => join(dir, e.name));
    } catch {
      return [];
    }
  }

  async freeBytes(dir: string): Promise<number | null> {
    try {
      const info = await statfs(dir);
      return Number(info.bavail) * Number(info.bsize);
    } catch {
      // 查不出来 = 放行（把"查不出来"当成"没空间"会让功能在未知环境里不可用）
      return null;
    }
  }

  async exists(file: string): Promise<boolean> {
    try {
      await stat(file);
      return true;
    } catch {
      return false;
    }
  }

  async remove(file: string): Promise<void> {
    await rm(file, { force: true });
  }

  async move(from: string, to: string): Promise<void> {
    await rename(from, to);
  }
}
