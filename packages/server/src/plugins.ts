/**
 * 插件发现：两级目录（数据根用户插件 > 资源根内置），单个坏清单只记 warning。
 * 扫描结果同时给出"启动计划"（路径白名单已校验），解析时不用再算。
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildRegistry,
  parseManifest,
  planLaunch,
  type LaunchPlan,
  type PluginEntry,
  type PluginManifest,
  type PluginRegistry,
} from '@tidewatch/protocol';

export interface PluginDetail {
  name: string;
  version: string;
  protocol: number;
  dir: string;
  sourceDir: string;
  platforms: string[];
  urlPatterns: string[];
  missingRuntimes: string[];
  shadowed: { version: string; dir: string; sourceDir: string }[];
  error: string | null;
}

export interface PluginManagerOptions {
  dataRoot: string;
  resourceRoot: string;
  pythonPath?: string;
  nodePath?: string;
}

function detectPython(resourceRoot: string): string {
  const explicit = process.env['TIDEWATCH_PYTHON'];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const bundled = join(resourceRoot, 'vendor', 'python', 'bin', 'python3');
  if (existsSync(bundled)) return bundled;
  return 'python3';
}

export class PluginManager {
  readonly #opts: PluginManagerOptions & { pythonPath: string; nodePath: string };
  readonly #plans = new Map<string, LaunchPlan>();
  readonly #details: PluginDetail[] = [];
  #registry: PluginRegistry;

  constructor(opts: PluginManagerOptions) {
    this.#opts = {
      ...opts,
      pythonPath: opts.pythonPath ?? detectPython(opts.resourceRoot),
      nodePath: opts.nodePath ?? process.execPath,
    };
    this.#registry = buildRegistry([], [], true);
  }

  get registry(): PluginRegistry {
    return this.#registry;
  }

  get pythonPath(): string {
    return this.#opts.pythonPath;
  }

  get nodePath(): string {
    return this.#opts.nodePath;
  }

  planFor(name: string): LaunchPlan | undefined {
    return this.#plans.get(name);
  }

  details(): PluginDetail[] {
    return [...this.#details];
  }

  async scan(): Promise<{ count: number; warnings: string[] }> {
    const roots = [join(this.#opts.dataRoot, 'plugins'), join(this.#opts.resourceRoot, 'plugins')];
    const entries: PluginEntry[] = [];
    const warnings: string[] = [];
    this.#plans.clear();
    this.#details.length = 0;

    for (const root of roots) {
      let dirs: string[];
      try {
        dirs = (await readdir(root, { withFileTypes: true }))
          .filter((d) => d.isDirectory())
          .map((d) => join(root, d.name))
          .sort();
      } catch {
        continue; // 目录不存在是正常状态
      }

      for (const dir of dirs) {
        const file = join(dir, 'plugin.json');
        let raw: unknown;
        try {
          raw = JSON.parse(await readFile(file, 'utf8'));
        } catch {
          warnings.push(`跳过 ${dir}：没有可读的 plugin.json`);
          continue;
        }
        const parsed = parseManifest(raw);
        if ('error' in parsed) {
          warnings.push(`跳过 ${dir}：${parsed.error}`);
          continue;
        }
        const manifest: PluginManifest = parsed.manifest;
        const plan = planLaunch(manifest, {
          pluginDir: dir,
          resourceRoot: this.#opts.resourceRoot,
          pythonPath: this.#opts.pythonPath,
          nodePath: this.#opts.nodePath,
        });
        const missingRuntimes: string[] = [];
        let error: string | null = null;
        if (plan.ok) {
          this.#plans.set(manifest.name, plan.plan);
        } else {
          error = plan.error;
          if (/Python/i.test(plan.error)) missingRuntimes.push('python');
          if (/Node/i.test(plan.error)) missingRuntimes.push('node');
        }

        entries.push({
          manifest,
          dir,
          sourceDir: root,
          shadowed: [],
          missingRuntimes,
        });
        this.#details.push({
          name: manifest.name,
          version: manifest.version,
          protocol: manifest.protocol,
          dir,
          sourceDir: root,
          platforms: manifest.platforms,
          urlPatterns: manifest.urlPatterns,
          missingRuntimes,
          shadowed: [],
          error,
        });
      }
    }

    this.#registry = buildRegistry(entries, warnings, true);
    // 遮蔽关系在注册表构建时才知道，回填给 UI
    for (const entry of this.#registry.list()) {
      const detail = this.#details.find((d) => d.name === entry.manifest.name && d.dir === entry.dir);
      if (detail !== undefined) detail.shadowed = entry.shadowed;
    }
    return { count: entries.length, warnings: [...warnings, ...this.#registry.warnings()] };
  }

  /** 请求下一轮重新解析前刷新注册表（放插件即生效） */
  async refresh(): Promise<{ count: number; warnings: string[] }> {
    return this.scan();
  }
}

export type { PluginEntry, PluginManifest, PluginRegistry };
