/**
 * HTTP 推送渠道：ntfy / Bark / Telegram。
 * 渠道自身失败只记账，不影响其它渠道与录制（一条通知扇出多渠道）。
 */
import type { Channel, Notification } from './types.ts';

const TIMEOUT_MS = 10_000;

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

const priority = (n: Notification): string => (n.level === 'error' ? '5' : n.level === 'warn' ? '4' : '3');

export function ntfyChannel(cfg: { server?: string; topic: string; token?: string }): Channel {
  const server = (cfg.server ?? 'https://ntfy.sh').replace(/\/+$/, '');
  return {
    id: 'ntfy',
    async send(n) {
      try {
        const headers: Record<string, string> = {
          Title: encodeURIComponent(n.title),
          Priority: priority(n),
          Tags: 'tidewatch',
        };
        if (cfg.token !== undefined && cfg.token.length > 0) headers['Authorization'] = `Bearer ${cfg.token}`;
        const res = await fetch(`${server}/${encodeURIComponent(cfg.topic)}`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' },
          body: `[TideWatch] ${n.title}\n${n.body}`,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        return res.ok ? { ok: true } : { ok: false, reason: `HTTP ${res.status}` };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export function barkChannel(cfg: { server?: string; key: string; level?: string }): Channel {
  const server = (cfg.server ?? 'https://api.day.app').replace(/\/+$/, '');
  return {
    id: 'bark',
    async send(n) {
      try {
        const res = await postJson(`${server}/push`, {
          device_key: cfg.key,
          title: n.title,
          body: n.body,
          level: cfg.level ?? (n.level === 'error' ? 'timeSensitive' : 'active'),
          group: 'TideWatch',
        });
        return res.ok ? { ok: true } : { ok: false, reason: `HTTP ${res.status}` };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export function telegramChannel(cfg: { botToken: string; chatId: string }): Channel {
  return {
    id: 'telegram',
    async send(n) {
      try {
        const res = await postJson(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
          chat_id: cfg.chatId,
          text: `[TideWatch] ${n.title}\n${n.body}`,
          disable_web_page_preview: true,
        });
        return res.ok ? { ok: true } : { ok: false, reason: `HTTP ${res.status}` };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
