import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import { sendDailyOperationsAlert } from "../../run-publication/daily-stage-handlers.js";
import { settleDailyNotifications } from "../../run-publication/notification-stage.js";
import type { ProductionRuntimeAdapters } from "../adapters.js";
import type { ProductionTypes } from "../contracts.js";

type ProductionDailyDependencies = DailyTransactionDependencies<ProductionTypes>;
type NotificationRuntimeAdapters = Pick<
  ProductionRuntimeAdapters,
  | "environment"
  | "repositoryPath"
  | "loadConfig"
  | "openStateSession"
  | "createStateBranchAdapter"
  | "discordHttpClient"
  | "now"
  | "sleep"
  | "random"
  | "sendDiscord"
  | "diagnosticsRecorder"
>;

/** 日次runの通知settlementを共通stageへ接続する。 */
export function createSettleNotificationsStage(
  adapters: NotificationRuntimeAdapters,
): ProductionDailyDependencies["settleNotifications"] {
  return (input) => settleDailyNotifications(adapters, input);
}

/** 日次runの障害通知を既存公開処理へ接続する。 */
export function createSendOperationsAlertStage(
  adapters: NotificationRuntimeAdapters,
): ProductionDailyDependencies["sendOperationsAlert"] {
  return (input) => sendDailyOperationsAlert({ adapters }, input);
}
