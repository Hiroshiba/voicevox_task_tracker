import { serializeCanonicalJson } from "../canonical-json/value.js";
import type { NotificationDeliveryAttempt } from "../domain/notification-delivery-attempt.js";
import {
  createStateNotificationLedger,
  type StateNotificationLedger,
} from "../persistence/state-documents.js";
import type { DurablePublicationRecord } from "./durable-record-schema.js";
import { describeNotificationMessage } from "./notification-message-context.js";
import type { NotificationMessageState } from "./notification-message-state.js";

/** 解決する一つの開始済みmessageを特定する入力。 */
export type ManualResolutionTarget = Readonly<{
  runId: string;
  checkpointDigest: string;
  deliveryId: string;
  attemptId: string;
  notificationKeys: readonly string[];
  decision: "retry" | "acknowledge";
}>;

/** 固定outbox内の解決対象と開始済み試行を照合する。 */
export function startedManualResolutionAttempt(
  state: NotificationMessageState,
  target: ManualResolutionTarget,
): NotificationDeliveryAttempt {
  const { marker, record, initialPagesEvidence } = state.transaction;
  if (
    marker.phase !== "notifications_in_progress" ||
    marker.runId !== target.runId ||
    marker.checkpointDigest !== target.checkpointDigest ||
    record.runIdentity.runId !== target.runId ||
    record.checkpointDigest !== target.checkpointDigest ||
    state.snapshot.run.id !== target.runId ||
    initialPagesEvidence == null ||
    marker.lastMessageDeliveryId !== target.deliveryId ||
    record.notificationOutbox.action !== "send" ||
    record.notificationOutbox.selectedContext.action !== "create_digest"
  ) {
    throw new TypeError("手動解決対象が保留中の同じrunと一致しません");
  }
  const match = /:message:([1-9][0-9]*)$/u.exec(target.deliveryId);
  if (match?.[1] == null) {
    throw new TypeError("手動解決のdelivery IDが不正です");
  }
  const message = describeNotificationMessage(
    record,
    state.snapshot,
    initialPagesEvidence,
    Number(match[1]) - 1,
  );
  if (
    message.deliveryId !== target.deliveryId ||
    serializeCanonicalJson(message.notificationKeys) !==
      serializeCanonicalJson(target.notificationKeys)
  ) {
    throw new TypeError("手動解決のdelivery IDまたはnotification keyが固定outboxと一致しません");
  }
  const first = state.ledger.entries.find(
    (entry) => entry.notificationKey === target.notificationKeys[0],
  );
  const attempt = first?.lastDeliveryAttempt;
  if (
    first?.status !== "delivery_started" ||
    first.deliveryId !== target.deliveryId ||
    attempt?.result !== "started" ||
    attempt.attemptId !== target.attemptId ||
    serializeCanonicalJson(attempt.notificationKeys) !==
      serializeCanonicalJson(target.notificationKeys) ||
    target.notificationKeys.some((key) => {
      const entry = state.ledger.entries.find((value) => value.notificationKey === key);
      return (
        entry?.status !== "delivery_started" ||
        entry.deliveryId !== target.deliveryId ||
        serializeCanonicalJson(entry.lastDeliveryAttempt) !== serializeCanonicalJson(attempt) ||
        entry.manualResolution != null
      );
    }) ||
    state.ledger.entries.some(
      (entry) => entry.status === "delivery_started" && entry.deliveryId !== target.deliveryId,
    )
  ) {
    throw new TypeError("手動解決対象に一意な開始済み送達試行がありません");
  }
  return attempt;
}

/** 開始試行を監査保持して予約復帰または確認済みへ遷移する。 */
export function resolveManualNotificationLedger(
  state: NotificationMessageState,
  target: ManualResolutionTarget,
  operationId: string,
  resolvedAt: string,
): StateNotificationLedger {
  const attempt = startedManualResolutionAttempt(state, target);
  if (resolvedAt < attempt.startedAt) {
    throw new TypeError("手動解決時刻は送信開始以後にしてください");
  }
  const record: DurablePublicationRecord = state.transaction.record;
  if (
    record.notificationOutbox.action !== "send" ||
    record.notificationOutbox.selectedContext.action !== "create_digest"
  ) {
    throw new TypeError("手動解決の固定予約がありません");
  }
  const selection = record.notificationOutbox.selectedContext;
  const reservations = new Map(
    selection.ledgerReservations.map((entry) => [entry.notificationKey, entry]),
  );
  const keys = new Set(target.notificationKeys);
  const resolution = {
    deliveryId: target.deliveryId,
    attemptId: target.attemptId,
    operationId,
    decision: target.decision,
    resolvedAt,
  } as const;
  const entries = state.ledger.entries.map((entry) => {
    if (!keys.has(entry.notificationKey)) {
      return entry;
    }
    const reservation = reservations.get(entry.notificationKey);
    if (
      reservation?.status !== "reserved" ||
      entry.status !== "delivery_started" ||
      entry.itemNodeId !== reservation.itemNodeId ||
      entry.reasonCode !== reservation.reasonCode ||
      entry.severity !== reservation.severity ||
      entry.reservedAt !== reservation.reservedAt
    ) {
      throw new TypeError("手動解決のledger entryが固定予約と一致しません");
    }
    const base = {
      notificationKey: entry.notificationKey,
      itemNodeId: entry.itemNodeId,
      reasonCode: entry.reasonCode,
      severity: entry.severity,
      reservedAt: entry.reservedAt,
      lastDeliveryAttempt: attempt,
      manualResolution: resolution,
    };
    return target.decision === "retry"
      ? { ...base, status: "reserved" as const, expiresAt: reservation.expiresAt }
      : { ...base, status: "acknowledged" as const, acknowledgedAt: resolvedAt };
  });
  return createStateNotificationLedger({
    schemaVersion: state.ledger.schemaVersion,
    entries,
    operationsAlerts: state.ledger.operationsAlerts,
    pendingNotifications:
      target.decision === "retry"
        ? state.ledger.pendingNotifications
        : state.ledger.pendingNotifications.filter((pending) => !keys.has(pending.notificationKey)),
  });
}
