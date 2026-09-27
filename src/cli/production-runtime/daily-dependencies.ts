import type { DailyTransactionDependencies } from "../daily-transaction.js";
import { analyzeDeterministically } from "../../application/tracking-run/stages/deterministic.js";
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
import { createReconcileGraphStage } from "./graph/stage.js";
import { createAnalyzePersonalRemindersStage } from "./personal-reminder/stage.js";
import {
  createWriteCollectAnalyzeArtifactStage,
  createWriteDryRunArtifactStage,
  createWriteReportStage,
} from "./publication/artifact.js";
import { createCompleteRunStage } from "./publication/completion.js";
import {
  createSendDiscordStage,
  createSendOperationsAlertStage,
} from "./publication/notification.js";
import { createBuildPagesStage } from "./publication/pages.js";
import { createPersistStateStage } from "./publication/persistence.js";
import { createReduceAnalysisStage } from "./reduction/stage.js";
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
    reduceAnalysis: createReduceAnalysisStage(),
    reconcileGraph: createReconcileGraphStage(),
    analyzePersonalReminders: createAnalyzePersonalRemindersStage(adapters),
    validateCompleteness: createValidateCompletenessStage(githubSessions),
    persistState: createPersistStateStage(),
    buildPages: createBuildPagesStage(adapters),
    sendDiscord: createSendDiscordStage(adapters),
    completeRun: createCompleteRunStage(adapters),
    sendOperationsAlert: createSendOperationsAlertStage(adapters),
    writeDryRunArtifact: createWriteDryRunArtifactStage(adapters),
    writeCollectAnalyzeArtifact: createWriteCollectAnalyzeArtifactStage(adapters),
    writeReport: createWriteReportStage(adapters),
  } satisfies DailyTransactionDependencies<ProductionTypes>);
}
