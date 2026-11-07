/**
 * M3 端到端：真实拉起一个（Node 写的）插件，走完 probe → resolve → cookies 写回。
 *
 * 用 Node 而不是 Python 做桩，是因为这条测试要验的是**宿主侧接线**
 * （发现 → 启动计划 → stdio 协议 → 字段映射 → 凭据写回），
 * 与插件用什么语言实现无关；Python 一侧由插件自带的离线用例覆盖。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChildProcessSupervisor, type CredentialStore } from '@tidewatch/host-adapter';
import { PluginHost } from '@tidewatch/protocol';
import { Store } from '@tidewatch/store';
import { PluginManager } from './plugins.ts';
import { PluginResolver } from './resolver.ts';

process.env['LOG_LEVEL'] = 'silent';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PLUGIN_MAIN = `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const req = JSON.parse(line);
  const reply = (obj) => process.stdout.write(JSON.stringify({ id: req.id, ...obj }) + '\\n');
  if (req.action === 'probe') {
    if (String(req.url).includes('example.com')) reply({ ok: true, platform: 'fake', platform_name: '假平台' });
    else reply({ id: req.id, ok: false, error: { code: 'UNSUPPORTED_URL', message: '不认识的地址', retryable: false } });
    return;
  }
  if (req.action === 'resolve') {
    if (req.cookies === 'stale') {
      reply({ ok: false, error: { code: 'AUTH_REQUIRED', message: '需要登录', retryable: false } });
      return;
    }
    reply({
      ok: true,
      is_live: true,
      record_url: 'https://cdn.example.com/live.flv',
      platform: 'fake',
      anchor_name: '假主播',
      title: '假直播',
      http_headers: { Referer: 'https://example.com/' },
      quality_options: ['origin', '720p'],
      // 只有这个地址回"实际画质"：另一个地址用来验"插件不回时宿主不猜"
      ...(String(req.url).includes('degraded')
        ? {
            quality_options: ['原画', '高清'],
            quality_actual: {
              qn: 150, label: '高清', codec: 'avc', format: 'flv',
              requested: '原画', degraded: true,
            },
          }
        : {}),
      cookies_out: 'fresh-cookie',
    });
    return;
  }
  reply({ ok: false, error: { code: 'INTERNAL', message: 'unknown action', retryable: false } });
});
`;

interface Rig {
  resolver: PluginResolver;
  manager: PluginManager;
  store: Store;
  credentials: Map<string, string>;
  dataRoot: string;
}

async function makeRig(): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), 'tidewatch-plugin-'));
  dirs.push(root);
  const resourceRoot = join(root, 'app');
  const dataRoot = join(root, 'data');
  const pluginDir = join(resourceRoot, 'plugins', 'fake');
  mkdirSync(pluginDir, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({
      name: 'fake',
      version: '0.1.0',
      protocol: 2,
      exec: '{node}',
      args: ['{plugin_dir}/main.mjs'],
      url_patterns: ['example.com/live'],
      platforms: ['fake'],
    }),
  );
  writeFileSync(join(pluginDir, 'main.mjs'), PLUGIN_MAIN);

  const supervisor = new ChildProcessSupervisor(process.platform === 'win32' ? 'win32' : 'linux');
  const manager = new PluginManager({ dataRoot, resourceRoot });
  await manager.scan();

  const host = new PluginHost({
    spawn: (input) => {
      const proc = supervisor.spawn({
        command: input.command,
        args: input.args,
        env: input.env,
        cwd: input.cwd,
        onLine: (stream, line) => input.onLine(stream, line),
      });
      return {
        write: (data) => proc.write(data),
        closeStdin: () => proc.closeStdin?.(),
        wait: () => proc.wait(),
        kill: () => {
          void proc.kill();
        },
      };
    },
    timeoutMs: 10_000,
    concurrency: 2,
    minIntervalMs: 0,
  });

  const credentials = new Map<string, string>();
  const credStore: CredentialStore = {
    get: async (k) => credentials.get(k),
    set: async (k, v) => {
      credentials.set(k, v);
      return { encrypted: true };
    },
    delete: async (k) => {
      credentials.delete(k);
    },
    describeBackend: () => 'memory',
  };
  const store = new Store(join(dataRoot, 'tidewatch.db'));
  const resolver = new PluginResolver({ manager, host, credentials: credStore, store });
  return { resolver, manager, store, credentials, dataRoot };
}

describe('插件发现与解析（真实子进程）', () => {
  it('扫描到插件并给出启动计划（{node} 展开成本进程解释器）', async () => {
    const rig = await makeRig();
    const details = rig.manager.details();
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ name: 'fake', protocol: 2, error: null });
    expect(rig.manager.planFor('fake')?.command).toBe(process.execPath);
    rig.store.close();
  });

  it('probe 命中平台；不属于该平台时回 unsupported 而不是抛异常', async () => {
    const rig = await makeRig();
    expect(await rig.resolver.probeUrl('https://example.com/live/1')).toMatchObject({
      ok: true,
      platform: 'fake',
      platformName: '假平台',
    });
    const miss = await rig.resolver.probeUrl('https://other.com/x');
    expect(miss.ok).toBe(false);
    rig.store.close();
  });

  it('resolve 把插件的平铺字段映射成 ResolveResult，并把 cookies_out 写回凭据', async () => {
    const rig = await makeRig();
    const task = rig.store.addTask({ url: 'https://example.com/live/1', platform: 'fake' });
    const outcome = await rig.resolver.resolve(task);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data).toMatchObject({
      isLive: true,
      recordUrl: 'https://cdn.example.com/live.flv',
      platform: 'fake',
      anchorName: '假主播',
      title: '假直播',
      qualityOptions: ['origin', '720p'],
      headers: { Referer: 'https://example.com/' },
    });
    // 插件刷新的 cookie 自动回写，下一次 resolve 能拿到
    expect(rig.credentials.get('cookie:fake')).toBe('fresh-cookie');
    expect(rig.store.listEvents({ limit: 20 }).map((e) => e.kind)).toContain('plugin.cookies_updated');
    rig.store.close();
  });

  it('quality_actual 映射成结构化的"实际画质"；插件不回时不猜', async () => {
    const rig = await makeRig();
    const degraded = rig.store.addTask({ url: 'https://example.com/live/degraded', platform: 'fake' });
    const got = await rig.resolver.resolve(degraded);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // 请求原画、实际高清：这正是"平台静默降级"的形状，必须原样传上去
    expect(got.data.qualityActual).toEqual({
      qn: 150,
      label: '高清',
      codec: 'avc',
      format: 'flv',
      requested: '原画',
      degraded: true,
    });

    const plain = rig.store.addTask({ url: 'https://example.com/live/plain', platform: 'fake' });
    const none = await rig.resolver.resolve(plain);
    expect(none.ok).toBe(true);
    if (!none.ok) return;
    expect(none.data.qualityActual).toBeNull();
    rig.store.close();
  });

  it('插件报 AUTH_REQUIRED → 错误码原样上抛（引擎据此换 needs_auth 状态）', async () => {
    const rig = await makeRig();
    rig.credentials.set('cookie:fake', 'stale');
    const task = rig.store.addTask({ url: 'https://example.com/live/2', platform: 'fake' });
    const outcome = await rig.resolver.resolve(task);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatchObject({ code: 'AUTH_REQUIRED', retryable: false });
    rig.store.close();
  });

  it('直链不需要插件：.flv/.m3u8 本身就是流地址', async () => {
    const rig = await makeRig();
    const task = rig.store.addTask({ url: 'https://cdn.example.com/a.flv', platform: '' });
    const outcome = await rig.resolver.resolve(task);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.recordUrl).toBe('https://cdn.example.com/a.flv');
    expect(outcome.data.platform).toBe('direct');
    rig.store.close();
  });
});
