/**
 * ffprobe 端口：采集分段指纹（codec/分辨率/流布局）与时长。
 * 解析失败返回 null —— 缺 ffprobe 的环境下录制仍要继续，只是分组退化为 unknown。
 */
import { fingerprintFromProbe, probeArgs, type Fingerprint, type ProbePort } from '@tidewatch/core';
import type { ProcessSupervisor } from '@tidewatch/host-adapter';
import { runCommand } from './capture.ts';

export class FfprobeProbe implements ProbePort {
  readonly #supervisor: ProcessSupervisor;
  readonly #command: string;

  constructor(supervisor: ProcessSupervisor, command: string) {
    this.#supervisor = supervisor;
    this.#command = command;
  }

  get command(): string {
    return this.#command;
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
