import type { DeterministicallyAnalyzedRun } from "../../../application/tracking-run/stages/deterministic.js";
import type {
  CanonicalCollectedItems,
  CollectedItems,
  DeterministicAnalysis,
} from "../../production-runtime/contracts.js";
import type { DeterministicItemAnalysis } from "../../initial-item-analysis.js";
import { projectLegacyCollectedItems } from "./collection.js";

type AnalyzedProductionRun = DeterministicallyAnalyzedRun<
  CanonicalCollectedItems,
  DeterministicItemAnalysis
>;

const projectedCollections = new WeakMap<AnalyzedProductionRun, CollectedItems>();

/** 未移行のAIとreducerへ初期判定を投影する。 */
export function projectLegacyDeterministicAnalysis(
  run: AnalyzedProductionRun,
): DeterministicAnalysis {
  return Object.freeze({ items: run.data.facts.items });
}

/** 未移行の下流処理へ同じstageが保持する収集値を投影する。 */
export function projectLegacyAnalyzedCollection(run: AnalyzedProductionRun): CollectedItems {
  const projected = projectedCollections.get(run);
  if (projected != null) {
    return projected;
  }
  const collection = projectLegacyCollectedItems(
    Object.freeze({
      ...run.data.collection,
      relationCandidates: Object.freeze(run.data.facts.relations.map((fact) => fact.candidate)),
    }),
  );
  projectedCollections.set(run, collection);
  return collection;
}
