import type { Relation } from "../../../domain/relation.js";

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
