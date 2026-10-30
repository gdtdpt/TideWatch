/**
 * ffprobe 端口：采集分段指纹（codec/分辨率/流布局）与时长。
 * 解析失败返回 null —— 缺 ffprobe 的环境下录制仍要继续，只是分组退化为 unknown。
 */
import { fingerprintFromProbe, probeArgs, type Fingerprint, type ProbePort } from '@tidewatch/core';
import type { ProcessSupervisor } from '@tidewatch/host-adapter';
import { describeBinary, runCommand, type BinaryInfo } from './capture.ts';

export class FfprobeProbe implements ProbePort {
  readonly #supervisor: ProcessSupervisor;
  readonly #command: string;
  #described: { at: number; info: BinaryInfo } | null = null;

  constructor(supervisor: ProcessSupervisor, command: string) {
    this.#supervisor = supervisor;
    this.#command = command;
  }

  get command(): string {
    return this.#command;
  }

  /**
   * 缺 ffprobe 时录制照旧（分组退化为 unknown），所以这里不做阻断，
   * 只把"有没有 / 哪个版本"报到健康页 —— 否则用户永远不知道分组为什么全是 unknown。
   */
  async describe(): Promise<BinaryInfo> {
    const now = Date.now();
    if (this.#described !== null && now - this.#described.at < 60_000) return this.#described.info;
    const info = await describeBinary(this.#supervisor, this.#command);
    this.#described = { at: now, info };
    return info;
  }

  async probe(file: string): Promise<Fingerprint | null> {
    const result = await runCommand(this.#supervisor, this.#command, probeArgs(file), 15_000);
    if (result.code !== 0 || result.stdout.trim().length === 0) return null;
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      if (typeof parsed !== 'object' || parsed === null) return null;
      return fingerprintFromProbe(parsed as Parameters<typeof fingerprintFromProbe>[0]);
    } catch {
      return null;
    }
  }
}
