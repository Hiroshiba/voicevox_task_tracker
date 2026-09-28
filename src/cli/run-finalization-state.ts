import { hashCanonicalJson } from "../canonical-json/index.js";
import { serializeCanonicalJson } from "../canonical-json/value.js";
import { createUtcIsoDateTime, resolveTrackingStartAt } from "../domain/index.js";
import { createStateRunReport, type StateRunReport } from "../persistence/state-run-report.js";
import { createStateSnapshot, type StateSnapshot } from "../persistence/snapshot-v21.js";
import type { NotificationMessageState } from "./notification-message-state.js";
import type { DurablePublicationRecord } from "./durable-record-schema.js";

/** settlement済みstateと保存済み規則だけから最終reportとsnapshotを作る。 */
export function finalRunValues(
  record: DurablePublicationRecord,
  settled: NotificationMessageState,
  finishedAt: string,
): Readonly<{ report: StateRunReport; snapshot: StateSnapshot; notificationCount: number }> {
  const policy = record.runFinalizationPolicy;
  if (
    settled.transaction.marker.phase !== "notifications_settled" ||
    settled.transaction.record.recordDigest !== record.recordDigest ||
    settled.snapshot.run.id !== policy.report.runId ||
    settled.snapshot.run.status !== policy.report.status ||
    settled.transaction.initialPagesEvidence == null ||
    settled.ledger.entries.some((entry) => entry.status === "delivery_started") ||
    serializeCanonicalJson(policy.completeSuccessRequires) !==
      serializeCanonicalJson(["initial_pages_deployed", "notifications_settled"])
  ) {
    throw new TypeError("run finalizationの保存済み規則とsettlement stateが一致しません");
  }
  const completedAt = createUtcIsoDateTime(finishedAt);
  const trackingStartAt = resolveTrackingStartAt({
    configuredStartAt: policy.configuredTrackingStartAt,
    previousState: settled.snapshot.trackingStartAt,
    run: { outcome: "complete_success", finishedAt: completedAt },
  });
  if (trackingStartAt.status !== "fixed") {
    throw new TypeError("完了済みrunのtracking.startAtを確定できません");
  }
  const entries = new Map(settled.ledger.entries.map((entry) => [entry.notificationKey, entry]));
  const selectedKeys =
    record.notificationOutbox.action === "send" &&
    record.notificationOutbox.selectedContext.action === "create_digest"
      ? new Set(
          record.notificationOutbox.selectedContext.candidates.flatMap((candidate) =>
            candidate.reasons.map((reason) => reason.notificationKey),
          ),
        )
      : new Set<string>();
  const notificationCount = [...selectedKeys].filter(
    (key) => entries.get(key)?.status === "sent",
  ).length;
  const report = createStateRunReport({
    schemaVersion: "3",
    runId: policy.report.runId,
    date: policy.report.startedAt.slice(0, 10),
    status: policy.report.status,
    complete: true,
    scheduledFor: policy.report.scheduledFor,
    startedAt: policy.report.startedAt,
    finishedAt: completedAt,
    metrics: {
      ...policy.report.metrics,
      notificationCount,
      durationMilliseconds: Date.parse(completedAt) - Date.parse(policy.report.startedAt),
    },
    diagnostics: policy.report.diagnostics,
  });
  return Object.freeze({
    report,
    snapshot: createStateSnapshot({ ...settled.snapshot, trackingStartAt }),
    notificationCount,
  });
}

/** 最終stateがsettlement正本から作られた値と一致することを確かめる。 */
export function assertFinalRunValues(
  record: DurablePublicationRecord,
  settled: NotificationMessageState,
  finalized: NotificationMessageState,
  report: StateRunReport,
): void {
  const expected = finalRunValues(record, settled, report.finishedAt);
  if (
    finalized.transaction.marker.phase !== "run_finalized" ||
    finalized.transaction.record.recordDigest !== record.recordDigest ||
    finalized.transaction.marker.finalRunReportDigest !== hashCanonicalJson(report) ||
    finalized.transaction.notificationLedgerDigest !==
      settled.transaction.notificationLedgerDigest ||
    serializeCanonicalJson(finalized.snapshot) !== serializeCanonicalJson(expected.snapshot) ||
    serializeCanonicalJson(finalized.ledger.entries) !==
      serializeCanonicalJson(settled.ledger.entries) ||
    serializeCanonicalJson(finalized.ledger.pendingNotifications) !==
      serializeCanonicalJson(settled.ledger.pendingNotifications) ||
    serializeCanonicalJson(finalized.transaction.initialPagesEvidence) !==
      serializeCanonicalJson(settled.transaction.initialPagesEvidence) ||
    serializeCanonicalJson(report) !== serializeCanonicalJson(expected.report)
  ) {
    throw new TypeError("run finalizationのreport、ledgerまたはsnapshotがsettlementと一致しません");
  }
}
