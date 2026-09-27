import type {
  GenericAiPlanningItemSource,
  GenericAiPlanningPort,
} from "../../../application/tracking-run/stages/generic-ai-plan.js";
import type { DeterministicallyAnalyzedRun } from "../../../application/tracking-run/stages/deterministic.js";
import type { DeterministicItemAnalysis } from "../../../application/tracking-run/stages/deterministic-item.js";
import { type AnalysisElementInputFingerprintMap } from "../../../codex/analysis-element-dependencies.js";
import {
  CODEX_AUTHENTICATION_PREFLIGHT_INPUT_CHARACTERS,
  CODEX_AUTHENTICATION_PREFLIGHT_PROMPT,
} from "../../../codex/preflight.js";
import { estimateAiInputCost } from "../../../codex/budget.js";
import { recordCodexDiagnostic, type CodexDiagnosticsContext } from "../../../codex/diagnostics.js";
import type { AnalysisElementPlanning } from "../../../codex/element-planning.js";
import type { CodexAnalysisInput } from "../../../codex/input.js";
import { serializeCodexTransportAnalysisInput } from "../../../codex/transport-alias.js";
import type { GraphNodeId, Relation } from "../../../domain/index.js";
import type { AnalyzeGraphResult } from "../../../graph/index.js";
import { relationNodes } from "../../../graph/relation-candidate-endpoints.js";
import { createCodexInput } from "../../codex-input-projection.js";
import { nodeContentDigestPort } from "../../../infrastructure/tracking-run/content-digest.js";
import { elementDependencyFingerprints } from "../analysis-identity.js";
import { forcedAiAnalysisTarget } from "../ai-analysis-target.js";
import type { RuntimeConfiguration, RuntimeState } from "../contracts.js";
import { previousGraphIndex } from "../previous-state/graph.js";
import { savedGenerationsForItem } from "../previous-state/saved-ai-elements.js";
import { previousSnapshot, previousTrackedItem } from "../previous-state/snapshot.js";
import { createEarliestRelationSourceOccurredAtById } from "../relation-source-occurrence.js";
import { necessityInputForAnalysis, preservedElementsForSelection } from "./input.js";
import { analysisImpactProofsForItem } from "./reuse.js";
import { reserveGenericAiBudget } from "./budget-plan.js";
import { createGenericAiCacheLookup } from "./planning-cache.js";

function createPriority(
  state: RuntimeState,
  run: DeterministicallyAnalyzedRun,
  analysis: DeterministicItemAnalysis,
  previousImpactByNodeId: ReadonlyMap<GraphNodeId, AnalyzeGraphResult["downstreamImpacts"][number]>,
  previousRelations: readonly Relation[],
): GenericAiPlanningItemSource["priority"] {
  const previousIncomingBlockers = new Set<string>(
    previousRelations
      .filter(
        (relation) =>
          relation.active &&
          relation.type === "blocks" &&
          relation.toNodeId === analysis.item.nodeId,
      )
      .map((relation) => relation.id),
  );
  const currentPotentialBlockers = new Set<string>(
    analysis.relationCandidates
      .filter((candidate) => {
        if (candidate.relation.type === "blocks") {
          return candidate.relation.blocked.nodeId === analysis.item.nodeId;
        }
        return candidate.authority === "inferred";
      })
      .map((candidate) => candidate.id),
  );
  const changedNodeIds = new Set(run.data.facts.changedNodeIds);
  const relatedNodeChanged = analysis.relationCandidates.some((candidate) =>
    relationNodes(candidate.relation).some(
      (node) =>
        node.nodeId !== analysis.item.nodeId &&
        node.scope === "organization" &&
        changedNodeIds.has(node.nodeId),
    ),
  );
  const previousImpact = previousImpactByNodeId.get(analysis.item.nodeId);
  const previousItem = previousTrackedItem(state, analysis.item.nodeId);
  return Object.freeze({
    previouslyDeferred: previousItem?.aiAnalysis.status === "deferred",
    severityCandidate: analysis.decision.determination === "codex_candidate",
    ownerUnknown: analysis.decision.waitingOn.some((waitingOn) => waitingOn.kind === "unknown"),
    changedBlocker:
      relatedNodeChanged ||
      previousIncomingBlockers.size !== currentPotentialBlockers.size ||
      [...previousIncomingBlockers].some((id) => !currentPotentialBlockers.has(id)),
    downstreamImpact: Object.freeze({
      openNodeCount: previousImpact?.openNodeCount ?? 0,
      repositoryCount: previousImpact?.repositoryCount ?? 0,
    }),
  });
}

/** 旧stateと入力投影から計画に必要な事実を提供する。 */
export function createGenericAiPlanningPort(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  diagnostics: CodexDiagnosticsContext | undefined,
): GenericAiPlanningPort {
  const previousGraph = previousGraphIndex(state);
  const previousImpactByNodeId =
    previousGraph.availability === "available"
      ? previousGraph.downstreamImpactByNodeId
      : new Map<GraphNodeId, AnalyzeGraphResult["downstreamImpacts"][number]>();
  const previousRelations = previousSnapshot(state)?.relations ?? [];
  const preflightCost =
    configuration.config.ai.enabled &&
    configuration.credentials.codex.enabled &&
    configuration.credentials.codex.authentication === "auth-json"
      ? estimateAiInputCost(
          CODEX_AUTHENTICATION_PREFLIGHT_PROMPT,
          configuration.config.ai.budget.estimatedInputCostUsdPerMillionTokens,
        )
      : undefined;
  const preflightCharge =
    preflightCost == null
      ? undefined
      : Object.freeze({
          inputCharacters: CODEX_AUTHENTICATION_PREFLIGHT_INPUT_CHARACTERS,
          estimatedInputTokens: preflightCost.estimatedInputTokens,
          estimatedCostUsd: preflightCost.estimatedCostUsd,
        });
  return Object.freeze({
    digest: nodeContentDigestPort,
    lookupCache: createGenericAiCacheLookup(state.session.aiCache),
    reserveBudget: (candidates: Parameters<GenericAiPlanningPort["reserveBudget"]>[0]) =>
      reserveGenericAiBudget(
        candidates,
        configuration.config.ai.budget,
        configuration.config.ai.budget.estimatedInputCostUsdPerMillionTokens,
        configuration.codexAttemptBudget,
        preflightCharge,
      ),
    target: forcedAiAnalysisTarget(configuration),
    prepareItem: (
      run: DeterministicallyAnalyzedRun,
      analysis: DeterministicItemAnalysis,
    ): GenericAiPlanningItemSource => {
      const previousObservedAt = previousTrackedItem(state, analysis.item.nodeId)?.observedAt;
      const baseInput = createCodexInput(
        configuration,
        run.data.collection.evaluatedAt,
        analysis,
        [],
        {},
        previousObservedAt,
        createEarliestRelationSourceOccurredAtById,
      );
      return Object.freeze({
        baseInput,
        necessityInput: necessityInputForAnalysis(
          state,
          analysis,
          baseInput.selfCommitmentCandidates.length !== 0,
        ),
        dependencyFingerprints: elementDependencyFingerprints(state, analysis),
        priority: createPriority(state, run, analysis, previousImpactByNodeId, previousRelations),
      });
    },
    resolvePrevious: (
      analysis: DeterministicItemAnalysis,
      source: GenericAiPlanningItemSource,
      inputFingerprints: AnalysisElementInputFingerprintMap,
    ) => {
      const impact = analysisImpactProofsForItem(
        state,
        analysis,
        source.baseInput,
        inputFingerprints,
        source.dependencyFingerprints,
      );
      return Object.freeze({
        generations: savedGenerationsForItem(state, analysis.item.nodeId),
        evaluations: impact.evaluation,
        reuses: impact.adopted,
        impacts: impact.decisions,
      });
    },
    createTransportInput: (
      run: DeterministicallyAnalyzedRun,
      analysis: DeterministicItemAnalysis,
      source: GenericAiPlanningItemSource,
      planning: AnalysisElementPlanning,
      target: GenericAiPlanningPort["target"],
    ): CodexAnalysisInput =>
      createCodexInput(
        configuration,
        run.data.collection.evaluatedAt,
        analysis,
        planning.selection.selected.map((candidate) => candidate.element),
        preservedElementsForSelection(state, analysis, planning, target, source.baseInput),
        previousTrackedItem(state, analysis.item.nodeId)?.observedAt,
        createEarliestRelationSourceOccurredAtById,
      ),
    serializeTransportInput: serializeCodexTransportAnalysisInput,
    recordInputValidationFailure: async (candidateId: string, error: unknown): Promise<void> => {
      await recordCodexDiagnostic(
        diagnostics == null ? undefined : Object.freeze({ ...diagnostics, candidateId }),
        "codex.input.validation_failed",
        {
          phase: "input_validation",
          errorType: error instanceof Error ? error.name : typeof error,
        },
        error,
      );
    },
  });
}
