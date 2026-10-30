/**
 * 插件注册表（纯逻辑，扫描交给 server）：两级目录的优先级、同名遮蔽、URL 命中。
 *
 * 单个坏插件只记 warning 并跳过 —— 一颗坏清单不能带崩整张注册表。
 */
import type { PluginManifest } from './manifest.ts';

export interface ShadowedPlugin {
  version: string;
  dir: string;
  sourceDir: string;
}

export interface PluginEntry {
  manifest: PluginManifest;
  /** 插件目录（绝对路径） */
  dir: string;
  /** 来自哪一档（数据根 / 资源根） */
  sourceDir: string;
  shadowed: ShadowedPlugin[];
  missingRuntimes: string[];
}

export class PluginRegistry {
  readonly #byName = new Map<string, PluginEntry>();
  readonly #warnings: string[];
  readonly #catalog: boolean;

  constructor(entries: readonly PluginEntry[], warnings: readonly string[], catalog = true) {
    this.#warnings = [...warnings];
    this.#catalog = catalog;
    for (const entry of entries) {
      const existing = this.#byName.get(entry.manifest.name);
      if (existing === undefined) {
        this.#byName.set(entry.manifest.name, { ...entry, shadowed: [...entry.shadowed] });
        continue;
      }
      // 高优先级层胜出，被遮蔽的那份两条都留：warning + 胜出者身上的 shadowed[]
      const shadow: ShadowedPlugin = {
        version: entry.manifest.version,
        dir: entry.dir,
        sourceDir: entry.sourceDir,
      };
      const winner = this.#byName.get(entry.manifest.name);
      if (winner !== undefined) winner.shadowed.push(shadow);
      this.#warnings.push(
        `插件 ${entry.manifest.name} 同名：${entry.dir} 被 ${existing.dir} 遮蔽（版本 ${entry.manifest.version} < ${existing.manifest.version}）`,
      );
    }
  }

  get catalog(): boolean {
    return this.#catalog;
  }

  list(): PluginEntry[] {
    return [...this.#byName.values()];
  }

  warnings(): string[] {
    return [...this.#warnings];
  }

  get(name: string): PluginEntry | undefined {
    return this.#byName.get(name);
  }

  /** 先按 platform（上次解析回填的已知事实），再退回 url_patterns 词法预过滤 */
  findFor(url: string, platform?: string | null): PluginEntry | undefined {
    if (platform !== undefined && platform !== null && platform.length > 0) {
      for (const entry of this.#byName.values()) {
        if (entry.manifest.platforms.includes(platform)) return entry;
      }
    }
    return this.matchUrl(url)[0]?.[0];
  }

  /** 命中列表（胜出者在前），便于 API/UI 提示"谁遮住了谁" */
  matchUrl(url: string): [PluginEntry, boolean][] {
    const lower = url.toLowerCase();
    const hits: [PluginEntry, boolean][] = [];
    for (const entry of this.#byName.values()) {
      const direct = entry.manifest.urlPatterns.find((p) => lower.includes(p.toLowerCase()));
      if (direct !== undefined) hits.push([entry, true]);
    }
    return hits;
  }
}

export function buildRegistry(
  entries: readonly PluginEntry[],
  warnings: readonly string[] = [],
  catalog = true,
): PluginRegistry {
  return new PluginRegistry(entries, warnings, catalog);
}
