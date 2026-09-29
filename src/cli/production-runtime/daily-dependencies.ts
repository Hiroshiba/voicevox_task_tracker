import type { DailyTransactionDependencies } from "../daily-transaction.js";
import { analyzeDeterministically } from "../../application/tracking-run/stages/deterministic.js";
import { reconcileAdoptedGraph } from "../../application/tracking-run/stages/graph-reconciliation.js";
import { planPublication } from "../../publication/plan-publication.js";
import { nodeContentDigestPort } from "../../infrastructure/tracking-run/content-digest.js";
import type { ProductionRuntimeAdapters } from "./adapters.js";
import {
  createAdoptGenericAiStage,
  createAnalyzeWithCodexStage,
  createPlanGenericAiStage,
} from "./codex/stage.js";
import { createCollectItemsStage } from "./collection/stage.js";
import type { ProductionTypes } from "./contracts.js";
import {
  createReadAiProcessAttemptCountStage,
  createValidateConfigurationStage,
} from "./daily-startup/configuration.js";
import { GitHubRunSessions } from "../../infrastructure/tracking-run/github-port.js";
import { projectLegacyRepositoryInventory } from "../tracking-run/migration-bridge/inventory.js";
import { projectLegacyCollection } from "../tracking-run/migration-bridge/collection.js";
import { createCollectInventoryStage } from "./daily-startup/inventory.js";
import { createLoadStateStage } from "./daily-startup/state.js";
import { createPrepareRunStage } from "./daily-startup/preparation.js";
import { createAnalyzePersonalRemindersStage } from "./personal-reminder/stage.js";
import {
  createWriteCollectAnalyzeArtifactStage,
  createWriteDryRunArtifactStage,
  createWriteReportStage,
} from "./publication/artifact.js";
import { createFinalizeRunStage } from "./publication/completion.js";
import { createSettleNotificationsStage } from "./publication/notification.js";
import { createBuildPagesStage, createDeployPagesStage } from "./publication/pages.js";
import {
  createCommitPreparedCheckpointStage,
  createPersistStateStage,
  createPrepareCheckpointStage,
  createReadCommittedStateStage,
} from "./publication/persistence.js";
import {
  createBuildNotificationHistoryPagesStage,
  createDeployNotificationHistoryPagesStage,
} from "./publication/history-pages.js";
import { createValidateCompletenessStage } from "./validation/stage.js";

/** 日次transactionの各段階を既存アダプターへ接続する。 */
export function createDailyDependencies(
  adapters: ProductionRuntimeAdapters,
): DailyTransactionDependencies<ProductionTypes> {
  const githubSessions = new GitHubRunSessions();
  return Object.freeze({
    ...(adapters.diagnosticsRecorder == null
      ? {}
      : { diagnosticsRecorder: adapters.diagnosticsRecorder }),
    readAiProcessAttemptCount: createReadAiProcessAttemptCountStage(),
    validateConfiguration: createValidateConfigurationStage(adapters),
    loadState: createLoadStateStage(adapters),
    prepareRun: createPrepareRunStage(),
    collectInventory: createCollectInventoryStage(adapters, githubSessions),
    projectLegacyRepositoryInventory,
    collectIncrementalItems: createCollectItemsStage(adapters, githubSessions),
    projectLegacyCollection,
    applyDeterministicRules: analyzeDeterministically,
    planGenericAi: createPlanGenericAiStage(adapters),
    analyzeWithCodex: createAnalyzeWithCodexStage(adapters),
    adoptGenericAi: createAdoptGenericAiStage(),
    reconcileAdoptedGraph,
    analyzePersonalReminders: createAnalyzePersonalRemindersStage(adapters),
    validateCompleteness: createValidateCompletenessStage(githubSessions),
    planPublication: (validated) => planPublication(validated, nodeContentDigestPort),
    prepareCheckpoint: createPrepareCheckpointStage(adapters),
    commitPreparedCheckpoint: createCommitPreparedCheckpointStage(adapters),
    readCommittedState: createReadCommittedStateStage(adapters),
    persistState: createPersistStateStage(adapters),
    buildPages: createBuildPagesStage(adapters),
    deployPages: createDeployPagesStage(adapters),
    settleNotifications: createSettleNotificationsStage(adapters),
    finalizeRun: createFinalizeRunStage(adapters),
    buildNotificationHistoryPages: createBuildNotificationHistoryPagesStage(adapters),
    deployNotificationHistoryPages: createDeployNotificationHistoryPagesStage(adapters),
    writeDryRunArtifact: createWriteDryRunArtifactStage(adapters),
    writeCollectAnalyzeArtifact: createWriteCollectAnalyzeArtifactStage(adapters),
    writeReport: createWriteReportStage(adapters),
  } satisfies DailyTransactionDependencies<ProductionTypes>);
}
