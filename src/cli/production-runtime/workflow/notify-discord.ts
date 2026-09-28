import { notifyWorkflowDiscord } from "../../run-publication/workflow-stage-handlers.js";
import type { WorkflowStageDependencies } from "../../workflow-stage.js";

/** workflowのDiscord通知段階を既存公開処理へ接続する。 */
export function createNotifyWorkflowDiscordStage(
  adapters: Parameters<typeof notifyWorkflowDiscord>[0]["adapters"],
): WorkflowStageDependencies["notifyDiscord"] {
  return (command) =>
    notifyWorkflowDiscord({ adapters }, command);
}
