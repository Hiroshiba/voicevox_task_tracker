import type { CollectedRun } from "../../../application/tracking-run/stages/collection.js";
import type {
  CanonicalCollectedItems,
  CollectedItems,
} from "../../production-runtime/contracts.js";

const projectedCollections = new WeakMap<CanonicalCollectedItems, CollectedItems>();

/** canonical配列を未移行処理の索引型へ一度だけ投影する。 */
export function projectLegacyCollectedItems(collection: CanonicalCollectedItems): CollectedItems {
  const projected = projectedCollections.get(collection);
  if (projected != null) {
    return projected;
  }
  const {
    trackedNodeIds,
    trackingNotificationClassByNodeId,
    analysisNodeIds,
    staleBlockerTopologyNodeIds,
    changedNodeIds,
    ...fields
  } = collection;
  const value = Object.freeze({
    ...fields,
    trackedNodeIds: new Set(trackedNodeIds),
    trackingNotificationClassByNodeId: new Map(trackingNotificationClassByNodeId),
    analysisNodeIds: new Set(analysisNodeIds),
    staleBlockerTopologyNodeIds: new Set(staleBlockerTopologyNodeIds),
    changedNodeIds: new Set(changedNodeIds),
  }) satisfies CollectedItems;
  projectedCollections.set(collection, value);
  return value;
}

/** 未移行のAIとgraph入力へ正規化済み収集値を投影する。 */
export function projectLegacyCollection(
  run: CollectedRun<CanonicalCollectedItems>,
): CollectedItems {
  return projectLegacyCollectedItems(run.data.collection);
}
