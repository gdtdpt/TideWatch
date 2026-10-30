/**
 * 路径与命名：全项目唯一命名真源（docs/09 §6.2）。
 *
 * 纯函数，零 IO —— 命名规则一旦分叉，"恢复扫描找不到会话目录"就是必然结果。
 */
import type { SessionOrigin } from '@tidewatch/store';
import { sanitizeDirName } from './naming.ts';

const p = (n: number, w = 2): string => String(n).padStart(w, '0');

/** 目录名里的本地时间：`20261025-104804`（字典序 = 时间序） */
export function localDirStamp(d: Date): string {
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 产物名里的本地时间：`20261025_104804`（旧版踩过 UTC 坑） */
export function localFileStamp(d: Date): string {
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 会话目录名：`<本地时间>_<cap|new>_<session_id 前 8 位>`
 * 短 id 保证同秒也不撞；`cap`/`new` 让"切出来的"和"重开的"一眼可分。
 */
export function sessionDirName(d: Date, origin: SessionOrigin, sessionId: string): string {
  return `${localDirStamp(d)}_${origin}_${sessionId.slice(0, 8)}`;
}

export function partFileName(sessionId: string, partNo: number): string {
  return `${sessionId}_part${String(partNo).padStart(3, '0')}.ts`;
}

/** ffmpeg segment muxer 的实时记账表（`+live` 随分段落盘） */
export function segmentListName(sessionId: string): string {
  return `.${sessionId}.seglist.csv`;
}

export const MANIFEST_NAME = 'session.manifest.json';
export const ORPHAN_DIR = 'orphan';

/** 产物基线名：`<主播>_<会话开始本地时间>`（不含扩展名） */
export function outputBaseName(streamerName: string | null, startedAt: Date): string {
  const name = sanitizeDirName(streamerName ?? 'livestream', 80);
  return `${name}_${localFileStamp(startedAt)}`;
}

/**
 * `-headers` 渲染：字典序、抹 CR/LF、空则不产生该参数。
 * 空头不发 → 抖音/虎牙/斗鱼/AcFun 的命令行与本机制引入前逐字节一致。
 */
export function renderHeaders(headers: Readonly<Record<string, string>> | null | undefined): string | null {
  if (headers === null || headers === undefined) return null;
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.replace(/[\r\n]/g, '').trim(), String(v).replace(/[\r\n]/g, '').trim()] as const)
    .filter(([k]) => k.length > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return null;
  return entries.map(([k, v]) => `${k}: ${v}\r\n`).join('');
}

/** `xxx_part007.ts` → 7；解析不出返回 undefined */
export function parsePartNo(file: string): number | undefined {
  const m = /_part(\d+)\.ts$/i.exec(file);
  if (m === null) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 恢复扫描只认 `.ts`，且跳过 `orphan/` 与 `.fixed.ts`（合并中间产物） */
export function isCandidateTs(name: string): boolean {
  if (!name.toLowerCase().endsWith('.ts')) return false;
  if (name.toLowerCase().endsWith('.fixed.ts')) return false;
  if (name.startsWith('.')) return false;
  return true;
}

/** 路径比较的规范化 key：统一分隔符 + 小写（抵消 Windows 大小写差异） */
export function pathKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

export function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i < 0 ? path : path.slice(i + 1);
}

export function dirName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i <= 0 ? path.slice(0, Math.max(i, 0)) : path.slice(0, i);
}

export function joinPath(...parts: string[]): string {
  return parts
    .filter((x) => x.length > 0)
    .map((x, i) => (i === 0 ? x.replace(/[\\/]+$/, '') : x.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '')))
    .join('/');
}
