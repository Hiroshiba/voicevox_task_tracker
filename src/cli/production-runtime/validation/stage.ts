import type { DailyRunInvocation, DailyTransactionDependencies } from "../../daily-transaction.js";
import type { GitHubRunSessions } from "../../../infrastructure/tracking-run/github-port.js";
import type { GenericAiAdoptedRun } from "../../../application/tracking-run/stages/generic-ai-adoption.js";
import type { GraphReconciledRun } from "../../../application/tracking-run/stages/graph-reconciliation.js";
import type {
  CodexAnalysis,
  CollectedItems,
  GraphResult,
  PersonalReminderAnalysis,
  ProductionTypes,
  ReducedAnalysis,
  RepositoryInventory,
  RuntimeConfiguration,
  RuntimeState,
  ValidatedRunWithPreview,
} from "../contracts.js";
import { stateHistoryInputEvents } from "./history-events.js";
import {
  mergeSelectedNotificationLedger,
  selectValidationNotifications,
} from "./notification-selection.js";
import { createValidatedSnapshot } from "./snapshot-state.js";

function validateRunCompleteness(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  codexAnalysis: CodexAnalysis,
  genericAiAdopted: GenericAiAdoptedRun,
  graphReconciled: GraphReconciledRun,
  reduction: ReducedAnalysis,
  graph: GraphResult,
  personalReminderAnalysis: PersonalReminderAnalysis,
): ValidatedRunWithPreview {
  const snapshot = createValidatedSnapshot(
    invocation,
    configuration,
    state,
    collection,
    codexAnalysis,
    genericAiAdopted,
    graphReconciled,
    reduction,
    graph,
    personalReminderAnalysis,
  );
  const notification = selectValidationNotifications(
    invocation,
    configuration,
    state,
    inventory,
    collection,
    reduction,
    graph,
    personalReminderAnalysis,
  );
  return Object.freeze({
    snapshot,
    historyInputEvents: stateHistoryInputEvents(reduction),
    notificationLedger: mergeSelectedNotificationLedger(state, notification),
    notificationSelection: notification.notificationSelection,
    notificationPreview: notification.notificationPreview,
  });
}

/** 完全性検証段階を作る。 */
export function createValidateCompletenessStage(
  sessions: GitHubRunSessions,
): DailyTransactionDependencies<ProductionTypes>["validateCompleteness"] {
  return ({
    invocation,
    configuration,
    state,
    repositoryInventory,
    collection,
    codexAnalysis,
    genericAiAdopted,
    graphReconciled,
    reduction,
    graph,
    personalReminderAnalysis,
  }) => {
    try {
      const value = validateRunCompleteness(
        invocation,
        configuration,
        state,
        repositoryInventory,
        collection,
        codexAnalysis,
        genericAiAdopted,
        graphReconciled,
        reduction,
        graph,
        personalReminderAnalysis,
      );
      sessions.assertPublicBoundary(invocation.runId, [
        value,
        state.session.pendingAiCacheEntries(),
        state.session.pendingPersonalReminderAiCacheEntries(),
      ]);
      return Promise.resolve(
        Object.freeze({
          status: "complete",
          value,
          diagnostics: Object.freeze([]),
        }),
      );
    } finally {
      sessions.release(invocation.runId);
    }
  };
}
