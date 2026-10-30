/**
 * 解析器：任务 → 插件（或直链兜底）→ 统一 ResolveResult。
 *
 * 核心不认识任何平台；`http_headers` / `cookies_out` 都按协议 2 原样消费。
 */
import { randomUUID } from 'node:crypto';
import type { ResolveFailure, ResolveOutcome, ResolveResult, ResolverPort } from '@tidewatch/core';
import type { Store, Task } from '@tidewatch/store';
import type { CredentialStore } from '@tidewatch/host-adapter';
import type { PluginErrorCode, PluginHost } from '@tidewatch/protocol';
import type { PluginManager } from './plugins.ts';

const ERROR_CODES: readonly PluginErrorCode[] = [
  'AUTH_REQUIRED',
  'DEPENDENCY_MISSING',
  'RATE_LIMITED',
  'PLATFORM_CHANGED',
  'PLATFORM_UNSUPPORTED',
  'UNSUPPORTED_URL',
  'NETWORK',
  'INTERNAL',
];

const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const asBool = (v: unknown): boolean => v === true;
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const asHeaders = (v: unknown): Record<string, string> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  return out;
};

/** 直链兜底：没有插件也能用（`.m3u8` / `.flv` 本身就是流地址） */
export function directUrl(url: string): string | null {
  return /\.(m3u8|flv|ts)(\?|$)/i.test(url) ? url : null;
}

export interface ProbeOutcome {
  ok: boolean;
  platform?: string;
  platformName?: string;
  message?: string;
}

export interface PluginResolverOptions {
  manager: PluginManager;
  host: PluginHost;
  credentials: CredentialStore;
  store?: Store;
  logger?: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
}

export class PluginResolver implements ResolverPort {
  readonly #o: PluginResolverOptions;

  constructor(opts: PluginResolverOptions) {
    this.#o = opts;
  }

  async probeUrl(url: string): Promise<ProbeOutcome> {
    if (directUrl(url) !== null) return { ok: true, platform: 'direct', platformName: '直链' };
    const entry = this.#o.manager.registry.findFor(url);
    if (entry === undefined) {
      return { ok: false, message: '没有可用的平台插件（已支持：抖音、B站；也可直接填 .m3u8/.flv 直链）' };
    }
    const plan = this.#o.manager.planFor(entry.manifest.name);
    if (plan === undefined) {
      return { ok: false, message: `插件 ${entry.manifest.name} 无法启动（缺少运行时或路径越界）` };
    }
    const res = await this.#o.host.call(entry, plan, {
      id: randomUUID(),
      action: 'probe',
      protocol: entry.manifest.protocol,
      url,
    });
    if (!res.ok) return { ok: false, message: res.error?.message ?? '插件探测失败' };
    const platform = asString(res.data?.['platform']);
    if (platform === null) return { ok: false, message: '该地址不属于已支持的平台' };
    return {
      ok: true,
      platform,
      platformName: asString(res.data?.['platform_name']) ?? platform,
    };
  }

  async resolve(task: Task): Promise<ResolveOutcome> {
    const direct = directUrl(task.url);
    if (direct !== null) {
      return {
        ok: true,
        data: {
          isLive: true,
          recordUrl: direct,
          platform: 'direct',
          anchorName: '直链',
          title: task.title,
          isOverseas: false,
          headers: {},
          qualityOptions: [],
          cookiesOut: null,
        },
      };
    }

    const entry = this.#o.manager.registry.findFor(task.url, task.platform);
    if (entry === undefined) {
      return {
        ok: false,
        error: {
          code: 'PLATFORM_UNSUPPORTED',
          message: '没有可用的平台插件',
          retryable: true,
        },
      };
    }
    const plan = this.#o.manager.planFor(entry.manifest.name);
    if (plan === undefined) {
      return {
        ok: false,
        error: {
          code: 'DEPENDENCY_MISSING',
          message: `插件 ${entry.manifest.name} 无法启动（缺少运行时或路径越界）`,
          retryable: false,
        },
      };
    }

    const cookies =
      task.platform.length > 0 ? await this.#o.credentials.get(`cookie:${task.platform}`) : undefined;
    const proxy = typeof task.override['proxy'] === 'string' ? task.override['proxy'] : undefined;

    const res = await this.#o.host.call(entry, plan, {
      id: randomUUID(),
      action: 'resolve',
      protocol: entry.manifest.protocol,
      url: task.url,
      platform: task.platform.length > 0 ? task.platform : entry.manifest.platforms[0],
      quality: task.quality,
      cookies: cookies ?? null,
      proxy: proxy ?? null,
      timeout_s: 25,
    });

    if (!res.ok) return { ok: false, error: this.#toFailure(res.error) };
    const d = res.data ?? {};
    const cookiesOut = asString(d['cookies_out']);
    if (cookiesOut !== null && task.platform.length > 0) {
      await this.#o.credentials.set(`cookie:${task.platform}`, cookiesOut);
      this.#o.store?.insertEvent({
        kind: 'plugin.cookies_updated',
        payload: { platform: task.platform },
        taskId: task.id,
        sessionId: null,
      });
    }

    const flv = asString(d['flv_url']);
    const m3u8 = asString(d['m3u8_url']);
    const record = asString(d['record_url']) ?? flv ?? m3u8;
    return {
      ok: true,
      data: {
        isLive: asBool(d['is_live']),
        recordUrl: record,
        platform: asString(d['platform']) ?? entry.manifest.platforms[0] ?? entry.manifest.name,
        anchorName: asString(d['anchor_name']),
        title: asString(d['title']),
        isOverseas: asBool(d['is_overseas']),
        headers: asHeaders(d['http_headers']),
        qualityOptions: asStringArray(d['quality_options']),
        cookiesOut,
      },
    };
  }

  #toFailure(error: { code?: string; message?: string; retryable?: boolean; retry_after_s?: number } | undefined): ResolveFailure {
    const code = ERROR_CODES.find((c) => c === error?.code) ?? 'INTERNAL';
    return {
      code,
      message: error?.message ?? '插件返回了未知错误',
      retryable: error?.retryable ?? true,
      ...(typeof error?.retry_after_s === 'number' ? { retryAfterS: error.retry_after_s } : {}),
    };
  }
}

export type { ResolveResult };
