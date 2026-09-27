import { StateHistoryError, StateSnapshotSemanticError } from "./errors.js";
import {
  resolveStateHistoryNotificationItemDisplayReference,
  type StateHistoryNotificationEvent,
} from "./history.js";
import type { StateSnapshot } from "./snapshot.js";
import type { StateRunReport } from "./state-documents.js";

/** snapshotとrun reportの整合性を検証する。 */
export function assertRunConsistency(snapshot: StateSnapshot, report: StateRunReport): void {
  if (
    snapshot.run.id !== report.runId ||
    snapshot.run.status !== report.status ||
    snapshot.generatedAt < report.startedAt ||
    snapshot.generatedAt > report.finishedAt
  ) {
    throw new StateSnapshotSemanticError("snapshotとrun reportのrun情報が一致しません");
  }
  const activeEdgeCount = snapshot.relations.filter((relation) => relation.active).length;
  if (
    report.metrics.repositoryCount !== snapshot.repositories.length ||
    report.metrics.itemCount !== snapshot.items.length ||
    report.metrics.activeEdgeCount !== activeEdgeCount ||
    report.metrics.staleRepositoryCount !==
      snapshot.repositories.filter((repository) => repository.freshness === "stale").length
  ) {
    throw new StateSnapshotSemanticError("snapshotとrun reportの件数が一致しません");
  }
}

/** 通知eventの待機先とsnapshotの表示情報を照合する。 */
export function assertNotificationWaitingOnMatchesSnapshot(
  event: StateHistoryNotificationEvent,
  snapshot: StateSnapshot,
  item: StateSnapshot["items"][number],
): void {
  if (event.waitingOn.status !== "recorded") {
    throw new StateHistoryError("新規通知送信eventのwaitingOnが記録済みではありません");
  }
  if (item.waitingOn.length === 0) {
    throw new StateHistoryError("通知送信eventの対象itemにwaitingOnがありません");
  }
  if (event.waitingOn.values.length !== item.waitingOn.length) {
    throw new StateHistoryError("通知送信eventとsnapshotのwaitingOn件数が一致しません");
  }
  for (const [index, expected] of item.waitingOn.entries()) {
    const actual = event.waitingOn.values[index];
    if (actual == null) {
      throw new StateHistoryError("通知送信eventとsnapshotのwaitingOnが順序込みで一致しません");
    }
    if (
      actual.kind !== expected.kind ||
      actual.candidateId !== expected.candidateId ||
      actual.role !== expected.role
    ) {
      throw new StateHistoryError("通知送信eventとsnapshotのwaitingOnが順序込みで一致しません");
    }
    if (expected.kind !== "item") {
      continue;
    }
    if (actual.kind !== "item") {
      throw new StateHistoryError("通知送信eventのitem waitingOn種別が一致しません");
    }
    if (
      actual.displayReference !==
      resolveStateHistoryNotificationItemDisplayReference(snapshot, expected.candidateId)
    ) {
      throw new StateHistoryError("通知送信eventのitem waitingOn表示参照とsnapshotが一致しません");
    }
  }
}
