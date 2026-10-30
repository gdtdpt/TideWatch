/**
 * plugin.json 解析 + 启动计划白名单（docs/04 §4.1）。
 *
 * 清单可能来自用户可写目录，所以 `exec` / `args` / `env` 都要过词法白名单：
 * 绝对字面量路径一律拒绝，`{plugin_dir}/../../..` 归一化后照样拒绝。
 */
import { SUPPORTED_PROTOCOLS } from './index.ts';

export interface PluginManifest {
  name: string;
  version: string;
  protocol: number;
  exec: string;
  args: string[];
  env: Record<string, string>;
  modes: string[];
  urlPatterns: string[];
  platforms: string[];
  requires: {
    runtime?: { kind: string; version?: string };
    optional?: { kind: string; version?: string; reason?: string; affectsPlatforms?: string[] }[];
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function parseManifest(raw: unknown): { manifest: PluginManifest } | { error: string } {
  if (!isObject(raw)) return { error: 'plugin.json 不是对象' };
  const name = str(raw['name']);
  const version = str(raw['version']);
  const protocol = Number(raw['protocol']);
  const exec = str(raw['exec']);
  if (name.length === 0) return { error: '缺少 name' };
  if (exec.length === 0) return { error: '缺少 exec' };
  if (!Number.isInteger(protocol)) return { error: 'protocol 不是整数' };
  if (!(SUPPORTED_PROTOCOLS as readonly number[]).includes(protocol)) {
    return { error: `插件协议 ${String(protocol)} 高于宿主支持的 ${SUPPORTED_PROTOCOLS.join('/')}（请升级 App）` };
  }
  const envRaw = isObject(raw['env']) ? raw['env'] : {};
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(envRaw)) if (typeof v === 'string') env[k] = v;

  const requiresRaw = isObject(raw['requires']) ? raw['requires'] : {};
  const runtimeRaw = isObject(requiresRaw['runtime']) ? requiresRaw['runtime'] : null;
  const optional = Array.isArray(requiresRaw['optional'])
    ? requiresRaw['optional'].filter(isObject).map((o) => ({
        kind: str(o['kind']),
        version: str(o['version']),
        reason: str(o['reason']),
        affectsPlatforms: strArray(o['affects_platforms']),
      }))
    : [];

  return {
    manifest: {
      name,
      version: version.length > 0 ? version : '0.0.0',
      protocol,
      exec,
      args: strArray(raw['args']),
      env,
      modes: strArray(raw['modes']),
      urlPatterns: strArray(raw['url_patterns']),
      platforms: strArray(raw['platforms']),
      requires: {
        ...(runtimeRaw === null
          ? {}
          : { runtime: { kind: str(runtimeRaw['kind']), version: str(runtimeRaw['version']) } }),
        optional,
      },
    },
  };
}

export interface LaunchContext {
  pluginDir: string;
  resourceRoot: string;
  pythonPath?: string | null;
  nodePath?: string | null;
}

export interface LaunchPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export type LaunchResult = { ok: true; plan: LaunchPlan } | { ok: false; error: string };

const isAbsoluteLiteral = (p: string): boolean => /^[A-Za-z]:[\\/]|^[\\/]/.test(p);

/** 归一化但**保留盘符/UNC 前缀**（Path 分量拼装会把 D:\ 变成 \） */
export function normalizePath(p: string): string {
  const unified = p.replace(/\\/g, '/');
  const drive = /^[A-Za-z]:/.exec(unified)?.[0] ?? '';
  const rest = drive.length > 0 ? unified.slice(drive.length) : unified;
  const leading = rest.startsWith('/') ? '/' : '';
  const parts: string[] = [];
  for (const part of rest.split('/')) {
    if (part.length === 0 || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `${drive}${leading}${parts.join('/')}`;
}

function within(candidate: string, root: string): boolean {
  const c = normalizePath(candidate).toLowerCase();
  const r = normalizePath(root).toLowerCase().replace(/\/+$/, '');
  return c === r || c.startsWith(`${r}/`);
}

function expand(value: string, ctx: LaunchContext): string {
  return value
    .replaceAll('{plugin_dir}', normalizePath(ctx.pluginDir))
    .replaceAll('{resource}', normalizePath(ctx.resourceRoot))
    .replaceAll('{python}', ctx.pythonPath === null || ctx.pythonPath === undefined ? '{python}' : normalizePath(ctx.pythonPath))
    .replaceAll('{node}', ctx.nodePath === null || ctx.nodePath === undefined ? '{node}' : normalizePath(ctx.nodePath));
}

/**
 * 启动计划：`exec` 只接受纯 `{python}` / `{node}`，或展开后落在白名单根内的路径。
 * 越界只在**启动计划解析**时报错，清单本身仍可加载（插件列表能看见它和原因）。
 */
export function planLaunch(manifest: PluginManifest, ctx: LaunchContext): LaunchResult {
  const roots = [ctx.pluginDir, ctx.resourceRoot];
  if (ctx.pythonPath !== null && ctx.pythonPath !== undefined) roots.push(ctx.pythonPath.replace(/[\\/][^\\/]+$/, ''));
  if (ctx.nodePath !== null && ctx.nodePath !== undefined) roots.push(ctx.nodePath.replace(/[\\/][^\\/]+$/, ''));

  let command: string;
  if (manifest.exec === '{python}') {
    if (ctx.pythonPath === null || ctx.pythonPath === undefined) {
      return { ok: false, error: '插件需要 Python 运行时，但未找到 python' };
    }
    command = ctx.pythonPath;
  } else if (manifest.exec === '{node}') {
    if (ctx.nodePath === null || ctx.nodePath === undefined) {
      return { ok: false, error: '插件需要 Node 运行时，但未找到 node' };
    }
    command = ctx.nodePath;
  } else {
    if (isAbsoluteLiteral(manifest.exec)) return { ok: false, error: `exec 不接受绝对路径：${manifest.exec}` };
    const expanded = expand(manifest.exec, ctx);
    if (expanded.includes('{')) return { ok: false, error: `exec 含未知占位符：${manifest.exec}` };
    if (!roots.some((r) => within(expanded, r))) {
      return { ok: false, error: `exec 越出白名单：${manifest.exec}` };
    }
    command = expanded;
  }

  const args: string[] = [];
  for (const raw of manifest.args) {
    if (isAbsoluteLiteral(raw) && !raw.includes('{')) {
      return { ok: false, error: `args 不接受绝对路径：${raw}` };
    }
    const expanded = expand(raw, ctx);
    if (expanded.includes('{')) return { ok: false, error: `args 含未知占位符：${raw}` };
    if (raw.includes('{') && !roots.some((r) => within(expanded, r))) {
      return { ok: false, error: `args 越出白名单：${raw}` };
    }
    if (!raw.includes('{') && !isAbsoluteLiteral(expanded)) {
      args.push(expanded);
      continue;
    }
    args.push(expanded);
  }

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(manifest.env)) {
    if (isAbsoluteLiteral(v) && !v.includes('{')) {
      return { ok: false, error: `env ${k} 不接受绝对路径` };
    }
    const expanded = expand(v, ctx);
    if (expanded.includes('{')) return { ok: false, error: `env ${k} 含未知占位符` };
    if (v.includes('{') && !roots.some((r) => within(expanded, r))) {
      return { ok: false, error: `env ${k} 越出白名单` };
    }
    env[k] = expanded;
  }

  return { ok: true, plan: { command, args, env, cwd: ctx.pluginDir } };
}
