import { WorkflowStageRunner } from "../../workflow-stage.js";
import type { ProductionRuntimeAdapters } from "../adapters.js";
import { createBuildWorkflowPagesStage } from "./build-pages.js";
import { prepareWorkflowNotificationHistoryPages } from "../../run-publication/workflow-history-pages.js";
import {
  preflightWorkflowPagesDeployment,
  recordWorkflowPagesDeployment,
} from "../../run-publication/deployment.js";
import { createSettleWorkflowNotificationsStage } from "./settle-notifications.js";
import { createFinalizeWorkflowRunStage } from "./finalize-run.js";
import { createNotifyWorkflowOperationsStage } from "./notify-operations.js";
import { createPersistWorkflowStateStage } from "./persist-state.js";
import { reportWorkflowRun } from "./report-run.js";
import { createResolveDiscordDeliveryStage } from "./resolve-delivery.js";
import {
  reportFailureCommand,
  verifyCheckpointCommand,
  verifyReceiptChainCommand,
  verifyRuntimeRecoveryCommand,
  inspectRunStateCommand,
} from "../../verify-publication.js";

/** workflowの各stageを実行順に接続する。 */
export function createWorkflowStageRunner(
  adapters: ProductionRuntimeAdapters,
): WorkflowStageRunner {
  return new WorkflowStageRunner({
    persistState: createPersistWorkflowStateStage(adapters),
    buildPages: createBuildWorkflowPagesStage(adapters),
    prepareNotificationHistoryPages: (command) =>
      prepareWorkflowNotificationHistoryPages(adapters, command),
    preflightPagesDeployment: (command) => preflightWorkflowPagesDeployment(adapters, command),
    recordPagesDeployment: (command) => recordWorkflowPagesDeployment(adapters, command),
    settleNotifications: createSettleWorkflowNotificationsStage(adapters),
    finalizeRun: createFinalizeWorkflowRunStage(adapters),
    notifyOperations: createNotifyWorkflowOperationsStage(adapters),
    resolveDiscordDelivery: createResolveDiscordDeliveryStage(adapters),
    reportWorkflow: (command) => reportWorkflowRun(adapters, command),
    verifyCheckpoint: (command) => verifyCheckpointCommand(adapters, command),
    verifyRuntimeRecovery: (command) => verifyRuntimeRecoveryCommand(adapters, command),
    inspectRunState: (command) => inspectRunStateCommand(adapters, command),
    verifyReceiptChain: (command) => verifyReceiptChainCommand(adapters, command),
    reportFailure: (command) => reportFailureCommand(adapters, command),
  });
}
