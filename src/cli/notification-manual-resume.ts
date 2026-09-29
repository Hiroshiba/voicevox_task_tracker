import { randomUUID } from "node:crypto";

import { serializeCanonicalJson } from "../canonical-json/value.js";
import { verifyReceiptChain } from "../application/tracking-run/receipt-chain.js";
import type {
  ManualResolutionReceipt,
  NotificationMessageReceipt,
  Receipt,
} from "../application/tracking-run/receipt-schema.js";
import type { InitialPagesPublicationEvidence } from "../application/tracking-run/initial-pages-evidence.js";
import type { PreparedDiscordDigestMessage } from "../discord/payload.js";
import { nodeContentDigestPort as digest } from "../infrastructure/tracking-run/content-digest.js";
import { createStateCommitOperationId } from "../persistence/state-commit-metadata.js";
import { StateBranchConflictError } from "../persistence/errors.js";
import { MAX_INTERVENING_COMMITS } from "../persistence/state-orthogonal-advance.js";
import { commitNotificationSettlement } from "./notification-settlement-commit.js";
import { observeNotificationMessageDelivery } from "./notification-message-observation.js";
import { deliverNotificationMessage } from "./notification-message-delivery.js";
import { observeManualResolutionAtRevision } from "./manual-resolution-observation.js";
import { verifyManualResolutionReceipt } from "./manual-resolution.js";
import {
  readNotificationMessageState,
  type NotificationMessageState,
} from "./notification-message-state.js";
import { assertNextReceipt, receiptForSettlement } from "./notification-settlement-observation.js";
import type {
  NotificationSettlementInput,
  NotificationSettlementOutcome,
  NotificationSettlementPort,
  SettledMessageReceipt,
} from "./notification-settlement.js";

async function findMessageCommit(
  port: NotificationSettlementPort,
  headRevision: string,
  initialRevision: string,
  operationId: string,
  attemptId: string,
  transition: "reservation" | "result",
): Promise<Readonly<{ revision: string; expectedRevision: string }>> {
  const commitOperationId = createStateCommitOperationId({
    kind: "notification_message",
    deliveryOperationId: operationId,
    deliveryAttemptId: attemptId,
    transition,
  });
  let revision = headRevision;
  for (let count = 0; count < MAX_INTERVENING_COMMITS; count += 1) {
    if (revision === initialRevision) {
      break;
    }
    const commit = await port.adapter.readCommit(revision);
    if (commit.parent.status !== "present") {
      throw new TypeError("通知再開のGit祖先が初回stateへ到達しません");
    }
    if (commit.metadata.operationId === commitOperationId) {
      if (commit.metadata.commitScope !== "tracking_run") {
        throw new TypeError("通知再開のmessage commit scopeが一致しません");
      }
      let expectedRevision = commit.parent.revision;
      for (let skip = 0; skip < MAX_INTERVENING_COMMITS; skip += 1) {
        const preceding = await port.adapter.readCommit(expectedRevision);
        if (preceding.metadata.commitScope !== "operations_alert") {
          return { revision, expectedRevision };
        }
        if (preceding.parent.status !== "present") {
          throw new TypeError("通知再開の運用通知commitに親がありません");
        }
        expectedRevision = preceding.parent.revision;
      }
      throw new TypeError("通知再開の運用通知祖先探索が上限を超えました");
    }
    revision = commit.parent.revision;
  }
  throw new TypeError("通知再開のmessage commitをGit祖先で一意に特定できません");
}

async function previousMessageReceipt(
  input: NotificationSettlementInput,
  port: NotificationSettlementPort,
  state: NotificationMessageState,
  messages: readonly PreparedDiscordDigestMessage[],
  index: number,
): Promise<NotificationMessageReceipt | ManualResolutionReceipt> {
  const message = input.record.notificationOutbox;
  if (message.action !== "send" || message.selectedContext.action !== "create_digest") {
    throw new TypeError("通知再開に固定outboxがありません");
  }
  const evidence = state.transaction.initialPagesEvidence;
  if (evidence == null) {
    throw new TypeError("通知再開に初回Pages証拠がありません");
  }
  const described = message.selectedContext.ledgerReservations;
  const keys = new Set(described.map((entry) => entry.notificationKey));
  const selected = messages[index];
  if (selected == null || selected.notificationKeys.some((key) => !keys.has(key))) {
    throw new TypeError("通知再開の先行messageが固定outboxと一致しません");
  }
  const entry = state.ledger.entries.find(
    (candidate) => candidate.notificationKey === selected.notificationKeys[0],
  );
  if (entry == null) {
    throw new TypeError("通知再開の先行messageにledger entryがありません");
  }
  const attempt = entry.lastDeliveryAttempt;
  if (
    attempt == null ||
    serializeCanonicalJson(attempt.notificationKeys) !==
      serializeCanonicalJson(selected.notificationKeys)
  ) {
    throw new TypeError("通知再開の先行messageに確定済み試行がありません");
  }
  if (entry.status === "acknowledged") {
    const resolution = entry.manualResolution;
    if (resolution?.decision !== "acknowledge") {
      throw new TypeError("通知再開の先行確認済みmessageに手動判断がありません");
    }
    let revision = state.revision;
    for (let count = 0; count < MAX_INTERVENING_COMMITS; count += 1) {
      const commit = await port.adapter.readCommit(revision);
      if (
        commit.metadata.commitScope === "manual_resolution" &&
        commit.metadata.operationId === resolution.operationId
      ) {
        const observed = await observeManualResolutionAtRevision(
          port.adapter,
          port.configuration,
          revision,
          {
            runId: input.record.runIdentity.runId,
            checkpointDigest: input.record.checkpointDigest,
            deliveryId: resolution.deliveryId,
            attemptId: resolution.attemptId,
            notificationKeys: selected.notificationKeys,
            decision: "acknowledge",
          },
          {
            invocationId: randomUUID(),
            observedAt: port.now().toISOString(),
            receiptKind: "observed",
          },
        );
        return observed.receipt;
      }
      if (commit.parent.status !== "present") {
        break;
      }
      revision = commit.parent.revision;
    }
    throw new TypeError("通知再開の先行手動判断がGit祖先にありません");
  }
  if (
    (entry.status !== "sent" && entry.status !== "reserved") ||
    (attempt.result !== "sent" && attempt.result !== "clear_rejection")
  ) {
    throw new TypeError("通知再開の先行messageが確定していません");
  }
  const result = await findMessageCommit(
    port,
    state.revision,
    input.initialStateReceipt.result.resultingStateRevision,
    attempt.operationId,
    attempt.attemptId,
    "result",
  );
  const reservation = await findMessageCommit(
    port,
    result.revision,
    input.initialStateReceipt.result.resultingStateRevision,
    attempt.operationId,
    attempt.attemptId,
    "reservation",
  );
  const observed = await observeNotificationMessageDelivery(
    {
      record: input.record,
      initialStateReceipt: input.initialStateReceipt,
      initialPages: input.initialPages,
      previousReceipt: input.initialStateReceipt,
      expectedStateRevision: reservation.expectedRevision,
      messageIndex: index,
      invocationId: randomUUID(),
      localAttemptIndex: index,
    },
    port.adapter,
    port.configuration,
    result.revision,
    port.now().toISOString(),
  );
  if (observed == null || observed.receipt.status === "ambiguous") {
    throw new TypeError("通知再開の先行message結果を再観測できません");
  }
  return observed.receipt;
}

/** 検証済み手動判断を起点に固定outboxの残りを同じrunで確定する。 */
export async function resumeManualNotificationSettlement(
  input: NotificationSettlementInput,
  port: NotificationSettlementPort,
  initial: NotificationMessageState,
  current: NotificationMessageState,
  messages: readonly PreparedDiscordDigestMessage[],
  evidence: InitialPagesPublicationEvidence,
): Promise<NotificationSettlementOutcome> {
  if (input.manualResolutionReceipt == null) {
    throw new TypeError("通知の手動再開receiptがありません");
  }
  const verified = await verifyManualResolutionReceipt(
    port,
    input.manualResolutionReceipt,
    current.revision,
  );
  const manualRevision = verified.stateRevision;
  const manual = await readNotificationMessageState(
    port.adapter,
    port.configuration,
    manualRevision,
  );
  if (
    current.transaction.marker.runId !== input.record.runIdentity.runId ||
    current.transaction.marker.checkpointDigest !== input.record.checkpointDigest ||
    manual.transaction.marker.phase !== "notifications_in_progress" ||
    manual.transaction.record.recordDigest !== input.record.recordDigest ||
    current.transaction.record.recordDigest !== input.record.recordDigest ||
    current.transaction.initialPagesEvidence?.evidenceDigest !== evidence.evidenceDigest ||
    manual.transaction.initialPagesEvidence?.evidenceDigest !== evidence.evidenceDigest
  ) {
    throw new TypeError("手動解決後のstateが同じpending runの再開位置ではありません");
  }
  const match = /:message:([1-9][0-9]*)$/u.exec(verified.receipt.result.deliveryId);
  const targetIndex = match?.[1] == null ? -1 : Number(match[1]) - 1;
  if (
    targetIndex < 0 ||
    targetIndex >= messages.length ||
    serializeCanonicalJson(messages[targetIndex]?.notificationKeys) !==
      serializeCanonicalJson(verified.receipt.result.notificationKeys)
  ) {
    throw new TypeError("手動解決receiptが固定outboxのmessageと一致しません");
  }
  const previousState = await readNotificationMessageState(
    port.adapter,
    port.configuration,
    verified.evidence.parentRevision,
  );
  const attempt = previousState.ledger.entries.find(
    (entry) => entry.notificationKey === verified.receipt.result.notificationKeys[0],
  )?.lastDeliveryAttempt;
  if (attempt?.result !== "started") {
    throw new TypeError("手動再開の元送達試行が開始済みではありません");
  }
  const reservation = await findMessageCommit(
    port,
    previousState.revision,
    input.initialStateReceipt.result.resultingStateRevision,
    attempt.operationId,
    attempt.attemptId,
    "reservation",
  );
  const observedAmbiguous = await observeNotificationMessageDelivery(
    {
      record: input.record,
      initialStateReceipt: input.initialStateReceipt,
      initialPages: input.initialPages,
      previousReceipt: input.initialStateReceipt,
      expectedStateRevision: reservation.expectedRevision,
      messageIndex: targetIndex,
      invocationId: randomUUID(),
      localAttemptIndex: targetIndex,
    },
    port.adapter,
    port.configuration,
    reservation.revision,
    port.now().toISOString(),
  );
  if (observedAmbiguous?.receipt.status !== "ambiguous") {
    throw new TypeError("手動再開の曖昧な送達試行を再観測できません");
  }
  const observedManual = await observeManualResolutionAtRevision(
    port.adapter,
    port.configuration,
    manualRevision,
    {
      runId: input.record.runIdentity.runId,
      checkpointDigest: input.record.checkpointDigest,
      deliveryId: verified.receipt.result.deliveryId,
      attemptId: verified.receipt.result.deliveryAttemptId,
      notificationKeys: verified.receipt.result.notificationKeys,
      decision: verified.receipt.result.decision,
    },
    {
      invocationId: randomUUID(),
      observedAt: port.now().toISOString(),
      receiptKind: "observed",
      previousReceipt: observedAmbiguous.receipt,
    },
  );
  const chain: SettledMessageReceipt[] = [
    {
      receipt: observedAmbiguous.receipt,
      evidence: { kind: "notification_message_state", state: observedAmbiguous.evidence },
    },
    {
      receipt: observedManual.receipt,
      evidence: { kind: "manual_resolution_state", state: observedManual.evidence },
    },
  ];
  verifyReceiptChain(chain, digest);
  const finalReceipts: (NotificationMessageReceipt | ManualResolutionReceipt)[] = [];
  for (let index = 0; index < targetIndex; index += 1) {
    finalReceipts.push(await previousMessageReceipt(input, port, previousState, messages, index));
  }
  let previousReceipt: Receipt = observedManual.receipt;
  let expectedRevision = manualRevision;
  const invocationId = randomUUID();
  const firstIndex = verified.receipt.result.decision === "retry" ? targetIndex : targetIndex + 1;
  if (verified.receipt.result.decision === "acknowledge") {
    finalReceipts.push(observedManual.receipt);
  }
  for (let index = firstIndex; index < messages.length; index += 1) {
    const outcome = await deliverNotificationMessage(
      {
        record: input.record,
        initialStateReceipt: input.initialStateReceipt,
        initialPages: input.initialPages,
        previousReceipt,
        expectedStateRevision: expectedRevision,
        messageIndex: index,
        invocationId,
        localAttemptIndex: index,
        ...(index === targetIndex && verified.receipt.result.decision === "retry"
          ? { manualResolutionReceipt: observedManual.receipt }
          : {}),
      },
      port,
    );
    if (outcome.kind === "conflict" || outcome.kind === "state_unconfirmed") {
      throw new StateBranchConflictError();
    }
    assertNextReceipt(previousReceipt, outcome.receipt, expectedRevision);
    const next = { receipt: outcome.receipt, evidence: outcome.receiptEvidence };
    verifyReceiptChain([...chain, next], digest);
    chain.push(next);
    finalReceipts.push(outcome.receipt);
    previousReceipt = outcome.receipt;
    expectedRevision = outcome.stateRevision;
    if (outcome.kind === "ambiguous") {
      return {
        kind: "manual_resolution_required",
        receipt: outcome.receipt,
        messageReceipts: chain,
        stateRevision: expectedRevision,
      };
    }
  }
  const committed = await commitNotificationSettlement(
    input,
    port,
    initial,
    messages,
    finalReceipts,
    evidence,
    expectedRevision,
  );
  if (committed.kind !== "committed") {
    throw new StateBranchConflictError();
  }
  return receiptForSettlement(
    input,
    port,
    committed.revision,
    expectedRevision,
    previousReceipt,
    chain,
    finalReceipts,
    initial,
    messages,
    invocationId,
    !committed.observed,
  );
}
