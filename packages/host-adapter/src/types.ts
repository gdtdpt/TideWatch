/**
 * HostAdapter —— 全项目唯一允许出现平台分支的地方（见 docs/00 §3）。
 *
 * 五项差异：进程树 / 凭据 / 服务注册 / 路径 / 引擎单实例租约。
 * 任何 `process.platform` 判断都必须在这里关掉；core 里出现即设计事故。
 */

export type Platform = 'win32' | 'darwin' | 'linux';

/** ① 进程树：级联终止 + 退出必回收（Windows 走 Job Object，Unix 走进程组） */
export interface ProcessSupervisor {
  /** spawn 一个受监督的子进程；返回句柄用于优雅停止 */
  spawn(opts: SpawnOptions): SupervisedProcess;
  /** 宿主退出前调用：确保所有子进程（含孙进程）都被回收 */
  disposeAll(timeoutMs: number): Promise<void>;
}

export interface SpawnOptions {
  command: string;
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
  cwd?: string;
  onLine?: (stream: 'stdout' | 'stderr', line: string) => void;
  onExit?: (info: { code: number | null; signal: string | null }) => void;
}

export interface SupervisedProcess {
  readonly pid: number | undefined;
  /** 写入 stdin（ffmpeg 的优雅停止是写 'q'） */
  write(data: string): void;
  closeStdin?(): void;
  /** 优雅停止：SIGTERM → 宽限 → 硬杀（Windows 下为 taskkill /T /F） */
  stop(graceMs: number): Promise<void>;
  kill(): Promise<void>;
  /** 退出信息（进程只退出一次，promise 已记忆化） */
  wait(): Promise<{ code: number | null; signal: string | null }>;
}

/** ② 凭据：系统钥匙串；不可用时降级明文，但必须如实上报 encrypted=false */
export interface CredentialStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<{ encrypted: boolean }>;
  delete(key: string): Promise<void>;
  /** 诊断用：当前后端描述（如 macOS Keychain / Windows Credential Manager） */
  describeBackend(): string;
}

/** ③ 服务注册：开机自启（launchd / systemd / 计划程序） */
export interface ServiceControl {
  install(): Promise<void>;
  uninstall(): Promise<void>;
  isInstalled(): Promise<boolean>;
}

export interface Paths {
  /** 数据根：默认与程序同层；指针文件/环境变量可覆盖（docs/11 语义照搬） */
  dataRoot(): string;
  /** 随包资源（ffmpeg / python / 插件 / ui 静态资源） */
  resourceRoot(): string;
  /** 产物默认目录 */
  defaultDownloads(): string;
}

/** ④ 引擎单实例租约：同一数据根同时只允许一个宿主跑引擎 */
export interface LeaseResult {
  acquired: boolean;
  holderPid?: number;
  reason?: 'held-by-other' | 'infra-error';
}

export interface EngineLease {
  acquire(dbPath: string): Promise<LeaseResult>;
  release(): Promise<void>;
}

export interface HostAdapter {
  readonly platform: Platform;
  processes: ProcessSupervisor;
  credentials: CredentialStore;
  service: ServiceControl;
  paths: Paths;
  lease: EngineLease;
}
