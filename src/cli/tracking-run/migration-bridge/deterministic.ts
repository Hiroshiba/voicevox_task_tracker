import type { DeterministicallyAnalyzedRun } from "../../../application/tracking-run/stages/deterministic.js";
import type {
  CanonicalCollectedItems,
  CollectedItems,
  DeterministicAnalysis,
} from "../../production-runtime/contracts.js";
import { projectLegacyCollectedItems } from "./collection.js";

const projectedCollections = new WeakMap<DeterministicallyAnalyzedRun, CollectedItems>();

/** 未移行のAIとreducerへ初期判定を投影する。 */
export function projectLegacyDeterministicAnalysis(
  run: DeterministicallyAnalyzedRun,
): DeterministicAnalysis {
  return Object.freeze({ items: run.data.facts.items });
}

/** 未移行の下流処理へ同じstageが保持する収集値を投影する。 */
export function projectLegacyAnalyzedCollection(run: DeterministicallyAnalyzedRun): CollectedItems {
  const projected = projectedCollections.get(run);
  if (projected != null) {
    return projected;
  }
  const collection = projectLegacyCollectedItems(
    Object.freeze({
      ...run.data.collection,
      relationCandidates: Object.freeze(run.data.facts.relations.map((fact) => fact.candidate)),
      trackedNodeIds: run.data.facts.trackedNodeIds,
      analysisNodeIds: run.data.facts.analysisNodeIds,
      unavailableConsumerNodeIds: run.data.facts.unavailableConsumerNodeIds,
      changedNodeIds: run.data.facts.changedNodeIds,
    } satisfies CanonicalCollectedItems),
  );
  projectedCollections.set(run, collection);
  return collection;
}
