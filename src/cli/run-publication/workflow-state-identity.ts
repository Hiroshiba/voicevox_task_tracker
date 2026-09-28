import { hashCanonicalJson } from "../../canonical-json/index.js";
import type { StateNotificationLedger, StateSnapshot } from "../../persistence/index.js";
import type { ValidatedRun } from "./contracts.js";

type WorkflowStateIdentity = Pick<
  ValidatedRun,
  "artifactValueDigests" | "notificationLedger" | "notificationSelection"
>;

function ledgerMismatch(): never {
  throw new TypeError("workflow artifactとtracker-state branchの初期通知ledgerが一致しません");
}

function compareNotificationKeys(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function initialOperationsAlerts(
  initialLedger: StateNotificationLedger,
  ledger: StateNotificationLedger,
): StateNotificationLedger["operationsAlerts"] {
  const initialKeys = new Set(initialLedger.operationsAlerts.map((entry) => entry.alertKey));
  const entries = ledger.operationsAlerts.filter((entry) => initialKeys.has(entry.alertKey));
  if (entries.length !== initialLedger.operationsAlerts.length) {
    ledgerMismatch();
  }
  return entries;
}

/** workflow artifactで検証したsnapshotと保存済みsnapshotの同一性を確認する。 */
export function assertWorkflowSnapshotMatches(
  validated: WorkflowStateIdentity,
  snapshot: StateSnapshot,
): void {
  if (hashCanonicalJson(snapshot) !== validated.artifactValueDigests.snapshot) {
    throw new TypeError("workflow artifactとtracker-state branchのsnapshotが一致しません");
  }
}

/** workflow artifactの初期通知ledgerと保存済みledgerの同一性を確認する。 */
export function assertWorkflowInitialLedgerMatches(
  validated: WorkflowStateIdentity,
  ledger: StateNotificationLedger,
): void {
  if (
    hashCanonicalJson({
      ...ledger,
      operationsAlerts: initialOperationsAlerts(validated.notificationLedger, ledger),
    }) !== validated.artifactValueDigests.notificationLedger
  ) {
    ledgerMismatch();
  }
}

/** 通知の送達進捗を除いて初期通知ledgerが変わっていないことを確認する。 */
export function assertWorkflowDeliveryLedgerMatches(
  validated: WorkflowStateIdentity,
  ledger: StateNotificationLedger,
): void {
  const initialLedger = validated.notificationLedger;
  const initialEntries = new Map(
    initialLedger.entries.map((entry) => [entry.notificationKey, entry]),
  );
  const reservations = new Set(
    validated.notificationSelection.ledgerReservations.map((entry) => entry.notificationKey),
  );
  if (ledger.entries.length !== initialLedger.entries.length) {
    ledgerMismatch();
  }
  const entries = ledger.entries.map((entry) => {
    const initialEntry = initialEntries.get(entry.notificationKey);
    if (initialEntry == null) {
      return ledgerMismatch();
    }
    if (!reservations.has(entry.notificationKey) || entry.status === "reserved") {
      return entry;
    }
    if (
      initialEntry.status !== "reserved" ||
      entry.itemNodeId !== initialEntry.itemNodeId ||
      entry.reasonCode !== initialEntry.reasonCode ||
      entry.severity !== initialEntry.severity ||
      entry.reservedAt !== initialEntry.reservedAt ||
      (entry.status === "delivery_started" && entry.startedAt > initialEntry.expiresAt)
    ) {
      return ledgerMismatch();
    }
    return initialEntry;
  });
  const currentEntries = new Map(ledger.entries.map((entry) => [entry.notificationKey, entry]));
  for (const candidate of validated.notificationSelection.candidates) {
    const firstReason = candidate.reasons[0];
    const firstEntry = currentEntries.get(firstReason.notificationKey);
    if (firstEntry == null) {
      ledgerMismatch();
    }
    for (const reason of candidate.reasons) {
      const entry = currentEntries.get(reason.notificationKey);
      if (entry?.status !== firstEntry.status) {
        ledgerMismatch();
      }
      if (
        (entry.status === "delivery_started" &&
          firstEntry.status === "delivery_started" &&
          (entry.deliveryId !== firstEntry.deliveryId ||
            entry.startedAt !== firstEntry.startedAt)) ||
        (entry.status === "sent" &&
          firstEntry.status === "sent" &&
          (entry.discordMessageId !== firstEntry.discordMessageId ||
            entry.sentAt !== firstEntry.sentAt)) ||
        (entry.status === "acknowledged" &&
          firstEntry.status === "acknowledged" &&
          entry.acknowledgedAt !== firstEntry.acknowledgedAt)
      ) {
        ledgerMismatch();
      }
    }
  }
  const currentPendingKeys = new Set(
    ledger.pendingNotifications.map((notification) => notification.notificationKey),
  );
  const removedPending = initialLedger.pendingNotifications.filter((notification) => {
    const entry = currentEntries.get(notification.notificationKey);
    const delivered = entry?.status === "sent" || entry?.status === "acknowledged";
    if (currentPendingKeys.has(notification.notificationKey)) {
      if (reservations.has(notification.notificationKey) && delivered) {
        ledgerMismatch();
      }
      return false;
    }
    if (!reservations.has(notification.notificationKey) || !delivered) {
      return ledgerMismatch();
    }
    return true;
  });
  const pendingNotifications = [...ledger.pendingNotifications, ...removedPending].sort(
    (left, right) => compareNotificationKeys(left.notificationKey, right.notificationKey),
  );
  if (
    hashCanonicalJson({
      schemaVersion: ledger.schemaVersion,
      entries,
      operationsAlerts: initialOperationsAlerts(initialLedger, ledger),
      pendingNotifications,
    }) !== validated.artifactValueDigests.notificationLedger
  ) {
    ledgerMismatch();
  }
}
