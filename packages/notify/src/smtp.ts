/**
 * 极简 SMTP 客户端（只为发通知）：EHLO → STARTTLS（可用则升）→ AUTH LOGIN → DATA。
 * 不引 nodemailer：这里只需要 20 行协议，依赖越少越不容易在 NAS 上装不起来。
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { Channel } from './types.ts';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  to: string;
}

interface SmtpSession {
  socket: Socket | TLSSocket;
  buffer: string;
  waiters: ((line: string) => void)[];
  lines: string[];
}

function attach(session: SmtpSession): void {
  session.socket.setEncoding('utf8');
  session.socket.on('data', (chunk: string) => {
    session.buffer += chunk;
    let idx = session.buffer.indexOf('\r\n');
    while (idx >= 0) {
      const line = session.buffer.slice(0, idx);
      session.buffer = session.buffer.slice(idx + 2);
      const waiter = session.waiters.shift();
      if (waiter !== undefined) waiter(line);
      else session.lines.push(line);
      idx = session.buffer.indexOf('\r\n');
    }
  });
}

function readLine(session: SmtpSession, timeoutMs = 15_000): Promise<string> {
  const buffered = session.lines.shift();
  if (buffered !== undefined) return Promise.resolve(buffered);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SMTP 读超时')), timeoutMs);
    session.waiters.push((line) => {
      clearTimeout(timer);
      resolve(line);
    });
  });
}

/** 一条命令可能收到多行（`250-...` 续行），直到 `250 ` 才算结束 */
async function command(session: SmtpSession, line: string, expect: number): Promise<string[]> {
  session.socket.write(`${line}\r\n`);
  const out: string[] = [];
  for (;;) {
    const reply = await readLine(session);
    out.push(reply);
    const code = Number(reply.slice(0, 3));
    if (reply.length > 3 && reply[3] === '-') continue;
    if (code !== expect) throw new Error(`SMTP ${line.split(' ')[0] ?? ''} 失败：${reply}`);
    return out;
  }
}

function dotStuff(body: string): string {
  return body
    .replace(/\r?\n/g, '\r\n')
    .split('\r\n')
    .map((l) => (l.startsWith('.') ? `.${l}` : l))
    .join('\r\n');
}

async function sendMail(cfg: SmtpConfig, subject: string, text: string): Promise<void> {
  const base = cfg.secure
    ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host })
    : netConnect({ host: cfg.host, port: cfg.port });
  const session: SmtpSession = { socket: base, buffer: '', waiters: [], lines: [] };
  attach(session);
  await new Promise<void>((resolve, reject) => {
    base.once('connect', () => resolve());
    base.once('error', reject);
  });

  try {
    const greeting = await readLine(session);
    if (!greeting.startsWith('220')) throw new Error(`SMTP 拒绝连接：${greeting}`);

    let ehlo = await command(session, 'EHLO tidewatch', 250);
    if (!cfg.secure && ehlo.some((l) => /STARTTLS/i.test(l))) {
      await command(session, 'STARTTLS', 220);
      const upgraded = tlsConnect({ socket: base, servername: cfg.host });
      session.socket = upgraded;
      session.buffer = '';
      session.waiters = [];
      session.lines = [];
      attach(session);
      await new Promise<void>((resolve, reject) => {
        upgraded.once('secureConnect', () => resolve());
        upgraded.once('error', reject);
      });
      ehlo = await command(session, 'EHLO tidewatch', 250);
    }

    if (cfg.user !== undefined && cfg.user.length > 0 && ehlo.some((l) => /AUTH/i.test(l))) {
      await command(session, 'AUTH LOGIN', 334);
      await command(session, Buffer.from(cfg.user).toString('base64'), 334);
      await command(session, Buffer.from(cfg.pass ?? '').toString('base64'), 235);
    }

    await command(session, `MAIL FROM:<${cfg.from}>`, 250);
    await command(session, `RCPT TO:<${cfg.to}>`, 250);
    await command(session, 'DATA', 354);

    const message = [
      `From: ${cfg.from}`,
      `To: ${cfg.to}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      dotStuff(text),
      '.',
      '',
    ].join('\r\n');
    await command(session, message.replace(/\r\n$/, ''), 250);
    await command(session, 'QUIT', 221).catch(() => undefined);
  } finally {
    session.socket.end();
  }
}

export function smtpChannel(cfg: SmtpConfig): Channel {
  return {
    id: 'smtp',
    async send(n) {
      try {
        await sendMail(cfg, `[TideWatch] ${n.title}`, n.body);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
