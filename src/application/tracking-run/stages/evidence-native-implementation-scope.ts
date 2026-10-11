import type { Relation } from "../../../domain/relation.js";
import type { GitHubRepositoryId } from "../../../domain/types.js";
import { parseSourceId } from "../../../domain/source-id.js";
import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type {
  HistoricalAiSnapshotInput,
  HistoricalNativeImplementation,
} from "../contracts/evidence-closure.js";
import { RunCompletenessError } from "./run-completeness-error.js";

type NativeImplementationScopeRelation = Pick<
  Relation,
  "active" | "fromNodeId" | "provenance" | "toNodeId" | "type"
>;

/** 有効なGitHub native実装関係からIssueごとの実装PRを列挙する。 */
export function createNativeImplementationOwnerScopes(
  relations: readonly NativeImplementationScopeRelation[],
): ReadonlyMap<string, readonly string[]> {
  const ownersByIssue = new Map<string, Set<string>>();
  for (const relation of relations) {
    if (!relation.active || relation.type !== "implements" || relation.provenance !== "native") {
      continue;
    }
    const owners = ownersByIssue.get(relation.toNodeId) ?? new Set<string>();
    owners.add(relation.fromNodeId);
    ownersByIssue.set(relation.toNodeId, owners);
  }
  return new Map(
    [...ownersByIssue].map(([itemNodeId, owners]) => [
      itemNodeId,
      Object.freeze([...owners].sort()),
    ]),
  );
}

/** Issue自身とnative実装PRに限ったsource所有範囲を返す。 */
export function nativeImplementationOwnerNodeIds(
  itemNodeId: string,
  ownersByIssue: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  return Object.freeze([itemNodeId, ...(ownersByIssue.get(itemNodeId) ?? [])].sort());
}

/** 関係の端点を実装するPRの本文だけを、その根拠の所有範囲へ加える。 */
export function relationEvidenceOwnerNodeIds(
  sourceId: string,
  relation: Readonly<{ fromNodeId: string; toNodeId: string }>,
  ownersByIssue: ReadonlyMap<string, readonly string[]>,
  path: readonly (string | number)[],
): readonly string[] {
  const nodeIds = [relation.fromNodeId, relation.toNodeId];
  let source;
  try {
    source = parseSourceId(sourceId);
  } catch (error: unknown) {
    throw new RunCompletenessError("invalid_reference", sourceId, path, undefined, error);
  }
  if (
    source.kind === "github_item_body" &&
    nodeIds.some((nodeId) => ownersByIssue.get(nodeId)?.includes(source.originalId) === true)
  ) {
    nodeIds.push(source.originalId);
  }
  return Object.freeze([...new Set(nodeIds)].sort());
}

/** 前回の有効なnative実装関係を根拠とPRのrepository所属付きで抽出する。 */
export function collectHistoricalNativeImplementations(
  relations: readonly Relation[],
  snapshot: HistoricalAiSnapshotInput,
): readonly HistoricalNativeImplementation[] {
  const repositories = new Map<string, GitHubRepositoryId>();
  for (const item of [
    ...snapshot.trackedItems,
    ...snapshot.collectionRepositories.flatMap((repository) => repository.items),
  ]) {
    const existing = repositories.get(item.nodeId);
    if (existing != null && existing !== item.repositoryId) {
      throw new TypeError(`前回項目のrepositoryが一致しません。対象: ${item.nodeId}`);
    }
    repositories.set(item.nodeId, item.repositoryId);
  }
  const records: HistoricalNativeImplementation[] = [];
  const ids = new Set<string>();
  for (const relation of relations) {
    if (!relation.active || relation.type !== "implements" || relation.provenance !== "native") {
      continue;
    }
    if (ids.has(relation.id)) {
      throw new TypeError(`前回のnative実装関係が重複しています。対象: ${relation.id}`);
    }
    ids.add(relation.id);
    const repositoryId = repositories.get(relation.fromNodeId);
    if (repositoryId == null || !relation.evidence.some((entry) => entry.supports === "relation")) {
      continue;
    }
    records.push(
      Object.freeze({
        relationId: relation.id,
        implementationNodeId: relation.fromNodeId,
        issueNodeId: relation.toNodeId,
        repositoryId,
        evidence: relation.evidence,
      }),
    );
  }
  return Object.freeze(
    records.sort((left, right) => {
      const a = serializeCanonicalJson(left);
      const b = serializeCanonicalJson(right);
      return a < b ? -1 : a > b ? 1 : 0;
    }),
  );
}
