import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import {
  elementInputFingerprints,
  createAnalysisElementExactInputs,
  type AnalysisElementDependencyFingerprintMap,
  type AnalysisElementExactInputMap,
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
import {
  GENERIC_AI_ELEMENT_DEFINITIONS,
  AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS,
} from "../../../codex/generic-ai-definition.js";
import type { CodexAnalysisInput } from "../../../codex/input.js";
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

type GenericAiElementDecision =
  | Readonly<{ choice: "not_required"; reason: "deterministic" | "forced_target_other_element" }>
  | Readonly<{ choice: "snapshot_reuse"; reason: "current_completed_result" }>
  | Readonly<{
      choice: "cache_lookup";
      onCacheMiss: "execute";
      reason: "current_input_requires_evaluation";
    }>
  | Readonly<{ choice: "ai_disabled"; reason: "ai_disabled" }>
  | Readonly<{ choice: "deferred"; reason: "forced_target_other_item" }>;

/** 汎用AIの1要素について確定した入力と計画理由。 */
export type GenericAiElementPlan = Readonly<{
  element: AiAnalysisElement;
  revision: number;
  inputProjectionVersion: number;
  necessity: "required" | "not_required";
  selected: boolean;
  exactInput: object;
  inputFingerprint: AiAnalysisElementInputFingerprint;
  dependencyFingerprint: AiAnalysisElementInputFingerprint;
}> &
  GenericAiElementDecision;

/** 1項目の全要素と実行用候補を保持する。 */
export type GenericAiItemPlan = Readonly<{
  nodeId: GitHubNodeId;
  selectedElements: readonly AiAnalysisElement[];
  elements: readonly GenericAiElementPlan[];
  planning: AnalysisElementPlanning;
  candidate: PreparedAiAnalysisCandidate;
}>;

/** 汎用AIの全項目について確定した候補と入力。 */
export type GenericAiPlan = Readonly<{
  identity: AiAnalysisRunIdentity;
  target?: AiAnalysisTarget;
  items: readonly GenericAiItemPlan[];
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

function chooseElementPlan(
  selected: boolean,
  skipReason: "not_required" | "up_to_date" | undefined,
  forcedOtherItem: boolean,
  forcedOtherElement: boolean,
  aiEnabled: boolean,
): GenericAiElementDecision {
  if (forcedOtherItem) {
    return Object.freeze({ choice: "deferred", reason: "forced_target_other_item" });
  }
  if (forcedOtherElement) {
    return Object.freeze({ choice: "not_required", reason: "forced_target_other_element" });
  }
  if (selected) {
    return aiEnabled
      ? Object.freeze({
          choice: "cache_lookup",
          onCacheMiss: "execute",
          reason: "current_input_requires_evaluation",
        })
      : Object.freeze({ choice: "ai_disabled", reason: "ai_disabled" });
  }
  if (skipReason === "up_to_date") {
    return Object.freeze({ choice: "snapshot_reuse", reason: "current_completed_result" });
  }
  return Object.freeze({ choice: "not_required", reason: "deterministic" });
}

function elementPlans(
  exactInputs: AnalysisElementExactInputMap,
  planning: AnalysisElementPlanning,
  target: AiAnalysisTarget | undefined,
  candidateId: string,
  aiEnabled: boolean,
): readonly GenericAiElementPlan[] {
  const selected = new Set(planning.selection.selected.map((value) => value.element));
  const skipped = new Map(
    planning.selection.skipped.map((value) => [value.candidate.element, value.reason]),
  );
  return Object.freeze(
    AI_ANALYSIS_ELEMENTS.map((element) => {
      const exact = exactInputs[element];
      const candidate = planning.candidates[element];
      if (exact.fingerprint !== candidate.inputFingerprint) {
        throw new TypeError(
          `AI要素の厳密入力とfingerprintが一致しません。対象: ${candidateId}/${element}`,
        );
      }
      const forcedOtherItem = target != null && target.nodeId !== candidateId;
      const forcedOtherElement =
        target?.nodeId === candidateId && !target.elements.includes(element);
      const selectedForExecution = selected.has(element) && !forcedOtherItem;
      const skipReason = skipped.get(element);
      const decision = chooseElementPlan(
        selectedForExecution,
        skipReason,
        forcedOtherItem,
        forcedOtherElement,
        aiEnabled,
      );
      return Object.freeze({
        element,
        revision: GENERIC_AI_ELEMENT_DEFINITIONS[element].revision,
        inputProjectionVersion: GENERIC_AI_ELEMENT_DEFINITIONS[element].inputProjectionVersion,
        necessity: candidate.necessity,
        selected: selectedForExecution,
        ...decision,
        exactInput: exact.exactInput,
        inputFingerprint: exact.fingerprint,
        dependencyFingerprint: candidate.dependencyFingerprint,
      });
    }),
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
      targetForItem == null
        ? planning
        : Object.freeze({
            ...planning,
            selection: forceAnalysisElementSelection(planning, targetForItem),
          });
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
          `${serializeCanonicalJson(input)}\n`,
          analyzed.core.config.ai.budget.estimatedInputCostUsdPerMillionTokens,
        ).estimatedCostUsd,
      } satisfies AiAnalysisCandidate),
      executionPlanning.selection,
    );
    items.push(
      Object.freeze({
        nodeId,
        selectedElements: Object.freeze(
          target != null && target.nodeId !== nodeId
            ? []
            : executionPlanning.selection.selected.map((value) => value.element),
        ),
        elements: elementPlans(
          exactInputs,
          executionPlanning,
          target,
          nodeId,
          analyzed.core.config.ai.enabled,
        ),
        planning: executionPlanning,
        candidate,
      }),
    );
  }
  const plan = Object.freeze({
    identity,
    ...(target == null ? {} : { target }),
    items: Object.freeze(items),
    failures: Object.freeze(failures),
    analysisImpactDecisions: Object.freeze(analysisImpactDecisions),
  }) satisfies GenericAiPlan;
  return Object.freeze({
    stage: "generic_ai_planned",
    core: projectGenericAiRunCore(analyzed.core),
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
