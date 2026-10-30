/**
 * 崩溃恢复扫描（docs/03 §11）：daemon 启动时一次性、幂等地回答两个问题 ——
 * 「上次录到哪了」「磁盘上多出来的文件是什么」。
 *
 * 能救则救：崩溃瞬间正在写的段两边都没记录，但 `-flush_packets 1` 让它仍然可播。
 * 一律丢进 orphan/ 等于丢内容，所以先 ffprobe，能解析就就地登记为 `recovered`。
 */
import type { Store } from '@tidewatch/store';
import type { EngineFs, ProbePort } from './engine.ts';
import { isCandidateTs, ORPHAN_DIR, parsePartNo, pathKey, joinPath, baseName } from './layout.ts';

export interface RecoveryDeps {
  store: Store;
  fs: EngineFs;
  probe: ProbePort;
  logger?: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
}

export interface RecoverySummary {
  interrupted: number;
  recovered: number;
  orphaned: number;
  missing: number;
}

export async function runRecovery(deps: RecoveryDeps): Promise<RecoverySummary> {
  const summary: RecoverySummary = { interrupted: 0, recovered: 0, orphaned: 0, missing: 0 };
  const sessions = deps.store.listSessions({ limit: 500 });

  for (const session of sessions) {
    if (session.endedAt === null) {
      deps.store.endSession(session.id, 'interrupted');
      deps.store.insertEvent({
        kind: 'recovery.session_interrupted',
        payload: { output_dir: session.outputDir },
        taskId: session.taskId,
        sessionId: session.id,
      });
      summary.interrupted += 1;
    }

    const segments = deps.store.listSegments(session.id);
    const known = new Set(segments.map((s) => pathKey(s.path)));
    const usedParts = new Set(segments.map((s) => s.partNo));
    let maxPart = segments.reduce((m, s) => Math.max(m, s.partNo), 0);

    let files: string[];
    try {
      files = await deps.fs.listFiles(session.outputDir);
    } catch {
      files = [];
    }

    for (const file of files) {
      const name = baseName(file);
      if (!isCandidateTs(name)) continue;
      if (known.has(pathKey(file))) continue;

      const fp = await deps.probe.probe(file);
      const salvageable = fp !== null && fp.video !== null && fp.durationS > 0;
      if (salvageable) {
        let partNo = parsePartNo(name) ?? maxPart + 1;
        if (usedParts.has(partNo)) {
          maxPart += 1;
          partNo = maxPart;
        }
        usedParts.add(partNo);
        maxPart = Math.max(maxPart, partNo);
        const size = await deps.fs.statSize(file);
        deps.store.insertSegment({
          sessionId: session.id,
          path: file,
          partNo,
          startedAt: new Date().toISOString(),
          durationS: fp.durationS,
          sizeBytes: size,
          integrity: 'recovered',
          errorClass: null,
          video: fp.video,
          audio: fp.audio,
        });
        deps.store.insertEvent({
          kind: 'recovery.segment_recovered',
          payload: { path: file, part_no: partNo, duration_s: fp.durationS },
          taskId: session.taskId,
          sessionId: session.id,
        });
        summary.recovered += 1;
        continue;
      }

      try {
        const orphanDir = joinPath(session.outputDir, ORPHAN_DIR);
        await deps.fs.mkdirp(orphanDir);
        await deps.fs.move(file, joinPath(orphanDir, name));
        deps.store.insertEvent({
          kind: 'recovery.orphan_found',
          payload: { path: file },
          taskId: session.taskId,
          sessionId: session.id,
        });
        summary.orphaned += 1;
      } catch (err) {
        deps.logger?.warn('孤儿文件归档失败', err);
      }
    }

    for (const seg of deps.store.listSegments(session.id)) {
      if (seg.integrity === 'cleaned') continue;
      if (await deps.fs.exists(seg.path)) continue;
      deps.store.insertEvent({
        kind: 'recovery.segment_missing',
        payload: { path: seg.path, part_no: seg.partNo },
        taskId: session.taskId,
        sessionId: session.id,
      });
      summary.missing += 1;
    }
  }

  deps.store.insertEvent({
    kind: 'recovery.done',
    payload: { ...summary },
  });
  deps.logger?.info('恢复扫描完成', summary);
  return summary;
}
