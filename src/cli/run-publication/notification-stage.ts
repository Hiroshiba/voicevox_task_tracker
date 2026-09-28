import { createUtcIsoDateTime } from "../../domain/index.js";
import { readNotificationMessageState } from "../notification-message-state.js";
import { settleNotifications } from "../notification-settlement.js";
import { createNotificationSettlementPort } from "../notification-stage-runtime.js";
import type { DailyPublicationStageHandlers, RunPublicationAdapters } from "./contracts.js";

type NotificationAdapters = Pick<
  RunPublicationAdapters,
  "environment" | "createStateBranchAdapter" | "discordHttpClient" | "diagnosticsRecorder" | "now"
>;

/** 初回Pages成功後の通知を保存済みrecordと同じsettlement stageで確定する。 */
export async function settleDailyNotifications(
  adapters: NotificationAdapters,
  input: Parameters<DailyPublicationStageHandlers["settleNotifications"]>[0],
): ReturnType<DailyPublicationStageHandlers["settleNotifications"]> {
  const initialStateReceipt = input.persisted.result.receipt;
  const configuration = input.configuration.target.state;
  const initial = await readNotificationMessageState(
    adapters.createStateBranchAdapter(),
    configuration,
    initialStateReceipt.result.resultingStateRevision,
  );
  const outcome = await settleNotifications(
    {
      record: initial.transaction.record,
      initialStateReceipt,
      initialPages: {
        kind: "published",
        buildReceipt: input.pages.prepared.receipt,
        deploymentReceipt: input.pages.deployment.receipt,
        evidence: input.pages.deployment.evidence,
      },
      pagesReceipt: input.pages.deployment.receipt,
    },
    createNotificationSettlementPort(
      adapters,
      configuration,
      input.repositoryInventory.inventory,
      input.configuration.credentials.knownSecrets,
      input.configuration.target.kind === "production" ? "production" : "recording",
    ),
  );
  if (outcome.kind !== "settled") {
    throw new TypeError(`通知settlementを確定できません。状態: ${outcome.kind}`);
  }
  const sentAt = outcome.messageReceipts
    .filter((entry) => entry.receipt.status === "sent")
    .map((entry) => entry.receipt.effectOccurredAt)
    .sort()
    .at(-1);
  return Object.freeze({
    value: outcome,
    notificationCount: outcome.notificationCount,
    discordSentAt:
      sentAt == null || input.configuration.target.kind !== "production"
        ? null
        : createUtcIsoDateTime(sentAt),
  });
}
