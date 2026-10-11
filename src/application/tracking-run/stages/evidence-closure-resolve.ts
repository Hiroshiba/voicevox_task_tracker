import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import { parseSourceId } from "../../../domain/source-id.js";
import { isProductionSourceIdKind } from "../../../github/production-source-id.js";
import type { CurrentSourceFact } from "../contracts/evidence-catalog.js";
import type { ContentDigestPort } from "../contracts/content-digest-port.js";
import type {
  EvidenceResolutionContext,
  EvidenceUse,
  OwnedHistoricalEvidence,
  ResolvedEvidenceUse,
} from "../contracts/evidence-closure.js";
import {
  aiResultSourceIds,
  matchingHistoricalAiResults,
  type AiResultSlot,
} from "./evidence-ai-results.js";
import { RunCompletenessError } from "./run-completeness-error.js";

function historyEventKinds(kind: string): readonly string[] {
  if (kind === "comment") return ["github_issue_comment", "github_pull_request_review_comment"];
  if (kind === "push") return ["github_timeline_event", "github_pull_request_commit"];
  if (kind === "review") return ["github_pull_request_review"];
  if (kind === "relation") {
    return [
      "github_timeline_event",
      "github_native_dependency",
      "github_native_hierarchy",
      "github_native_closing_issue",
    ];
  }
  return ["github_timeline_event"];
}

function assertCurrentFact(
  use: EvidenceUse,
  fact: CurrentSourceFact,
  context: EvidenceResolutionContext,
  allowedOwnerNodeIds: readonly string[],
): void {
  const repositoryIds = new Set<string>(
    context.approvedRepositories.map((repository) => repository.id),
  );
  if (
    fact.immutable.repositoryId != null &&
    !repositoryIds.has(fact.immutable.repositoryId) &&
    !(fact.sourceKind === "github_item" && fact.origin === "item_detail")
  ) {
    throw new RunCompletenessError("private_source", use.sourceId, use.path, use);
  }
  const sourceOwner = parseSourceId(use.sourceId).originalId;
  if (
    (fact.sourceKind === "github_item" && fact.immutable.nodeId !== sourceOwner) ||
    ((fact.sourceKind === "github_item_body" || fact.sourceKind === "github_item_detail") &&
      fact.itemNodeId !== sourceOwner)
  ) {
    throw new RunCompletenessError("wrong_owner", use.sourceId, use.path, use);
  }
  if (fact.scope === "item" && !allowedOwnerNodeIds.includes(fact.itemNodeId)) {
    throw new RunCompletenessError("wrong_owner", use.sourceId, use.path, use);
  }
  for (const occurredAt of [fact.immutable.occurredAt, fact.immutable.committedAt]) {
    if (occurredAt != null && occurredAt > context.evaluatedAt) {
      throw new RunCompletenessError("future_source", use.sourceId, use.path, use);
    }
  }
  if (use.purpose.startsWith("history_")) {
    const kind = use.purpose.slice("history_".length);
    if (!historyEventKinds(kind).includes(fact.sourceKind)) {
      throw new RunCompletenessError("kind_mismatch", use.sourceId, use.path, use);
    }
  }
}

function historicalOwnerMatches(
  use: EvidenceUse,
  value: OwnedHistoricalEvidence,
  allowedOwnerNodeIds: readonly string[],
): boolean {
  if (value.owner.kind === "item") {
    return allowedOwnerNodeIds.includes(value.owner.itemNodeId);
  }
  return (
    use.allowedRelationIds.includes(value.owner.relationId) &&
    allowedOwnerNodeIds.includes(value.owner.fromNodeId) &&
    allowedOwnerNodeIds.includes(value.owner.toNodeId)
  );
}

function assertHistoricalRecord(
  use: EvidenceUse,
  value: OwnedHistoricalEvidence,
  context: EvidenceResolutionContext,
): void {
  if (value.owner.kind !== "item") return;
  const repositoryIds = new Set<string>(
    context.approvedRepositories.map((repository) => repository.id),
  );
  if (!repositoryIds.has(value.owner.repositoryId)) {
    throw new RunCompletenessError("private_source", use.sourceId, use.path, use);
  }
}

function historicalAiSlot(slot: AiResultSlot): boolean {
  const analysisIndex = slot.path.indexOf("aiAnalysis");
  if (analysisIndex >= 0) {
    return (
      slot.path[analysisIndex + 1] === "retainedElements" ||
      slot.path[analysisIndex + 1] === "elements"
    );
  }
  return (
    slot.path[0] === "aiItems" && (slot.path[4] === "retained" || slot.path[4] === "evaluated")
  );
}

function retainedItemEvidence(use: EvidenceUse, context: EvidenceResolutionContext): boolean {
  const itemEvidencePath =
    (use.path[0] === "items" && use.path[2] === "item" && use.path[3] === "evidence") ||
    (use.path[0] === "snapshot" && use.path[1] === "items" && use.path[3] === "evidence");
  return (
    itemEvidencePath &&
    use.destination.kind === "item" &&
    context.retainedAiSourceIdsByItem.get(use.destination.itemNodeId)?.has(use.sourceId) === true
  );
}

function historicalImplementationOwnerNodeIds(
  use: EvidenceUse,
  context: EvidenceResolutionContext,
): readonly string[] {
  if (use.destination.kind !== "item") return Object.freeze([]);
  const itemNodeId = use.destination.itemNodeId;
  const approved = new Set<string>(context.approvedRepositories.map((repository) => repository.id));
  return Object.freeze(
    context.historicalNativeImplementations
      .filter(
        (relation) =>
          relation.issueNodeId === itemNodeId &&
          approved.has(relation.repositoryId) &&
          relation.evidence.some((evidence) => evidence.supports === "relation"),
      )
      .map((relation) => relation.implementationNodeId),
  );
}

function historicalAiOwnerNodeIds(
  use: EvidenceUse,
  slot: AiResultSlot,
  context: EvidenceResolutionContext,
): readonly string[] {
  return historicalAiSlot(slot)
    ? Object.freeze([
        ...use.allowedOwnerNodeIds,
        ...historicalImplementationOwnerNodeIds(use, context),
      ])
    : use.allowedOwnerNodeIds;
}

function assertKnownItemSourceOwner(
  use: EvidenceUse,
  sourceKind: string,
  allowedOwnerNodeIds: readonly string[],
): void {
  if (
    sourceKind !== "github_item" &&
    sourceKind !== "github_item_body" &&
    sourceKind !== "github_item_detail"
  ) {
    return;
  }
  const ownerNodeId = parseSourceId(use.sourceId).originalId;
  if (!allowedOwnerNodeIds.includes(ownerNodeId)) {
    throw new RunCompletenessError("wrong_owner", use.sourceId, use.path, use);
  }
}

/** 一つの利用を現行事実か所有位置を証明できる履歴recordへ解決する。 */
export function resolveEvidenceUse(
  use: EvidenceUse,
  currentById: ReadonlyMap<string, readonly CurrentSourceFact[]>,
  historicalById: ReadonlyMap<string, readonly OwnedHistoricalEvidence[]>,
  context: EvidenceResolutionContext,
  digest: ContentDigestPort,
  annotation?: Readonly<{ supports: string; summary: string }>,
  aiSlot?: Readonly<{ slot: AiResultSlot; origin: "current" | "historical" }>,
): Readonly<{ resolved: ResolvedEvidenceUse; historical: readonly OwnedHistoricalEvidence[] }> {
  const sourceKind = parseSourceId(use.sourceId).kind;
  if (!isProductionSourceIdKind(sourceKind)) {
    throw new RunCompletenessError("kind_mismatch", use.sourceId, use.path, use);
  }
  if (aiSlot != null) {
    const { slot, origin } = aiSlot;
    if (
      !use.allowedOwnerNodeIds.includes(slot.owner.itemNodeId) ||
      !aiResultSourceIds(slot.element, slot.result).includes(use.sourceId)
    ) {
      throw new RunCompletenessError("wrong_owner", use.sourceId, use.path, use);
    }
    if (origin === "historical") {
      if (use.requiredCurrentness === "current")
        throw new RunCompletenessError("missing_source", use.sourceId, use.path, use);
      const repositories = new Set<string>(
        context.approvedRepositories.map((repository) => repository.id),
      );
      if (!repositories.has(slot.owner.repositoryId))
        throw new RunCompletenessError("private_source", use.sourceId, use.path, use);
      const matched = matchingHistoricalAiResults(slot, context.historicalAiResults);
      const allowedOwnerNodeIds = historicalAiOwnerNodeIds(use, slot, context);
      assertKnownItemSourceOwner(use, sourceKind, allowedOwnerNodeIds);
      const facts = currentById.get(use.sourceId) ?? [];
      for (const fact of facts) {
        if (fact.sourceKind !== sourceKind) {
          throw new RunCompletenessError("kind_mismatch", use.sourceId, use.path, use);
        }
        assertCurrentFact(use, fact, context, allowedOwnerNodeIds);
      }
      return Object.freeze({
        resolved: Object.freeze({
          use,
          resolution: "historical",
          recordDigest: digest.sha256Utf8(
            serializeCanonicalJson({
              matched,
              ...(annotation == null ? {} : { annotation }),
            }),
          ),
        }),
        historical: Object.freeze([]),
      });
    }
  }
  const previousNotification = use.purpose === "previous_notification_pending";
  const facts = previousNotification ? [] : (currentById.get(use.sourceId) ?? []);
  if (
    facts.length > 0 &&
    use.destination.kind === "item" &&
    retainedItemEvidence(use, context) &&
    annotation != null
  ) {
    const itemNodeId = use.destination.itemNodeId;
    const historical = historicalById.get(use.sourceId) ?? [];
    const matched = historical.filter(
      (value) =>
        value.owner.kind === "item" &&
        value.owner.itemNodeId === itemNodeId &&
        value.record.evidence.supports === annotation.supports &&
        value.record.evidence.summary === annotation.summary,
    );
    if (matched.length > 0) {
      const allowedOwnerNodeIds = [
        ...use.allowedOwnerNodeIds,
        ...historicalImplementationOwnerNodeIds(use, context),
      ];
      assertKnownItemSourceOwner(use, sourceKind, allowedOwnerNodeIds);
      for (const fact of facts) {
        if (fact.sourceKind !== sourceKind) {
          throw new RunCompletenessError("kind_mismatch", use.sourceId, use.path, use);
        }
        assertCurrentFact(use, fact, context, allowedOwnerNodeIds);
      }
      for (const value of matched) assertHistoricalRecord(use, value, context);
      return Object.freeze({
        resolved: Object.freeze({
          use,
          resolution: "historical",
          recordDigest: digest.sha256Utf8(serializeCanonicalJson({ matched, annotation })),
        }),
        historical: Object.freeze(matched),
      });
    }
  }
  if (facts.length > 0) {
    for (const fact of facts) {
      if (fact.sourceKind !== sourceKind) {
        throw new RunCompletenessError("kind_mismatch", use.sourceId, use.path, use);
      }
      assertCurrentFact(use, fact, context, use.allowedOwnerNodeIds);
    }
    return Object.freeze({
      resolved: Object.freeze({
        use,
        resolution: "current",
        recordDigest: digest.sha256Utf8(
          serializeCanonicalJson({
            facts,
            ...(annotation == null ? {} : { annotation }),
          }),
        ),
      }),
      historical: Object.freeze([]),
    });
  }
  const historical = historicalById.get(use.sourceId) ?? [];
  if (use.requiredCurrentness === "current" || historical.length === 0) {
    throw new RunCompletenessError("missing_source", use.sourceId, use.path, use);
  }
  const owned = historical.filter((value) =>
    historicalOwnerMatches(use, value, use.allowedOwnerNodeIds),
  );
  if (owned.length === 0) {
    throw new RunCompletenessError("wrong_owner", use.sourceId, use.path, use);
  }
  const matched = owned.filter(
    (value) =>
      annotation == null ||
      (value.record.evidence.supports === annotation.supports &&
        value.record.evidence.summary === annotation.summary),
  );
  if (matched.length === 0) {
    throw new RunCompletenessError("missing_source", use.sourceId, use.path, use);
  }
  for (const value of matched) assertHistoricalRecord(use, value, context);
  return Object.freeze({
    resolved: Object.freeze({
      use,
      resolution: "historical",
      recordDigest: digest.sha256Utf8(
        serializeCanonicalJson({
          matched,
          ...(annotation == null ? {} : { annotation }),
        }),
      ),
    }),
    historical: Object.freeze(matched),
  });
}
