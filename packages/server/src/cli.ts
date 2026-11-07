#!/usr/bin/env node
/**
 * CLI：`serve` 是唯一常驻形态；其余子命令都是控制面客户端。
 * 退出只有一条管道：HTTP `/api/shutdown` 与 SIGTERM/SIGINT 调同一个 shutdown()。
 */
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { createHostAdapter } from '@tidewatch/host-adapter';
import { buildApp } from './app.ts';
import { loadOrCreateToken, SESSION_COOKIE } from './auth.ts';
import { TidewatchService } from './service.ts';

const VERSION = '0.0.0';
const here = import.meta.dirname;
/** `src/`（tsx 开发）与 `dist/`（构建产物）向上一层都是仓库根 */
const repoRoot = resolve(here, '../../..');

/**
 * 数据根默认值：**不跟 cwd 走**。
 *
 * `pnpm --filter @tidewatch/server dev|start` 会把 cwd 切到 `packages/server`，
 * 于是同一个仓库从不同入口启动会各自生成一套 `data/`（token、sqlite、downloads
 * 全不一样）—— 表现是"页面能开但 401 / 任务列表是空的"，而且很难联想到数据根。
 * 只要能认出这是仓库（根 package.json 的名字），就固定用仓库根的 `data/`；
 * 不像仓库的形态（全局安装、单目录分发）才退回 cwd。
 */
function defaultDataRoot(): string {
  const env = process.env['TIDEWATCH_DATA_ROOT'];
  if (env !== undefined && env.trim().length > 0) return resolve(env);
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { name?: string };
    if (pkg.name === 'tidewatch-daemon') return join(repoRoot, 'data');
  } catch {
    /* 没有仓库根的 package.json：按 cwd 兜底 */
  }
  return resolve(process.cwd(), 'data');
}

/** 本机 daemon 用的数据根（null = 没连上），用于判断"新 token 是否与运行中的进程对得上" */
async function runningDataRoot(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = (await res.json()) as { paths?: { dataRoot?: string } };
    return body.paths?.dataRoot ?? '';
  } catch {
    return null;
  }
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

async function login(base: string, dataRoot: string): Promise<string> {
  const { token } = loadOrCreateToken(dataRoot);
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error(`登录失败（HTTP ${String(res.status)}）`);
  const setCookie = res.headers.getSetCookie();
  const raw = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? setCookie[0] ?? '';
  const pair = raw.split(';')[0] ?? '';
  if (pair.length === 0) throw new Error('登录未返回会话 cookie');
  return pair;
}

async function api(base: string, dataRoot: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const cookie = await login(base, dataRoot);
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      cookie,
      'x-tidewatch-client': '1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 保留原文 */
  }
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}: ${text}`);
  return parsed;
}

const program = new Command();
program.name('tidewatch').description('TideWatch daemon — 多平台直播录制服务').version(VERSION);

program
  .command('serve', { isDefault: true })
  .description('以常驻服务方式启动（唯一形态）')
  .option('-p, --port <port>', '监听端口', '8686')
  .option('-H, --host <host>', '监听地址', '0.0.0.0')
  .option('-d, --data-root <path>', '数据根目录')
  .action(async (opts: { port: string; host: string; dataRoot?: string }) => {
    const dataRoot = opts.dataRoot === undefined ? defaultDataRoot() : resolve(opts.dataRoot);
    const port = Number(opts.port);
    const closing = { done: false };

    const host = createHostAdapter({
      dataRoot,
      resourceRoot: resolve(here, '../../..'),
      defaultDownloads: join(dataRoot, 'downloads'),
      cliPath: resolve(here, 'cli.js'),
      port,
    });

    const service = new TidewatchService({
      dataRoot,
      resourceRoot: resolve(here, '../../..'),
      host,
      version: VERSION,
      port,
      logger: {
        info: (msg, meta) => console.log(`[tidewatch] ${msg}`, meta ?? ''),
        warn: (msg, meta) => console.warn(`[tidewatch] ${msg}`, meta ?? ''),
      },
    });

    async function shutdown(reason: string): Promise<void> {
      if (closing.done) return;
      closing.done = true;
      console.log(`\n[tidewatch] 开始优雅收尾（${reason}）`);
      try {
        // onClose → service.stop：等 runner → 超时硬杀 → 恢复扫描兜底
        await app.close();
        process.exit(0);
      } catch (err) {
        console.error('收尾失败，强制退出：', err);
        process.exit(1);
      }
    }

    const app = await buildApp({
      dataRoot,
      version: VERSION,
      host,
      service,
      requestShutdown: (r) => void shutdown(r),
    });

    if (!service.status.leaseAcquired) {
      console.error(`引擎租约被占用：${service.status.leaseNote ?? ''}`);
      await app.close();
      process.exit(2);
    }

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));

    await app.listen({ port, host: opts.host });

    const { token } = loadOrCreateToken(dataRoot);
    console.log(
      [
        '',
        `  TideWatch daemon 已启动  (pid ${String(process.pid)})`,
        `  数据根     ${dataRoot}`,
        `  本机访问   http://127.0.0.1:${String(port)}`,
        ...lanAddresses().map((ip) => `  局域网访问 http://${ip}:${String(port)}`),
        `  访问 token ${token}`,
        '',
      ].join('\n'),
    );
  });

program
  .command('status')
  .description('查询正在运行的 daemon 状态')
  .option('-p, --port <port>', '端口', '8686')
  .action(async (opts: { port: string }) => {
    try {
      const res = await fetch(`http://127.0.0.1:${String(opts.port)}/api/health`);
      const body: unknown = await res.json();
      console.log(res.ok ? JSON.stringify(body, null, 2) : `HTTP ${String(res.status)}`);
      process.exit(res.ok ? 0 : 1);
    } catch {
      console.error(`未连上 daemon（127.0.0.1:${String(opts.port)}）`);
      process.exit(1);
    }
  });

program
  .command('stop')
  .description('优雅停止正在运行的 daemon')
  .option('-p, --port <port>', '端口', '8686')
  .option('-d, --data-root <path>', '数据根目录')
  .action(async (opts: { port: string; dataRoot?: string }) => {
    const dataRoot = opts.dataRoot === undefined ? defaultDataRoot() : resolve(opts.dataRoot);
    await api(`http://127.0.0.1:${String(opts.port)}`, dataRoot, 'POST', '/api/shutdown');
    console.log('已请求优雅停止');
  });

program
  .command('token')
  .description('显示访问 token（本机操作）')
  .option('-d, --data-root <path>', '数据根目录')
  .option('-p, --port <port>', '探测本机 daemon 的端口（仅用于提示）', '8686')
  .action(async (opts: { dataRoot?: string; port: string }) => {
    const dataRoot = opts.dataRoot === undefined ? defaultDataRoot() : resolve(opts.dataRoot);
    const { token, created } = loadOrCreateToken(dataRoot);
    if (created) console.log(`已生成新 token（写入 ${join(dataRoot, 'auth-token.txt')}）：`);
    else console.log(`当前 token（${join(dataRoot, 'auth-token.txt')}）：`);
    console.log(token);
    // 文件是刚建的，说明之前被删了；此时若同一个数据根上的 daemon 还在跑，
    // 它手里仍是旧 token，粘这个新的一律 401 —— 必须重启才生效，提前讲清楚省一轮排查。
    if (created) {
      const running = await runningDataRoot(Number(opts.port));
      if (running !== null && resolve(running) === resolve(dataRoot)) {
        console.warn(
          `注意：${String(opts.port)} 端口上的 daemon 仍在用旧 token，重启后这个新 token 才会生效。`,
        );
      }
    }
  });

program
  .command('add <url>')
  .description('添加任务（默认开启监控）')
  .option('-p, --port <port>', '端口', '8686')
  .option('-d, --data-root <path>', '数据根目录')
  .option('--no-monitor', '只添加不监控')
  .action(async (url: string, opts: { port: string; dataRoot?: string; monitor: boolean }) => {
    const dataRoot = opts.dataRoot === undefined ? defaultDataRoot() : resolve(opts.dataRoot);
    const result = await api(`http://127.0.0.1:${String(opts.port)}`, dataRoot, 'POST', '/api/tasks', {
      url,
      monitor: opts.monitor,
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('record <taskId>')
  .description('手动录这一场；--stop 停止当前场')
  .option('-p, --port <port>', '端口', '8686')
  .option('-d, --data-root <path>', '数据根目录')
  .option('--stop', '停止当前场')
  .action(async (taskId: string, opts: { port: string; dataRoot?: string; stop?: boolean }) => {
    const dataRoot = opts.dataRoot === undefined ? defaultDataRoot() : resolve(opts.dataRoot);
    const result = await api(`http://127.0.0.1:${String(opts.port)}`, dataRoot, 'POST', `/api/tasks/${taskId}/record`, {
      recording: opts.stop !== true,
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('diagnose')
  .description('导出诊断包到数据根 exports/')
  .option('-p, --port <port>', '端口', '8686')
  .option('-d, --data-root <path>', '数据根目录')
  .action(async (opts: { port: string; dataRoot?: string }) => {
    const dataRoot = opts.dataRoot === undefined ? defaultDataRoot() : resolve(opts.dataRoot);
    const result = await api(
      `http://127.0.0.1:${String(opts.port)}`,
      dataRoot,
      'POST',
      '/api/diagnostics/export',
    );
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('retention')
  .description('归档并删除过期事件（过程事件 7 天 / 结果事件 90 天）')
  .option('-p, --port <port>', '端口', '8686')
  .option('-d, --data-root <path>', '数据根目录')
  .option('--info', '只看现状（条数 / 库大小 / 归档文件），不执行')
  .action(async (opts: { port: string; dataRoot?: string; info?: boolean }) => {
    const dataRoot = opts.dataRoot === undefined ? defaultDataRoot() : resolve(opts.dataRoot);
    const base = `http://127.0.0.1:${String(opts.port)}`;
    const result = await api(base, dataRoot, opts.info === true ? 'GET' : 'POST', opts.info === true ? '/api/retention' : '/api/retention/run');
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('compact')
  .description('回收已删除事件留下的空页（VACUUM；**必须先 stop**，否则会等锁）')
  .option('-d, --data-root <path>', '数据根目录')
  .action(async (opts: { dataRoot?: string }) => {
    const dataRoot = opts.dataRoot === undefined ? defaultDataRoot() : resolve(opts.dataRoot);
    const { Store } = await import('@tidewatch/store');
    const store = Store.open(join(dataRoot, 'tidewatch.db'));
    const before = store.dbSizeBytes();
    const free = store.freePages();
    try {
      store.compact();
      const after = store.dbSizeBytes();
      console.log(`已回收：${(before / 1024 / 1024).toFixed(1)} MB → ${(after / 1024 / 1024).toFixed(1)} MB（空闲页 ${String(free)}）`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`压缩失败：${msg}`);
      if (/busy|locked/i.test(msg)) console.error('daemon 还在运行：先 tidewatch stop，再跑一次 compact。');
      process.exitCode = 1;
    } finally {
      store.close();
    }
  });

program
  .command('merge <sessionIds...>')
  .description('把几场录制按时间顺序合并成一个视频（跨会话拼接）')
  .option('-p, --port <port>', '端口', '8686')
  .option('-d, --data-root <path>', '数据根目录')
  .option('--sessions <ids>', '逗号分隔的会话 id（与位置参数等价）')
  .option('--wait', '等到合并结束再退出')
  .action(async (sessionIds: string[], opts: { port: string; dataRoot?: string; sessions?: string; wait?: boolean }) => {
    const dataRoot = opts.dataRoot === undefined ? defaultDataRoot() : resolve(opts.dataRoot);
    const base = `http://127.0.0.1:${String(opts.port)}`;
    const ids = [...sessionIds, ...(opts.sessions ?? '').split(',')].map((s) => s.trim()).filter((s) => s.length > 0);
    if (ids.length < 2) {
      console.error('至少给两个会话 id：tidewatch merge <id1> <id2> [id3...]');
      process.exit(1);
    }
    const created = (await api(base, dataRoot, 'POST', '/api/merges', { sessionIds: ids })) as {
      job?: { id: string };
    };
    const jobId = created.job?.id;
    if (jobId === undefined) {
      console.error('服务端没有返回合并任务 id');
      process.exit(1);
    }
    console.log(`已受理：${jobId}（界面上看：录制 → 合并记录）`);
    if (opts.wait !== true) return;

    // 轮询而不是订阅事件流：CLI 是一次性进程，SSE 在这里只会多一层重连逻辑
    for (;;) {
      const detail = (await api(base, dataRoot, 'GET', `/api/merges/${jobId}`)) as {
        merge?: { status: string; progress: number; outputs: { path: string; durationS: number }[]; message: string | null };
      };
      const job = detail.merge;
      if (job === undefined) break;
      process.stdout.write(`\r${job.status} ${String(Math.round(job.progress * 100))}%`);
      if (job.status !== 'queued' && job.status !== 'running') {
        process.stdout.write('\n');
        for (const o of job.outputs) console.log(`产物：${o.path}（${(o.durationS / 60).toFixed(1)} 分钟）`);
        if (job.message !== null) console.log(`说明：${job.message}`);
        process.exit(job.status === 'completed' ? 0 : 1);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  });

program
  .command('service <action>')
  .description('安装/卸载开机自启（install | uninstall | status）')
  .option('-d, --data-root <path>', '数据根目录')
  .option('-p, --port <port>', '端口', '8686')
  .action(async (action: string, opts: { dataRoot?: string; port: string }) => {
    const dataRoot = opts.dataRoot === undefined ? defaultDataRoot() : resolve(opts.dataRoot);
    const host = createHostAdapter({
      dataRoot,
      resourceRoot: resolve(here, '../../..'),
      defaultDownloads: join(dataRoot, 'downloads'),
      cliPath: resolve(here, 'cli.js'),
      port: Number(opts.port),
    });
    if (action === 'install') {
      await host.service.install();
      console.log('已安装开机自启');
    } else if (action === 'uninstall') {
      await host.service.uninstall();
      console.log('已卸载开机自启');
    } else if (action === 'status') {
      console.log((await host.service.isInstalled()) ? '已安装' : '未安装');
    } else {
      console.error('未知动作：install | uninstall | status');
      process.exit(1);
    }
  });

await program.parseAsync(process.argv);
