import type { OperationsAlertLedgerEntry } from "../domain/index.js";
import {
  DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
  INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1,
  RUN_TRANSACTION_MARKER_STATE_PATH_V1,
} from "../application/tracking-run/contracts/recovery-paths.js";
import { createStateCommitOperationId } from "./state-commit-metadata.js";
import {
  type StateBranchAdapter,
  type StateBranchCommitResult,
  type StateBranchHead,
  type StateFileReadResult,
  type StatePersistenceConfiguration,
} from "./branch-adapter.js";
import { StateBranchConflictError, StateBranchCommitError } from "./errors.js";
import { createStateNotificationLedger } from "./state-documents.js";
import { createStateLedgerUpdates, loadStateNotificationLedgers } from "./state-ledger-files.js";
import { OPERATIONS_ALERT_LEDGER_STATE_PATH_V1 } from "./operations-alert-ledger.js";
import { writeStateCas } from "./state-cas.js";

/** 送信前にexact headの専用ledgerだけを更新できることを確認する。 */
export async function assertOperationsAlertLedgerWritable(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  head: StateBranchHead,
): Promise<void> {
  const ledger = await loadStateNotificationLedgers(adapter, configuration, head);
  await createStateLedgerUpdates(adapter, configuration, head, ledger, "operations_alert");
}

function sameFile(left: StateFileReadResult, right: StateFileReadResult): boolean {
  if (left.status !== right.status) {
    return false;
  }
  if (left.status === "missing" || right.status === "missing") {
    return true;
  }
  return (
    left.bytes.length === right.bytes.length &&
    left.bytes.every((byte, index) => byte === right.bytes[index])
  );
}

async function assertProtectedFilesUnchanged(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  parent: StateBranchHead,
  revision: string,
): Promise<void> {
  const paths = [
    configuration.snapshotPath,
    configuration.notificationLedgerPath,
    DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
    RUN_TRANSACTION_MARKER_STATE_PATH_V1,
    INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1,
  ];
  const before =
    parent.status === "missing"
      ? new Map(paths.map((path) => [path, { status: "missing" } satisfies StateFileReadResult]))
      : await adapter.readFiles(parent.revision, paths);
  const after = await adapter.readFiles(revision, paths);
  for (const path of paths) {
    const previous = before.get(path);
    const current = after.get(path);
    if (previous == null || current == null || !sameFile(previous, current)) {
      throw new TypeError("運用障害通知commitで追跡state fileが変更されました");
    }
  }
}

/** 運用障害通知だけを専用ledgerへCAS保存し、追跡fileをpush前後に照合する。 */
export async function commitOperationsAlertLedger(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  expectedHead: StateBranchHead,
  entry: OperationsAlertLedgerEntry,
): Promise<StateBranchCommitResult> {
  const commitIdentity = Object.freeze({
    commitScope: "operations_alert" as const,
    operationId: createStateCommitOperationId({
      scope: "operations_alert",
      alertKey: entry.alertKey,
    }),
  });
  const written = await writeStateCas(adapter, configuration, expectedHead, {
    commitIdentity,
    build: async (parent) => {
      const current = await loadStateNotificationLedgers(adapter, configuration, parent);
      if (current.operationsAlerts.some((alert) => alert.alertKey === entry.alertKey)) {
        throw new StateBranchConflictError();
      }
      const next = createStateNotificationLedger({
        ...current,
        operationsAlerts: [...current.operationsAlerts, entry],
      });
      const updates = await createStateLedgerUpdates(
        adapter,
        configuration,
        parent,
        next,
        "operations_alert",
      );
      if (updates.length !== 1 || updates[0]?.path !== OPERATIONS_ALERT_LEDGER_STATE_PATH_V1) {
        throw new TypeError("運用障害通知commitに専用ledger以外の更新があります");
      }
      return {
        updates,
        deletions: [],
        message: `tracker operations alert ${entry.alertKey}`,
        committedAt: entry.sentAt,
        commitIdentity,
      };
    },
    verifyCandidate: async (_files, revision, request) => {
      const candidate = await adapter.readCommit(revision);
      await assertProtectedFilesUnchanged(adapter, configuration, candidate.parent, revision);
      if (
        request.updates.length !== 1 ||
        request.updates[0]?.path !== OPERATIONS_ALERT_LEDGER_STATE_PATH_V1
      ) {
        throw new TypeError("運用障害通知commitの変更pathが不正です");
      }
    },
  });
  if (written.status === "conflict") {
    throw new StateBranchConflictError();
  }
  if (written.status === "no_effect") {
    throw new StateBranchCommitError({
      cause: new TypeError("運用障害通知ledgerをremoteへ反映できませんでした"),
    });
  }
  const inspected = await adapter.readCommit(written.commit.revision);
  const published = await adapter.resolveHead(configuration.branch);
  if (published.status !== "present" || published.revision !== written.commit.revision) {
    throw new StateBranchConflictError();
  }
  await assertProtectedFilesUnchanged(adapter, configuration, inspected.parent, published.revision);
  return written.commit;
}
