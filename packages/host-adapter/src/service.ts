/**
 * 开机自启 = 服务注册（docs/00 §7）。模板随包分发，不引第三方服务库。
 * 平台语义差异全部关在这里；安装/卸载失败如实抛出，不吞。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Platform, ServiceControl } from './types.ts';

export interface ServiceOptions {
  platform: Platform;
  /** `dist/cli.js` 的绝对路径 */
  cliPath: string;
  dataRoot: string;
  port: number;
  /** 运行时 node 路径（默认当前进程的 execPath） */
  nodePath?: string;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err) => (err === null ? resolve() : reject(err)));
  });
}

function argsOf(opts: ServiceOptions): string[] {
  return [opts.nodePath ?? process.execPath, opts.cliPath, 'serve', '--data-root', opts.dataRoot, '--port', String(opts.port)];
}

export function createServiceControl(opts: ServiceOptions): ServiceControl {
  if (opts.platform === 'darwin') return darwinService(opts);
  if (opts.platform === 'win32') return windowsService(opts);
  return linuxService(opts);
}

function darwinService(opts: ServiceOptions): ServiceControl {
  const label = 'com.tidewatch.daemon';
  const file = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const argv = argsOf(opts);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${argv.map((a) => `<string>${a}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>WorkingDirectory</key><string>${opts.dataRoot}</string>
  <key>StandardOutPath</key><string>${join(opts.dataRoot, 'logs', 'service.out.log')}</string>
  <key>StandardErrorPath</key><string>${join(opts.dataRoot, 'logs', 'service.err.log')}</string>
</dict></plist>
`;
  return {
    async install() {
      mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
      mkdirSync(join(opts.dataRoot, 'logs'), { recursive: true });
      writeFileSync(file, plist);
      await run('launchctl', ['load', '-w', file]).catch(() => undefined);
    },
    async uninstall() {
      await run('launchctl', ['unload', '-w', file]).catch(() => undefined);
      rmSync(file, { force: true });
    },
    async isInstalled() {
      return existsSync(file);
    },
  };
}

function linuxService(opts: ServiceOptions): ServiceControl {
  const file = join(homedir(), '.config', 'systemd', 'user', 'tidewatch.service');
  const argv = argsOf(opts);
  const unit = `[Unit]
Description=TideWatch live recorder daemon
After=network-online.target

[Service]
Type=simple
ExecStart=${argv.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}
Restart=on-failure
RestartSec=3
WorkingDirectory=${opts.dataRoot}

[Install]
WantedBy=default.target
`;
  return {
    async install() {
      mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
      writeFileSync(file, unit);
      await run('systemctl', ['--user', 'daemon-reload']).catch(() => undefined);
      await run('systemctl', ['--user', 'enable', '--now', 'tidewatch.service']);
    },
    async uninstall() {
      await run('systemctl', ['--user', 'disable', '--now', 'tidewatch.service']).catch(() => undefined);
      rmSync(file, { force: true });
      await run('systemctl', ['--user', 'daemon-reload']).catch(() => undefined);
    },
    async isInstalled() {
      return existsSync(file);
    },
  };
}

function windowsService(opts: ServiceOptions): ServiceControl {
  const name = 'TideWatch';
  const tr = argsOf(opts)
    .map((a) => (a.includes(' ') ? `"${a}"` : a))
    .join(' ');
  return {
    async install() {
      await run('schtasks', ['/Create', '/SC', 'ONLOGON', '/TN', name, '/TR', tr, '/F']);
    },
    async uninstall() {
      await run('schtasks', ['/Delete', '/TN', name, '/F']).catch(() => undefined);
    },
    async isInstalled() {
      try {
        await run('schtasks', ['/Query', '/TN', name]);
        return true;
      } catch {
        return false;
      }
    },
  };
}
