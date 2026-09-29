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
import { decodeStateFile, encodeStateFile } from "./state-file-codec.js";
import { createStateLedgerUpdates, loadStateNotificationLedgers } from "./state-ledger-files.js";
import {
  createStateOperationsAlertLedger,
  OPERATIONS_ALERT_LEDGER_STATE_PATH_V1,
  parseStateOperationsAlertLedger,
  serializeStateOperationsAlertLedger,
  type StateOperationsAlertLedger,
  type StateOperationsAlertReservation,
} from "./operations-alert-ledger.js";
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

/** exact stateから送信予約と送信済み通知を読む。 */
export async function loadOperationsAlertLedger(
  adapter: StateBranchAdapter,
  head: StateBranchHead,
): Promise<StateOperationsAlertLedger> {
  const file =
    head.status === "missing"
      ? ({ status: "missing" } satisfies StateFileReadResult)
      : await adapter.readFile(head.revision, OPERATIONS_ALERT_LEDGER_STATE_PATH_V1);
  const source = decodeStateFile(file, "operations alert ledger");
  return source == null
    ? createStateOperationsAlertLedger({
        schemaVersion: "2",
        operationsAlerts: [],
        deliveryReservations: [],
      })
    : parseStateOperationsAlertLedger(source);
}

async function commitOperationsAlertUpdate(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  expectedHead: StateBranchHead,
  alertKey: string,
  action: "reserve" | "settle" | "release",
  committedAt: string,
  update: (ledger: StateOperationsAlertLedger) => StateOperationsAlertLedger,
): Promise<StateBranchCommitResult> {
  const commitIdentity = Object.freeze({
    commitScope: "operations_alert" as const,
    operationId: createStateCommitOperationId({
      scope: "operations_alert",
      alertKey,
      action,
    }),
  });
  const written = await writeStateCas(adapter, configuration, expectedHead, {
    commitIdentity,
    build: async (parent) => {
      await assertOperationsAlertLedgerWritable(adapter, configuration, parent);
      const next = update(await loadOperationsAlertLedger(adapter, parent));
      return {
        updates: [
          {
            path: OPERATIONS_ALERT_LEDGER_STATE_PATH_V1,
            bytes: encodeStateFile(serializeStateOperationsAlertLedger(next)),
          },
        ],
        deletions: [],
        message: `tracker operations alert ${action} ${alertKey}`,
        committedAt,
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

/** Discord HTTPより前に送信予約を専用ledgerへCAS保存する。 */
export async function reserveOperationsAlertDelivery(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  expectedHead: StateBranchHead,
  reservation: StateOperationsAlertReservation,
): Promise<StateBranchCommitResult> {
  return commitOperationsAlertUpdate(
    adapter,
    configuration,
    expectedHead,
    reservation.alertKey,
    "reserve",
    reservation.startedAt,
    (ledger) => {
      if (
        ledger.operationsAlerts.some((entry) => entry.alertKey === reservation.alertKey) ||
        ledger.deliveryReservations.some((entry) => entry.alertKey === reservation.alertKey)
      ) {
        throw new StateBranchConflictError();
      }
      return createStateOperationsAlertLedger({
        ...ledger,
        deliveryReservations: [...ledger.deliveryReservations, reservation],
      });
    },
  );
}

/** 送信予約を同じincidentの送信済み記録へCAS確定する。 */
export async function commitOperationsAlertLedger(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  expectedHead: StateBranchHead,
  entry: OperationsAlertLedgerEntry,
): Promise<StateBranchCommitResult> {
  return commitOperationsAlertUpdate(
    adapter,
    configuration,
    expectedHead,
    entry.alertKey,
    "settle",
    entry.sentAt,
    (ledger) => {
      const reservation = ledger.deliveryReservations.find(
        (item) => item.alertKey === entry.alertKey,
      );
      if (reservation == null) {
        throw new StateBranchConflictError();
      }
      if (
        reservation.incidentId !== entry.incidentId ||
        reservation.kind !== entry.kind ||
        reservation.occurredAt !== entry.occurredAt ||
        entry.sentAt < reservation.startedAt
      ) {
        throw new StateBranchConflictError();
      }
      return createStateOperationsAlertLedger({
        ...ledger,
        operationsAlerts: [...ledger.operationsAlerts, entry],
        deliveryReservations: ledger.deliveryReservations.filter(
          (item) => item.alertKey !== entry.alertKey,
        ),
      });
    },
  );
}

/** 明確に送信されなかった通知の予約だけをCAS解除する。 */
export async function releaseOperationsAlertDelivery(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  expectedHead: StateBranchHead,
  reservation: StateOperationsAlertReservation,
): Promise<StateBranchCommitResult> {
  return commitOperationsAlertUpdate(
    adapter,
    configuration,
    expectedHead,
    reservation.alertKey,
    "release",
    reservation.startedAt,
    (ledger) => {
      const current = ledger.deliveryReservations.find(
        (item) => item.alertKey === reservation.alertKey,
      );
      if (current == null) {
        throw new StateBranchConflictError();
      }
      if (
        current.incidentId !== reservation.incidentId ||
        current.startedAt !== reservation.startedAt
      ) {
        throw new StateBranchConflictError();
      }
      return createStateOperationsAlertLedger({
        ...ledger,
        deliveryReservations: ledger.deliveryReservations.filter(
          (item) => item.alertKey !== reservation.alertKey,
        ),
      });
    },
  );
}
