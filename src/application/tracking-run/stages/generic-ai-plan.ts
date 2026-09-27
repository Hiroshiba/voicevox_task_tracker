import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import {
  elementInputFingerprints,
  createAnalysisElementExactInputs,
  type AnalysisElementDependencyFingerprintMap,
  type AnalysisElementInputFingerprintMap,
  type AnalysisImpactDecisionForDiagnostics,
} from "../../../codex/analysis-element-dependencies.js";
import { estimateAiInputCost } from "../../../codex/budget.js";
import { CODEX_PROMPT_BUNDLE_VERSION } from "../../../codex/semantic-validation-issues.js";
import {
  forceAnalysisCandidateElements,
  forceAnalysisElementSelection,
  determineAnalysisElementNecessities,
  planAnalysisElements,
  type AnalysisElementNecessityInput,
  type AnalysisElementPlanning,
} from "../../../codex/element-planning.js";
import {
  prepareAiAnalysisCandidate,
  type AiAnalysisCandidate,
  type AiAnalysisPriority,
  type AiAnalysisRunIdentity,
  type AiAnalysisTarget,
  type PreparedAiAnalysisCandidate,
} from "../../../codex/analysis-selection.js";
import type { AnalysisElementReuseRecord } from "../../../codex/analysis-elements.js";
import { AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS } from "../../../codex/generic-ai-definition.js";
import {
  createCodexAnalysisInput,
  projectCodexLockedElementResult,
  serializeCodexAnalysisInput,
  type CodexAnalysisInput,
} from "../../../codex/input.js";
import {
  AI_ANALYSIS_ELEMENTS,
  aiAnalysisElementSchema,
  aiAnalysisElementFingerprintSchema,
  type AiAnalysisElement,
  type AiAnalysisElementInputFingerprint,
} from "../../../domain/ai-analysis-elements.js";
import type { GitHubNodeId } from "../../../domain/types.js";
import { z } from "zod";
import type { AiAnalysisElementSourceGeneration } from "../../../domain/ai-analysis-source-generations.js";
import { createGenericAiPlannedStageProof } from "../contracts/proofs.js";
import { projectGenericAiRunCore, type StageState } from "../contracts/run-core.js";
import type { ContentDigestPort } from "../ports.js";
import { createAiAnalysisRunIdentity } from "./collection-analysis-fingerprint.js";
import type { DeterministicallyAnalyzedRun } from "./deterministic.js";
import type { DeterministicItemAnalysis } from "./deterministic-item.js";
import {
  planGenericAiCachedElements,
  type GenericAiCacheLookupPort,
  type GenericAiElementPlan,
} from "./generic-ai-cache-plan.js";
import type { GenericAiBudgetPlan } from "./generic-ai-budget-plan.js";

export type { GenericAiElementPlan } from "./generic-ai-cache-plan.js";

/** 1項目の全要素と実行用候補を保持する。 */
export type GenericAiItemPlan = Readonly<{
  nodeId: GitHubNodeId;
  selectedElements: readonly AiAnalysisElement[];
  elements: readonly GenericAiElementPlan[];
  planning: AnalysisElementPlanning;
  candidate: PreparedAiAnalysisCandidate;
  executionCandidate?: PreparedAiAnalysisCandidate;
}>;

/** 汎用AIの全項目について確定した候補と入力。 */
export type GenericAiPlan = Readonly<{
  identity: AiAnalysisRunIdentity;
  target?: AiAnalysisTarget;
  items: readonly GenericAiItemPlan[];
  budget: GenericAiBudgetPlan;
  failures: readonly Readonly<{
    candidateId: string;
    reason: "input_validation_failed";
    errorType: string;
  }>[];
  analysisImpactDecisions: readonly Readonly<{
    candidateId: string;
    element: AiAnalysisElement;
    role: "adopted" | "evaluated";
    decision: AnalysisImpactDecisionForDiagnostics;
  }>[];
}>;

/** 汎用AIの候補、厳密な意味入力、再利用判断が確定したrun。 */
export type GenericAiPlannedRun = StageState<
  "generic_ai_planned",
  {
    approvedRepositories: DeterministicallyAnalyzedRun["data"]["approvedRepositories"];
    allowlistDigest: DeterministicallyAnalyzedRun["data"]["allowlistDigest"];
    collection: DeterministicallyAnalyzedRun["data"]["collection"];
    sourceCatalog: DeterministicallyAnalyzedRun["data"]["sourceCatalog"];
    facts: DeterministicallyAnalyzedRun["data"]["facts"];
    plan: GenericAiPlan;
  }
>;

/** 旧stateから計画に必要な事実だけを投影した項目入力。 */
export type GenericAiPlanningItemSource = Readonly<{
  baseInput: CodexAnalysisInput;
  necessityInput: AnalysisElementNecessityInput;
  dependencyFingerprints: AnalysisElementDependencyFingerprintMap;
  priority: AiAnalysisPriority;
}>;

/** 保存済み評価と採用の現在性を要素別に照合した結果。 */
export type GenericAiPreviousElements = Readonly<{
  generations: Readonly<Partial<Record<AiAnalysisElement, AiAnalysisElementSourceGeneration>>>;
  evaluations: Readonly<Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>>>;
  reuses: Readonly<Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>>>;
  impacts: readonly Readonly<{
    element: AiAnalysisElement;
    role: "adopted" | "evaluated";
    decision: AnalysisImpactDecisionForDiagnostics;
  }>[];
}>;

/** 未移行のstateと輸送入力を計画段階へ投影する境界。 */
export type GenericAiPlanningPort = Readonly<{
  digest: ContentDigestPort;
  lookupCache: GenericAiCacheLookupPort;
  reserveBudget: (candidates: readonly PreparedAiAnalysisCandidate[]) => GenericAiBudgetPlan;
  target: AiAnalysisTarget | undefined;
  prepareItem: (
    run: DeterministicallyAnalyzedRun,
    analysis: DeterministicItemAnalysis,
  ) => GenericAiPlanningItemSource;
  resolvePrevious: (
    analysis: DeterministicItemAnalysis,
    source: GenericAiPlanningItemSource,
    inputFingerprints: AnalysisElementInputFingerprintMap,
  ) => GenericAiPreviousElements;
  createTransportInput: (
    run: DeterministicallyAnalyzedRun,
    analysis: DeterministicItemAnalysis,
    source: GenericAiPlanningItemSource,
    planning: AnalysisElementPlanning,
    target: AiAnalysisTarget | undefined,
  ) => CodexAnalysisInput;
  serializeTransportInput: (input: CodexAnalysisInput) => string;
  recordInputValidationFailure: (candidateId: string, error: unknown) => Promise<void>;
}>;

function executionFingerprints(
  identity: AiAnalysisRunIdentity,
  digest: ContentDigestPort,
): Readonly<Record<AiAnalysisElement, AiAnalysisElementInputFingerprint>> {
  const values: Partial<Record<AiAnalysisElement, AiAnalysisElementInputFingerprint>> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    values[element] = digest.sha256Utf8(
      serializeCanonicalJson({
        element,
        model: identity.model,
        reasoningEffort: identity.reasoningEffort,
        backendVersion: identity.backendVersion,
        schemaVersion: identity.schemaVersion,
      }),
    );
  }
  return Object.freeze(
    z.record(aiAnalysisElementSchema, aiAnalysisElementFingerprintSchema).parse(values),
  );
}

/** 確定済み判定から全9要素の汎用AI計画を作る。 */
export async function planGenericAi(
  analyzed: DeterministicallyAnalyzedRun,
  port: GenericAiPlanningPort,
): Promise<GenericAiPlannedRun> {
  const identity = createAiAnalysisRunIdentity(analyzed.core.config);
  const currentExecutionFingerprints = executionFingerprints(identity, port.digest);
  const promptFingerprint = port.digest.sha256Utf8(
    serializeCanonicalJson({
      bundleVersion: CODEX_PROMPT_BUNDLE_VERSION,
    }),
  );
  const target = port.target;
  if (target != null && !analyzed.core.config.ai.enabled) {
    throw new TypeError("forced sandbox実行にはAIを有効にしてください");
  }
  const items: GenericAiItemPlan[] = [];
  const failures: GenericAiPlan["failures"][number][] = [];
  const analysisImpactDecisions: GenericAiPlan["analysisImpactDecisions"][number][] = [];
  const itemIds = new Set<string>();
  for (const analysis of analyzed.data.facts.items) {
    const nodeId = analysis.item.nodeId;
    if (itemIds.has(nodeId)) {
      throw new TypeError(`AI計画の項目IDが重複しています。対象: ${nodeId}`);
    }
    itemIds.add(nodeId);
    let source: GenericAiPlanningItemSource;
    try {
      source = port.prepareItem(analyzed, analysis);
    } catch (error: unknown) {
      await port.recordInputValidationFailure(nodeId, error);
      failures.push(
        Object.freeze({
          candidateId: nodeId,
          reason: "input_validation_failed",
          errorType: error instanceof Error ? error.name : typeof error,
        }),
      );
      continue;
    }
    const exactInputs = createAnalysisElementExactInputs(source.baseInput);
    const inputFingerprints = elementInputFingerprints(exactInputs);
    const previous = port.resolvePrevious(analysis, source, inputFingerprints);
    for (const impact of previous.impacts) {
      analysisImpactDecisions.push(Object.freeze({ candidateId: nodeId, ...impact }));
    }
    const planning = planAnalysisElements({
      necessities: determineAnalysisElementNecessities(source.necessityInput),
      inputFingerprints,
      executionFingerprints: currentExecutionFingerprints,
      inputProjectionVersions: AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS,
      dependencyFingerprints: source.dependencyFingerprints,
      savedGenerations: previous.generations,
      savedEvaluations: previous.evaluations,
      savedReuses: previous.reuses,
    });
    const targetForItem = target?.nodeId === nodeId ? target : undefined;
    const executionPlanning =
      target == null
        ? planning
        : targetForItem != null
          ? Object.freeze({
              ...planning,
              selection: forceAnalysisElementSelection(planning, targetForItem),
            })
          : Object.freeze({
              ...planning,
              selection: Object.freeze({
                ...planning.selection,
                selected: Object.freeze([]),
                shouldCallAi: false,
              }),
            });
    const elements = await planGenericAiCachedElements(
      exactInputs,
      executionPlanning,
      target,
      nodeId,
      analyzed.core.config.ai.enabled,
      identity,
      port.lookupCache,
    );
    const input = port.createTransportInput(
      analyzed,
      analysis,
      source,
      executionPlanning,
      targetForItem,
    );
    const candidate = prepareAiAnalysisCandidate(
      Object.freeze({
        id: nodeId,
        input,
        elements:
          targetForItem == null
            ? Object.freeze(AI_ANALYSIS_ELEMENTS.map((element) => planning.candidates[element]))
            : forceAnalysisCandidateElements(planning, targetForItem),
        promptFingerprint,
        priority: source.priority,
        estimatedCostUsd: estimateAiInputCost(
          serializeCodexAnalysisInput(input),
          analyzed.core.config.ai.budget.estimatedInputCostUsdPerMillionTokens,
        ).estimatedCostUsd,
      } satisfies AiAnalysisCandidate),
      executionPlanning.selection,
    );
    const misses = elements.filter((element) => element.choice === "execute");
    const cachedLockedElements = Object.fromEntries(
      elements
        .filter((element) => element.choice === "cache_hit")
        .map((element) => [
          element.element,
          projectCodexLockedElementResult(element.element, element.entry.generation.result),
        ]),
    );
    const executionInput =
      misses.length === 0
        ? undefined
        : createCodexAnalysisInput({
            ...input,
            selectedElements: misses.map((element) => element.element),
            lockedElements: Object.freeze({
              ...input.lockedElements,
              ...cachedLockedElements,
            }),
          });
    const preparedExecutionCandidate =
      executionInput == null
        ? undefined
        : prepareAiAnalysisCandidate(
            Object.freeze({
              ...candidate,
              input: executionInput,
            }),
            Object.freeze({
              ...executionPlanning.selection,
              selected: Object.freeze(
                executionPlanning.selection.selected.filter((value) =>
                  misses.some((element) => element.element === value.element),
                ),
              ),
            }),
          );
    const executionInputJson =
      executionInput == null ? undefined : port.serializeTransportInput(executionInput);
    const executionCandidate =
      preparedExecutionCandidate == null || executionInputJson == null
        ? undefined
        : Object.freeze({
            ...preparedExecutionCandidate,
            normalizedInput: executionInputJson,
            inputCharacters: Array.from(executionInputJson).length,
            estimatedCostUsd: estimateAiInputCost(
              executionInputJson,
              analyzed.core.config.ai.budget.estimatedInputCostUsdPerMillionTokens,
            ).estimatedCostUsd,
          });
    items.push(
      Object.freeze({
        nodeId,
        selectedElements: Object.freeze(
          executionPlanning.selection.selected.map((value) => value.element),
        ),
        elements,
        planning: executionPlanning,
        candidate,
        ...(executionCandidate == null ? {} : { executionCandidate }),
      }),
    );
  }
  const budget = port.reserveBudget(
    items.flatMap((item) => (item.executionCandidate == null ? [] : [item.executionCandidate])),
  );
  if (
    budget.ledger.ledgerId !== analyzed.core.aiBudget.ledgerId ||
    budget.ledger.sequence < analyzed.core.aiBudget.sequence
  ) {
    throw new TypeError("汎用AIの予約ledgerが入力runと一致しません");
  }
  const deferredByCandidateId = new Map(
    budget.deferred.map((value) => [value.candidateId, value.reason]),
  );
  const budgetedItems = Object.freeze(
    items.map((item) => {
      const reason = deferredByCandidateId.get(item.nodeId);
      return reason == null
        ? item
        : Object.freeze({
            ...item,
            elements: Object.freeze(
              item.elements.map((element) =>
                element.choice === "execute"
                  ? Object.freeze({ ...element, choice: "budget_deferred" as const, reason })
                  : element,
              ),
            ),
          });
    }),
  );
  const plan = Object.freeze({
    identity,
    ...(target == null ? {} : { target }),
    items: budgetedItems,
    budget,
    failures: Object.freeze(failures),
    analysisImpactDecisions: Object.freeze(analysisImpactDecisions),
  }) satisfies GenericAiPlan;
  return Object.freeze({
    stage: "generic_ai_planned",
    core: Object.freeze({
      ...projectGenericAiRunCore(analyzed.core),
      aiBudget: budget.ledger,
    }),
    data: Object.freeze({
      approvedRepositories: analyzed.data.approvedRepositories,
      allowlistDigest: analyzed.data.allowlistDigest,
      collection: analyzed.data.collection,
      sourceCatalog: analyzed.data.sourceCatalog,
      facts: analyzed.data.facts,
      plan,
    }),
    proof: createGenericAiPlannedStageProof(),
  });
}
