/**
 * 平台实现装配：全项目唯一允许出现平台差异的包。
 */
import { join } from 'node:path';
import { createCredentialStore } from './credentials.ts';
import { FileEngineLease } from './lease.ts';
import { ChildProcessSupervisor } from './process-supervisor.ts';
import { createServiceControl } from './service.ts';
import type { HostAdapter, Platform } from './types.ts';

export * from './types.ts';
export { ChildProcessSupervisor, Supervised } from './process-supervisor.ts';
export { createCredentialStore, FileCredentialStore, KeyringCredentialStore } from './credentials.ts';
export { FileEngineLease } from './lease.ts';
export { createServiceControl } from './service.ts';

export interface CreateHostAdapterOptions {
  platform?: Platform;
  dataRoot: string;
  resourceRoot: string;
  defaultDownloads: string;
  /** 服务注册用：`dist/cli.js` 的绝对路径 */
  cliPath?: string;
  port?: number;
}

export function createHostAdapter(opts: CreateHostAdapterOptions): HostAdapter {
  const platform = opts.platform ?? (process.platform as Platform);
  return {
    platform,
    processes: new ChildProcessSupervisor(platform),
    credentials: createCredentialStore(opts.dataRoot),
    service: createServiceControl({
      platform,
      cliPath: opts.cliPath ?? join(opts.resourceRoot, 'packages', 'server', 'dist', 'cli.js'),
      dataRoot: opts.dataRoot,
      port: opts.port ?? 8686,
    }),
    paths: {
      dataRoot: () => opts.dataRoot,
      resourceRoot: () => opts.resourceRoot,
      defaultDownloads: () => opts.defaultDownloads,
    },
    lease: new FileEngineLease(opts.dataRoot),
  };
}
