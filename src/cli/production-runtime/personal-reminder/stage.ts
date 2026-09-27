import {
  CODEX_AUTHENTICATION_PREFLIGHT_INPUT_CHARACTERS,
  CODEX_AUTHENTICATION_PREFLIGHT_PROMPT,
  estimateAiInputCost,
  recordCodexDiagnostic,
  runPersonalReminderAiAnalyses,
  type CodexDiagnosticsContext,
  type CodexInitialAttemptTicket,
  type PersonalReminderAiRunConfiguration,
  type PersonalReminderAiRunResult,
} from "../../../codex/index.js";
import { summarizeAiBudgetLedger } from "../../../application/tracking-run/contracts/ai-budget-ledger.js";
import type { GraphReconciledRun } from "../../../application/tracking-run/stages/graph-reconciliation.js";
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
import {
  projectLegacyAnalyzedCollection,
  projectLegacyDeterministicAnalysis,
} from "../../tracking-run/migration-bridge/deterministic.js";
import { projectLegacyGraphReconciliation } from "../../tracking-run/migration-bridge/graph-reconciliation.js";
import {
  projectFinalAiDependencyContext,
  projectPersonalReminderGraphContext,
} from "../../tracking-run/migration-bridge/personal-reminder-graph.js";
import {
  applyPersonalReminderCauseOutcomes,
  finalizePersonalReminderAnalysis,
  personalReminderAiCandidate,
  personalReminderAssessmentReuseCount,
  personalReminderCauseAttemptCounts,
  personalReminderUsageDelta,
  type PersonalReminderFinalizationItem,
} from "../../personal-reminder/index.js";
import {
  createPersonalReminderRuntimeContext,
  planPersonalReminderCauses,
} from "../../personal-reminder-runtime.js";
import type { PersonalReminderRuntimeAdapters } from "../adapters.js";
import { forcedAiAnalysisTarget } from "../ai-analysis-target.js";
import { CODEX_BACKEND_VERSION } from "../../../codex/backend-version.js";
import type {
  CollectedItems,
  DeterministicAnalysis,
  PersonalReminderAnalysis,
  ProductionTypes,
  RepositoryInventory,
  RuntimeConfiguration,
  RuntimeState,
} from "../contracts.js";
import { normalizeLabelRules } from "../label-rules.js";
import { previousSnapshot } from "../previous-state/snapshot.js";
import { findRepository, repositoryFullName } from "../repository-lookup.js";
import { personalReminderPreviousState, personalReminderRuntimeCollection } from "./context.js";

async function analyzePersonalReminders(
  adapters: PersonalReminderRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  deterministicAnalysis: DeterministicAnalysis,
  graphReconciled: GraphReconciledRun,
): Promise<PersonalReminderAnalysisStageResult<PersonalReminderAnalysis>> {
  const { reduction, graph } = projectLegacyGraphReconciliation(graphReconciled);
  const unavailableConsumerNodeIds = collection.unavailableConsumerNodeIds;
  const runtimeCollection = personalReminderRuntimeCollection(
    collection,
    deterministicAnalysis,
    inventory,
    reduction,
    graph,
    unavailableConsumerNodeIds,
  );
  const runtimeGraph = projectPersonalReminderGraphContext(graphReconciled);
  const currentEvidenceGroups: readonly (readonly Evidence[])[] = [
    ...reduction.items.map((item) => item.evidence),
    ...graph.edges.map((edge) => edge.evidence),
  ];
  const currentEvidenceBySourceId =
    createPersonalReminderEvidenceSourceIndex(currentEvidenceGroups);
  const previousState = personalReminderPreviousState(state);
  const context = createPersonalReminderRuntimeContext({
    evaluatedAt: collection.evaluatedAt,
    state: previousState,
    collection: runtimeCollection.collection,
    graph: runtimeGraph,
    aiDependencyContext: projectFinalAiDependencyContext(graphReconciled),
    currentEvidenceBySourceId,
  });
  const plan = planPersonalReminderCauses(context);
  const continuityConflictNodeIds = new Set(
    plan.continuityConflicts.map((conflict) => conflict.itemNodeId),
  );
  const personalReminderFallbackNodeIds = new Set<GitHubNodeId>([
    ...unavailableConsumerNodeIds,
    ...continuityConflictNodeIds,
    ...plan.incompleteInputNodeIds,
    ...plan.deferredStructuralEndNodeIds,
  ]);
  const candidates = Object.freeze(
    plan.entries.flatMap((entry) => {
      const candidate = personalReminderAiCandidate(
        entry,
        graph.analysis.downstreamImpacts.find((impact) => impact.nodeId === entry.seed.itemNodeId),
      );
      return candidate == null ? [] : [candidate];
    }),
  );
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
  const forcedTarget = forcedAiAnalysisTarget(configuration);
  let run: PersonalReminderAiRunResult | undefined;
  if (configuration.config.ai.enabled && forcedTarget == null) {
    const codexCredentials = configuration.credentials.codex;
    if (!codexCredentials.enabled) {
      throw new TypeError("AIが有効ですがCodex認証情報がありません");
    }
    const codexConfiguration = createCodexAdapterConfiguration(configuration.config);
    const codexDependencies = createCodexAdapterDependencies(
      adapters,
      codexCredentials,
      configuration.codexAttemptBudget,
      diagnostics,
      undefined,
    );
    const preflightInputCost =
      codexCredentials.authentication === "auth-json"
        ? estimateAiInputCost(
            CODEX_AUTHENTICATION_PREFLIGHT_PROMPT,
            configuration.config.ai.budget.estimatedInputCostUsdPerMillionTokens,
          )
        : undefined;
    const preflightDiagnostics = createCodexPreflightDiagnostics(diagnostics, invocation);
    const preflight =
      initialSummary.authenticationPreflightAttemptCount > 0 || preflightInputCost == null
        ? undefined
        : Object.freeze({
            inputCharacters: CODEX_AUTHENTICATION_PREFLIGHT_INPUT_CHARACTERS,
            estimatedCostUsd: preflightInputCost.estimatedCostUsd,
            execute: (ticket: CodexInitialAttemptTicket) =>
              adapters.executeCodexAuthenticationPreflight(
                codexConfiguration,
                Object.freeze({
                  ...codexDependencies,
                  initialAttemptTicket: ticket,
                  ...(preflightDiagnostics == null
                    ? {}
                    : {
                        diagnostics: preflightDiagnostics,
                      }),
                }),
              ),
          });
    run = await runPersonalReminderAiAnalyses(
      candidates,
      {
        model: configuration.config.ai.model,
        reasoningEffort: configuration.config.ai.execution.reasoningEffort,
        backendVersion: CODEX_BACKEND_VERSION,
        budget: configuration.config.ai.budget,
        initialUsage,
        maxConcurrentCalls: configuration.config.ai.execution.maxConcurrentCalls,
        minimumConfidence: configuration.config.ai.confidence.high,
        inputCostUsdPerMillionTokens:
          configuration.config.ai.budget.estimatedInputCostUsdPerMillionTokens,
      } satisfies PersonalReminderAiRunConfiguration,
      {
        cache: state.session.personalReminderAiCache,
        attemptBudget: configuration.codexAttemptBudget,
        ensureReady: configuration.ensureCodexReady,
        ...(preflight == null ? {} : { preflight }),
        ...(diagnostics == null ? {} : { diagnostics }),
        execute: (input, ticket) =>
          adapters.executeCodexPersonalReminderAnalysis(
            input,
            codexConfiguration,
            Object.freeze({ ...codexDependencies, initialAttemptTicket: ticket }),
          ),
        executedAt: () => collection.evaluatedAt,
      },
    );
  }
  const application = applyPersonalReminderCauseOutcomes({
    plan,
    outcomes: run,
    evaluatedAt: collection.evaluatedAt,
  });
  const runtimeItemsByNodeId = new Map(
    runtimeCollection.collection.items.map((item) => [item.item.nodeId, item]),
  );
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
    const runtimeItem = runtimeItemsByNodeId.get(item.nodeId);
    if (runtimeItem != null && !continuityConflictNodeIds.has(item.nodeId)) {
      finalizationItems.push(
        Object.freeze({
          kind: "evaluated",
          itemNodeId: item.nodeId,
          itemState: item.state,
          collectionCompleteness: runtimeItem.completeness.status,
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
    aiDependencyContext: context.aiDependencyContext,
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
    candidateCauseCount: candidates.length,
    aiCallCount: usageDelta.calls,
    cacheHitCauseCount: run?.cacheHitCauseCount ?? 0,
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
    personalReminderAiCacheHitCount: run?.cacheHitCauseCount ?? 0,
    personalReminderAssessmentReuseCount: personalReminderAssessmentReuseCount(plan),
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
    deterministicallyAnalyzed,
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
      projectLegacyAnalyzedCollection(deterministicallyAnalyzed),
      projectLegacyDeterministicAnalysis(deterministicallyAnalyzed),
      graphReconciled,
    );
  };
}
