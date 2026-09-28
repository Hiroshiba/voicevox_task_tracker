import { recordCodexDiagnostic, type CodexDiagnosticsContext } from "../../../codex/index.js";
import { executePlannedPersonalReminderBatch } from "../../../codex/personal-reminder-runner.js";
import { summarizeAiBudgetLedger } from "../../../application/tracking-run/contracts/ai-budget-ledger.js";
import {
  executePersonalReminders,
  type PersonalReminderExecutionPort,
} from "../../../application/tracking-run/stages/personal-reminder-execution.js";
import type { GraphReconciledRun } from "../../../application/tracking-run/stages/graph-reconciliation.js";
import { planPersonalReminders } from "../../../application/tracking-run/stages/personal-reminder-plan.js";
import { nodeContentDigestPort } from "../../../infrastructure/tracking-run/content-digest.js";
import {
  createLabelEffectsResolver,
  type Evidence,
  type GitHubNodeId,
} from "../../../domain/index.js";
import { createPersonalReminderEvidenceSourceIndex } from "../../../persistence/index.js";
import { assertNonNullable } from "../../../util/index.js";
import {
  createCodexAdapterConfiguration,
  createCodexAdapterDependencies,
  createCodexPreflightDiagnostics,
} from "../../codex-runtime-support.js";
import type {
  DailyRunInvocation,
  DailyTransactionDependencies,
  PersonalReminderAnalysisStageResult,
} from "../../daily-transaction.js";
import { projectLegacyGraphReconciliation } from "../../tracking-run/migration-bridge/graph-reconciliation.js";
import { projectFinalAiDependencyContext } from "../../tracking-run/migration-bridge/personal-reminder-graph.js";
import { projectLegacyPersonalReminderCausePlan } from "../../tracking-run/migration-bridge/personal-reminder-plan.js";
import { projectLegacyPersonalReminderExecution } from "../../tracking-run/migration-bridge/personal-reminder-execution.js";
import {
  applyPersonalReminderCauseOutcomes,
  finalizePersonalReminderAnalysis,
  personalReminderCauseAttemptCounts,
  personalReminderUsageDelta,
  type PersonalReminderFinalizationItem,
} from "../../personal-reminder/index.js";
import type { PersonalReminderRuntimeAdapters } from "../adapters.js";
import { forcedAiAnalysisTarget } from "../ai-analysis-target.js";
import { CODEX_BACKEND_VERSION } from "../../../codex/backend-version.js";
import type {
  PersonalReminderAnalysis,
  ProductionTypes,
  RepositoryInventory,
  RuntimeConfiguration,
  RuntimeState,
} from "../contracts.js";
import { normalizeLabelRules } from "../label-rules.js";
import { previousSnapshot } from "../previous-state/snapshot.js";
import { findRepository, repositoryFullName } from "../repository-lookup.js";
import { personalReminderPreviousState } from "./context.js";

async function analyzePersonalReminders(
  adapters: PersonalReminderRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  graphReconciled: GraphReconciledRun,
): Promise<PersonalReminderAnalysisStageResult<PersonalReminderAnalysis>> {
  const { reduction, graph } = projectLegacyGraphReconciliation(graphReconciled);
  const collection = graphReconciled.data.collection;
  const unavailableConsumerNodeIds = new Set(graphReconciled.data.facts.unavailableConsumerNodeIds);
  const forcedTarget = forcedAiAnalysisTarget(configuration);
  const planned = planPersonalReminders(
    graphReconciled,
    forcedTarget != null,
    nodeContentDigestPort,
  );
  const plan = projectLegacyPersonalReminderCausePlan(planned.data.plan.causePlan);
  const currentEvidenceGroups: readonly (readonly Evidence[])[] = [
    ...reduction.items.map((item) => item.evidence),
    ...graph.edges.map((edge) => edge.evidence),
  ];
  const currentEvidenceBySourceId =
    createPersonalReminderEvidenceSourceIndex(currentEvidenceGroups);
  const previousState = personalReminderPreviousState(state);
  const continuityConflictNodeIds = new Set(
    plan.continuityConflicts.map((conflict) => conflict.itemNodeId),
  );
  const personalReminderFallbackNodeIds = new Set<GitHubNodeId>([
    ...unavailableConsumerNodeIds,
    ...continuityConflictNodeIds,
    ...plan.incompleteInputNodeIds,
    ...plan.deferredStructuralEndNodeIds,
  ]);
  const initialSummary = summarizeAiBudgetLedger(configuration.codexAttemptBudget.snapshot);
  const initialUsage = Object.freeze({
    calls:
      initialSummary.logicalCandidateCount + initialSummary.authenticationPreflightAttemptCount,
    inputCharacters: initialSummary.inputCharacters,
    estimatedCostUsd: initialSummary.estimatedCostUsd,
  });
  const diagnostics: CodexDiagnosticsContext | undefined =
    adapters.diagnosticsRecorder == null
      ? undefined
      : Object.freeze({
          recorder: adapters.diagnosticsRecorder,
          runId: invocation.runId,
          invocationId: invocation.invocationId,
          stage: "personal_reminder_analysis",
        });
  for (const conflict of plan.continuityConflicts) {
    await recordCodexDiagnostic(diagnostics, "codex.personal_reminder.continuity_conflict", {
      phase: "fallback",
      itemNodeId: conflict.itemNodeId,
      previousCauseIds: conflict.previousCauseIds,
    });
  }
  if (planned.data.plan.batches.length !== 0 && !configuration.credentials.codex.enabled) {
    throw new TypeError("AIが有効ですがCodex認証情報がありません");
  }
  const codexConfiguration = createCodexAdapterConfiguration(configuration.config);
  const codexDependencies = configuration.credentials.codex.enabled
    ? createCodexAdapterDependencies(
        adapters,
        configuration.credentials.codex,
        configuration.codexAttemptBudget,
        diagnostics,
        undefined,
      )
    : undefined;
  const preflightDiagnostics = createCodexPreflightDiagnostics(diagnostics, invocation);
  configuration.codexAttemptBudget.adoptPlannedSnapshot(planned.core.aiBudget);
  const port: PersonalReminderExecutionPort = Object.freeze({
    snapshot: () => configuration.codexAttemptBudget.snapshot,
    ensureReady: configuration.ensureCodexReady,
    executePreflight: (reservation) => {
      assertNonNullable(codexDependencies, "個人催促AIの認証実行依存がありません");
      return adapters.executeCodexAuthenticationPreflight(
        codexConfiguration,
        Object.freeze({
          ...codexDependencies,
          initialAttemptTicket: Object.freeze({ id: reservation.id }),
          ...(preflightDiagnostics == null ? {} : { diagnostics: preflightDiagnostics }),
        }),
      );
    },
    executeBatch: (batch) => {
      assertNonNullable(codexDependencies, "個人催促AIのbatch実行依存がありません");
      return executePlannedPersonalReminderBatch(
        batch,
        planned.data.plan.causes,
        Object.freeze({
          model: configuration.config.ai.model,
          reasoningEffort: configuration.config.ai.execution.reasoningEffort,
          backendVersion: CODEX_BACKEND_VERSION,
          minimumConfidence: configuration.config.ai.confidence.high,
          generatedAt: collection.evaluatedAt,
        }),
        Object.freeze({
          cache: state.session.personalReminderAiCache,
          ...(diagnostics == null ? {} : { diagnostics }),
          execute: () =>
            adapters.executeCodexPersonalReminderAnalysis(
              batch,
              codexConfiguration,
              Object.freeze({
                ...codexDependencies,
                initialAttemptTicket: Object.freeze({ id: batch.reservation.id }),
              }),
            ),
        }),
      );
    },
    release: (reservation) => {
      configuration.codexAttemptBudget.releaseInitialAttempt(Object.freeze({ id: reservation.id }));
    },
  });
  const executed = await executePersonalReminders(planned, port, nodeContentDigestPort);
  const run = projectLegacyPersonalReminderExecution(planned, executed);
  const application = applyPersonalReminderCauseOutcomes({
    plan,
    outcomes: run,
    evaluatedAt: collection.evaluatedAt,
  });
  const applicableItemNodeIds = new Set(plan.applicableItemNodeIds);
  const previousItemsByNodeId = new Map(
    (previousSnapshot(state)?.items ?? []).map((item) => [item.nodeId, item]),
  );
  const observedItemsByNodeId = new Map(
    collection.observedItems.map((item) => [item.nodeId, item]),
  );
  const expectedItemNodeIds = reduction.items.map((item) => item.nodeId);
  const finalizationItems: PersonalReminderFinalizationItem[] = [];
  for (const item of reduction.items) {
    const observedItem = observedItemsByNodeId.get(item.nodeId);
    const previousItem = previousItemsByNodeId.get(item.nodeId);
    const repositoryId =
      observedItem?.repositoryId ?? previousItem?.repositoryId ?? item.repositoryId;
    assertNonNullable(
      repositoryId,
      `個人催促causeのrepository IDがありません。対象: ${item.nodeId}`,
    );
    const repository = findRepository(inventory, repositoryId);
    const repositoryName = repositoryFullName(repository);
    const currentLabels = observedItem?.labels ?? previousItem?.labels ?? item.labels;
    if (applicableItemNodeIds.has(item.nodeId) && !continuityConflictNodeIds.has(item.nodeId)) {
      finalizationItems.push(
        Object.freeze({
          kind: "evaluated",
          itemNodeId: item.nodeId,
          itemState: item.state,
          collectionCompleteness: "complete",
          repositoryFullName: repositoryName,
          currentLabels,
        }),
      );
      continue;
    }
    assertNonNullable(
      previousItem,
      `個人催促runtime対象外の前回項目がありません。対象: ${item.nodeId}`,
    );
    finalizationItems.push(
      Object.freeze({
        kind: "retained",
        itemNodeId: item.nodeId,
        itemState: item.state,
        planningHandling: continuityConflictNodeIds.has(item.nodeId)
          ? Object.freeze({ kind: "force_pending", reason: "continuity_conflict" })
          : Object.freeze({ kind: "reconcile" }),
        previous: Object.freeze({
          causes: previousItem.personalReminderCauses,
          evidence: previousItem.evidence,
          planning: previousItem.personalReminderCausePlanning,
        }),
        repositoryFullName: repositoryName,
        currentLabels,
      }),
    );
  }
  const result = finalizePersonalReminderAnalysis({
    plan,
    application,
    expectedItemNodeIds,
    items: finalizationItems,
    evaluatedAt: collection.evaluatedAt,
    aiDependencyContext: projectFinalAiDependencyContext(graphReconciled),
    currentEvidenceBySourceId,
    previousEvidenceBySourceId: previousState.previousEvidenceBySourceId,
    minimumAiConfidence: configuration.config.ai.confidence.medium,
    thresholdsHours: configuration.config.staleness.thresholdsHours,
    resolveLabelEffects: createLabelEffectsResolver(normalizeLabelRules(configuration.config)),
  });
  const counts = personalReminderCauseAttemptCounts(result);
  const finalSummary = summarizeAiBudgetLedger(configuration.codexAttemptBudget.snapshot);
  const usage = Object.freeze({
    calls: finalSummary.logicalCandidateCount + finalSummary.authenticationPreflightAttemptCount,
    inputCharacters: finalSummary.inputCharacters,
    estimatedCostUsd: finalSummary.estimatedCostUsd,
  });
  const usageDelta = personalReminderUsageDelta(usage, initialUsage);
  const status =
    personalReminderFallbackNodeIds.size > 0 ||
    counts.failed > 0 ||
    counts.deferred > 0 ||
    [...result.itemsByNodeId.values()].some((item) => item.planning.status === "pending")
      ? "fallback"
      : "success";
  await recordCodexDiagnostic(diagnostics, "codex.personal_reminder.summary", {
    phase: "summary",
    candidateCauseCount: planned.data.plan.causes.filter((cause) => cause.choice === "execute")
      .length,
    aiCallCount: usageDelta.calls,
    cacheHitCauseCount: run.cacheHitCauseCount,
  });
  return Object.freeze({
    status,
    value: Object.freeze({
      status,
      result,
      run,
      budgetUsage: usage,
      authenticationPreflightExecuted:
        finalSummary.authenticationPreflightAttemptCount >
        initialSummary.authenticationPreflightAttemptCount,
    }),
    aiCallCount: usage.calls,
    estimatedInputTokens: finalSummary.estimatedInputTokens,
    personalReminderCauseCount: [...result.itemsByNodeId.values()].reduce(
      (count, item) => count + item.causeResults.length,
      0,
    ),
    personalReminderAiCallCount:
      finalSummary.logicalCandidateCount - initialSummary.logicalCandidateCount,
    personalReminderAiCacheHitCount: run.cacheHitCauseCount,
    personalReminderAssessmentReuseCount: planned.data.plan.causes.filter(
      (cause) => cause.choice === "snapshot_reuse",
    ).length,
    personalReminderUnknownCount: counts.unknown,
    personalReminderFailedCount: counts.failed,
    personalReminderDeferredCount: counts.deferred,
    personalReminderNotEvaluatedCount: counts.notEvaluated,
    diagnostics: Object.freeze([]),
  });
}

/** 個人向けリマインダー解析段階を既存adapterへ接続する。 */
export function createAnalyzePersonalRemindersStage(
  adapters: PersonalReminderRuntimeAdapters,
): DailyTransactionDependencies<ProductionTypes>["analyzePersonalReminders"] {
  return ({
    invocation,
    configuration,
    state,
    repositoryInventory,
    genericAiExecuted,
    graphReconciled,
  }) => {
    const currentLedger = configuration.codexAttemptBudget.snapshot;
    if (
      currentLedger.ledgerId !== genericAiExecuted.core.aiBudget.ledgerId ||
      currentLedger.sequence !== genericAiExecuted.core.aiBudget.sequence
    ) {
      throw new TypeError("個人催促AIへ渡す共有予算が汎用AI実行結果と一致しません");
    }
    return analyzePersonalReminders(
      adapters,
      invocation,
      configuration,
      state,
      repositoryInventory,
      graphReconciled,
    );
  };
}
