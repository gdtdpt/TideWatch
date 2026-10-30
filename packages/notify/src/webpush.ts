/**
 * Web Push（RFC 8291 aes128gcm + VAPID）。
 *
 * 只在 secure context（HTTPS / Tailscale Serve / 反代）下可用；
 * 默认 `http://<LAN-IP>` 收不到推送，文档里写清，靠外发渠道兜底。
 */
import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import type { Channel } from './types.ts';

export interface WebPushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface WebPushConfig {
  subject: string;
  /** base64url 未压缩点（65 字节）或 PEM 公钥 */
  publicKey: string;
  /** base64url 裸私钥（32 字节）或 PEM */
  privateKey: string;
  subscriptions: readonly WebPushSubscription[];
}

const b64url = (buf: Buffer): string => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function b64urlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, 'base64');
}

function privateKeyObject(cfg: WebPushConfig): KeyObject {
  if (cfg.privateKey.includes('BEGIN')) return createPrivateKey(cfg.privateKey);
  const d = b64urlDecode(cfg.privateKey);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey();
  return createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: b64url(d),
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
    },
  });
}

function hkdf(ikm: Buffer, salt: Buffer, info: string | Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, typeof info === 'string' ? Buffer.from(info, 'utf8') : info, length));
}

function encryptPayload(
  plaintext: Buffer,
  p256dh: Buffer,
  auth: Buffer,
): { body: Buffer } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(p256dh);

  const prk = hkdf(shared, auth, Buffer.concat([Buffer.from('WebPush: info\x00'), p256dh, asPublic]), 32);
  const salt = randomBytes(16);
  const cek = hkdf(prk, salt, 'Content-Encoding: aes128gcm\x00', 16);
  const nonce = hkdf(prk, salt, 'Content-Encoding: nonce\x00', 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final()]);
  const tag = cipher.getAuthTag();

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);
  const header = Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic]);
  return { body: Buffer.concat([header, encrypted, tag]) };
}

function vapidJwt(endpoint: string, cfg: WebPushConfig, key: KeyObject): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' }), 'utf8'));
  const payload = b64url(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: cfg.subject,
      }),
      'utf8',
    ),
  );
  const signingInput = `${header}.${payload}`;
  const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${b64url(signature)}`;
}

async function pushOne(cfg: WebPushConfig, sub: WebPushSubscription, payload: unknown): Promise<Response> {
  const key = privateKeyObject(cfg);
  const jwt = vapidJwt(sub.endpoint, cfg, key);
  const { body } = encryptPayload(
    Buffer.from(JSON.stringify(payload), 'utf8'),
    b64urlDecode(sub.p256dh),
    b64urlDecode(sub.auth),
  );
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt}, k=${cfg.publicKey}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'normal',
    },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(10_000),
  });
}

export function webPushChannel(cfg: WebPushConfig): Channel {
  return {
    id: 'webpush',
    async send(n) {
      const failures: string[] = [];
      let okCount = 0;
      for (const sub of cfg.subscriptions) {
        try {
          const res = await pushOne(cfg, sub, { title: n.title, body: n.body, kind: n.kind, level: n.level });
          if (res.ok) okCount += 1;
          else failures.push(`HTTP ${res.status}`);
        } catch (err) {
          failures.push(err instanceof Error ? err.message : String(err));
        }
      }
      if (okCount > 0) return { ok: true };
      return { ok: false, reason: failures.join('; ') || '没有订阅' };
    },
  };
}

/** 生成 VAPID 密钥对（base64url：public = 65 字节点，private = 32 字节标量） */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: b64url(ecdh.getPublicKey()),
    privateKey: b64url(ecdh.getPrivateKey()),
  };
}
