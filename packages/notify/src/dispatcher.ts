/**
 * 派生层：筛类别 → 去重 → 落库 → 扇出渠道。
 *
 * 两条纪律：
 * - 只有 warn/error 外发；info 只进铃铛（把正常进展弹出来会训练用户划掉弹窗）；
 * - 去重必须在这里：`plugin.auth_required` 每轮轮询都重发，原样落库一次断网能刷出上百条。
 */
import { DEDUPE_WINDOW_MS, dedupeKey, type Channel, type ChannelResult, type Notification } from './types.ts';

export interface DispatcherDeps {
  channels: readonly Channel[];
  /** 落库 + 广播（`notify.new`）；失败不能阻断外发 */
  record(n: Notification): void | Promise<void>;
  dedupeWindowMs?: number;
  now?: () => number;
  logger?: { warn(msg: string, meta?: unknown): void };
}

export interface DispatchResult {
  recorded: boolean;
  deduped: boolean;
  external: ChannelResult[];
}

export class NotificationDispatcher {
  readonly #d: DispatcherDeps;
  readonly #seen = new Map<string, number>();

  constructor(deps: DispatcherDeps) {
    this.#d = deps;
  }

  async dispatch(n: Notification): Promise<DispatchResult> {
    const now = (this.#d.now ?? Date.now)();
    let recorded = false;
    try {
      await this.#d.record(n);
      recorded = true;
    } catch (err) {
      this.#d.logger?.warn('通知落库失败', err);
    }

    if (n.level === 'info') {
      return { recorded, deduped: false, external: [] };
    }

    const key = dedupeKey(n);
    const last = this.#seen.get(key);
    const window = this.#d.dedupeWindowMs ?? DEDUPE_WINDOW_MS;
    if (last !== undefined && now - last < window) {
      return { recorded, deduped: true, external: [] };
    }
    this.#seen.set(key, now);

    // 顺手清理过期键，避免长跑内存无限增长
    for (const [k, ts] of this.#seen) if (now - ts > window) this.#seen.delete(k);

    const results = await Promise.all(
      this.#d.channels.map(async (channel): Promise<ChannelResult> => {
        try {
          const r = await channel.send(n);
          return r.ok ? { id: channel.id, ok: true } : { id: channel.id, ok: false, reason: r.reason ?? '未知原因' };
        } catch (err) {
          return { id: channel.id, ok: false, reason: err instanceof Error ? err.message : String(err) };
        }
      }),
    );

    for (const r of results) {
      if (!r.ok) this.#d.logger?.warn(`通知渠道 ${r.id} 投递失败：${r.reason ?? ''}`);
    }
    return { recorded, deduped: false, external: results };
  }
}
