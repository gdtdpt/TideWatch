/**
 * 通知渠道装配：配置（settings.notify）→ 可用渠道列表。
 *
 * 配置是用户可编辑的 JSON，解析必须宽容：一条坏配置只让该渠道缺席，
 * 不能让整个通知层起不来。
 */
import { barkChannel, ntfyChannel, telegramChannel } from './channels.ts';
import { smtpChannel } from './smtp.ts';
import type { Channel } from './types.ts';
import { webPushChannel, type WebPushSubscription } from './webpush.ts';

export * from './types.ts';
export * from './dispatcher.ts';
export * from './channels.ts';
export * from './smtp.ts';
export * from './webpush.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const s = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const n = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const b = (v: unknown): boolean => v === true;

export function channelsFromConfig(raw: Record<string, unknown>): Channel[] {
  const channels: Channel[] = [];

  const ntfy = raw['ntfy'];
  if (isObj(ntfy) && b(ntfy['enabled']) && s(ntfy['topic']).length > 0) {
    channels.push(ntfyChannel({ server: s(ntfy['server'], 'https://ntfy.sh'), topic: s(ntfy['topic']), token: s(ntfy['token']) }));
  }

  const bark = raw['bark'];
  if (isObj(bark) && b(bark['enabled']) && s(bark['key']).length > 0) {
    channels.push(barkChannel({ server: s(bark['server'], 'https://api.day.app'), key: s(bark['key']) }));
  }

  const telegram = raw['telegram'];
  if (isObj(telegram) && b(telegram['enabled']) && s(telegram['botToken']).length > 0) {
    channels.push(telegramChannel({ botToken: s(telegram['botToken']), chatId: s(telegram['chatId']) }));
  }

  const smtp = raw['smtp'];
  if (isObj(smtp) && b(smtp['enabled']) && s(smtp['host']).length > 0 && s(smtp['to']).length > 0) {
    channels.push(
      smtpChannel({
        host: s(smtp['host']),
        port: n(smtp['port'], 587),
        secure: b(smtp['secure']),
        user: s(smtp['user']),
        pass: s(smtp['pass']),
        from: s(smtp['from'], s(smtp['user'])),
        to: s(smtp['to']),
      }),
    );
  }

  const webpush = raw['webpush'];
  if (isObj(webpush) && b(webpush['enabled']) && s(webpush['publicKey']).length > 0) {
    const subs: WebPushSubscription[] = Array.isArray(webpush['subscriptions'])
      ? webpush['subscriptions'].filter(isObj).map((sub) => ({
          endpoint: s(sub['endpoint']),
          p256dh: s(sub['p256dh']),
          auth: s(sub['auth']),
        })).filter((sub) => sub.endpoint.length > 0 && sub.p256dh.length > 0 && sub.auth.length > 0)
      : [];
    if (subs.length > 0) {
      channels.push(
        webPushChannel({
          subject: s(webpush['subject'], 'mailto:admin@localhost'),
          publicKey: s(webpush['publicKey']),
          privateKey: s(webpush['privateKey']),
          subscriptions: subs,
        }),
      );
    }
  }

  return channels;
}
