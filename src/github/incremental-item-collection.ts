import { createUtcIsoDateTime, type GitHubNodeId, type UtcIsoDateTime } from "../domain/index.js";
import { type EnumeratedGitHubItem, type Sha256Fingerprint } from "./item-enumeration.js";

/** 前回成功時点の項目fingerprint。 */
export type PreviousItemCollection =
  | Readonly<{
      status: "none";
    }>
  | Readonly<{
      status: "successful";
      completedAt: UtcIsoDateTime;
      itemFingerprints: ReadonlyMap<GitHubNodeId, Sha256Fingerprint>;
    }>;

type IncrementalItemCollectionPlanFields = Readonly<{
  changedItemNodeIds: readonly GitHubNodeId[];
  detailItemNodeIds: readonly GitHubNodeId[];
  currentItemFingerprints: ReadonlyMap<GitHubNodeId, Sha256Fingerprint>;
}>;

/** 初回または前回成功時刻からの増分詳細取得計画。 */
export type IncrementalItemCollectionPlan =
  | (IncrementalItemCollectionPlanFields &
      Readonly<{
        mode: "initial";
      }>)
  | (IncrementalItemCollectionPlanFields &
      Readonly<{
        mode: "incremental";
        since: UtcIsoDateTime;
      }>);

export type PlanIncrementalItemCollectionOptions = Readonly<{
  items: readonly EnumeratedGitHubItem[];
  previous: PreviousItemCollection;
  adjacentItemNodeIds: ReadonlySet<GitHubNodeId>;
  overlapMilliseconds: number;
}>;

function validateOverlapMilliseconds(overlapMilliseconds: number): void {
  if (!Number.isSafeInteger(overlapMilliseconds) || overlapMilliseconds < 0) {
    throw new TypeError("overlapMillisecondsには0以上の安全な整数を指定してください");
  }
}

function calculateSince(completedAt: UtcIsoDateTime, overlapMilliseconds: number): UtcIsoDateTime {
  const sinceDate = new Date(new Date(completedAt).getTime() - overlapMilliseconds);
  if (Number.isNaN(sinceDate.getTime())) {
    throw new RangeError("overlap適用後の増分取得起点を表現できません");
  }
  return createUtcIsoDateTime(sinceDate.toISOString());
}

function compareNodeIds(left: GitHubNodeId, right: GitHubNodeId): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function createCurrentFingerprints(
  items: readonly EnumeratedGitHubItem[],
): ReadonlyMap<GitHubNodeId, Sha256Fingerprint> {
  const fingerprints = new Map<GitHubNodeId, Sha256Fingerprint>();
  for (const item of items) {
    if (fingerprints.has(item.nodeId)) {
      throw new TypeError(`同じitem node IDが重複しています。対象: ${item.nodeId}`);
    }
    fingerprints.set(item.nodeId, item.itemFingerprint);
  }
  return fingerprints;
}

function selectChangedItemNodeIds(
  items: readonly EnumeratedGitHubItem[],
  previous: PreviousItemCollection,
): readonly GitHubNodeId[] {
  if (previous.status === "none") {
    return Object.freeze(items.map((item) => item.nodeId));
  }

  return Object.freeze(
    items
      .filter((item) => previous.itemFingerprints.get(item.nodeId) !== item.itemFingerprint)
      .map((item) => item.nodeId),
  );
}

function selectDetailItemNodeIds(
  changedItemNodeIds: readonly GitHubNodeId[],
  adjacentItemNodeIds: ReadonlySet<GitHubNodeId>,
): readonly GitHubNodeId[] {
  const detailItemNodeIds = new Set(changedItemNodeIds);
  const sortedAdjacentItemNodeIds = [...adjacentItemNodeIds].sort(compareNodeIds);
  for (const nodeId of sortedAdjacentItemNodeIds) {
    detailItemNodeIds.add(nodeId);
  }
  return Object.freeze([...detailItemNodeIds]);
}

/** 変更項目と外部指定されたグラフ隣接nodeだけを詳細取得対象にする。 */
export function planIncrementalItemCollection(
  options: PlanIncrementalItemCollectionOptions,
): IncrementalItemCollectionPlan {
  validateOverlapMilliseconds(options.overlapMilliseconds);
  const currentItemFingerprints = createCurrentFingerprints(options.items);
  const changedItemNodeIds = selectChangedItemNodeIds(options.items, options.previous);
  const detailItemNodeIds = selectDetailItemNodeIds(
    changedItemNodeIds,
    options.adjacentItemNodeIds,
  );
  const fields = {
    changedItemNodeIds,
    detailItemNodeIds,
    currentItemFingerprints,
  } satisfies IncrementalItemCollectionPlanFields;

  if (options.previous.status === "none") {
    return Object.freeze({
      mode: "initial",
      ...fields,
    });
  }
  return Object.freeze({
    mode: "incremental",
    since: calculateSince(options.previous.completedAt, options.overlapMilliseconds),
    ...fields,
  });
}
