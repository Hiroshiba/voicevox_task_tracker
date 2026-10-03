import {
  normalizeVerifiedExternalReferences,
  type VerifiedExternalReference,
} from "../../domain/verified-external-reference.js";
import type {
  GitHubItemDetail,
  GitHubReferencedItem,
  GitHubTimelineEvent,
} from "../../github/item-detail-types.js";
import type { RelationCandidate } from "../../graph/index.js";
import { relationNodes } from "../../graph/relation-candidate-endpoints.js";

function timelineReferencedItems(event: GitHubTimelineEvent): readonly GitHubReferencedItem[] {
  if (event.kind === "cross_referenced") return [event.source];
  if (event.kind === "connected" || event.kind === "disconnected") return [event.subject];
  if (event.kind === "sub_issue_added" || event.kind === "sub_issue_removed") {
    return "status" in event.subIssue ? [] : [event.subIssue];
  }
  if (event.kind === "parent_issue_added" || event.kind === "parent_issue_removed") {
    return "status" in event.parent ? [] : [event.parent];
  }
  return [];
}

function referencedItems(detail: GitHubItemDetail): readonly GitHubReferencedItem[] {
  return Object.freeze([
    ...detail.timeline.flatMap(timelineReferencedItems),
    ...detail.inboundCrossReferences.map((reference) => reference.sourceItem),
    ...(detail.type === "issue"
      ? [
          ...(detail.nativeDependencies.availability === "available"
            ? detail.nativeDependencies.relations.map((relation) => relation.relatedItem)
            : []),
          ...(detail.nativeHierarchy.availability === "available"
            ? detail.nativeHierarchy.relations.map((relation) => relation.relatedItem)
            : []),
        ]
      : detail.nativeClosingIssues.map((relation) => relation.relatedItem)),
  ]);
}

/** 前回の証拠と今回の詳細確認済み候補から公開外部参照を固定する。 */
export function collectVerifiedExternalReferences(
  previous: readonly VerifiedExternalReference[],
  candidates: readonly RelationCandidate[],
  details: readonly GitHubItemDetail[],
): readonly VerifiedExternalReference[] {
  const excludedRepositories = new Set(
    details
      .flatMap(referencedItems)
      .filter((item) => item.repositoryArchived || item.repositoryDisabled)
      .map((item) => `${item.repositoryOwner}/${item.repositoryName}`.toLowerCase()),
  );
  return normalizeVerifiedExternalReferences([
    ...previous.filter(
      (reference) => !excludedRepositories.has(reference.repositoryFullName.toLowerCase()),
    ),
    ...candidates.flatMap((candidate) =>
      relationNodes(candidate.relation).flatMap((node) =>
        node.scope === "external_public" &&
        !excludedRepositories.has(`${node.repositoryOwner}/${node.repositoryName}`.toLowerCase())
          ? [
              {
                repositoryFullName: `${node.repositoryOwner}/${node.repositoryName}`,
                number: node.number,
                url: node.url,
              },
            ]
          : [],
      ),
    ),
  ]);
}
