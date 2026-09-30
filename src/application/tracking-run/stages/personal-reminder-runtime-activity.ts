import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type {
  PersonalReminderAiItemContext,
  PersonalReminderCauseSemanticInput,
} from "../../../codex/personal-reminder-input-contracts.js";
import type {
  PersonalReminderActionKind,
  PersonalReminderCause,
  PersonalReminderCauseSeed,
  PersonalReminderMissingInput,
  PersonalReminderResponsible,
  PersonalReminderTimeBasis,
} from "../../../domain/personal-reminder-causes.js";
import type {
  PersonalReminderCauseProjection,
  PersonalReminderCauseSeedOrigin,
} from "../../../domain/personal-reminder-planning.js";
import { createPersonalReminderCauseProjectionSeed } from "../../../domain/personal-reminder-planning.js";
import { isPullRequestRevisionResponsibilityResolved } from "../../../domain/pull-request-state-owner.js";
import type { SourceId } from "../../../domain/source-id.js";
import type {
  Evidence,
  GraphNodeId,
  NormalizedEvent,
  UtcIsoDateTime,
} from "../../../domain/types.js";
import { UnreachableError, assertNonNullable } from "../../../util/index.js";
import {
  compareSourceIds,
  compareStrings,
  createNonEmptySourceIds,
  determineLocalDecision,
  evidenceIdentity,
  personalReminderDraftIdentity,
  seedMatchesDraft,
} from "./personal-reminder-runtime-common.js";
import {
  actionKindForDecision,
  basisFromEvent,
  createActionActivity,
  isPersonalReminderResponsibleWaitingOn,
} from "./personal-reminder-runtime-context.js";
import type {
  PersonalReminderCauseSemanticProjection,
  PersonalReminderRuntimeActivity,
  PersonalReminderRuntimeActivityProjection,
  PersonalReminderRuntimeContext,
  PersonalReminderRuntimeContextItem,
  PersonalReminderRuntimeCurrentSeed,
  PersonalReminderRuntimeItem,
  PersonalReminderRuntimePlanningIndexes,
  PersonalReminderRuntimeSource,
} from "./personal-reminder-runtime-contracts.js";
import {
  duplicateOptionsForCause,
  selectedPendingRelations,
  selectedRelationEdges,
  waitingOptionsForCause,
} from "./personal-reminder-runtime-options.js";
import {
  activeRelationIsEffective,
  optionTargetScopeNodeIds,
  relationContextFromEdge,
  relationSourceProjectionForEdges,
} from "./personal-reminder-runtime-relations.js";
import { createCauseSemanticInput } from "./personal-reminder-runtime-semantic-input.js";

function firstObservationBasis(at: UtcIsoDateTime): PersonalReminderTimeBasis {
  return Object.freeze({ source: "first_observation", at });
}

type PersonalReminderWaitingTarget = Readonly<{
  item: PersonalReminderRuntimeItem;
  actionKind: PersonalReminderActionKind;
  responsible: readonly PersonalReminderResponsible[];
}>;

function waitingTargetForCause(
  item: PersonalReminderRuntimeContextItem,
  waitingFor: Readonly<{ itemNodeId: GraphNodeId; action: string }>,
  currentSeeds: readonly PersonalReminderRuntimeCurrentSeed[],
): PersonalReminderWaitingTarget | undefined {
  const seededTargets = currentSeeds.filter(
    (currentSeed) =>
      currentSeed.origin === "current_draft" &&
      currentSeed.seed.itemNodeId === waitingFor.itemNodeId &&
      currentSeed.seed.action.summary === waitingFor.action,
  );
  if (seededTargets.length > 1) {
    return undefined;
  }
  const seededTarget = seededTargets[0];
  if (seededTarget != null) {
    return Object.freeze({
      item: seededTarget.item.item,
      actionKind: seededTarget.seed.action.kind,
      responsible: seededTarget.seed.responsible,
    });
  }
  const related = [
    Object.freeze({ item: item.item, localDecision: item.localDecision }),
    ...item.relatedContexts.map((context) =>
      Object.freeze({
        item: context.item,
        localDecision:
          context.localDecision == null ? undefined : determineLocalDecision(context.localDecision),
      }),
    ),
  ].filter((context) => context.item.nodeId === waitingFor.itemNodeId);
  if (related.length !== 1) {
    return undefined;
  }
  const target = related[0];
  assertNonNullable(target, "待機先itemを取得できませんでした");
  if (target.localDecision?.nextAction !== waitingFor.action) {
    return undefined;
  }
  const actionKind = actionKindForDecision(target.localDecision);
  if (actionKind == null) {
    return undefined;
  }
  const responsible = target.localDecision.waitingOn
    .filter(isPersonalReminderResponsibleWaitingOn)
    .map((waitingOn) =>
      Object.freeze({
        kind: waitingOn.kind,
        candidateId: waitingOn.candidateId,
        role: waitingOn.role,
      }),
    );
  return Object.freeze({ item: target.item, actionKind, responsible });
}

function eventActorMatchesResponsible(
  event: NormalizedEvent,
  responsible: readonly PersonalReminderResponsible[],
): boolean {
  const actor = event.actor;
  if (actor.type !== "human") {
    return false;
  }
  return responsible.some(
    (value) =>
      value.kind === "user" && value.candidateId.toLowerCase() === actor.login.toLowerCase(),
  );
}

function isStructuredWaitingResolutionEvent(
  event: NormalizedEvent,
  target: PersonalReminderWaitingTarget,
): boolean {
  if (!eventActorMatchesResponsible(event, target.responsible)) {
    if (target.actionKind !== "work" && target.actionKind !== "merge") {
      return false;
    }
  }
  switch (target.actionKind) {
    case "review":
      return event.kind === "review" && event.actor.type === "human" && event.state !== "commented";
    case "revision":
      return event.kind === "push";
    case "reply":
      return false;
    case "owner":
      return event.kind === "assignee" && event.action === "added";
    case "work":
      return event.kind === "state" && (event.state === "closed" || event.state === "merged");
    case "merge":
      return event.kind === "state" && event.state === "merged";
    case "assessment":
    case "decision":
      return false;
  }
}

/** 二つのeventの発生順を比較する。 */
export function compareEventOccurrence(left: NormalizedEvent, right: NormalizedEvent): number {
  const leftTime = Date.parse(left.occurredAt);
  const rightTime = Date.parse(right.occurredAt);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    throw new TypeError("待機解消イベントの時刻が不正です");
  }
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return compareSourceIds(left.sourceId, right.sourceId);
}

function scopedActivityForCause(
  item: PersonalReminderRuntimeContextItem,
  seed: PersonalReminderCauseSeed,
): PersonalReminderRuntimeActivityProjection {
  const responsibleCandidateIds = new Set(
    seed.responsible.map((responsible) => responsible.candidateId.toLowerCase()),
  );
  const activities: PersonalReminderRuntimeActivity[] = [];
  const missing = new Set<PersonalReminderMissingInput>();
  if (seed.responsibility.scope.kind !== "execution_surfaces") {
    activities.push(createActionActivity(item.item, seed.action.kind, responsibleCandidateIds));
  }
  for (const surface of seed.responsibility.scope.kind === "item"
    ? []
    : seed.responsibility.scope.surfaces) {
    const related = item.relatedContexts.find((context) => context.item.nodeId === surface.nodeId);
    if (related == null) {
      missing.add("related_item");
      continue;
    }
    if (related.item.type !== surface.kind) {
      throw new TypeError(`causeのexecution surface種別が一致しません。対象: ${surface.nodeId}`);
    }
    if (related.localDecision == null) {
      missing.add("related_timeline");
    }
    activities.push(createActionActivity(related.item, seed.action.kind, responsibleCandidateIds));
  }
  return Object.freeze({
    activity: Object.freeze({
      relevantProgress: Object.freeze(activities.flatMap((value) => value.relevantProgress)),
      responsibleActivity: Object.freeze(activities.flatMap((value) => value.responsibleActivity)),
      humanReviewActivity: Object.freeze(activities.flatMap((value) => value.humanReviewActivity)),
      actionabilityStartByAction: new Map<
        PersonalReminderActionKind,
        PersonalReminderTimeBasis | undefined
      >(),
    }),
    missing: Object.freeze([...missing]),
  });
}

function actionabilityEventForCause(
  item: PersonalReminderRuntimeContextItem,
  previousCause: PersonalReminderCause,
  previousObservedAt: UtcIsoDateTime,
  currentSeeds: readonly PersonalReminderRuntimeCurrentSeed[],
): PersonalReminderTimeBasis | undefined {
  if (
    previousCause.lastConfirmedActionability.status !== "confirmed" ||
    previousCause.lastConfirmedActionability.verdict !== "waiting"
  ) {
    return undefined;
  }
  const waitingFor = previousCause.lastConfirmedActionability.waitingFor;
  const target = waitingTargetForCause(item, waitingFor, currentSeeds);
  if (target?.item.nodeId !== waitingFor.itemNodeId) {
    return undefined;
  }
  const previousTimestamp = Date.parse(previousObservedAt);
  if (!Number.isFinite(previousTimestamp)) {
    throw new TypeError("前回の観測時刻が不正です");
  }
  const events = target.item.events
    .filter((event) => {
      const occurredAt = Date.parse(event.occurredAt);
      if (!Number.isFinite(occurredAt)) {
        throw new TypeError(`待機解消イベントの時刻が不正です。対象: ${event.sourceId}`);
      }
      return occurredAt > previousTimestamp;
    })
    .filter((event) => isStructuredWaitingResolutionEvent(event, target))
    .sort(compareEventOccurrence);
  if (target.actionKind === "revision" && target.item.type === "pull_request") {
    const resolved = isPullRequestRevisionResponsibilityResolved({
      pullRequest: target.item,
      previousResponsibilityBasis: {
        sourceIds: createNonEmptySourceIds([target.item.sourceId], "revision待機起点"),
        occurredAt: previousObservedAt,
        precision: "inferred",
      },
    });
    if (!resolved) {
      return undefined;
    }
  }
  const event = events.at(-1);
  return event == null ? undefined : basisFromEvent(event);
}

function activityForCause(
  item: PersonalReminderRuntimeContextItem,
  seed: PersonalReminderCauseSeed,
  previousCause: PersonalReminderCause | undefined,
  evaluatedAt: UtcIsoDateTime,
  currentSeeds: readonly PersonalReminderRuntimeCurrentSeed[],
): PersonalReminderRuntimeActivityProjection {
  const projection = scopedActivityForCause(item, seed);
  const actionabilityStartByAction = new Map(projection.activity.actionabilityStartByAction);
  if (previousCause == null) {
    const actionabilityStart =
      seed.responsibility.authority === "fixed" && seed.obligationSince.source === "event"
        ? seed.obligationSince
        : firstObservationBasis(evaluatedAt);
    actionabilityStartByAction.set(seed.action.kind, actionabilityStart);
  } else if (
    previousCause.lastConfirmedActionability.status === "confirmed" &&
    previousCause.lastConfirmedActionability.verdict === "waiting"
  ) {
    actionabilityStartByAction.set(
      seed.action.kind,
      actionabilityEventForCause(item, previousCause, item.previous.observedAt, currentSeeds) ??
        firstObservationBasis(evaluatedAt),
    );
  } else {
    actionabilityStartByAction.set(
      seed.action.kind,
      previousCause.actionableClock.status === "not_observed"
        ? firstObservationBasis(evaluatedAt)
        : undefined,
    );
  }
  return Object.freeze({
    activity: Object.freeze({
      relevantProgress: projection.activity.relevantProgress,
      responsibleActivity: projection.activity.responsibleActivity,
      humanReviewActivity: projection.activity.humanReviewActivity,
      actionabilityStartByAction,
    }),
    missing: projection.missing,
  });
}

/** 原因入力に利用する項目contextの索引を作る。 */
export function createGlobalItemContextIndex(
  context: PersonalReminderRuntimeContext,
): ReadonlyMap<GraphNodeId, PersonalReminderAiItemContext> {
  const itemContextsByNodeId = new Map<GraphNodeId, PersonalReminderAiItemContext>();
  const addContext = (itemContext: PersonalReminderAiItemContext): void => {
    const previous = itemContextsByNodeId.get(itemContext.nodeId);
    if (
      previous != null &&
      serializeCanonicalJson(previous) !== serializeCanonicalJson(itemContext)
    ) {
      if (previous.type === "external_reference" && itemContext.type !== "external_reference") {
        itemContextsByNodeId.set(itemContext.nodeId, itemContext);
        return;
      }
      if (previous.type !== "external_reference" && itemContext.type === "external_reference") {
        return;
      }
      throw new TypeError(`同じitem node IDに異なるcontextがあります。対象: ${itemContext.nodeId}`);
    }
    itemContextsByNodeId.set(itemContext.nodeId, itemContext);
  };
  for (const item of context.items) {
    addContext(item.itemContext);
    for (const related of item.relatedItemContexts) {
      addContext(related);
    }
    for (const external of item.externalItemContexts) {
      addContext(external);
    }
  }
  return itemContextsByNodeId;
}

/** 原因入力のsourceに対応する根拠記録を集める。 */
export function createCauseSourceEvidence(
  item: PersonalReminderRuntimeContextItem,
  globalSourcesById: ReadonlyMap<SourceId, PersonalReminderRuntimeSource>,
  semanticInput: PersonalReminderCauseSemanticInput,
  currentEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>,
  previousEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>,
  seed: PersonalReminderCauseSeed,
): readonly Evidence[] {
  const evidenceByIdentity = new Map<string, Evidence>();
  const semanticSourceIds = new Set(semanticInput.sources.map((source) => source.sourceId));
  for (const sourceId of [...new Set(seed.evidenceSourceIds)].sort(compareStrings)) {
    const currentEvidence = currentEvidenceBySourceId.get(sourceId) ?? [];
    const previousEvidence = previousEvidenceBySourceId.get(sourceId) ?? [];
    const seedEvidence = item.seedEvidence.filter((evidence) => evidence.sourceId === sourceId);
    for (const evidence of [...currentEvidence, ...previousEvidence, ...seedEvidence]) {
      evidenceByIdentity.set(evidenceIdentity(evidence), evidence);
    }
    if (
      currentEvidence.length !== 0 ||
      previousEvidence.length !== 0 ||
      seedEvidence.length !== 0
    ) {
      continue;
    }
    if (!globalSourcesById.has(sourceId) && !semanticSourceIds.has(sourceId)) {
      throw new TypeError(
        `個人催促causeのsource evidenceに必要なruntime sourceがありません。item: ${item.item.nodeId} cause: ${seed.causeId} source: ${sourceId}`,
      );
    }
    const evidence: Evidence = Object.freeze({
      sourceId,
      supports: "waiting_on",
      summary: `担当する対応: ${seed.action.summary}`,
    });
    evidenceByIdentity.set(evidenceIdentity(evidence), evidence);
  }
  return Object.freeze(
    [...evidenceByIdentity.values()].sort((left, right) =>
      compareStrings(evidenceIdentity(left), evidenceIdentity(right)),
    ),
  );
}

/** 原因seedから意味入力の投影を作る。 */
export function createCauseSemanticProjection(
  input: Readonly<{
    context: PersonalReminderRuntimeContext;
    item: PersonalReminderRuntimeContextItem;
    globalSourcesById: ReadonlyMap<SourceId, PersonalReminderRuntimeSource>;
    globalCausalSourcesByNodeId: ReadonlyMap<GraphNodeId, readonly PersonalReminderRuntimeSource[]>;
    globalItemContextsByNodeId: ReadonlyMap<GraphNodeId, PersonalReminderAiItemContext>;
    seed: PersonalReminderCauseSeed;
    currentSeed: PersonalReminderRuntimeCurrentSeed;
    currentSeeds: readonly PersonalReminderRuntimeCurrentSeed[];
    planningIndexes: PersonalReminderRuntimePlanningIndexes;
  }>,
): PersonalReminderCauseSemanticProjection {
  const relationEdges = selectedRelationEdges(input.context, input.seed, input.planningIndexes);
  const pendingRelations = selectedPendingRelations(input.context, input.seed);
  const waitingProjection = waitingOptionsForCause(
    input.context,
    input.item,
    input.globalSourcesById,
    input.seed,
    relationEdges,
    input.currentSeed,
    input.planningIndexes,
  );
  const duplicateProjection = duplicateOptionsForCause(
    input.context,
    input.globalSourcesById,
    input.currentSeed,
    input.planningIndexes,
  );
  const duplicateRelationIds = new Set(
    duplicateProjection.options.flatMap((option) => option.relationIds),
  );
  const duplicateRelationEdges = input.context.graph.activeRelations.filter(
    (relation) =>
      duplicateRelationIds.has(relation.id) &&
      activeRelationIsEffective(input.context.graph, relation),
  );
  const relationEdgesForInput = [
    ...new Map(
      [...relationEdges, ...duplicateRelationEdges].map((relation) => [relation.id, relation]),
    ).values(),
  ].sort((left, right) => compareStrings(left.id, right.id));
  const relations = relationEdgesForInput.map(relationContextFromEdge);
  const relationSources = relationSourceProjectionForEdges(
    relationEdgesForInput,
    input.globalSourcesById,
  );
  const optionSources = [...waitingProjection.sources, ...duplicateProjection.sources];
  const targetScopeNodeIds = new Set<GraphNodeId>();
  for (const option of [...waitingProjection.options, ...duplicateProjection.options]) {
    for (const nodeId of optionTargetScopeNodeIds(option)) {
      targetScopeNodeIds.add(nodeId);
    }
  }
  const additionalItemContexts = [...targetScopeNodeIds].sort(compareStrings).map((nodeId) => {
    const itemContext = input.globalItemContextsByNodeId.get(nodeId);
    assertNonNullable(itemContext, `target scopeのitem contextがありません。対象: ${nodeId}`);
    return itemContext;
  });
  const activityProjection = activityForCause(
    input.item,
    input.seed,
    input.currentSeed.previousCause,
    input.context.evaluatedAt,
    input.currentSeeds,
  );
  const relationMissing: readonly PersonalReminderMissingInput[] =
    relationSources.missingSourceIds.length === 0 ? [] : ["relation_evidence"];
  const additionalMissing: readonly PersonalReminderMissingInput[] = [
    ...waitingProjection.missing,
    ...activityProjection.missing,
    ...relationMissing,
  ];
  const semanticInput = createCauseSemanticInput(
    input.item,
    input.globalSourcesById,
    input.globalCausalSourcesByNodeId,
    input.globalItemContextsByNodeId,
    input.seed,
    relations,
    pendingRelations,
    waitingProjection.options,
    duplicateProjection.options,
    relationSources.sources,
    optionSources,
    additionalItemContexts,
    additionalMissing,
  );
  return Object.freeze({
    currentSeed: input.currentSeed,
    relationEdges,
    pendingRelations,
    waitingProjection,
    duplicateProjection,
    relations,
    relationSources,
    optionSources,
    additionalItemContexts,
    activityProjection,
    semanticInput,
  });
}

/** 今回の原因seedと前回原因の対応を保持する。 */
export function createRuntimeCurrentSeed(
  input: Readonly<{
    item: PersonalReminderRuntimeContextItem;
    seed: PersonalReminderCauseSeed;
    constructionOrigin: PersonalReminderCauseSeedOrigin;
    projectionKey: string;
    probe: boolean;
  }>,
): PersonalReminderRuntimeCurrentSeed {
  if (
    input.constructionOrigin.seed.causeId !== input.seed.causeId ||
    serializeCanonicalJson(input.constructionOrigin.seed) !== serializeCanonicalJson(input.seed)
  ) {
    throw new TypeError(`seedの生成元とseedが一致しません。対象: ${input.seed.causeId}`);
  }
  const draft =
    input.constructionOrigin.kind === "retained_without_draft"
      ? undefined
      : input.constructionOrigin.draft;
  if (draft != null && !seedMatchesDraft(input.seed, draft)) {
    throw new TypeError(`current seedとdraftが一致しません。対象: ${input.seed.causeId}`);
  }
  let previousCause: PersonalReminderCause | undefined;
  switch (input.constructionOrigin.kind) {
    case "new_draft":
      previousCause = undefined;
      break;
    case "normal_continuation":
    case "retained_without_draft":
      previousCause = input.constructionOrigin.previousCause;
      break;
    default:
      throw new UnreachableError(input.constructionOrigin);
  }
  return Object.freeze({
    seed: input.seed,
    item: input.item,
    origin: draft == null ? "retained_without_draft" : "current_draft",
    constructionOrigin: input.constructionOrigin,
    draft,
    draftIdentity: draft == null ? undefined : personalReminderDraftIdentity(draft),
    projectionKey: input.projectionKey,
    probe: input.probe,
    previousCause,
  });
}

/** 原因projectionからseedの生成元を取得する。 */
export function seedOriginForProjection(
  projection: PersonalReminderCauseProjection,
  seed: PersonalReminderCauseSeed,
): PersonalReminderCauseSeedOrigin {
  if (projection.draft == null) {
    assertNonNullable(
      projection.previousCause,
      `保持seedのprevious causeがありません。対象: ${seed.causeId}`,
    );
    return Object.freeze({
      kind: "retained_without_draft",
      seed,
      previousCause: projection.previousCause,
    });
  }
  if (projection.previousCause == null) {
    return Object.freeze({ kind: "new_draft", seed, draft: projection.draft });
  }
  return Object.freeze({
    kind: "normal_continuation",
    seed,
    draft: projection.draft,
    previousCause: projection.previousCause,
  });
}

/** 原因seedが正規の生成規則と一致するか検証する。 */
export function assertRuntimeSeedMatchesBuilder(
  currentSeed: PersonalReminderRuntimeCurrentSeed,
  evaluatedAt: UtcIsoDateTime,
): void {
  const origin = currentSeed.constructionOrigin;
  let projection: PersonalReminderCauseProjection;
  switch (origin.kind) {
    case "new_draft":
      projection = Object.freeze({
        key: currentSeed.projectionKey,
        draft: origin.draft,
        previousCause: undefined,
      });
      break;
    case "normal_continuation":
      projection = Object.freeze({
        key: currentSeed.projectionKey,
        draft: origin.draft,
        previousCause: origin.previousCause,
      });
      break;
    case "retained_without_draft":
      projection = Object.freeze({
        key: currentSeed.projectionKey,
        draft: undefined,
        previousCause: origin.previousCause,
      });
      break;
    default:
      throw new UnreachableError(origin);
  }
  const rebuilt = createPersonalReminderCauseProjectionSeed({
    projection,
    currentObservedAt: evaluatedAt,
    sourceOccurredAtById: currentSeed.item.sourceOccurredAtById,
  });
  if (serializeCanonicalJson(rebuilt) !== serializeCanonicalJson(currentSeed.seed)) {
    throw new TypeError(
      `個人催促cause seedの生成元が一致しません。対象: ${currentSeed.seed.causeId}`,
    );
  }
}
