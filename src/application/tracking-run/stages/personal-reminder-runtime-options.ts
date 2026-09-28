import type {
  PersonalReminderCauseSemanticInput,
  PersonalReminderDuplicateOption,
  PersonalReminderPendingRelation,
  PersonalReminderTargetScope,
  PersonalReminderWaitingOption,
} from "../../../codex/personal-reminder-input-contracts.js";
import type { AiAnalysisDependencyInput } from "../../../domain/ai-analysis-dependencies.js";
import type {
  PersonalReminderCause,
  PersonalReminderCauseAssessment,
  PersonalReminderCauseId,
  PersonalReminderCauseSeed,
  PersonalReminderMissingInput,
  PersonalReminderResponseMembershipAssessmentRequirement,
  PersonalReminderResponsible,
} from "../../../domain/personal-reminder-causes.js";
import type { PreviousPersonalReminderCauses } from "../../../domain/personal-reminder-planning.js";
import { relationAffectsPersonalReminderCause } from "../../../domain/personal-reminder-planning.js";
import type { SourceId } from "../../../domain/source-id.js";
import type { GraphNodeId, NormalizedEvent } from "../../../domain/types.js";
import type { GitHubItemDetail } from "../../../github/item-detail-types.js";
import type { ReconciledGraphEdge } from "../../../graph/index.js";
import { assertNonNullable } from "../../../util/index.js";
import { compareEventOccurrence } from "./personal-reminder-runtime-activity.js";
import {
  addRuntimeSource,
  compareStrings,
  createNonEmptySourceIds,
  currentAiDependencyInput,
  seedAiDependencyInput,
} from "./personal-reminder-runtime-common.js";
import { contextItemByNodeId } from "./personal-reminder-runtime-context.js";
import type {
  PersonalReminderCauseNewDraftIdCollision,
  PersonalReminderRuntimeActiveRelation,
  PersonalReminderRuntimeCandidateRelation,
  PersonalReminderRuntimeContext,
  PersonalReminderRuntimeContextItem,
  PersonalReminderRuntimeCurrentSeed,
  PersonalReminderRuntimeOptionProjection,
  PersonalReminderRuntimePlanningIndexes,
  PersonalReminderRuntimeSource,
} from "./personal-reminder-runtime-contracts.js";
import {
  activeRelationIsEffective,
  candidateAffectsCause,
  connectedSeedRelations,
  duplicateCanonicalSeed,
  endpointStateAllowsRelation,
  negativeWorkCandidateEndpoints,
  pendingRelationContext,
  personalReminderCauseSeedAiDependencyInputs,
  relationEndpointsAllowPending,
  relationSourceProjectionForEdges,
  relationsIncidentToScope,
  scopeNodeIdsForSeed,
  targetScopeForSeed,
} from "./personal-reminder-runtime-relations.js";

/** 前回原因をIDで引ける索引にする。 */
export function previousCauseById(
  previous: PreviousPersonalReminderCauses,
): ReadonlyMap<PersonalReminderCauseId, PersonalReminderCause> {
  const causes = new Map<PersonalReminderCauseId, PersonalReminderCause>();
  for (const cause of previous.causes) {
    if (causes.has(cause.causeId)) {
      throw new TypeError(`前回cause IDが重複しています。対象: ${cause.causeId}`);
    }
    causes.set(cause.causeId, cause);
  }
  return causes;
}

/** 新規候補ID競合の前回原因を検証する。 */
export function assertNewDraftIdCollisionPreviousCauses(
  item: PersonalReminderRuntimeContextItem,
  conflict: PersonalReminderCauseNewDraftIdCollision,
): void {
  if (conflict.itemNodeId !== item.item.nodeId) {
    throw new TypeError(`new_draft ID衝突のitem node IDが一致しません。対象: ${item.item.nodeId}`);
  }
  for (const causeId of conflict.previousCauseIds) {
    const previousCause = item.previous.causes.find((cause) => cause.causeId === causeId);
    assertNonNullable(
      previousCause,
      `new_draft ID衝突のprevious causeがありません。対象: ${causeId}`,
    );
    if (previousCause.itemNodeId !== item.item.nodeId) {
      throw new TypeError(`new_draft ID衝突のprevious cause所有者が一致しません。対象: ${causeId}`);
    }
  }
}

/** 原因に必要な確定relationを選ぶ。 */
export function selectedRelationEdges(
  context: PersonalReminderRuntimeContext,
  seed: PersonalReminderCauseSeed,
  indexes: PersonalReminderRuntimePlanningIndexes,
): readonly PersonalReminderRuntimeActiveRelation[] {
  const relations = relationsIncidentToScope(indexes, scopeNodeIdsForSeed(seed));
  return Object.freeze(
    relations
      .filter((relation) => relationAffectsPersonalReminderCause(relation, seed))
      .filter(
        (relation) =>
          endpointStateAllowsRelation(context.graph, relation.fromNodeId) &&
          endpointStateAllowsRelation(context.graph, relation.toNodeId),
      )
      .sort((left, right) => compareStrings(left.id, right.id)),
  );
}

/** 原因に影響する未確定relationを選ぶ。 */
export function selectedPendingRelations(
  context: PersonalReminderRuntimeContext,
  seed: PersonalReminderCauseSeed,
): readonly PersonalReminderPendingRelation[] {
  const candidateById = new Map(
    context.graph.candidateRelations.map((candidate) => [candidate.candidateId, candidate]),
  );
  const pending: PersonalReminderPendingRelation[] = [];
  for (const resolution of context.graph.candidateResolutions) {
    if (resolution.status !== "pending") {
      continue;
    }
    const candidate = candidateById.get(resolution.candidateId);
    assertNonNullable(
      candidate,
      `pending relation candidateがありません。対象: ${resolution.candidateId}`,
    );
    if (
      candidateAffectsCause(candidate, seed) &&
      negativeWorkCandidateEndpoints(context, candidate) == null &&
      relationEndpointsAllowPending(context.graph, candidate.endpointNodeIds)
    ) {
      pending.push(pendingRelationContext(candidate, resolution));
    }
  }
  return Object.freeze(
    pending.sort((left, right) => compareStrings(left.candidateId, right.candidateId)),
  );
}

/** 決定論的に確定できる原因評価を作る。 */
export function deterministicAssessment(
  item: PersonalReminderRuntimeContextItem,
  seed: PersonalReminderCauseSeed,
  semanticInput: PersonalReminderCauseSemanticInput,
  origin: PersonalReminderRuntimeCurrentSeed["origin"],
): PersonalReminderCauseAssessment | undefined {
  if (
    origin !== "current_draft" ||
    seed.responsibility.authority !== "fixed" ||
    semanticInput.relations.length !== 0 ||
    semanticInput.pendingRelations.length !== 0 ||
    semanticInput.waitingOptions.length !== 0 ||
    semanticInput.duplicateOptions.length !== 0 ||
    semanticInput.completeness.status !== "complete" ||
    item.localDecision.aiAnalysisElementNecessities.status !== "not_required" ||
    item.localDecision.aiAnalysisElementNecessities.waitingOn !== "not_required" ||
    item.localDecision.aiAnalysisElementNecessities.nextAction !== "not_required"
  ) {
    return undefined;
  }
  const sourceIds = seed.evidenceSourceIds.filter((sourceId) =>
    semanticInput.sources.some((source) => source.sourceId === sourceId),
  );
  return {
    verdict: "actionable",
    references: {
      nodeIds: [seed.itemNodeId],
      relationIds: [],
      sourceIds,
      reasonSummary: "決定論的な責務と実行可能性が確認されています",
    },
    confidence: 1,
  };
}

type PersonalReminderAuthorReplyProjection = Readonly<{
  option: PersonalReminderWaitingOption | undefined;
  sources: readonly PersonalReminderRuntimeSource[];
  missing: readonly PersonalReminderMissingInput[];
}>;

function hasNonEmptyDetailConversationSource(
  detail: GitHubItemDetail,
  sourceId: SourceId,
): boolean {
  if (
    detail.comments.some((comment) => comment.sourceId === sourceId && comment.body.length !== 0)
  ) {
    return true;
  }
  if (detail.type !== "pull_request") {
    return false;
  }
  if (detail.reviews.some((review) => review.sourceId === sourceId && review.body.length !== 0)) {
    return true;
  }
  return detail.reviewThreads.some((thread) =>
    thread.comments.some((comment) => comment.sourceId === sourceId && comment.body.length !== 0),
  );
}

function authorReplyWaitingProjection(
  item: PersonalReminderRuntimeContextItem,
  seed: PersonalReminderCauseSeed,
  currentSeed: PersonalReminderRuntimeCurrentSeed,
): PersonalReminderAuthorReplyProjection | undefined {
  if (
    currentSeed.origin !== "current_draft" ||
    seed.responsibility.authority !== "fixed" ||
    seed.action.kind !== "revision" ||
    item.item.type !== "pull_request" ||
    item.localDecision.status !== "waiting_for_revision" ||
    (item.localDecision.aiAnalysisElementNecessities.status !== "required" &&
      item.localDecision.aiAnalysisElementNecessities.waitingOn !== "required" &&
      item.localDecision.aiAnalysisElementNecessities.nextAction !== "required")
  ) {
    return undefined;
  }
  const responsibilitySourceIds = new Set(item.localDecision.responsibilityBasis.sourceIds);
  const changesRequested = item.item.events
    .filter(
      (event): event is Extract<NormalizedEvent, { kind: "review" }> =>
        event.kind === "review" &&
        event.state === "changes_requested" &&
        responsibilitySourceIds.has(event.sourceId),
    )
    .sort(compareEventOccurrence);
  const latestChangesRequested = changesRequested.at(-1);
  if (latestChangesRequested == null) {
    return undefined;
  }
  const uncertaintyEvidence = item.localDecision.evidence.filter(
    (evidence) => evidence.supports === "uncertainty",
  );
  const uncertaintySourceIds = new Set(uncertaintyEvidence.map((evidence) => evidence.sourceId));
  const possibleAuthorSpeech = item.item.events.filter(
    (event): event is Extract<NormalizedEvent, { kind: "comment" | "review" }> =>
      (event.kind === "comment" || event.kind === "review") &&
      event.actor.type === "human" &&
      !event.bodyEmpty &&
      event.occurredAt > latestChangesRequested.occurredAt &&
      uncertaintySourceIds.has(latestChangesRequested.sourceId) &&
      uncertaintySourceIds.has(event.sourceId),
  );
  if (possibleAuthorSpeech.length === 0) {
    return undefined;
  }
  const author = item.item.author;
  const authorActor = author.status === "identified" ? author.actor : undefined;
  if (authorActor == null) {
    return Object.freeze({
      option: undefined,
      sources: Object.freeze([]),
      missing: Object.freeze([
        "item_conversation",
      ] satisfies readonly PersonalReminderMissingInput[]),
    });
  }
  if (authorActor.type !== "human") {
    return undefined;
  }
  const authorSpeech = possibleAuthorSpeech.filter(
    (event) => event.actor.type === "human" && event.actor.nodeId === authorActor.nodeId,
  );
  if (authorSpeech.length === 0) {
    return undefined;
  }
  const sourceById = new Map(
    item.sources
      .filter(
        (source) =>
          (source.source.kind === "comment" ||
            source.source.kind === "review" ||
            source.source.kind === "review_comment") &&
          source.source.actorType === "human" &&
          source.source.actorCandidateId?.toLowerCase() === authorActor.login.toLowerCase(),
      )
      .map((source) => [source.source.sourceId, source]),
  );
  const rawAuthorSpeech = authorSpeech.filter(
    (event) =>
      sourceById.has(event.sourceId) &&
      hasNonEmptyDetailConversationSource(item.detail, event.sourceId),
  );
  if (rawAuthorSpeech.length !== authorSpeech.length) {
    return Object.freeze({
      option: undefined,
      sources: Object.freeze([]),
      missing: Object.freeze([
        "item_conversation",
      ] satisfies readonly PersonalReminderMissingInput[]),
    });
  }
  const evidenceSourceIds = createNonEmptySourceIds(
    [latestChangesRequested.sourceId, ...rawAuthorSpeech.map((event) => event.sourceId)],
    `author reply waiting option ${seed.causeId}`,
  );
  const optionSources: PersonalReminderRuntimeSource[] = [];
  for (const sourceId of evidenceSourceIds) {
    const source =
      sourceById.get(sourceId) ?? item.sources.find((value) => value.source.sourceId === sourceId);
    if (source == null) {
      return Object.freeze({
        option: undefined,
        sources: Object.freeze([]),
        missing: Object.freeze([
          "item_conversation",
        ] satisfies readonly PersonalReminderMissingInput[]),
      });
    }
    optionSources.push(source);
  }
  return Object.freeze({
    option: Object.freeze({
      optionId: `${seed.causeId}:waiting:author-reply`,
      itemNodeId: seed.itemNodeId,
      targetScope: { kind: "item" } satisfies PersonalReminderTargetScope,
      action: Object.freeze({ kind: "reply", summary: "PR作者の質問や反論へ回答する" }),
      relationIds: [],
      evidenceSourceIds: [...evidenceSourceIds],
    }),
    sources: Object.freeze(optionSources),
    missing: Object.freeze([]),
  });
}

/** 原因が待つ可能性のある候補を作る。 */
export function waitingOptionsForCause(
  context: PersonalReminderRuntimeContext,
  item: PersonalReminderRuntimeContextItem,
  globalSourcesById: ReadonlyMap<SourceId, PersonalReminderRuntimeSource>,
  seed: PersonalReminderCauseSeed,
  relationEdges: readonly (ReconciledGraphEdge & Readonly<{ active: true }>)[],
  currentSeed: PersonalReminderRuntimeCurrentSeed,
  indexes: PersonalReminderRuntimePlanningIndexes,
): PersonalReminderRuntimeOptionProjection {
  const options: PersonalReminderWaitingOption[] = [];
  const sources = new Map<SourceId, PersonalReminderRuntimeSource>();
  const missing = new Set<PersonalReminderMissingInput>();
  const aiDependencyInputsByOptionId = new Map<string, readonly AiAnalysisDependencyInput[]>();
  const connected = connectedSeedRelations(indexes, seed, relationEdges, currentSeed);
  const candidateSeedsByCauseId = new Map<
    PersonalReminderCauseId,
    PersonalReminderRuntimeCurrentSeed
  >([...connected].map(([causeId, value]) => [causeId, value.currentSeed]));
  if (currentSeed.origin === "retained_without_draft") {
    for (const candidate of indexes.currentSeedsByItemNodeId.get(seed.itemNodeId) ?? []) {
      candidateSeedsByCauseId.set(candidate.seed.causeId, candidate);
    }
  }
  const candidateSeeds = [...candidateSeedsByCauseId.values()].sort((left, right) =>
    compareStrings(left.seed.causeId, right.seed.causeId),
  );
  for (const candidate of candidateSeeds) {
    if (
      candidate.origin !== "current_draft" ||
      candidate.seed.causeId === seed.causeId ||
      (currentSeed.draftIdentity != null && candidate.draftIdentity === currentSeed.draftIdentity)
    ) {
      continue;
    }
    const matchingRelations = connected.get(candidate.seed.causeId)?.relations ?? [];
    if (candidate.seed.itemNodeId === seed.itemNodeId) {
      if (
        currentSeed.origin !== "retained_without_draft" ||
        candidate.seed.action.kind === seed.action.kind
      ) {
        continue;
      }
    } else if (matchingRelations.length === 0) {
      continue;
    }
    const relationIds = matchingRelations.map((relation) => relation.id);
    const relationSources = relationSourceProjectionForEdges(matchingRelations, globalSourcesById);
    const relationSourceIds = matchingRelations.flatMap((relation) =>
      relation.evidence.map((evidence) => evidence.sourceId),
    );
    if (relationSources.missingSourceIds.length !== 0) {
      missing.add("relation_evidence");
    }
    const sourceIds = createNonEmptySourceIds(
      [...candidate.seed.evidenceSourceIds, ...relationSourceIds],
      `waiting option ${candidate.seed.causeId}`,
    );
    for (const source of candidate.item.sources) {
      if (sourceIds.includes(source.source.sourceId)) {
        addRuntimeSource(sources, source);
      }
    }
    for (const source of relationSources.sources) {
      addRuntimeSource(sources, source);
    }
    const option = Object.freeze({
      optionId: `${seed.causeId}:waiting:${candidate.seed.causeId}`,
      itemNodeId: candidate.seed.itemNodeId,
      targetScope: targetScopeForSeed(candidate.seed),
      action: { kind: candidate.seed.action.kind, summary: candidate.seed.action.summary },
      relationIds,
      evidenceSourceIds: [...sourceIds],
    });
    options.push(option);
    aiDependencyInputsByOptionId.set(
      option.optionId,
      Object.freeze([
        ...personalReminderCauseSeedAiDependencyInputs(candidate),
        ...matchingRelations.map((relation) => currentAiDependencyInput(relation.aiDependency)),
      ]),
    );
  }
  const representedRelationIds = new Set(
    [...connected]
      .filter(([causeId]) => causeId !== seed.causeId)
      .flatMap(([, value]) => value.relations.map((relation) => relation.id)),
  );
  const subjectScope = scopeNodeIdsForSeed(seed);
  for (const relation of relationEdges) {
    if (representedRelationIds.has(relation.id)) {
      continue;
    }
    let endpoint: GraphNodeId | undefined;
    if (subjectScope.has(relation.fromNodeId)) {
      endpoint = relation.toNodeId;
    } else if (subjectScope.has(relation.toNodeId)) {
      endpoint = relation.fromNodeId;
    }
    if (endpoint == null) {
      continue;
    }
    const endpointSeeds = indexes.currentSeedsByScopeNodeId.get(endpoint) ?? [];
    if (
      endpointSeeds.some(
        (candidate) =>
          candidate.seed.causeId === seed.causeId ||
          (currentSeed.draftIdentity != null &&
            candidate.draftIdentity === currentSeed.draftIdentity),
      )
    ) {
      continue;
    }
    const endpointItem = contextItemByNodeId(context, endpoint);
    if (endpointItem == null) {
      missing.add("related_item");
      continue;
    }
    const relatedContext = item.relatedContexts.find((value) => value.item.nodeId === endpoint);
    if (relatedContext?.localDecision == null) {
      missing.add("related_timeline");
    }
  }
  const authorReply = authorReplyWaitingProjection(item, seed, currentSeed);
  if (authorReply != null) {
    for (const source of authorReply.sources) {
      addRuntimeSource(sources, source);
    }
    for (const value of authorReply.missing) {
      missing.add(value);
    }
    if (authorReply.option != null) {
      options.push(authorReply.option);
      aiDependencyInputsByOptionId.set(
        authorReply.option.optionId,
        Object.freeze([currentAiDependencyInput(Object.freeze({ status: "not_dependent" }))]),
      );
    }
  }
  return Object.freeze({
    options: Object.freeze(
      options.sort((left, right) => compareStrings(left.optionId, right.optionId)),
    ),
    sources: Object.freeze([...sources.values()]),
    missing: Object.freeze([...missing]),
    aiDependencyInputsByOptionId,
  });
}

/** 原因と重複する可能性のある候補を作る。 */
export function duplicateOptionsForCause(
  context: PersonalReminderRuntimeContext,
  globalSourcesById: ReadonlyMap<SourceId, PersonalReminderRuntimeSource>,
  current: PersonalReminderRuntimeCurrentSeed,
  indexes: PersonalReminderRuntimePlanningIndexes,
): Readonly<{
  options: readonly PersonalReminderDuplicateOption[];
  sources: readonly PersonalReminderRuntimeSource[];
  aiDependencyInputsByCanonicalCauseId: ReadonlyMap<string, readonly AiAnalysisDependencyInput[]>;
}> {
  const options: PersonalReminderDuplicateOption[] = [];
  const sources = new Map<SourceId, PersonalReminderRuntimeSource>();
  const aiDependencyInputsByCanonicalCauseId = new Map<
    string,
    readonly AiAnalysisDependencyInput[]
  >();
  const effectiveRelations = relationsIncidentToScope(
    indexes,
    scopeNodeIdsForSeed(current.seed),
  ).filter(
    (relation) =>
      relation.type !== "related_to" && activeRelationIsEffective(context.graph, relation),
  );
  const connected = connectedSeedRelations(indexes, current.seed, effectiveRelations, current);
  for (const { currentSeed: candidate, relations: directRelations } of connected.values()) {
    if (!seedCanBeDuplicateCandidate(current, candidate)) {
      continue;
    }
    const relationIds = directRelations.map((relation) => relation.id);
    const canonical =
      current.origin === "retained_without_draft"
        ? candidate
        : duplicateCanonicalSeed(context, current, candidate, directRelations);
    if (canonical.seed.causeId !== candidate.seed.causeId) {
      continue;
    }
    const relationSourceEntries = relationSourceProjectionForEdges(
      directRelations,
      globalSourcesById,
    );
    const relationSourceIds = directRelations.flatMap((relation) =>
      relation.evidence.map((evidence) => evidence.sourceId),
    );
    const evidenceSourceIds = createNonEmptySourceIds(
      [...candidate.seed.evidenceSourceIds, ...relationSourceIds],
      `duplicate option ${candidate.seed.causeId}`,
    );
    for (const source of candidate.item.sources) {
      if (evidenceSourceIds.includes(source.source.sourceId)) {
        addRuntimeSource(sources, source);
      }
    }
    for (const source of relationSourceEntries.sources) {
      addRuntimeSource(sources, source);
    }
    const option = Object.freeze({
      canonicalCauseId: candidate.seed.causeId,
      itemNodeId: candidate.seed.itemNodeId,
      targetScope: targetScopeForSeed(candidate.seed),
      responsible: [...candidate.seed.responsible],
      action: { ...candidate.seed.action },
      relationIds,
      evidenceSourceIds: [...evidenceSourceIds],
    });
    options.push(option);
    if (aiDependencyInputsByCanonicalCauseId.has(option.canonicalCauseId)) {
      throw new TypeError(
        `duplicate optionのcanonical cause IDが重複しています。対象: ${option.canonicalCauseId}`,
      );
    }
    aiDependencyInputsByCanonicalCauseId.set(
      option.canonicalCauseId,
      Object.freeze([
        ...personalReminderCauseSeedAiDependencyInputs(candidate),
        ...directRelations.map((relation) => currentAiDependencyInput(relation.aiDependency)),
      ]),
    );
  }
  return Object.freeze({
    options: Object.freeze(options),
    sources: Object.freeze([...sources.values()]),
    aiDependencyInputsByCanonicalCauseId,
  });
}

function seedCanBeDuplicateCandidate(
  current: PersonalReminderRuntimeCurrentSeed,
  candidate: PersonalReminderRuntimeCurrentSeed,
): boolean {
  return (
    candidate.seed.causeId !== current.seed.causeId &&
    (current.draftIdentity == null || candidate.draftIdentity !== current.draftIdentity) &&
    candidate.origin === "current_draft" &&
    candidate.seed.action.kind === current.seed.action.kind &&
    sameResponsibleValues(candidate.seed.responsible, current.seed.responsible)
  );
}

function relationCandidateConnectsScopes(
  candidate: PersonalReminderRuntimeCandidateRelation,
  leftNodeIds: ReadonlySet<GraphNodeId>,
  rightNodeIds: ReadonlySet<GraphNodeId>,
): boolean {
  const [firstNodeId, secondNodeId] = candidate.endpointNodeIds;
  return (
    (leftNodeIds.has(firstNodeId) && rightNodeIds.has(secondNodeId)) ||
    (leftNodeIds.has(secondNodeId) && rightNodeIds.has(firstNodeId))
  );
}

function pendingRelationCanHideCauseAsDuplicate(
  current: PersonalReminderRuntimeCurrentSeed,
  candidateSeed: PersonalReminderRuntimeCurrentSeed,
  relationCandidate: PersonalReminderRuntimeCandidateRelation,
): boolean {
  if (
    !relationCandidateConnectsScopes(
      relationCandidate,
      scopeNodeIdsForSeed(current.seed),
      scopeNodeIdsForSeed(candidateSeed.seed),
    )
  ) {
    return false;
  }
  if (current.origin === "retained_without_draft") {
    return true;
  }
  if (compareStrings(candidateSeed.seed.causeId, current.seed.causeId) < 0) {
    return true;
  }
  const currentIsImplementation =
    current.item.item.type === "pull_request" &&
    relationCandidate.ownerNodeId === current.seed.itemNodeId;
  const candidateIsImplementation =
    candidateSeed.item.item.type === "pull_request" &&
    relationCandidate.ownerNodeId === candidateSeed.seed.itemNodeId;
  return candidateIsImplementation && !currentIsImplementation;
}

/** 未確定の人物所属に関するAI依存を集める。 */
export function pendingResponseMembershipDependencyInputs(
  context: PersonalReminderRuntimeContext,
  current: PersonalReminderRuntimeCurrentSeed,
  indexes: PersonalReminderRuntimePlanningIndexes,
): readonly AiAnalysisDependencyInput[] {
  const dependencies: AiAnalysisDependencyInput[] = [];
  for (const resolution of context.graph.candidateResolutions) {
    if (resolution.status !== "pending") {
      continue;
    }
    const candidate = context.graph.candidateRelations.find(
      (value) => value.candidateId === resolution.candidateId,
    );
    assertNonNullable(
      candidate,
      `pending relation candidateがありません。対象: ${resolution.candidateId}`,
    );
    if (
      candidate.authority !== "inferred" ||
      !relationEndpointsAllowPending(context.graph, candidate.endpointNodeIds)
    ) {
      continue;
    }
    const currentScopeNodeIds = scopeNodeIdsForSeed(current.seed);
    const [firstNodeId, secondNodeId] = candidate.endpointNodeIds;
    const duplicateCandidatesByCauseId = new Map<
      PersonalReminderCauseId,
      PersonalReminderRuntimeCurrentSeed
    >();
    if (currentScopeNodeIds.has(firstNodeId)) {
      for (const duplicateCandidate of indexes.currentSeedsByScopeNodeId.get(secondNodeId) ?? []) {
        duplicateCandidatesByCauseId.set(duplicateCandidate.seed.causeId, duplicateCandidate);
      }
    }
    if (currentScopeNodeIds.has(secondNodeId)) {
      for (const duplicateCandidate of indexes.currentSeedsByScopeNodeId.get(firstNodeId) ?? []) {
        duplicateCandidatesByCauseId.set(duplicateCandidate.seed.causeId, duplicateCandidate);
      }
    }
    const matchingDuplicateCandidates = [...duplicateCandidatesByCauseId.values()].filter(
      (duplicateCandidate) =>
        seedCanBeDuplicateCandidate(current, duplicateCandidate) &&
        pendingRelationCanHideCauseAsDuplicate(current, duplicateCandidate, candidate),
    );
    if (matchingDuplicateCandidates.length === 0) {
      continue;
    }
    if (candidate.aiDependency.status === "not_dependent") {
      throw new TypeError(
        `推定pending relation candidateのAI依存はnot_dependentにできません。対象: ${candidate.candidateId}`,
      );
    }
    dependencies.push(
      Object.freeze({
        origin: "current",
        dependency: candidate.aiDependency,
        relationCandidateAssessment: "missing",
      }),
      ...matchingDuplicateCandidates.flatMap((duplicateCandidate) => [
        seedAiDependencyInput(
          duplicateCandidate.seed.aiDependencies.presence,
          duplicateCandidate.origin,
        ),
        seedAiDependencyInput(
          duplicateCandidate.seed.aiDependencies.responsible,
          duplicateCandidate.origin,
        ),
      ]),
    );
  }
  return Object.freeze(dependencies);
}

/** 人物所属の意味評価が必要か判定する。 */
export function responseMembershipAssessmentRequirement(
  seed: PersonalReminderCauseSeed,
  duplicateOptions: readonly PersonalReminderDuplicateOption[],
): PersonalReminderResponseMembershipAssessmentRequirement {
  if (seed.responsibility.authority === "semantic" || duplicateOptions.length !== 0) {
    return Object.freeze({ status: "required" });
  }
  return Object.freeze({ status: "not_required" });
}

/** 二つの責任主体集合が同一か判定する。 */
export function sameResponsibleValues(
  left: readonly PersonalReminderResponsible[],
  right: readonly PersonalReminderResponsible[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const leftValues = left
    .map((value) => `${value.kind}\u0000${value.candidateId.toLowerCase()}\u0000${value.role}`)
    .sort(compareStrings);
  const rightValues = right
    .map((value) => `${value.kind}\u0000${value.candidateId.toLowerCase()}\u0000${value.role}`)
    .sort(compareStrings);
  return leftValues.every((value, index) => value === rightValues[index]);
}
