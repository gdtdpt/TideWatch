/**
 * 凭据存储（docs/00 §4 红线）：
 * 优先系统钥匙串；不可用时降级明文并**如实**回报 `encrypted=false`。
 * 界面上绝不能出现"看起来加密、其实没有"。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { CredentialStore } from './types.ts';

const SERVICE = 'TideWatch';

interface KeyringEntry {
  setPassword(value: string): void;
  getPassword(): string | null;
  deletePassword(): void;
}

type KeyringModule = { Entry: new (service: string, user: string) => KeyringEntry };

function loadKeyring(): KeyringModule | null {
  try {
    const require = createRequire(import.meta.url);
    const mod = require('@napi-rs/keyring') as KeyringModule;
    // 构造一次，确认后端真的可用（Linux 上没有 secret-service 时这里就炸）
    const probe = new mod.Entry(SERVICE, '__probe__');
    probe.getPassword();
    return mod;
  } catch {
    return null;
  }
}

/** 明文降级：仅当钥匙串不可用；文件 0600，值永不进日志 */
export class FileCredentialStore implements CredentialStore {
  readonly #file: string;

  constructor(dataRoot: string) {
    this.#file = join(dataRoot, 'credentials.json');
  }

  #read(): Record<string, string> {
    try {
      if (!existsSync(this.#file)) return {};
      const parsed: unknown = JSON.parse(readFileSync(this.#file, 'utf8'));
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  #write(data: Record<string, string>): void {
    mkdirSync(join(this.#file, '..'), { recursive: true });
    writeFileSync(this.#file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(this.#file, 0o600);
    } catch {
      /* Windows 上 chmod 只是近似 */
    }
  }

  async get(key: string): Promise<string | undefined> {
    return this.#read()[key];
  }

  async set(key: string, value: string): Promise<{ encrypted: boolean }> {
    const data = this.#read();
    data[key] = value;
    this.#write(data);
    return { encrypted: false };
  }

  async delete(key: string): Promise<void> {
    const data = this.#read();
    delete data[key];
    this.#write(data);
  }

  describeBackend(): string {
    return 'plaintext-file (未加密，钥匙串不可用时的降级)';
  }
}

export class KeyringCredentialStore implements CredentialStore {
  readonly #mod: KeyringModule;

  constructor(mod: KeyringModule) {
    this.#mod = mod;
  }

  async get(key: string): Promise<string | undefined> {
    const value = new this.#mod.Entry(SERVICE, key).getPassword();
    return value === null ? undefined : value;
  }

  async set(key: string, value: string): Promise<{ encrypted: boolean }> {
    new this.#mod.Entry(SERVICE, key).setPassword(value);
    return { encrypted: true };
  }

  async delete(key: string): Promise<void> {
    new this.#mod.Entry(SERVICE, key).deletePassword();
  }

  describeBackend(): string {
    return 'system-keyring (macOS Keychain / Windows 凭据管理器 / secret-service)';
  }
}

export function createCredentialStore(dataRoot: string): CredentialStore {
  const mod = loadKeyring();
  return mod === null ? new FileCredentialStore(dataRoot) : new KeyringCredentialStore(mod);
}
