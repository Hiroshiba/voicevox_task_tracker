import { reconcileRetainedPersonalReminderCause } from "./personal-reminder-retained-cause.js";
import type { PersonalReminderAiItemContext } from "../../../codex/personal-reminder-input-contracts.js";
import type { AiAnalysisDependencyReconciliationContext } from "../../../domain/ai-analysis-dependencies.js";
import { aiAnalysisDependencyForRelationCandidate } from "../../../domain/ai-analysis-dependencies.js";
import { determineIssuePersonalReminderResponsibilityAuthority } from "../../../domain/issue-state-machine.js";
import { isExcludedFromProgressAndHumanActivity } from "../../../domain/meaningful-progress.js";
import type {
  PersonalReminderActionKind,
  PersonalReminderExecutionSurface,
  PersonalReminderResponsibility,
  PersonalReminderResponsible,
  PersonalReminderTimeBasis,
} from "../../../domain/personal-reminder-causes.js";
import type {
  PersonalReminderItem,
  PersonalReminderLocalDecision,
} from "../../../domain/personal-reminder-planning.js";
import { determinePullRequestPersonalReminderResponsibilityAuthority } from "../../../domain/pull-request-state-machine.js";
import type { SourceId } from "../../../domain/source-id.js";
import type {
  Evidence,
  GitHubNodeId,
  GraphNodeId,
  NormalizedEvent,
  UtcIsoDateTime,
} from "../../../domain/types.js";
import type { GitHubCheckContext } from "../../../github/item-detail-types.js";
import { assertNonNullable } from "../../../util/index.js";
import {
  compareStrings,
  createPreviousCauses,
  determineLocalDecision,
  validateCollectedItem,
  validateLocalDecision,
} from "./personal-reminder-runtime-common.js";
import type {
  PersonalReminderRuntimeActivity,
  PersonalReminderRuntimeCandidateEndpointItem,
  PersonalReminderRuntimeCandidateRelation,
  PersonalReminderRuntimeCollection,
  PersonalReminderRuntimeContext,
  PersonalReminderRuntimeContextItem,
  PersonalReminderRuntimeExternalReference,
  PersonalReminderRuntimeGraph,
  PersonalReminderRuntimeItem,
  PersonalReminderRuntimeRelatedContext,
  PersonalReminderRuntimeSource,
  PersonalReminderRuntimeState,
} from "./personal-reminder-runtime-contracts.js";
import { currentReviewTargetFromItem } from "./personal-reminder-runtime-relations.js";
import { createRuntimeSources } from "./personal-reminder-runtime-sources.js";

/** check contextの発生時刻を取得する。 */
export function checkContextOccurredAt(
  headOccurredAt: UtcIsoDateTime,
  context: GitHubCheckContext,
): UtcIsoDateTime {
  if (context.type === "commit_status") {
    return context.createdAt;
  }
  return context.completedAt ?? headOccurredAt;
}

/** 日時の集合から最も新しい値を取得する。 */
export function latestUtcIsoDateTime(
  values: readonly UtcIsoDateTime[],
  context: string,
): UtcIsoDateTime {
  const firstValue = values[0];
  assertNonNullable(firstValue, `${context}の時刻がありません`);
  return values.slice(1).reduce((latest, value) => (latest < value ? value : latest), firstValue);
}

/** eventを時刻根拠へ変換する。 */
export function basisFromEvent(event: NormalizedEvent): PersonalReminderTimeBasis {
  return Object.freeze({ source: "event", at: event.occurredAt, sourceIds: [event.sourceId] });
}

function timeBasisFromTransitionBasis(
  basis: Readonly<{
    sourceIds: readonly SourceId[];
    occurredAt: UtcIsoDateTime;
    precision: "event" | "inferred";
  }>,
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
): PersonalReminderTimeBasis | undefined {
  if (basis.precision !== "event") {
    return undefined;
  }
  const sourceIds = basis.sourceIds.filter(
    (sourceId) => sourceOccurredAtById.get(sourceId) === basis.occurredAt,
  );
  if (sourceIds.length === 0) {
    return undefined;
  }
  return Object.freeze({
    source: "event",
    at: basis.occurredAt,
    sourceIds,
  });
}

/** local decisionから催促する行動種別を取得する。 */
export function actionKindForDecision(
  decision: PersonalReminderLocalDecision,
): PersonalReminderActionKind | undefined {
  switch (decision.status) {
    case "waiting_for_assessment":
      return "assessment";
    case "waiting_for_owner":
      return "owner";
    case "waiting_for_decision":
      return "decision";
    case "waiting_for_review":
      return "review";
    case "waiting_for_revision":
      return "revision";
    case "waiting_for_reply":
      return "reply";
    case "waiting_for_work":
    case "in_progress":
      return "work";
    case "waiting_for_merge":
      return "merge";
    case "waiting_for_unblock":
    case "waiting_for_automation":
    case "unknown":
    case "terminal_merged":
    case "terminal_completed":
    case "terminal_not_planned":
      return undefined;
  }
}

type PersonalReminderDecisionWaitingOn = PersonalReminderLocalDecision["waitingOn"][number];

type PersonalReminderResponsibleWaitingOn = Omit<
  PersonalReminderDecisionWaitingOn,
  "kind" | "role"
> &
  Readonly<{
    kind: "user" | "team" | "role";
    role: Exclude<PersonalReminderDecisionWaitingOn["role"], "dependency" | "ci">;
  }>;

/** 待機先が催促対象の責任主体か判定する。 */
export function isPersonalReminderResponsibleWaitingOn(
  waitingOn: PersonalReminderDecisionWaitingOn,
): waitingOn is PersonalReminderResponsibleWaitingOn {
  return (
    (waitingOn.kind === "user" || waitingOn.kind === "team" || waitingOn.kind === "role") &&
    waitingOn.role !== "dependency" &&
    waitingOn.role !== "ci"
  );
}

function isRelevantProgressEvent(
  event: NormalizedEvent,
  actionKind: PersonalReminderActionKind | undefined,
): boolean {
  if (isExcludedFromProgressAndHumanActivity(event)) {
    return false;
  }
  if (actionKind === "work") {
    return event.kind === "push" || event.kind === "state";
  }
  if (actionKind === "reply") {
    return false;
  }
  if (actionKind === "review" || actionKind === "revision") {
    return event.kind === "review" && event.actor.type === "human";
  }
  if (actionKind === "owner") {
    return event.kind === "state" || event.kind === "label";
  }
  if (actionKind === "merge") {
    return event.kind === "state";
  }
  return (
    event.kind === "state" ||
    (event.kind === "relation" && event.relationType === "blocks" && event.action === "removed")
  );
}

function isResponsibleActivityEvent(
  event: NormalizedEvent,
  actionKind: PersonalReminderActionKind | undefined,
): boolean {
  if (isExcludedFromProgressAndHumanActivity(event)) {
    return false;
  }
  switch (actionKind) {
    case "work":
    case "revision":
      return event.kind === "push" || event.kind === "state";
    case "review":
      return event.kind === "review" && event.actor.type === "human";
    case "reply":
      return (
        (event.kind === "comment" && !event.bodyEmpty) ||
        (event.kind === "review" && event.state === "commented" && !event.bodyEmpty)
      );
    case "owner":
      return event.kind === "assignee" || event.kind === "label" || event.kind === "state";
    case "merge":
      return event.kind === "state";
    case "assessment":
    case "decision":
    case undefined:
      return false;
  }
}

/** 行動種別に対応する進捗と担当者の活動を集める。 */
export function createActionActivity(
  item: PersonalReminderItem,
  actionKind: PersonalReminderActionKind | undefined,
  responsibleCandidateIds: ReadonlySet<string>,
): PersonalReminderRuntimeActivity {
  const relevantProgress = item.events
    .filter((event) => isRelevantProgressEvent(event, actionKind))
    .map(basisFromEvent);
  const responsibleActivity = item.events
    .filter(
      (event) =>
        !isExcludedFromProgressAndHumanActivity(event) &&
        event.actor.type === "human" &&
        responsibleCandidateIds.has(event.actor.login.toLowerCase()) &&
        isResponsibleActivityEvent(event, actionKind),
    )
    .map(basisFromEvent);
  const humanReviewActivity = item.events
    .filter(
      (event) =>
        !isExcludedFromProgressAndHumanActivity(event) &&
        event.actor.type === "human" &&
        event.kind === "review",
    )
    .map(basisFromEvent);
  return Object.freeze({
    relevantProgress: Object.freeze(relevantProgress),
    responsibleActivity: Object.freeze(responsibleActivity),
    humanReviewActivity: Object.freeze(humanReviewActivity),
    actionabilityStartByAction: new Map(),
  });
}

function createRuntimeActivity(
  item: PersonalReminderItem,
  decision: PersonalReminderLocalDecision,
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
): PersonalReminderRuntimeActivity {
  const actionKind = actionKindForDecision(decision);
  const responsibleCandidateIds = new Set(
    decision.waitingOn
      .filter(isPersonalReminderResponsibleWaitingOn)
      .map((waitingOn) => waitingOn.candidateId.toLowerCase()),
  );
  const activity = createActionActivity(item, actionKind, responsibleCandidateIds);
  if (actionKind == null) {
    return activity;
  }
  const actionabilityStartByAction = new Map(activity.actionabilityStartByAction);
  actionabilityStartByAction.set(
    actionKind,
    timeBasisFromTransitionBasis(decision.responsibilityBasis, sourceOccurredAtById),
  );
  return Object.freeze({ ...activity, actionabilityStartByAction });
}

function responsibilitySignature(value: PersonalReminderResponsible): string {
  return `${value.kind}\u0000${value.candidateId.toLowerCase()}\u0000${value.role}`;
}

function createResponsibilityScope(
  item: PersonalReminderItem,
  decision: PersonalReminderLocalDecision,
  sources: readonly PersonalReminderRuntimeSource[],
  relatedContexts: readonly PersonalReminderRuntimeRelatedContext[],
): PersonalReminderResponsibility {
  const waitingSourceIds = new Set(decision.waitingOn.flatMap((waitingOn) => waitingOn.sourceIds));
  const surfaces = new Map<GitHubNodeId, PersonalReminderExecutionSurface>();
  let hasSubjectSource = false;
  for (const source of sources) {
    if (!waitingSourceIds.has(source.source.sourceId)) {
      continue;
    }
    if (source.source.itemNodeId === item.nodeId) {
      hasSubjectSource = true;
      continue;
    }
    const related = relatedContexts.find(
      (context) => context.item.nodeId === source.source.itemNodeId,
    )?.item;
    if (related?.type === "pull_request" || related?.type === "issue") {
      surfaces.set(related.nodeId, Object.freeze({ kind: related.type, nodeId: related.nodeId }));
    }
  }
  const sortedSurfaces = [...surfaces.values()].sort((left, right) =>
    compareStrings(left.nodeId, right.nodeId),
  );
  const firstSurface = sortedSurfaces[0];
  const authority = responsibilityAuthority(item, decision);
  if (firstSurface == null) {
    return Object.freeze({ authority, scope: Object.freeze({ kind: "item" }) });
  }
  const surfaceTuple: readonly [
    PersonalReminderExecutionSurface,
    ...PersonalReminderExecutionSurface[],
  ] = [firstSurface, ...sortedSurfaces.slice(1)];
  const scope = hasSubjectSource
    ? Object.freeze({ kind: "item_and_execution_surfaces", surfaces: surfaceTuple })
    : Object.freeze({ kind: "execution_surfaces", surfaces: surfaceTuple });
  return Object.freeze({ authority, scope });
}

function responsibilityAuthority(
  item: PersonalReminderItem,
  decision: PersonalReminderLocalDecision,
): "fixed" | "semantic" {
  if (item.type === "issue" && decision.deterministicRulesVersion === "issue-v14") {
    return determineIssuePersonalReminderResponsibilityAuthority({ issue: item, decision });
  }
  if (item.type === "pull_request" && decision.deterministicRulesVersion === "pull-request-v12") {
    return determinePullRequestPersonalReminderResponsibilityAuthority(decision);
  }
  throw new TypeError(`個人催促責務のitemとstate decisionが一致しません。対象: ${item.nodeId}`);
}

function createResponsibilities(
  item: PersonalReminderItem,
  decision: PersonalReminderLocalDecision,
  sources: readonly PersonalReminderRuntimeSource[],
  relatedContexts: readonly PersonalReminderRuntimeRelatedContext[],
): readonly [PersonalReminderResponsibility, ...PersonalReminderResponsibility[]] | undefined {
  const responsibles = decision.waitingOn
    .filter(isPersonalReminderResponsibleWaitingOn)
    .map((waitingOn) =>
      Object.freeze({
        kind: waitingOn.kind,
        candidateId: waitingOn.candidateId,
        role: waitingOn.role,
      }),
    );
  const firstResponsible = responsibles[0];
  if (firstResponsible == null) {
    return undefined;
  }
  const unique = new Map<string, PersonalReminderResponsible>();
  for (const responsible of responsibles) {
    unique.set(responsibilitySignature(responsible), responsible);
  }
  const sorted = [...unique.values()].sort((left, right) =>
    compareStrings(responsibilitySignature(left), responsibilitySignature(right)),
  );
  const first = sorted[0];
  assertNonNullable(first, `個人催促runtimeの責任主体がありません。対象: ${item.nodeId}`);
  const scope = createResponsibilityScope(item, decision, sources, relatedContexts);
  return Object.freeze([scope]);
}

/** graph端点から実行面の状態を取得する。 */
export function executionSurfaceStates(
  graph: PersonalReminderRuntimeGraph,
  contexts: readonly PersonalReminderRuntimeRelatedContext[],
): ReadonlyMap<GitHubNodeId, "open" | "merged" | "closed_without_merge"> {
  const states = new Map<GitHubNodeId, "open" | "merged" | "closed_without_merge">();
  for (const context of contexts) {
    const state = graph.endpointStates.get(context.item.nodeId);
    if (state === "open") {
      states.set(context.item.nodeId, "open");
    } else if (state === "merged") {
      states.set(context.item.nodeId, "merged");
    } else if (state === "closed") {
      states.set(context.item.nodeId, "closed_without_merge");
    }
  }
  return states;
}

function pullRequestReviewState(
  item: Extract<PersonalReminderItem, { type: "pull_request" }>,
): "not_requested" | "requested" | "changes_requested" | "approved" | "mixed" | "unknown" {
  const reviewStates = item.events
    .filter((event) => event.kind === "review")
    .map((event) => event.state);
  const hasChangesRequested = reviewStates.includes("changes_requested");
  const hasApproved = reviewStates.includes("approved");
  if (hasChangesRequested && hasApproved) {
    return "mixed";
  }
  if (hasChangesRequested) {
    return "changes_requested";
  }
  if (hasApproved) {
    return "approved";
  }
  return item.reviewRequests.length === 0 ? "not_requested" : "requested";
}

function pullRequestCheckState(
  item: Extract<PersonalReminderItem, { type: "pull_request" }>,
): "not_required" | "passing" | "pending" | "failing" | "unknown" {
  if (item.mergeState.checks.status !== "configured") {
    return "not_required";
  }
  switch (item.mergeState.checks.combinedState) {
    case "success":
      return "passing";
    case "expected":
    case "pending":
      return "pending";
    case "error":
    case "failure":
      return "failing";
  }
}

function pullRequestMergeState(
  item: Extract<PersonalReminderItem, { type: "pull_request" }>,
): "not_ready" | "ready" | "queued" | "merged" | "closed_unmerged" | "unknown" {
  if (item.events.some((event) => event.kind === "state" && event.state === "merged")) {
    return "merged";
  }
  if (item.state === "closed") {
    return "closed_unmerged";
  }
  if (item.mergeState.mergeQueue.status === "queued") {
    return "queued";
  }
  if (item.mergeState.mergeState === "clean" && item.mergeState.mergeability === "mergeable") {
    return "ready";
  }
  if (item.mergeState.mergeability === "unknown" || item.mergeState.mergeState === "unknown") {
    return "unknown";
  }
  return "not_ready";
}

function createItemContext(item: PersonalReminderRuntimeItem): PersonalReminderAiItemContext {
  if (item.type === "issue") {
    return {
      nodeId: item.nodeId,
      url: item.url,
      title: item.title,
      type: "issue",
      state: item.state,
    };
  }
  const mergeState = pullRequestMergeState(item);
  let state: "open" | "closed_unmerged" | "merged" = "closed_unmerged";
  if (item.state === "open") {
    state = "open";
  } else if (mergeState === "merged") {
    state = "merged";
  }
  return {
    nodeId: item.nodeId,
    url: item.url,
    title: item.title,
    type: "pull_request",
    state,
    draft: item.draft,
    reviewState: pullRequestReviewState(item),
    checkState: pullRequestCheckState(item),
    mergeState,
  };
}

function createExternalReferenceItemContext(
  reference: PersonalReminderRuntimeExternalReference,
): PersonalReminderAiItemContext {
  return Object.freeze({
    nodeId: reference.nodeId,
    url: reference.url,
    title: reference.title,
    type: "external_reference",
    state: reference.state,
  });
}

/** 計画context内の項目をnode IDで取得する。 */
export function contextItemByNodeId(
  context: PersonalReminderRuntimeContext,
  nodeId: GraphNodeId,
): PersonalReminderRuntimeContextItem | undefined {
  return context.items.find((value) => value.item.nodeId === nodeId);
}

/** relation候補の端点項目をnode IDで取得する。 */
export function candidateEndpointItemByNodeId(
  context: PersonalReminderRuntimeContext,
  nodeId: GraphNodeId,
): PersonalReminderRuntimeCandidateEndpointItem | undefined {
  return context.graph.candidateEndpointItemsByNodeId.get(nodeId);
}

function indexCandidateRelationsByTargetNodeId(
  graph: PersonalReminderRuntimeGraph,
): ReadonlyMap<GraphNodeId, readonly PersonalReminderRuntimeCandidateRelation[]> {
  const candidatesByTargetNodeId = new Map<
    GraphNodeId,
    PersonalReminderRuntimeCandidateRelation[]
  >();
  for (const candidate of graph.candidateRelations) {
    for (const endpointNodeId of candidate.endpointNodeIds) {
      const endpoint = graph.candidateEndpointItemsByNodeId.get(endpointNodeId);
      if (endpoint?.type !== "issue") {
        continue;
      }
      const candidates = candidatesByTargetNodeId.get(endpointNodeId);
      if (candidates == null) {
        candidatesByTargetNodeId.set(endpointNodeId, [candidate]);
      } else {
        candidates.push(candidate);
      }
    }
  }
  return new Map(
    [...candidatesByTargetNodeId.entries()].map(([nodeId, candidates]) => [
      nodeId,
      Object.freeze(candidates),
    ]),
  );
}

/** 収集済み値から個人催促cause判定用のpure contextを作る。 */
export function createPersonalReminderRuntimeContext(
  input: Readonly<{
    evaluatedAt: UtcIsoDateTime;
    state: PersonalReminderRuntimeState;
    collection: PersonalReminderRuntimeCollection;
    graph: PersonalReminderRuntimeGraph;
    aiDependencyContext: AiAnalysisDependencyReconciliationContext;
    currentEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>;
  }>,
): PersonalReminderRuntimeContext {
  const items: PersonalReminderRuntimeContextItem[] = [];
  const graph = Object.freeze({
    ...input.graph,
    candidateRelations: Object.freeze(
      input.graph.candidateRelations.map((candidate) =>
        Object.freeze({
          ...candidate,
          aiDependency: aiAnalysisDependencyForRelationCandidate(
            candidate.candidateId,
            candidate.endpointNodeIds,
            candidate.aiDependency,
          ),
        }),
      ),
    ),
  });
  const nodeIds = new Set<GitHubNodeId>();
  const externalNodeIds = new Set<GraphNodeId>();
  const externalItemContexts = input.graph.externalReferences.map((reference) => {
    if (externalNodeIds.has(reference.nodeId)) {
      throw new TypeError(`外部参照node IDが重複しています。対象: ${reference.nodeId}`);
    }
    externalNodeIds.add(reference.nodeId);
    return createExternalReferenceItemContext(reference);
  });
  for (const item of input.collection.items) {
    validateCollectedItem(item);
    if (nodeIds.has(item.item.nodeId)) {
      throw new TypeError(
        `個人催促runtime item node IDが重複しています。対象: ${item.item.nodeId}`,
      );
    }
    nodeIds.add(item.item.nodeId);
    if (item.localDecision.itemType !== item.item.type) {
      throw new TypeError(
        `個人催促runtimeのlocal decision種別が一致しません。対象: ${item.item.nodeId}`,
      );
    }
    const relatedNodeIds = new Set<GitHubNodeId>();
    for (const related of item.relatedContexts) {
      validateLocalDecision(
        related.item.type,
        related.localDecision,
        `個人催促runtimeの関連項目 ${related.item.nodeId}`,
      );
      if (
        related.detail.nodeId !== related.item.nodeId ||
        related.detail.type !== related.item.type
      ) {
        throw new TypeError(
          `個人催促runtimeの関連itemとdetailが一致しません。対象: ${related.item.nodeId}`,
        );
      }
      if (relatedNodeIds.has(related.item.nodeId) || related.item.nodeId === item.item.nodeId) {
        throw new TypeError(
          `個人催促runtimeの関連item node IDが重複しています。対象: ${related.item.nodeId}`,
        );
      }
      relatedNodeIds.add(related.item.nodeId);
    }
    const localDecision = determineLocalDecision(item.localDecision);
    const sourceProjection = createRuntimeSources(
      item.item,
      item.detail,
      item.localDecision,
      item.relatedContexts,
    );
    const responsibilities = createResponsibilities(
      item.item,
      localDecision,
      sourceProjection.sources,
      item.relatedContexts,
    );
    const previousCauses = createPreviousCauses(input.state, item);
    const previous = Object.freeze({
      ...previousCauses,
      causes: Object.freeze(
        previousCauses.causes.map((cause) =>
          reconcileRetainedPersonalReminderCause(cause, input.aiDependencyContext),
        ),
      ),
    });
    const activity = createRuntimeActivity(
      item.item,
      localDecision,
      sourceProjection.sourceOccurredAtById,
    );
    const allContexts = [
      Object.freeze({ item: item.item, detail: item.detail, localDecision: item.localDecision }),
      ...item.relatedContexts,
    ];
    const itemContext = createItemContext(item.item);
    const relatedItemContexts = Object.freeze(
      item.relatedContexts.map((context) => createItemContext(context.item)),
    );
    items.push(
      Object.freeze({
        ...item,
        localDecision,
        previous,
        sources: sourceProjection.sources,
        activity,
        stale: input.collection.staleNodeIds.has(item.item.nodeId),
        currentReviewRequestTargets: currentReviewTargetFromItem(item.item),
        executionSurfaceStates: executionSurfaceStates(graph, allContexts),
        sourceOccurredAtById: sourceProjection.sourceOccurredAtById,
        seedEvidence: sourceProjection.seedEvidence,
        evidenceScopes: sourceProjection.evidenceScopes,
        responsibilities: responsibilities ?? Object.freeze([]),
        itemContext,
        relatedItemContexts,
        externalItemContexts: Object.freeze(externalItemContexts),
        endpointStates: graph.endpointStates,
      }),
    );
  }
  const candidateRelationsByTargetNodeId = indexCandidateRelationsByTargetNodeId(graph);
  return Object.freeze({
    evaluatedAt: input.evaluatedAt,
    state: input.state,
    items: Object.freeze(items),
    graph,
    aiDependencyContext: input.aiDependencyContext,
    candidateRelationsByTargetNodeId,
    currentEvidenceBySourceId: input.currentEvidenceBySourceId,
  });
}
