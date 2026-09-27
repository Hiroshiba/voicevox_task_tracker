import type { GitHubNodeId } from "../../../domain/types.js";
import type { SnapshotCollectionItem } from "../../../persistence/snapshot.js";
import type { RuntimeState } from "../contracts.js";
import { previousSnapshot } from "./snapshot.js";

/** 前回の収集項目をnode IDで参照する。 */
export function previousCollectionItemsByNodeId(
  state: RuntimeState,
): ReadonlyMap<GitHubNodeId, SnapshotCollectionItem> {
  return new Map(
    (previousSnapshot(state)?.collection.repositories ?? []).flatMap((repository) =>
      repository.items.map((item) => [item.nodeId, item] as const),
    ),
  );
}
