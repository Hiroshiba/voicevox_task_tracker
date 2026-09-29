import { finalizeWorkflowRun } from "../../run-publication/workflow-notifications.js";
import type { WorkflowStageDependencies } from "../../workflow-stage.js";

/** split workflowの最終CASを共通stageへ接続する。 */
export function createFinalizeWorkflowRunStage(
  adapters: Parameters<typeof finalizeWorkflowRun>[0],
): WorkflowStageDependencies["finalizeRun"] {
  return async (command) => {
    await finalizeWorkflowRun(adapters, command);
  };
}
