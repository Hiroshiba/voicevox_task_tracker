import { hashCanonicalJson } from "../canonical-json/index.js";
import { serializeCanonicalJson } from "../canonical-json/value.js";
import {
  INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1,
  RUN_TRANSACTION_MARKER_STATE_PATH_V1,
} from "../application/tracking-run/contracts/recovery-paths.js";
import {
  serializeInitialPagesPublicationEvidence,
  type InitialPagesPublicationEvidence,
} from "../application/tracking-run/initial-pages-evidence.js";
import {
  parseRunTransactionMarker,
  serializeRunTransactionMarker,
  type RunTransactionMarker,
} from "../application/tracking-run/run-transaction-marker.js";
import {
  createNotificationHistoryContext,
  createNotificationHistoryEventsForMessage,
} from "./notification-history-runtime.js";
import { nodeContentDigestPort as digest } from "../infrastructure/tracking-run/content-digest.js";
import {
  joinStatePath,
  type StateBranchAdapter,
  type StateFileReadResult,
  type StateFileUpdate,
  type StatePersistenceConfiguration,
} from "../persistence/branch-adapter.js";
import {
  appendStateHistoryNotificationEvents,
  parseStateHistoryRecords,
  serializeStateHistoryRecords,
} from "../persistence/history.js";
import { createStateLedgerUpdates } from "../persistence/state-ledger-files.js";
import { assertStatePublicSafety } from "../persistence/public-safety.js";
import {
  createStateNotificationLedger,
  OPERATIONS_ALERT_LEDGER_STATE_PATH_V1,
  parseStateNotificationLedger,
  parseStateOperationsAlertLedger,
  type StateNotificationLedger,
} from "../persistence/state-documents.js";
import {
  verifyRunTransactionFiles,
  type VerifiedRunTransactionFiles,
} from "../persistence/state-transaction-files.js";
import { parseStateSnapshot, type StateSnapshot } from "../persistence/snapshot-v21.js";
import { normalNotificationLedgerValue } from "../publication/publication-order.js";
import { createGitHubRepositoryId, type Repository } from "../domain/index.js";
import type { NotificationDeliveryAttempt } from "../domain/notification-delivery-attempt.js";
import { notificationLedgerEntry } from "./notification-ledger-normalization.js";
import { NotificationStructureError } from "./notification-structure-error.js";
import {
  restoreNotificationSelection,
  type NotificationMessageContext,
} from "./notification-message-context.js";
import type { DurablePublicationRecord } from "./durable-record-schema.js";

export function assertCurrentState(
  state: NotificationMessageState,
  record: DurablePublicationRecord,
  initialStateRevision: string,
  evidence: InitialPagesPublicationEvidence,
): void {
  const { marker } = state.transaction;
  if (
    marker.phase === "notifications_settled" ||
    marker.phase === "run_finalized" ||
    state.transaction.record.recordDigest !== record.recordDigest ||
    marker.runId !== record.runIdentity.runId ||
    marker.checkpointDigest !== record.checkpointDigest ||
    state.snapshot.run.id !== record.runIdentity.runId
  ) {
    throw new NotificationStructureError(
      "通知messageのstateが保留中の同じrunではありません",
      "no_effect",
    );
  }
  if (
    marker.phase === "initial_state_committed"
      ? state.transaction.initialPagesEvidence != null
      : marker.initialStateRevision !== initialStateRevision ||
        serializeCanonicalJson(state.transaction.initialPagesEvidence) !==
          serializeCanonicalJson(evidence)
  ) {
    throw new NotificationStructureError(
      "通知messageの初回revisionまたはPages証拠がstateと一致しません",
      "no_effect",
    );
  }
}

/** 一つのexact state revisionで検証した通知送達入力。 */
export type NotificationMessageState = Readonly<{
  revision: string;
  transaction: VerifiedRunTransactionFiles;
  snapshot: StateSnapshot;
  ledger: StateNotificationLedger;
  files: ReadonlyMap<string, StateFileReadResult>;
}>;

function requiredSource(files: ReadonlyMap<string, StateFileReadResult>, path: string): string {
  const file = files.get(path);
  if (file?.status !== "present") {
    throw new TypeError(`通知messageのstate fileがありません。対象: ${path}`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
}

/** snapshot、ledger、marker、recordを同じcommit treeから読む。 */
export async function readNotificationMessageState(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  revision: string,
): Promise<NotificationMessageState> {
  const paths = await adapter.listFiles(revision, "state");
  const files = await adapter.readFiles(revision, paths);
  if (files.size !== paths.length || paths.some((path) => files.get(path)?.status !== "present")) {
    throw new TypeError("通知messageのexact state file一覧が不足しています");
  }
  const transaction = verifyRunTransactionFiles(files, configuration);
  if (transaction == null) {
    throw new TypeError("通知messageのrun transactionがありません");
  }
  const snapshot = parseStateSnapshot(requiredSource(files, configuration.snapshotPath));
  const normalLedger = parseStateNotificationLedger(
    requiredSource(files, configuration.notificationLedgerPath),
  );
  const operationsFile = files.get(OPERATIONS_ALERT_LEDGER_STATE_PATH_V1);
  const ledger = createStateNotificationLedger({
    ...normalLedger,
    operationsAlerts:
      operationsFile?.status === "present"
        ? parseStateOperationsAlertLedger(
            new TextDecoder("utf-8", { fatal: true }).decode(operationsFile.bytes),
          ).operationsAlerts
        : [],
  });
  return Object.freeze({ revision, transaction, snapshot, ledger, files });
}

export type MessageAttempt = NotificationDeliveryAttempt;

/** 一つのmessageに含まれる全keyを同じ試行へ遷移させる。 */
export function transitionMessageLedger(
  ledger: StateNotificationLedger,
  context: NotificationMessageContext,
  attempt: MessageAttempt,
  result: "started" | "sent" | "clear_rejection",
  reservations: readonly Readonly<{ notificationKey: string; expiresAt: string }>[],
): StateNotificationLedger {
  const keys = new Set(context.notificationKeys);
  const reservationByKey = new Map(reservations.map((entry) => [entry.notificationKey, entry]));
  const entries = ledger.entries.map((entry) => {
    if (!keys.has(entry.notificationKey)) {
      return entry;
    }
    const reservation = reservationByKey.get(entry.notificationKey);
    if (reservation == null) {
      throw new NotificationStructureError("通知messageの元予約がありません", "no_effect");
    }
    if (result === "started") {
      if (entry.status !== "reserved" || attempt.startedAt > entry.expiresAt) {
        throw new NotificationStructureError("通知messageの開始前予約が無効です", "no_effect");
      }
      return {
        notificationKey: entry.notificationKey,
        itemNodeId: entry.itemNodeId,
        reasonCode: entry.reasonCode,
        severity: entry.severity,
        reservedAt: entry.reservedAt,
        status: "delivery_started",
        deliveryId: context.deliveryId,
        startedAt: attempt.startedAt,
        lastDeliveryAttempt: attempt,
      };
    }
    if (
      entry.status !== "delivery_started" ||
      entry.deliveryId !== context.deliveryId ||
      entry.lastDeliveryAttempt?.attemptId !== attempt.attemptId
    ) {
      throw new NotificationStructureError(
        "通知messageの結果が開始済みledgerと一致しません",
        "no_effect",
      );
    }
    const base = {
      notificationKey: entry.notificationKey,
      itemNodeId: entry.itemNodeId,
      reasonCode: entry.reasonCode,
      severity: entry.severity,
      reservedAt: entry.reservedAt,
      lastDeliveryAttempt: attempt,
    };
    if (result === "sent") {
      if (attempt.completedAt == null || attempt.discordMessageId == null) {
        throw new TypeError("送信済みmessageに結果時刻またはDiscord IDがありません");
      }
      return {
        ...base,
        status: "sent",
        sentAt: attempt.completedAt,
        discordMessageId: attempt.discordMessageId,
      };
    }
    return { ...base, status: "reserved", expiresAt: reservation.expiresAt };
  });
  return createStateNotificationLedger({
    schemaVersion: ledger.schemaVersion,
    entries,
    operationsAlerts: ledger.operationsAlerts,
    pendingNotifications:
      result === "sent"
        ? ledger.pendingNotifications.filter((pending) => !keys.has(pending.notificationKey))
        : ledger.pendingNotifications,
  });
}

/** message commitに対応するmarkerを同じphaseで進める。 */
export function advanceMessageMarker(
  previous: RunTransactionMarker,
  ledger: StateNotificationLedger,
  evidence: InitialPagesPublicationEvidence,
  initialStateRevision: string,
  parentRevision: string,
  deliveryId: string,
): RunTransactionMarker {
  return parseRunTransactionMarker({
    ...previous,
    phase: "notifications_in_progress",
    phaseSequence: previous.phaseSequence + 1,
    expectedParentStateRevision: parentRevision,
    initialStateRevision,
    initialPagesPublicationEvidenceDigest: evidence.evidenceDigest,
    notificationLedgerDigest: hashCanonicalJson(normalNotificationLedgerValue(ledger)),
    lastMessageDeliveryId: deliveryId,
  });
}

/** 成功したmessageの履歴eventと安全なstate更新を組み立てる。 */
export async function messageStateUpdates(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  state: NotificationMessageState,
  nextLedger: StateNotificationLedger,
  marker: RunTransactionMarker,
  evidence: InitialPagesPublicationEvidence,
  context: NotificationMessageContext,
  result: "started" | "sent" | "clear_rejection",
  repositoryInventory: readonly Repository[],
  knownSecrets: readonly string[],
): Promise<readonly StateFileUpdate[]> {
  const updates: StateFileUpdate[] = [
    ...(await createStateLedgerUpdates(
      adapter,
      configuration,
      { status: "present", revision: state.revision },
      nextLedger,
      "tracking_run",
    )),
  ];
  let historyRecords: readonly unknown[] = [];
  if (result === "sent") {
    if (state.transaction.record.notificationOutbox.action !== "send") {
      throw new TypeError("送信action以外の通知履歴を作れません");
    }
    const historyContext = createNotificationHistoryContext(
      state.snapshot,
      restoreNotificationSelection(state.transaction.record),
    );
    const entries = nextLedger.entries.filter((entry) =>
      context.notificationKeys.includes(entry.notificationKey),
    );
    const events = createNotificationHistoryEventsForMessage(
      state.snapshot,
      historyContext,
      entries.map(notificationLedgerEntry),
    );
    const path = joinStatePath(
      configuration.historyDirectory,
      `${state.snapshot.generatedAt.slice(0, 10)}.jsonl`,
    );
    const source = appendStateHistoryNotificationEvents(
      requiredSource(state.files, path),
      marker.runId,
      events,
    );
    const records = parseStateHistoryRecords(source);
    if (serializeStateHistoryRecords(records) !== source) {
      throw new TypeError("通知履歴の保存値がcanonical JSON Linesではありません");
    }
    historyRecords = records;
    updates.push({ path, bytes: new TextEncoder().encode(source) });
  }
  if (state.transaction.marker.phase === "initial_state_committed") {
    updates.push({
      path: INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1,
      bytes: new TextEncoder().encode(serializeInitialPagesPublicationEvidence(evidence, digest)),
    });
  }
  updates.push({
    path: RUN_TRANSACTION_MARKER_STATE_PATH_V1,
    bytes: new TextEncoder().encode(serializeRunTransactionMarker(marker)),
  });
  assertStatePublicSafety({
    snapshot: state.snapshot,
    repositoryInventory,
    repositoryAllowlist: state.transaction.record.initialPagesProjection.repositoryAllowlist.map(
      (repository) => ({ ...repository, id: createGitHubRepositoryId(repository.id) }),
    ),
    additionalValues: [nextLedger, marker, evidence, ...historyRecords],
    knownSecrets,
  });
  updates.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return Object.freeze(updates);
}

/** ledgerとmarkerの候補が要求したmessage遷移と一致することを確かめる。 */
export function assertMessageCandidate(
  marker: RunTransactionMarker,
  ledger: StateNotificationLedger,
  context: NotificationMessageContext,
  result: "started" | "sent" | "clear_rejection",
  attemptId: string,
): void {
  if (
    marker.phase !== "notifications_in_progress" ||
    marker.lastMessageDeliveryId !== context.deliveryId ||
    context.notificationKeys.some((key) => {
      const entry = ledger.entries.find((value) => value.notificationKey === key);
      return (
        entry == null ||
        entry.lastDeliveryAttempt?.attemptId !== attemptId ||
        entry.lastDeliveryAttempt.result !== result ||
        (result === "started" && entry.status !== "delivery_started") ||
        (result === "sent" && entry.status !== "sent") ||
        (result === "clear_rejection" && entry.status !== "reserved")
      );
    })
  ) {
    throw new TypeError("通知messageのCAS候補が予定した遷移と一致しません");
  }
}
