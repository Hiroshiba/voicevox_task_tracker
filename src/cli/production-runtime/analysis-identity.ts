import { hashCanonicalJson } from "../../canonical-json/index.js";
import {
  createAiAnalysisElementResultSchema,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElement,
  type AiAnalysisElementEvidence,
  type AiAnalysisElementInputFingerprint,
  type AiAnalysisElementMigrationResult,
} from "../../domain/ai-analysis-elements.js";
import type {
  TrackedItemAiAnalysisCurrentAdoptedElements,
  TrackedItemAiAnalysisMigrationElements,
} from "../../domain/index.js";
import type { AnalysisElementDependencyFingerprintMap } from "../../codex/analysis-element-dependencies.js";
import { UnreachableError } from "../../util/index.js";
import type { DeterministicItemAnalysis } from "../../application/tracking-run/stages/deterministic-item.js";
import type { RuntimeState } from "./contracts.js";
import { adoptedResultForRetainedItem } from "./previous-state/saved-ai-elements.js";
import { previousTrackedItem } from "./previous-state/snapshot.js";

export function deterministicElementResult(
  analysis: DeterministicItemAnalysis,
  element: AiAnalysisElement,
): AiAnalysisElementMigrationResult | undefined {
  const evidence: readonly AiAnalysisElementEvidence[] = Object.freeze([
    Object.freeze({
      sourceId: analysis.item.sourceId,
      summary: "決定論的な判定結果です",
      supports: "element",
    }),
  ]);
  const common = {
    evidence,
    confidence: analysis.decision.confidence,
    uncertainties: analysis.decision.uncertainties,
  };
  switch (element) {
    case "status":
      return createAiAnalysisElementResultSchema("status").parse({
        ...common,
        value: analysis.decision.status,
      });
    case "waitingOn":
      return createAiAnalysisMigrationElementResultSchema("waitingOn").parse({
        ...common,
        value: analysis.decision.waitingOn,
      });
    case "nextAction":
      return createAiAnalysisElementResultSchema("nextAction").parse({
        ...common,
        value: analysis.decision.nextAction,
      });
    case "relations":
    case "progress":
    case "importance":
    case "deadline":
    case "notification":
    case "selfCommitment":
      return undefined;
    default:
      throw new UnreachableError(element);
  }
}

function dependencyResultForElement(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  element: AiAnalysisElement,
): AiAnalysisElementMigrationResult | undefined {
  const item = previousTrackedItem(state, analysis.item.nodeId);
  return item == null ? undefined : adoptedResultForRetainedItem(item, element);
}

export function stateDependencyFingerprintForResults(
  analysis: DeterministicItemAnalysis,
  results: Readonly<Partial<Record<AiAnalysisElement, AiAnalysisElementMigrationResult>>>,
): AiAnalysisElementInputFingerprint {
  const elements = Object.fromEntries(
    (["status", "waitingOn", "nextAction"] as const).map((element) => {
      const savedResult = results[element];
      const result =
        savedResult == null
          ? deterministicElementResult(analysis, element)
          : createAiAnalysisMigrationElementResultSchema(element).parse(savedResult);
      return [
        element,
        result == null
          ? { status: "unavailable" }
          : {
              status: "available",
              value: result.value,
              confidence: result.confidence,
              uncertainties: result.uncertainties,
            },
      ];
    }),
  );
  return hashCanonicalJson({ kind: "state", elements });
}

export function stateDependencyFingerprint(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
): AiAnalysisElementInputFingerprint {
  const results: Partial<Record<AiAnalysisElement, AiAnalysisElementMigrationResult>> = {};
  for (const element of ["status", "waitingOn", "nextAction"] as const) {
    const result = dependencyResultForElement(state, analysis, element);
    if (result != null) {
      results[element] = result;
    }
  }
  return stateDependencyFingerprintForResults(analysis, results);
}

export function finalStateDependencyFingerprint(
  analysis: DeterministicItemAnalysis,
  current: TrackedItemAiAnalysisCurrentAdoptedElements,
  migration: TrackedItemAiAnalysisMigrationElements,
): AiAnalysisElementInputFingerprint {
  const results: Partial<Record<AiAnalysisElement, AiAnalysisElementMigrationResult>> = {};
  for (const element of ["status", "waitingOn", "nextAction"] as const) {
    const currentElement = current[element];
    if (currentElement != null) {
      results[element] = currentElement.result;
      continue;
    }
    const migrationResult = migration[element];
    if (migrationResult != null) {
      results[element] = migrationResult;
    }
  }
  return stateDependencyFingerprintForResults(analysis, results);
}

export function elementDependencyFingerprints(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
): AnalysisElementDependencyFingerprintMap {
  const stateFingerprint = stateDependencyFingerprint(state, analysis);
  const independentFingerprint = hashCanonicalJson({ kind: "independent" });
  return Object.freeze({
    status: stateFingerprint,
    waitingOn: stateFingerprint,
    nextAction: stateFingerprint,
    relations: independentFingerprint,
    progress: independentFingerprint,
    importance: independentFingerprint,
    deadline: independentFingerprint,
    notification: independentFingerprint,
    selfCommitment: independentFingerprint,
  });
}
