import type {
  PersonalReminderAiRelationContext,
  PersonalReminderPendingRelation,
  PersonalReminderTargetScope,
} from "../../../codex/personal-reminder-input-contracts.js";
import type { AiAnalysisDependencyInput } from "../../../domain/ai-analysis-dependencies.js";
import type {
  PersonalReminderCauseAiDependencies,
  PersonalReminderCauseId,
  PersonalReminderCauseSeed,
  PersonalReminderExecutionSurface,
  PersonalReminderInputCompleteness,
  PersonalReminderMissingInput,
  PersonalReminderResponsible,
} from "../../../domain/personal-reminder-causes.js";
import type {
  PersonalReminderCauseDraft,
  PersonalReminderItem,
  PersonalReminderReviewRequestTarget,
} from "../../../domain/personal-reminder-planning.js";
import type { SourceId } from "../../../domain/source-id.js";
import type { GitHubNodeId, GraphNodeId } from "../../../domain/types.js";
import type {
  PendingRelationCandidateResolution,
  ReconciledGraphEdge,
} from "../../../graph/index.js";
import { assertNonNullable } from "../../../util/index.js";
import {
  addRuntimeSource,
  compareStrings,
  createNonEmptySourceIds,
  createRuntimeSourceRoles,
  currentAiDependencyInput,
  seedAiDependencyInput,
} from "./personal-reminder-runtime-common.js";
import {
  candidateEndpointItemByNodeId,
  contextItemByNodeId,
} from "./personal-reminder-runtime-context-values.js";
import type {
  PersonalReminderConnectedSeedRelations,
  PersonalReminderGraphDraftProjection,
  PersonalReminderRuntimeActiveRelation,
  PersonalReminderRuntimeCandidateEndpointItem,
  PersonalReminderRuntimeCandidateRelation,
  PersonalReminderRuntimeContext,
  PersonalReminderRuntimeContextItem,
  PersonalReminderRuntimeCurrentSeed,
  PersonalReminderRuntimeGraph,
  PersonalReminderRuntimePlanningIndexes,
  PersonalReminderRuntimeSource,
  PersonalReminderRuntimeSourceProjection,
  PersonalReminderRuntimeSubjectDependency,
} from "./personal-reminder-runtime-contracts.js";

function endpointIsOpen(
  graph: PersonalReminderRuntimeGraph,
  relation: Readonly<{ fromNodeId: GraphNodeId; toNodeId: GraphNodeId }>,
): boolean {
  const fromState = graph.endpointStates.get(relation.fromNodeId);
  const toState = graph.endpointStates.get(relation.toNodeId);
  if (fromState == null || toState == null) {
    throw new TypeError("graph relationのendpoint stateがありません");
  }
  return fromState === "open" && toState === "open";
}

/** 端点状態が確定relationの利用を許すか判定する。 */
export function endpointStateAllowsRelation(
  graph: PersonalReminderRuntimeGraph,
  nodeId: GraphNodeId,
): boolean {
  const state = graph.endpointStates.get(nodeId);
  if (state == null) {
    throw new TypeError(`graph relationのendpoint stateがありません。対象: ${nodeId}`);
  }
  return state === "open" || state === "missing";
}

/** 端点状態が未確定relationの利用を許すか判定する。 */
export function relationEndpointsAllowPending(
  graph: PersonalReminderRuntimeGraph,
  endpointNodeIds: readonly [GraphNodeId, GraphNodeId],
): boolean {
  return (
    endpointStateAllowsRelation(graph, endpointNodeIds[0]) &&
    endpointStateAllowsRelation(graph, endpointNodeIds[1])
  );
}

/** active relationが最終graphで有効か判定する。 */
export function activeRelationIsEffective(
  graph: PersonalReminderRuntimeGraph,
  relation: ReconciledGraphEdge & Readonly<{ active: true }>,
): boolean {
  return endpointIsOpen(graph, relation);
}

/** relation候補が原因の範囲に影響するか判定する。 */
export function candidateAffectsCause(
  candidate: PersonalReminderRuntimeCandidateRelation,
  cause: PersonalReminderCauseSeed,
): boolean {
  const scopeNodeIds = seedScopeNodeIds(cause);
  return candidate.endpointNodeIds.some((nodeId) => scopeNodeIds.has(nodeId));
}

function scopeNodeIds(
  itemNodeId: GraphNodeId,
  scope: PersonalReminderTargetScope,
): ReadonlySet<GraphNodeId> {
  const nodeIds = new Set<GraphNodeId>([itemNodeId]);
  if (scope.kind !== "item") {
    for (const surface of scope.surfaces) {
      nodeIds.add(surface.nodeId);
    }
  }
  return nodeIds;
}

/** 原因seedの対象範囲に属するnode IDを取得する。 */
export function seedScopeNodeIds(seed: PersonalReminderCauseSeed): ReadonlySet<GraphNodeId> {
  return scopeNodeIds(seed.itemNodeId, seed.responsibility.scope);
}

/** 待機候補の対象範囲に属するnode IDを取得する。 */
export function optionTargetScopeNodeIds(
  option: Readonly<{
    itemNodeId: GraphNodeId;
    targetScope: PersonalReminderTargetScope;
  }>,
): ReadonlySet<GraphNodeId> {
  return scopeNodeIds(option.itemNodeId, option.targetScope);
}

/** 原因seedの責務範囲を待機候補の範囲へ変換する。 */
export function targetScopeForSeed(seed: PersonalReminderCauseSeed): PersonalReminderTargetScope {
  return seed.responsibility.scope;
}

function relationConnectsScopes(
  relation: PersonalReminderRuntimeActiveRelation,
  leftNodeIds: ReadonlySet<GraphNodeId>,
  rightNodeIds: ReadonlySet<GraphNodeId>,
): boolean {
  return (
    (leftNodeIds.has(relation.fromNodeId) && rightNodeIds.has(relation.toNodeId)) ||
    (leftNodeIds.has(relation.toNodeId) && rightNodeIds.has(relation.fromNodeId))
  );
}

/** 原因seedとrelationの計画用索引を作る。 */
export function createPersonalReminderPlanningIndexes(
  context: PersonalReminderRuntimeContext,
  currentSeeds: readonly PersonalReminderRuntimeCurrentSeed[],
): PersonalReminderRuntimePlanningIndexes {
  const activeRelationsByNodeId = new Map<GraphNodeId, PersonalReminderRuntimeActiveRelation[]>();
  for (const relation of context.graph.activeRelations) {
    const fromRelations = activeRelationsByNodeId.get(relation.fromNodeId);
    if (fromRelations == null) {
      activeRelationsByNodeId.set(relation.fromNodeId, [relation]);
    } else {
      fromRelations.push(relation);
    }
    if (relation.toNodeId === relation.fromNodeId) {
      continue;
    }
    const toRelations = activeRelationsByNodeId.get(relation.toNodeId);
    if (toRelations == null) {
      activeRelationsByNodeId.set(relation.toNodeId, [relation]);
    } else {
      toRelations.push(relation);
    }
  }

  const currentSeedByCauseId = new Map<
    PersonalReminderCauseId,
    PersonalReminderRuntimeCurrentSeed
  >();
  const currentSeedsByItemNodeId = new Map<GraphNodeId, PersonalReminderRuntimeCurrentSeed[]>();
  const currentSeedsByScopeNodeId = new Map<GraphNodeId, PersonalReminderRuntimeCurrentSeed[]>();
  for (const currentSeed of currentSeeds) {
    if (currentSeed.probe) {
      throw new TypeError(
        `終了probeをcurrent option indexへ追加できません。対象: ${currentSeed.seed.causeId}`,
      );
    }
    if (currentSeedByCauseId.has(currentSeed.seed.causeId)) {
      throw new TypeError(`current seed IDが重複しています。対象: ${currentSeed.seed.causeId}`);
    }
    currentSeedByCauseId.set(currentSeed.seed.causeId, currentSeed);
    const itemSeeds = currentSeedsByItemNodeId.get(currentSeed.seed.itemNodeId);
    if (itemSeeds == null) {
      currentSeedsByItemNodeId.set(currentSeed.seed.itemNodeId, [currentSeed]);
    } else {
      itemSeeds.push(currentSeed);
    }
    const nodeIds = seedScopeNodeIds(currentSeed.seed);
    for (const nodeId of nodeIds) {
      const scopedSeeds = currentSeedsByScopeNodeId.get(nodeId);
      if (scopedSeeds == null) {
        currentSeedsByScopeNodeId.set(nodeId, [currentSeed]);
      } else {
        scopedSeeds.push(currentSeed);
      }
    }
  }

  return Object.freeze({
    activeRelationsByNodeId: new Map(
      [...activeRelationsByNodeId].map(([nodeId, relations]) => [nodeId, Object.freeze(relations)]),
    ),
    currentSeedByCauseId,
    currentSeedsByItemNodeId: new Map(
      [...currentSeedsByItemNodeId].map(([nodeId, seeds]) => [nodeId, Object.freeze(seeds)]),
    ),
    currentSeedsByScopeNodeId: new Map(
      [...currentSeedsByScopeNodeId].map(([nodeId, seeds]) => [nodeId, Object.freeze(seeds)]),
    ),
  });
}

/** 原因seedと実行面のnode IDを集める。 */
export function scopeNodeIdsForSeed(seed: PersonalReminderCauseSeed): ReadonlySet<GraphNodeId> {
  return seedScopeNodeIds(seed);
}

/** 対象範囲に接続する有効relationを取得する。 */
export function relationsIncidentToScope(
  indexes: PersonalReminderRuntimePlanningIndexes,
  nodeIds: ReadonlySet<GraphNodeId>,
): readonly PersonalReminderRuntimeActiveRelation[] {
  const relationsById = new Map<string, PersonalReminderRuntimeActiveRelation>();
  for (const nodeId of nodeIds) {
    for (const relation of indexes.activeRelationsByNodeId.get(nodeId) ?? []) {
      relationsById.set(relation.id, relation);
    }
  }
  return Object.freeze([...relationsById.values()]);
}

/** 原因seedに接続する有効relationを取得する。 */
export function connectedSeedRelations(
  indexes: PersonalReminderRuntimePlanningIndexes,
  seed: PersonalReminderCauseSeed,
  relations: readonly PersonalReminderRuntimeActiveRelation[],
  subject: PersonalReminderRuntimeCurrentSeed,
): ReadonlyMap<PersonalReminderCauseId, PersonalReminderConnectedSeedRelations> {
  const seedNodeIds = scopeNodeIdsForSeed(seed);
  const relationsByCauseId = new Map<
    PersonalReminderCauseId,
    Readonly<{
      currentSeed: PersonalReminderRuntimeCurrentSeed;
      relationsById: Map<string, PersonalReminderRuntimeActiveRelation>;
    }>
  >();
  for (const relation of relations) {
    const candidateSeeds: PersonalReminderRuntimeCurrentSeed[] = [];
    if (seedNodeIds.has(relation.fromNodeId)) {
      candidateSeeds.push(...(indexes.currentSeedsByScopeNodeId.get(relation.toNodeId) ?? []));
    }
    if (seedNodeIds.has(relation.toNodeId)) {
      candidateSeeds.push(...(indexes.currentSeedsByScopeNodeId.get(relation.fromNodeId) ?? []));
    }
    for (const candidate of candidateSeeds) {
      if (
        candidate.seed.causeId === seed.causeId ||
        (subject.draftIdentity != null && candidate.draftIdentity === subject.draftIdentity)
      ) {
        continue;
      }
      if (!relationConnectsScopes(relation, seedNodeIds, scopeNodeIdsForSeed(candidate.seed))) {
        continue;
      }
      const existing = relationsByCauseId.get(candidate.seed.causeId);
      if (existing == null) {
        relationsByCauseId.set(
          candidate.seed.causeId,
          Object.freeze({
            currentSeed: candidate,
            relationsById: new Map([[relation.id, relation]]),
          }),
        );
      } else {
        existing.relationsById.set(relation.id, relation);
      }
    }
  }
  return new Map(
    [...relationsByCauseId]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([causeId, value]) => [
        causeId,
        Object.freeze({
          currentSeed: value.currentSeed,
          relations: Object.freeze(
            [...value.relationsById.values()].sort((left, right) =>
              compareStrings(left.id, right.id),
            ),
          ),
        }),
      ]),
  );
}

function seedRepresentsImplementsSource(
  context: PersonalReminderRuntimeContext,
  seed: PersonalReminderCauseSeed,
  relation: ReconciledGraphEdge & Readonly<{ active: true }>,
): boolean {
  if (relation.type !== "implements") {
    return false;
  }
  const item = contextItemByNodeId(context, seed.itemNodeId);
  return item?.item.type === "pull_request" && relation.fromNodeId === seed.itemNodeId;
}

/** 重複候補から正本となる原因seedを選ぶ。 */
export function duplicateCanonicalSeed(
  context: PersonalReminderRuntimeContext,
  left: PersonalReminderRuntimeCurrentSeed,
  right: PersonalReminderRuntimeCurrentSeed,
  relations: readonly (ReconciledGraphEdge & Readonly<{ active: true }>)[],
): PersonalReminderRuntimeCurrentSeed {
  const implementsRelation = relations.find((relation) => relation.type === "implements");
  if (implementsRelation != null) {
    const leftIsImplementation = seedRepresentsImplementsSource(
      context,
      left.seed,
      implementsRelation,
    );
    const rightIsImplementation = seedRepresentsImplementsSource(
      context,
      right.seed,
      implementsRelation,
    );
    if (leftIsImplementation !== rightIsImplementation) {
      return leftIsImplementation ? left : right;
    }
  }
  return compareStrings(left.seed.causeId, right.seed.causeId) <= 0 ? left : right;
}

/** 確定edgeをAI入力用のrelationへ変換する。 */
export function relationContextFromEdge(
  relation: ReconciledGraphEdge & Readonly<{ active: true }>,
): PersonalReminderAiRelationContext {
  const evidenceSourceIds = createNonEmptySourceIds(
    relation.evidence.map((evidence) => evidence.sourceId),
    `relation ${relation.id}`,
  );
  return Object.freeze({
    id: relation.id,
    fromNodeId: relation.fromNodeId,
    toNodeId: relation.toNodeId,
    type: relation.type,
    provenance: relation.provenance,
    confidence: relation.confidence,
    authoritative: relation.authoritative,
    evidenceSourceIds: [...evidenceSourceIds],
  });
}

function relationSourcesFromEdge(
  relation: ReconciledGraphEdge & Readonly<{ active: true }>,
  canonicalSourcesById: ReadonlyMap<SourceId, PersonalReminderRuntimeSource>,
): PersonalReminderRuntimeSourceProjection {
  const sources = new Map<SourceId, PersonalReminderRuntimeSource>();
  const missingSourceIds = new Set<SourceId>();
  for (const evidence of relation.evidence) {
    const canonicalSource = canonicalSourcesById.get(evidence.sourceId);
    if (canonicalSource == null) {
      missingSourceIds.add(evidence.sourceId);
      continue;
    }
    addRuntimeSource(
      sources,
      Object.freeze({
        source: canonicalSource.source,
        roles: createRuntimeSourceRoles([...canonicalSource.roles, "relation"]),
        evidence: Object.freeze([evidence]),
        causalPush: canonicalSource.causalPush,
      }),
    );
  }
  return Object.freeze({
    sources: Object.freeze([...sources.values()]),
    missingSourceIds: Object.freeze([...missingSourceIds].sort(compareStrings)),
  });
}

/** 確定edgeの根拠sourceを収集する。 */
export function relationSourceProjectionForEdges(
  relations: readonly (ReconciledGraphEdge & Readonly<{ active: true }>)[],
  canonicalSourcesById: ReadonlyMap<SourceId, PersonalReminderRuntimeSource>,
): PersonalReminderRuntimeSourceProjection {
  const sources = new Map<SourceId, PersonalReminderRuntimeSource>();
  const missingSourceIds = new Set<SourceId>();
  for (const relation of relations) {
    const projection = relationSourcesFromEdge(relation, canonicalSourcesById);
    for (const source of projection.sources) {
      addRuntimeSource(sources, source);
    }
    for (const sourceId of projection.missingSourceIds) {
      missingSourceIds.add(sourceId);
    }
  }
  return Object.freeze({
    sources: Object.freeze([...sources.values()]),
    missingSourceIds: Object.freeze([...missingSourceIds].sort(compareStrings)),
  });
}

/** 未確定候補を原因入力用のrelationへ変換する。 */
export function pendingRelationContext(
  candidate: PersonalReminderRuntimeCandidateRelation,
  resolution: PendingRelationCandidateResolution,
): PersonalReminderPendingRelation {
  const endpointNodeIds: [GraphNodeId, GraphNodeId] = [
    candidate.endpointNodeIds[0],
    candidate.endpointNodeIds[1],
  ];
  return Object.freeze({
    candidateId: candidate.candidateId,
    endpointNodeIds,
    status: "pending",
    reason: resolution.reason,
    evidenceSourceIds: [...candidate.evidenceSourceIds],
  });
}

/** 現在のreview依頼先を項目から取得する。 */
export function currentReviewTargetFromItem(
  item: PersonalReminderItem,
): readonly PersonalReminderReviewRequestTarget[] {
  if (item.type !== "pull_request") {
    return Object.freeze([]);
  }
  return Object.freeze(
    item.reviewRequests.map((request) =>
      request.target.type === "user"
        ? Object.freeze({ kind: "user", candidateId: request.target.actor.login })
        : Object.freeze({
            kind: "team",
            candidateId: `${request.target.organizationLogin}/${request.target.slug}`,
          }),
    ),
  );
}

function graphRelationSupportRank(
  relation: ReconciledGraphEdge & Readonly<{ active: true }>,
): number {
  if (relation.authoritative) {
    return 0;
  }
  switch (relation.aiDependency.status) {
    case "current":
      return 1;
    case "unverified":
      return 2;
    case "unknown":
      return 3;
    case "not_dependent":
      return 4;
    default:
      throw new TypeError(`implements relationのAI依存状態が不正です。対象: ${relation.id}`);
  }
}

function compareGraphRelationSupport(
  left: ReconciledGraphEdge & Readonly<{ active: true }>,
  right: ReconciledGraphEdge & Readonly<{ active: true }>,
): number {
  const rankDifference = graphRelationSupportRank(left) - graphRelationSupportRank(right);
  return rankDifference === 0 ? compareStrings(left.id, right.id) : rankDifference;
}

function graphRelationAiDependencies(
  relation: ReconciledGraphEdge & Readonly<{ active: true }>,
): PersonalReminderCauseAiDependencies {
  return Object.freeze({
    presence: relation.aiDependency,
    responseMembership: Object.freeze({ status: "not_dependent" }),
    responsible: relation.aiDependency,
    action: Object.freeze({ status: "not_dependent" }),
    evidence: relation.aiDependency,
  });
}

/** 原因seedの各fieldに対するAI依存入力を集める。 */
export function personalReminderCauseSeedAiDependencyInputs(
  currentSeed: PersonalReminderRuntimeCurrentSeed,
): readonly AiAnalysisDependencyInput[] {
  const seed = currentSeed.seed;
  return Object.freeze([
    seedAiDependencyInput(seed.aiDependencies.presence, currentSeed.origin),
    seedAiDependencyInput(seed.aiDependencies.responsible, currentSeed.origin),
    seedAiDependencyInput(seed.aiDependencies.action, currentSeed.origin),
    seedAiDependencyInput(seed.aiDependencies.evidence, currentSeed.origin),
  ]);
}

function makeGraphDraft(
  item: PersonalReminderItem,
  relation: ReconciledGraphEdge & Readonly<{ active: true }>,
  authorLogin: string,
  surfaces: readonly PersonalReminderExecutionSurface[],
): PersonalReminderCauseDraft {
  const sourceIds = createNonEmptySourceIds(
    relation.evidence.map((evidence) => evidence.sourceId),
    `implements relation ${relation.id}`,
  );
  const firstSurface = surfaces[0];
  assertNonNullable(
    firstSurface,
    `implements relationのexecution surfaceがありません。対象: ${relation.id}`,
  );
  const surfaceTuple: readonly [
    PersonalReminderExecutionSurface,
    ...PersonalReminderExecutionSurface[],
  ] = [firstSurface, ...surfaces.slice(1)];
  const responsible: PersonalReminderResponsible = Object.freeze({
    kind: "user",
    candidateId: authorLogin,
    role: "assignee",
  });
  const responsibleTuple: readonly [PersonalReminderResponsible, ...PersonalReminderResponsible[]] =
    [responsible];
  return Object.freeze({
    itemNodeId: item.nodeId,
    reasonCode: "work_overdue",
    responsible: responsibleTuple,
    action: Object.freeze({ kind: "work", summary: "実装項目を進める" }),
    evidenceSourceIds: sourceIds,
    responsibilityBasis: Object.freeze({
      sourceIds,
      occurredAt: relation.firstSeenAt,
      precision: "event",
    }),
    responsibility: Object.freeze({
      authority: "semantic",
      scope: Object.freeze({
        kind: "execution_surfaces",
        surfaces: surfaceTuple,
      }),
    }),
    aiDependencies: graphRelationAiDependencies(relation),
  });
}

/** 最終graphの実装関係から原因候補を作る。 */
export function graphDerivedDrafts(
  context: PersonalReminderRuntimeContext,
  item: PersonalReminderRuntimeContextItem,
  localDrafts: readonly PersonalReminderCauseDraft[],
): PersonalReminderGraphDraftProjection {
  if (
    item.item.type !== "issue" ||
    item.item.state !== "open" ||
    item.item.assignees.length !== 0
  ) {
    return Object.freeze({
      drafts: Object.freeze([]),
    });
  }
  const grouped = new Map<
    string,
    { login: string; relations: (ReconciledGraphEdge & Readonly<{ active: true }>)[] }
  >();
  for (const relation of context.graph.activeRelations) {
    if (!activeRelationIsEffective(context.graph, relation) || relation.type !== "implements") {
      continue;
    }
    if (relation.toNodeId !== item.item.nodeId) {
      continue;
    }
    const implementation = candidateEndpointItemByNodeId(context, relation.fromNodeId);
    if (implementation?.type !== "pull_request" || implementation.state !== "open") {
      continue;
    }
    if (implementation.author.status !== "identified" || implementation.author.type !== "human") {
      continue;
    }
    const login = implementation.author.login;
    const key = login.toLowerCase();
    const existing = grouped.get(key);
    if (existing == null) {
      grouped.set(key, { login, relations: [relation] });
    } else {
      existing.relations.push(relation);
    }
  }
  const localWorkActors = new Set(
    localDrafts
      .filter((draft) => draft.action.kind === "work")
      .flatMap((draft) =>
        draft.responsible.map((responsible) => responsible.candidateId.toLowerCase()),
      ),
  );
  const drafts: PersonalReminderCauseDraft[] = [];
  for (const group of [...grouped.values()].sort((left, right) =>
    compareStrings(left.login, right.login),
  )) {
    const firstRelation = [...group.relations].sort(compareGraphRelationSupport)[0];
    assertNonNullable(firstRelation, "graph由来責務のrelationがありません");
    if (localWorkActors.has(group.login.toLowerCase())) {
      continue;
    }
    const surfacesByNodeId = new Map<GitHubNodeId, PersonalReminderExecutionSurface>();
    for (const relation of group.relations) {
      const implementation = candidateEndpointItemByNodeId(context, relation.fromNodeId);
      assertNonNullable(
        implementation,
        `implements relationの実装項目がありません。対象: ${relation.id}`,
      );
      if (implementation.type !== "pull_request") {
        throw new TypeError(`implements relationの実装項目種別が不正です。対象: ${relation.id}`);
      }
      surfacesByNodeId.set(
        implementation.nodeId,
        Object.freeze({ kind: implementation.type, nodeId: implementation.nodeId }),
      );
    }
    const surfaces = [...surfacesByNodeId.values()].sort((left, right) =>
      compareStrings(left.nodeId, right.nodeId),
    );
    drafts.push(makeGraphDraft(item.item, firstRelation, group.login, surfaces));
  }
  return Object.freeze({
    drafts: Object.freeze(drafts),
  });
}

function candidateIsActualPositiveImplements(
  candidate: PersonalReminderRuntimeCandidateRelation,
  implementationNodeId: GraphNodeId,
  targetNodeId: GraphNodeId,
): boolean {
  const resolution = candidate.resolution;
  const canonicalRelation = candidate.canonicalRelation;
  return (
    resolution?.status === "active" &&
    canonicalRelation?.type === "implements" &&
    canonicalRelation.fromNodeId === implementationNodeId &&
    canonicalRelation.toNodeId === targetNodeId
  );
}

function candidateTargetNodeId(candidate: PersonalReminderRuntimeCandidateRelation): GraphNodeId {
  const [firstNodeId, secondNodeId] = candidate.endpointNodeIds;
  if (firstNodeId === secondNodeId) {
    throw new TypeError(`個人催促relation候補のendpointが同一です。対象: ${candidate.candidateId}`);
  }
  if (candidate.ownerNodeId === firstNodeId) {
    return secondNodeId;
  }
  if (candidate.ownerNodeId === secondNodeId) {
    return firstNodeId;
  }
  throw new TypeError(
    `個人催促relation候補のownerがendpointではありません。対象: ${candidate.candidateId}`,
  );
}

/** 未採用候補の作業責務に関わる端点を取得する。 */
export function negativeWorkCandidateEndpoints(
  context: PersonalReminderRuntimeContext,
  candidate: PersonalReminderRuntimeCandidateRelation,
):
  | Readonly<{
      implementation: PersonalReminderRuntimeCandidateEndpointItem;
      target: PersonalReminderRuntimeCandidateEndpointItem;
    }>
  | undefined {
  if (candidate.authority !== "inferred") {
    return undefined;
  }
  const resolution = candidate.resolution;
  if (
    resolution == null ||
    (resolution.status === "rejected" && resolution.reason === "blocker_not_open")
  ) {
    return undefined;
  }
  const implementation = candidateEndpointItemByNodeId(context, candidate.ownerNodeId);
  const target = candidateEndpointItemByNodeId(context, candidateTargetNodeId(candidate));
  if (implementation?.type !== "pull_request" || target?.type !== "issue") {
    return undefined;
  }
  if (implementation.author.status !== "identified" || implementation.author.type !== "human") {
    return undefined;
  }
  if (
    implementation.state !== "open" ||
    target.state !== "open" ||
    !endpointIsOpen(context.graph, {
      fromNodeId: implementation.nodeId,
      toNodeId: target.nodeId,
    }) ||
    candidateIsActualPositiveImplements(candidate, implementation.nodeId, target.nodeId)
  ) {
    return undefined;
  }
  return Object.freeze({ implementation, target });
}

/** 未採用候補から原因集合が変わり得るAI依存を集める。 */
export function negativeCandidateDependenciesForIssue(
  context: PersonalReminderRuntimeContext,
  item: PersonalReminderRuntimeContextItem,
  localDrafts: readonly PersonalReminderCauseDraft[],
  positiveDrafts: readonly PersonalReminderCauseDraft[],
): readonly PersonalReminderRuntimeSubjectDependency[] {
  if (
    item.item.type !== "issue" ||
    item.item.state !== "open" ||
    item.item.assignees.length !== 0
  ) {
    return Object.freeze([]);
  }
  const localWorkActors = new Set(
    localDrafts
      .filter((draft) => draft.action.kind === "work")
      .flatMap((draft) =>
        draft.responsible.map((responsible) => responsible.candidateId.toLowerCase()),
      ),
  );
  const positiveGraphActors = new Set(
    positiveDrafts
      .filter((draft) => draft.action.kind === "work")
      .flatMap((draft) =>
        draft.responsible.map((responsible) => responsible.candidateId.toLowerCase()),
      ),
  );
  const grouped = new Map<
    string,
    Readonly<{
      login: string;
      candidates: PersonalReminderRuntimeCandidateRelation[];
    }>
  >();
  for (const candidate of context.candidateRelationsByTargetNodeId.get(item.item.nodeId) ?? []) {
    const endpoints = negativeWorkCandidateEndpoints(context, candidate);
    if (endpoints?.target.nodeId !== item.item.nodeId) {
      continue;
    }
    const author = endpoints.implementation.author;
    if (author.status !== "identified" || author.type !== "human") {
      continue;
    }
    const login = author.login;
    const key = login.toLowerCase();
    if (localWorkActors.has(key) || positiveGraphActors.has(key)) {
      continue;
    }
    const existing = grouped.get(key);
    if (existing == null) {
      grouped.set(key, { login, candidates: [candidate] });
    } else {
      existing.candidates.push(candidate);
    }
  }
  return Object.freeze(
    [...grouped.values()]
      .sort((left, right) => compareStrings(left.login, right.login))
      .map((group) =>
        Object.freeze({
          subject: Object.freeze({ kind: "user", candidateId: group.login }),
          inputs: Object.freeze(
            group.candidates.map((candidate) => currentAiDependencyInput(candidate.aiDependency)),
          ),
        }),
      ),
  );
}

/** 確定relationが参照するsource IDを集める。 */
export function sourceIdsForRelationContexts(
  relations: readonly PersonalReminderAiRelationContext[],
): readonly SourceId[] {
  return relations.flatMap((relation) => relation.evidenceSourceIds);
}

/** 未確定relationが参照するsource IDを集める。 */
export function sourceIdsForPendingRelations(
  relations: readonly PersonalReminderPendingRelation[],
): readonly SourceId[] {
  return relations.flatMap((relation) => relation.evidenceSourceIds);
}

/** 原因入力に不足する項目を確定する。 */
export function completenessForCause(
  item: PersonalReminderRuntimeContextItem,
  pendingRelations: readonly PersonalReminderPendingRelation[],
  additionalMissing: readonly PersonalReminderMissingInput[],
): PersonalReminderInputCompleteness {
  if (
    item.completeness.status === "complete" &&
    pendingRelations.length === 0 &&
    additionalMissing.length === 0
  ) {
    return Object.freeze({ status: "complete" });
  }
  const missing = item.completeness.status === "incomplete" ? [...item.completeness.missing] : [];
  if (pendingRelations.length !== 0 && !missing.includes("relation_evidence")) {
    missing.push("relation_evidence");
  }
  for (const value of additionalMissing) {
    if (!missing.includes(value)) {
      missing.push(value);
    }
  }
  const first = missing[0];
  assertNonNullable(first, "不完全cause入力の不足項目がありません");
  return Object.freeze({
    status: "incomplete",
    missing: [first, ...missing.slice(1)],
  });
}
