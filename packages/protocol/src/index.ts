/**
 * stdio JSON 插件协议（协议 2，原样平移 tide-cap-master docs/04）。
 * 语言无关：JSON Lines，一问一答，短命无状态进程。
 *
 * ⚠️ 字段是**平铺**的（`url` / `platform` / `quality` 在顶层），不是塞进 `payload`。
 * 这是 streamget 插件的既有形状，包一层会让所有插件失效。
 */
export const PROTOCOL_VERSION = 2 as const;
export const SUPPORTED_PROTOCOLS = [1, 2] as const;

export type PluginAction = 'probe' | 'resolve' | 'fetch_vod_meta' | 'fetch_vod_streams';

export type PluginErrorCode =
  | 'AUTH_REQUIRED'
  | 'DEPENDENCY_MISSING'
  | 'RATE_LIMITED'
  | 'PLATFORM_CHANGED'
  | 'PLATFORM_UNSUPPORTED'
  | 'UNSUPPORTED_URL'
  | 'NETWORK'
  | 'INTERNAL';

export interface PluginRequest {
  id: string;
  action: PluginAction;
  protocol: number;
  [key: string]: unknown;
}

export interface PluginError {
  code: PluginErrorCode;
  message: string;
  retryable: boolean;
  retry_after_s?: number;
  detail?: Record<string, unknown>;
}

/** 成功响应：除 `id` / `ok` 外的字段就是数据本身（平铺） */
export type PluginResponse =
  | { id: string; ok: true; data: Record<string, unknown> }
  | { id: string; ok: false; error: PluginError };

export function encodeRequest(req: PluginRequest): string {
  return `${JSON.stringify(req)}\n`;
}

/**
 * 增量切行：插件可能一次吐多行，也可能把一行劈成两个 chunk。
 * 纯函数，不带 IO —— 才能离线回归。
 */
export class LineSplitter {
  #buf = '';

  push(chunk: string): string[] {
    this.#buf += chunk;
    const out: string[] = [];
    let idx: number;
    while ((idx = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, idx).replace(/\r$/, '');
      this.#buf = this.#buf.slice(idx + 1);
      if (line.length > 0) out.push(line);
    }
    return out;
  }

  /** 进程退出时把残留的最后一行吐出来 */
  flush(): string[] {
    const rest = this.#buf.trim();
    this.#buf = '';
    return rest.length > 0 ? [rest] : [];
  }
}

/**
 * 宽容解析：协议 1/2 的插件都回平铺字段；历史上也有把数据放 `data` 的写法。
 * 两种都收，避免"插件回得对、宿主读不到"。
 */
export function decodeResponse(line: string): PluginResponse {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('插件响应不是对象');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['id'] !== 'string') throw new Error('插件响应缺少 id');
  if (obj['ok'] === false) {
    const error = obj['error'];
    if (typeof error !== 'object' || error === null) throw new Error('错误响应缺少 error 对象');
    return { id: obj['id'], ok: false, error: error as PluginError };
  }
  if (obj['ok'] !== true) throw new Error('插件响应缺少 ok');
  const nested = obj['data'];
  if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
    return { id: obj['id'], ok: true, data: nested as Record<string, unknown> };
  }
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'id' || k === 'ok') continue;
    data[k] = v;
  }
  return { id: obj['id'], ok: true, data };
}

export * from './manifest.ts';
export * from './registry.ts';
export * from './host.ts';
