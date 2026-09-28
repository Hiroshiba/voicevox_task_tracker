import { hashCanonicalJson } from "../canonical-json/index.js";
import { serializeCanonicalJson } from "../canonical-json/value.js";
import type { InitialPagesPublicationEvidence } from "../application/tracking-run/initial-pages-evidence.js";
import type { NotificationMessageReceipt } from "../application/tracking-run/receipt-schema.js";
import { buildDiscordDigestPlan, type PreparedDiscordDigestMessage } from "../discord/payload.js";
import {
  appendStateHistoryNotificationEvents,
  parseStateHistoryRecords,
  serializeStateHistoryRecords,
} from "../persistence/history.js";
import { joinStatePath } from "../persistence/branch-adapter.js";
import type { StatePersistenceConfiguration } from "../persistence/branch-adapter.js";
import type { StateNotificationLedger } from "../persistence/state-documents.js";
import { normalNotificationLedgerValue, sortByKey } from "../publication/publication-order.js";
import {
  createNotificationHistoryContext,
  createNotificationHistoryEventsForMessage,
} from "./notification-history-runtime.js";
import { notificationLedgerEntry } from "./notification-ledger-normalization.js";
import { restoreNotificationSelection } from "./notification-message-context.js";
import type { NotificationMessageState } from "./notification-message-state.js";
import type { DurablePublicationRecord } from "./durable-record-schema.js";

function same(left: unknown, right: unknown): boolean {
  return serializeCanonicalJson(left) === serializeCanonicalJson(right);
}

function historySource(
  state: NotificationMessageState,
  configuration: StatePersistenceConfiguration,
): string {
  const path = joinStatePath(
    configuration.historyDirectory,
    `${state.snapshot.generatedAt.slice(0, 10)}.jsonl`,
  );
  const file = state.files.get(path);
  if (file?.status !== "present") {
    throw new TypeError("通知settlementの履歴fileがありません");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  if (serializeStateHistoryRecords(parseStateHistoryRecords(source)) !== source) {
    throw new TypeError("通知settlementの履歴fileがcanonical形式ではありません");
  }
  return source;
}

/** 固定outboxと保存済みsnapshotから送信message列を作る。 */
export function plannedNotificationMessages(
  record: DurablePublicationRecord,
  initial: NotificationMessageState,
  evidence: InitialPagesPublicationEvidence,
): readonly PreparedDiscordDigestMessage[] {
  const outbox = record.notificationOutbox;
  if (outbox.action !== "send") {
    return Object.freeze([]);
  }
  if (outbox.selectedContext.action === "skip_digest") {
    if (outbox.delivery !== "no_candidates" || outbox.selectedContext.reason !== "no_candidates") {
      throw new TypeError("送信0件の固定outboxが一致しません");
    }
    return Object.freeze([]);
  }
  if (outbox.delivery !== "send" || !outbox.settings.enabled) {
    throw new TypeError("送信actionの固定outboxが一致しません");
  }
  const selection = restoreNotificationSelection(record);
  const plan = buildDiscordDigestPlan({
    candidates: selection.candidates,
    ledgerReservations: selection.ledgerReservations,
    items: initial.snapshot.items,
    pagesUrl: evidence.pageUrl,
    generatedAt: initial.snapshot.generatedAt,
    mentions: outbox.settings.mentions,
  });
  const plannedKeys = plan.messages.flatMap((message) => message.notificationKeys);
  const reservedKeys = selection.ledgerReservations.map((entry) => entry.notificationKey);
  if (
    plan.messages.length === 0 ||
    new Set(plannedKeys).size !== plannedKeys.length ||
    !same([...plannedKeys].sort(), [...reservedKeys].sort())
  ) {
    throw new TypeError("送信messageと固定outboxのkey集合が一致しません");
  }
  return plan.messages;
}

/** 初回ledgerと非送信actionの保存値を照合する。 */
export function assertInitialNotificationLedger(
  record: DurablePublicationRecord,
  initial: NotificationMessageState,
  previous: StateNotificationLedger,
): void {
  const outbox = record.notificationOutbox;
  if (
    initial.transaction.marker.phase !== "initial_state_committed" ||
    initial.transaction.notificationLedgerDigest !== outbox.initialLedgerDigest ||
    initial.snapshot.run.id !== record.runIdentity.runId ||
    hashCanonicalJson(normalNotificationLedgerValue(previous)) !== outbox.previousLedgerDigest
  ) {
    throw new TypeError("通知settlementの初回ledgerまたはrunが一致しません");
  }
  if (outbox.action === "send") {
    if (
      !same(
        sortByKey(initial.ledger.pendingNotifications, (pending) => pending.notificationKey),
        sortByKey(
          outbox.selectedContext.pendingNotifications,
          (pending) => pending.notificationKey,
        ),
      )
    ) {
      throw new TypeError("送信actionの未送信候補が固定outboxと一致しません");
    }
    return;
  }
  if (
    !same(initial.ledger.pendingNotifications, outbox.pendingNotifications) ||
    initial.ledger.entries.some((entry) => entry.status === "delivery_started")
  ) {
    throw new TypeError("非送信actionの未送信候補またはledger状態が一致しません");
  }
  if (outbox.action === "hold") {
    if (!same(initial.ledger.entries, previous.entries)) {
      throw new TypeError("保留actionで通常ledger entryが変化しています");
    }
    return;
  }
  const acknowledgements = new Map(
    outbox.acknowledgedEntries.map((entry) => [entry.notificationKey, entry]),
  );
  const previousEntries = new Map(previous.entries.map((entry) => [entry.notificationKey, entry]));
  for (const entry of initial.ledger.entries) {
    const acknowledged = acknowledgements.get(entry.notificationKey);
    const old = previousEntries.get(entry.notificationKey);
    if (
      (acknowledged != null && !same(entry, acknowledged)) ||
      (entry.status === "acknowledged" && old?.status !== "acknowledged" && acknowledged == null) ||
      ((old?.status === "sent" || old?.status === "acknowledged") && !same(entry, old)) ||
      (acknowledged == null && (old == null || !same(entry, old)))
    ) {
      throw new TypeError("確認済みactionの初回ledger遷移が固定outboxと一致しません");
    }
  }
  if (
    [...acknowledgements.keys()].some(
      (key) => !initial.ledger.entries.some((entry) => entry.notificationKey === key),
    )
  ) {
    throw new TypeError("確認済みactionのacknowledged entryがledgerにありません");
  }
  if (
    previous.entries.some(
      (entry) =>
        !initial.ledger.entries.some(
          (current) => current.notificationKey === entry.notificationKey,
        ),
    )
  ) {
    throw new TypeError("確認済みactionで既存のledger entryが消えています");
  }
}

/** 全message結果と最終ledgerおよび履歴を照合する。 */
export function assertSettledNotificationContent(
  record: DurablePublicationRecord,
  initial: NotificationMessageState,
  current: NotificationMessageState,
  messages: readonly PreparedDiscordDigestMessage[],
  receipts: readonly NotificationMessageReceipt[],
  configuration: StatePersistenceConfiguration,
): Readonly<{ ledgerDigest: string; historyDigest: string; notificationCount: number }> {
  if (
    current.transaction.record.recordDigest !== record.recordDigest ||
    current.snapshot.run.id !== record.runIdentity.runId ||
    !same(current.snapshot, initial.snapshot) ||
    messages.length !== receipts.length
  ) {
    throw new TypeError("通知settlementのrun、snapshotまたはmessage件数が一致しません");
  }
  const initialEntries = new Map(
    initial.ledger.entries.map((entry) => [entry.notificationKey, entry]),
  );
  const currentEntries = new Map(
    current.ledger.entries.map((entry) => [entry.notificationKey, entry]),
  );
  const selectedKeys = new Set(messages.flatMap((message) => message.notificationKeys));
  const sentKeys = new Set<string>();
  if (
    initialEntries.size !== currentEntries.size ||
    initialEntries.size !== initial.ledger.entries.length ||
    currentEntries.size !== current.ledger.entries.length
  ) {
    throw new TypeError("通知settlementのledger entry集合が変化しています");
  }
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const receipt = receipts[index];
    if (
      message == null ||
      receipt == null ||
      receipt.status === "ambiguous" ||
      receipt.logicalTarget !== `message:${(index + 1).toString()}` ||
      !same(message.notificationKeys, receipt.result.notificationKeys)
    ) {
      throw new TypeError("通知settlementに未確定またはoutbox外のmessageがあります");
    }
    let firstAttempt:
      NonNullable<(typeof current.ledger.entries)[number]["lastDeliveryAttempt"]> | undefined;
    for (const key of message.notificationKeys) {
      const before = initialEntries.get(key);
      const after = currentEntries.get(key);
      if (before?.status !== "reserved" || after?.lastDeliveryAttempt == null) {
        throw new TypeError("通知settlementの全keyに送達試行がありません");
      }
      const attempt = after.lastDeliveryAttempt;
      if (
        attempt.operationId !== receipt.operationId ||
        (receipt.receiptKind === "executed" && attempt.attemptId !== receipt.attemptId) ||
        attempt.durableAttemptSequence !== receipt.durableAttemptSequence ||
        !same(attempt.notificationKeys, message.notificationKeys) ||
        attempt.completedAt !== receipt.effectOccurredAt ||
        (firstAttempt != null && !same(attempt, firstAttempt)) ||
        after.itemNodeId !== before.itemNodeId ||
        after.reasonCode !== before.reasonCode ||
        after.severity !== before.severity ||
        after.reservedAt !== before.reservedAt
      ) {
        throw new TypeError("通知settlementの全keyに同じ送達試行がありません");
      }
      firstAttempt = attempt;
      if (receipt.status === "sent") {
        if (
          after.status !== "sent" ||
          attempt.result !== "sent" ||
          after.discordMessageId !== receipt.result.discordMessageId ||
          attempt.discordMessageId !== receipt.result.discordMessageId ||
          after.sentAt !== attempt.completedAt
        ) {
          throw new TypeError("送信済みmessageと最終ledgerが一致しません");
        }
        sentKeys.add(key);
      } else if (
        after.status !== "reserved" ||
        attempt.result !== "clear_rejection" ||
        after.expiresAt !== before.expiresAt ||
        attempt.completedAt == null
      ) {
        throw new TypeError("明確拒否messageと最終ledgerが一致しません");
      }
    }
  }
  for (const [key, before] of initialEntries) {
    const after = currentEntries.get(key);
    if (!selectedKeys.has(key) && (after == null || !same(after, before))) {
      throw new TypeError("固定outbox外のledger entryが変化しています");
    }
  }
  const expectedPending = initial.ledger.pendingNotifications.filter(
    (pending) => !sentKeys.has(pending.notificationKey),
  );
  if (!same(current.ledger.pendingNotifications, expectedPending)) {
    throw new TypeError("通知settlementの未送信候補が送達結果と一致しません");
  }
  let expectedHistory = historySource(initial, configuration);
  if (record.notificationOutbox.action === "send" && messages.length > 0) {
    const context = createNotificationHistoryContext(
      initial.snapshot,
      restoreNotificationSelection(record),
    );
    for (const receipt of receipts) {
      if (receipt.status !== "sent") {
        continue;
      }
      const entries = receipt.result.notificationKeys.map((key) => {
        const entry = currentEntries.get(key);
        if (entry == null) {
          throw new TypeError("送信済み通知のledger entryがありません");
        }
        return notificationLedgerEntry(entry);
      });
      const events = createNotificationHistoryEventsForMessage(initial.snapshot, context, entries);
      expectedHistory = appendStateHistoryNotificationEvents(
        expectedHistory,
        record.runIdentity.runId,
        events,
      );
    }
  }
  const actualHistory = historySource(current, configuration);
  if (expectedHistory !== actualHistory) {
    throw new TypeError("通知settlementの送信履歴がmessage結果と一致しません");
  }
  const records = parseStateHistoryRecords(actualHistory);
  const matching = records.filter((item) => item.runId === record.runIdentity.runId);
  if (matching.length !== 1) {
    throw new TypeError("通知settlementのrun履歴が一意ではありません");
  }
  return Object.freeze({
    ledgerDigest: hashCanonicalJson(normalNotificationLedgerValue(current.ledger)),
    historyDigest: hashCanonicalJson(matching[0]),
    notificationCount: sentKeys.size,
  });
}
