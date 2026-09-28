import type { DailyRunInvocation, DailyTransactionDependencies } from "../../daily-transaction.js";
import type { GitHubRunSessions } from "../../../infrastructure/tracking-run/github-port.js";
import type { GraphReconciledRun } from "../../../application/tracking-run/stages/graph-reconciliation.js";
import { closeFinalizedRunEvidence } from "../../../application/tracking-run/stages/evidence-closure.js";
import { buildFinalSnapshot } from "../../../application/tracking-run/stages/final-snapshot.js";
import type { FinalSnapshotCandidate } from "../../../application/tracking-run/contracts/final-snapshot.js";
import { nodeContentDigestPort } from "../../../infrastructure/tracking-run/content-digest.js";
import { createStateSnapshot, type StateSnapshot } from "../../../persistence/index.js";
import type {
  CodexAnalysis,
  CollectedItems,
  PersonalReminderAnalysis,
  ProductionTypes,
  RepositoryInventory,
  RuntimeConfiguration,
  RuntimeState,
  ValidatedRunWithPreview,
} from "../contracts.js";
import { createEvidenceClosureAdditions } from "./evidence-additions.js";
import { stateHistoryInputEvents } from "./history-events.js";
import {
  mergeSelectedNotificationLedger,
  selectValidationNotifications,
} from "./notification-selection.js";

function provisionalSnapshotForLegacyValidation(candidate: FinalSnapshotCandidate): StateSnapshot {
  // TODO: Task17-2の完全性proofが生成された後だけcompleteを付与する。
  return createStateSnapshot({
    ...candidate,
    run: Object.freeze({ ...candidate.run, complete: true }),
  });
}

function validateRunCompleteness(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  codexAnalysis: CodexAnalysis,
  graphReconciled: GraphReconciledRun,
  personalReminderAnalysis: PersonalReminderAnalysis,
): ValidatedRunWithPreview {
  const notification = selectValidationNotifications(
    invocation,
    configuration,
    state,
    inventory,
    collection,
    graphReconciled,
    personalReminderAnalysis,
  );
  const historyInputEvents = stateHistoryInputEvents(graphReconciled.data.reduction);
  const closure = closeFinalizedRunEvidence(
    personalReminderAnalysis.finalized,
    createEvidenceClosureAdditions(
      state,
      codexAnalysis,
      graphReconciled,
      personalReminderAnalysis,
      historyInputEvents,
      notification.notificationItems,
      notification.pendingNotifications,
    ),
  );
  const snapshot = provisionalSnapshotForLegacyValidation(
    buildFinalSnapshot(personalReminderAnalysis.finalized, closure, nodeContentDigestPort),
  );
  return Object.freeze({
    snapshot,
    historyInputEvents,
    notificationLedger: mergeSelectedNotificationLedger(state, notification),
    notificationSelection: notification.notificationSelection,
    notificationPreview: notification.notificationPreview,
    evidenceClosure: closure,
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
    graphReconciled,
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
        graphReconciled,
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
