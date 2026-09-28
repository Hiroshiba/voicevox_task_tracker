import { settleWorkflowNotifications } from "../../run-publication/workflow-notifications.js";
import type { WorkflowStageDependencies } from "../../workflow-stage.js";

/** split workflowの通知settlementを共通stageへ接続する。 */
export function createSettleWorkflowNotificationsStage(
  adapters: Parameters<typeof settleWorkflowNotifications>[0],
): WorkflowStageDependencies["settleNotifications"] {
  return (command) => settleWorkflowNotifications(adapters, command);
}
