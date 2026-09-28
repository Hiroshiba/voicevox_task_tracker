import type { DailyRunInvocation, DailyTransactionDependencies } from "../../daily-transaction.js";
import type { GitHubRunSessions } from "../../../infrastructure/tracking-run/github-port.js";
import type { GraphReconciledRun } from "../../../application/tracking-run/stages/graph-reconciliation.js";
import type { GenericAiAdoptedRun } from "../../../application/tracking-run/stages/generic-ai-adoption.js";
import { closeFinalizedRunEvidence } from "../../../application/tracking-run/stages/evidence-closure.js";
import { buildFinalSnapshot } from "../../../application/tracking-run/stages/final-snapshot.js";
import { validateRun } from "../../../application/tracking-run/stages/validate-run.js";
import { nodeContentDigestPort } from "../../../infrastructure/tracking-run/content-digest.js";
import { assertStatePublicSafety, createStateSnapshot } from "../../../persistence/index.js";
import type { RunMetrics } from "../../run-report.js";
import type {
  CodexAnalysis,
  CollectedItems,
  PersonalReminderAnalysis,
  ProductionTypes,
  RepositoryInventory,
  RuntimeConfiguration,
  RuntimeState,
  ValidatedRun,
} from "../contracts.js";
import { createEvidenceClosureAdditions } from "./evidence-additions.js";
import { stateHistoryInputEvents } from "./history-events.js";
import {
  mergeSelectedNotificationLedger,
  selectValidationNotifications,
} from "./notification-selection.js";
import { projectPublicationInputs } from "./publication-inputs.js";

async function validateRunCompleteness(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  codexAnalysis: CodexAnalysis,
  genericAiAdopted: GenericAiAdoptedRun,
  graphReconciled: GraphReconciledRun,
  personalReminderAnalysis: PersonalReminderAnalysis,
  metrics: RunMetrics,
  diagnostics: readonly string[],
  sessions: GitHubRunSessions,
): Promise<ValidatedRun> {
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
  const initialAiCacheEntries = state.session.pendingAiCacheEntries();
  const initialPersonalReminderAiCacheEntries =
    state.session.pendingPersonalReminderAiCacheEntries();
  const initialAdditions = createEvidenceClosureAdditions(
    initialAiCacheEntries,
    initialPersonalReminderAiCacheEntries,
    codexAnalysis,
    graphReconciled,
    personalReminderAnalysis,
    historyInputEvents,
    notification.notificationItems,
    notification.pendingNotifications,
  );
  const closure = closeFinalizedRunEvidence(personalReminderAnalysis.finalized, initialAdditions);
  const candidate = buildFinalSnapshot(
    personalReminderAnalysis.finalized,
    closure,
    nodeContentDigestPort,
  );
  const publicationInputs = projectPublicationInputs(
    configuration,
    await state.session.initialPublicationBaseState(candidate.generatedAt.slice(0, 10)),
  );
  const notificationLedger = mergeSelectedNotificationLedger(state, notification);
  const aiCacheAdditions = state.session.pendingAiCacheEntries();
  const personalReminderAiCacheAdditions = state.session.pendingPersonalReminderAiCacheEntries();
  const actualOutwardAdditions = createEvidenceClosureAdditions(
    aiCacheAdditions,
    personalReminderAiCacheAdditions,
    codexAnalysis,
    graphReconciled,
    personalReminderAnalysis,
    historyInputEvents,
    notification.notificationItems,
    notificationLedger.pendingNotifications,
  );
  return validateRun({
    expectedCore: Object.freeze({
      identity: Object.freeze({
        runId: invocation.runId,
        invocationId: invocation.invocationId,
        scheduledFor: invocation.scheduledFor,
        startedAt: invocation.startedAt,
      }),
      executionPolicy: invocation.executionPolicy,
      baseRevision: configuration.baseStateHead,
      configDigest: configuration.configDigest,
      allowlistDigest: inventory.allowlistDigest,
      evaluatedAt: collection.evaluatedAt,
    }),
    genericAiAdopted,
    graphReconciled,
    finalized: personalReminderAnalysis.finalized,
    candidate,
    closure,
    actualOutwardAdditions,
    historyInputEvents,
    aiCacheAdditions,
    personalReminderAiCacheAdditions,
    previousNotificationLedger: state.notificationLedger,
    notificationLedger,
    notificationSelection: notification.notificationSelection,
    notificationPreview: notification.notificationPreview,
    publicationInputs,
    ledgerEntriesToMerge: notification.ledgerEntriesToMerge,
    repositoryAllowlist: inventory.allowlist.repositories,
    metrics,
    diagnostics,
    digest: nodeContentDigestPort,
    createCompleteSnapshot: (value) =>
      createStateSnapshot({
        ...value,
        run: Object.freeze({ ...value.run, complete: true }),
      }),
    assertPublicSafety: (snapshot, values) => {
      assertStatePublicSafety({
        snapshot,
        repositoryInventory: inventory.inventory,
        repositoryAllowlist: inventory.allowlist.repositories,
        additionalValues: values.slice(1),
        knownSecrets: configuration.credentials.knownSecrets,
      });
      sessions.assertPublicBoundary(invocation.runId, values);
    },
  });
}

/** 完全性検証段階を作る。 */
export function createValidateCompletenessStage(
  sessions: GitHubRunSessions,
): DailyTransactionDependencies<ProductionTypes>["validateCompleteness"] {
  return async ({
    invocation,
    configuration,
    state,
    repositoryInventory,
    collection,
    codexAnalysis,
    genericAiAdopted,
    graphReconciled,
    personalReminderAnalysis,
    metrics,
    diagnostics,
  }) => {
    try {
      return await validateRunCompleteness(
        invocation,
        configuration,
        state,
        repositoryInventory,
        collection,
        codexAnalysis,
        genericAiAdopted,
        graphReconciled,
        personalReminderAnalysis,
        metrics,
        diagnostics,
        sessions,
      );
    } finally {
      sessions.release(invocation.runId);
    }
  };
}
