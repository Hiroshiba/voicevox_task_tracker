import {
  AI_ANALYSIS_DEPENDENCY_ELEMENTS,
  normalizeAiAnalysisDependency,
} from "../domain/ai-analysis-dependencies.js";
import {
  isTerminalStatus,
  personalReminderCauseAiDependenciesSchema,
  personalReminderCausePlanningSchema,
  personalReminderCauseSchema,
  validateDeadlineDate,
  type Actor,
  type AiAnalysisDependency,
  type ExternalGhostNode,
  type GitHubAccountActor,
  type GraphNodeId,
  type PersonalReminderCause,
  type PersonalReminderCausePlanning,
} from "../domain/index.js";
import { StateSnapshotSemanticError } from "./errors.js";
import { assertAiAnalysisApplicationsMatchTrackedItemValues } from "./snapshot-ai-adoption.js";
import { assertRelationCandidateProducerDefinitions } from "./snapshot-ai-integrity.js";
import { expectedSnapshotBlockerAnalysis } from "./snapshot-blocker-analysis.js";
import {
  assertAuthoritativeBlockerStateCompleteness,
  assertBlockerValueDependencyLowerBounds,
  expectedSnapshotBlockerValueAiDependencies,
} from "./snapshot-blocker-values.js";
import type {
  LegacyStateSnapshotFields,
  LegacyStateSnapshotFieldsWithoutAiDependencies,
  LegacyStateSnapshotFieldsWithPersonalReminder,
  LegacyStateSnapshotFieldsWithPersonalReminderVersion17,
  SnapshotItemForRelationValidation,
  StateSnapshotFields,
} from "./snapshot-contracts.js";
import {
  aiAnalysisDependencyContainsRecordedLowerBound,
  assertAiAnalysisSemantics,
  assertGraphDerivedAiDependencyLowerBounds,
  blockerDependencySatisfiesExpected,
  blocksArcKey,
  expectedRelationSetAiDependencies,
  relationSetDependencySatisfiesExpected,
} from "./snapshot-graph-dependencies.js";
import {
  assertImplementsRelationEndpointTypes,
  assertInferredRelationAiDependencySemantics,
  assertRelationAiDependencySemantics,
  expectedBlockersAiDependencies,
  expectedDownstreamImpactAiDependencies,
} from "./snapshot-relations.js";
import {
  assertPersonalReminderCausePlanningSemantics,
  assertPersonalReminderDependenciesSemantics,
} from "./snapshot-reminder-planning.js";
import {
  assertPersonalReminderCausesSemantics,
  isLegacyPersonalReminder,
} from "./snapshot-reminder-responsibility.js";
import type { ElementSchemaVersion } from "./snapshot-schema.js";
import {
  assertTrackedItemAiDependenciesSemantics,
  hasCanonicalStaleBlockerTopologyDependencies,
} from "./snapshot-state-dependencies.js";
import {
  assertUnique,
  assertUtcDateTime,
  effectiveGraphStateByNodeId,
  effectiveGraphStateForNode,
} from "./snapshot-values.js";

export function normalizeActor(actor: Actor): Actor {
  if (actor.type === "system") {
    return Object.freeze({
      type: actor.type,
      name: actor.name,
    });
  }
  return Object.freeze({
    type: actor.type,
    nodeId: actor.nodeId,
    login: actor.login,
  });
}

export function normalizePersonalReminderCause(
  cause: PersonalReminderCause,
): PersonalReminderCause {
  return personalReminderCauseSchema.parse({
    ...cause,
    aiDependencies: personalReminderCauseAiDependenciesSchema.parse({
      presence: normalizeAiAnalysisDependency(cause.aiDependencies.presence),
      responseMembership: normalizeAiAnalysisDependency(cause.aiDependencies.responseMembership),
      responsible: normalizeAiAnalysisDependency(cause.aiDependencies.responsible),
      action: normalizeAiAnalysisDependency(cause.aiDependencies.action),
      evidence: normalizeAiAnalysisDependency(cause.aiDependencies.evidence),
    }),
    currentInput: {
      ...cause.currentInput,
      aiDependency: normalizeAiAnalysisDependency(cause.currentInput.aiDependency),
    },
  });
}

export function normalizePersonalReminderCausePlanning(
  planning: PersonalReminderCausePlanning,
): PersonalReminderCausePlanning {
  if (planning.status !== "completed") {
    return personalReminderCausePlanningSchema.parse(planning);
  }
  return personalReminderCausePlanningSchema.parse({
    ...planning,
    causeSetAiDependency: normalizeAiAnalysisDependency(planning.causeSetAiDependency),
  });
}

export function normalizeAccountActor(actor: GitHubAccountActor): GitHubAccountActor {
  return Object.freeze({
    type: actor.type,
    nodeId: actor.nodeId,
    login: actor.login,
  });
}

export function assertSnapshotSemantics(
  snapshot:
    | StateSnapshotFields
    | LegacyStateSnapshotFieldsWithoutAiDependencies
    | LegacyStateSnapshotFields
    | LegacyStateSnapshotFieldsWithPersonalReminder
    | LegacyStateSnapshotFieldsWithPersonalReminderVersion17,
  elementSchemaVersion: ElementSchemaVersion,
  adoptedElementsFormat: "legacy" | "current",
  requireApplications: boolean,
  requireImplementsEndpointTypes: boolean,
): void {
  assertUtcDateTime(snapshot.generatedAt, "generatedAt");
  if (snapshot.trackingStartAt.status === "fixed") {
    assertUtcDateTime(snapshot.trackingStartAt.value, "trackingStartAt");
  }
  assertUnique(
    snapshot.repositories.map((repository) => repository.id),
    "repository ID",
  );
  assertUnique(
    snapshot.items.map((item) => item.nodeId),
    "item node ID",
  );
  assertUnique(
    snapshot.externalReferences.map((reference) => reference.nodeId),
    "外部参照node ID",
  );
  assertUnique(
    snapshot.relations.map((relation) => relation.id),
    "relation ID",
  );

  const repositoryIds = new Set(snapshot.repositories.map((repository) => repository.id));
  const personalReminderCauseIdValues = snapshot.items.flatMap((item) =>
    "personalReminderCauses" in item
      ? item.personalReminderCauses.map((cause) => cause.causeId)
      : [],
  );
  assertUnique(personalReminderCauseIdValues, "personal reminder cause ID");
  const personalReminderCauseIds = new Set(personalReminderCauseIdValues);
  const personalReminderResponsibilityIdValues = snapshot.items.flatMap((item) =>
    "personalReminderCauses" in item
      ? item.personalReminderCauses.map((cause) => cause.responsibilityId)
      : [],
  );
  assertUnique(personalReminderResponsibilityIdValues, "personal reminder responsibility ID");
  assertUnique(
    snapshot.collection.repositories.map((repository) => repository.repositoryId),
    "収集stateのrepository ID",
  );
  const collectionItemNodeIds = snapshot.collection.repositories.flatMap((repository) =>
    repository.items.map((item) => item.nodeId),
  );
  assertUnique(collectionItemNodeIds, "収集stateのitem node ID");
  const snapshotRepositoriesById = new Map(
    snapshot.repositories.map((repository) => [repository.id, repository]),
  );
  for (const collectionRepository of snapshot.collection.repositories) {
    const snapshotRepository = snapshotRepositoriesById.get(collectionRepository.repositoryId);
    if (snapshotRepository == null) {
      throw new StateSnapshotSemanticError(
        "収集stateのrepositoryIdがsnapshotのrepository一覧にありません",
      );
    }
    assertUtcDateTime(collectionRepository.successfulAt, "収集stateのrepository成功時刻");
    if (collectionRepository.successfulAt !== snapshotRepository.observedAt) {
      throw new StateSnapshotSemanticError(
        "収集stateのrepository成功時刻がsnapshotのrepository観測時刻と一致しません",
      );
    }
    for (const item of collectionRepository.items) {
      if (item.repositoryId !== collectionRepository.repositoryId) {
        throw new StateSnapshotSemanticError(
          "収集stateのitem repositoryIdが親repositoryと一致しません",
        );
      }
      assertUtcDateTime(item.observedAt, "収集stateのitem観測時刻");
      assertAiAnalysisSemantics(
        item.aiAnalysis,
        elementSchemaVersion,
        adoptedElementsFormat,
        requireApplications,
        true,
      );
      if (item.observedAt > collectionRepository.successfulAt) {
        throw new StateSnapshotSemanticError(
          "収集stateのitem観測時刻はrepository成功時刻以前にしてください",
        );
      }
      if (item.state === "closed") {
        assertUtcDateTime(item.terminalAt, "収集stateのterminal遷移時刻");
        if (item.terminalAt > collectionRepository.successfulAt) {
          throw new StateSnapshotSemanticError(
            "収集stateのterminal遷移時刻はrepository成功時刻以前にしてください",
          );
        }
      }
    }
  }
  for (const repository of snapshot.repositories) {
    assertUtcDateTime(repository.observedAt, "repository observedAt");
    if (repository.freshness === "stale") {
      assertUtcDateTime(repository.failedAt, "stale repository failedAt");
      if (repository.observedAt >= repository.failedAt) {
        throw new StateSnapshotSemanticError(
          "stale repositoryのobservedAtはfailedAtより前にしてください",
        );
      }
    }
    const latestRepositoryTime =
      repository.freshness === "stale" ? repository.failedAt : repository.observedAt;
    if (latestRepositoryTime > snapshot.generatedAt) {
      throw new StateSnapshotSemanticError(
        "repositoryの観測時刻はsnapshot generatedAt以前にしてください",
      );
    }
  }
  if ("graphNodeStateObservations" in snapshot) {
    assertUnique(
      snapshot.graphNodeStateObservations.map((observation) => observation.nodeId),
      "graph node状態観測のnode ID",
    );
    const itemsByNodeId = new Map(snapshot.items.map((item) => [item.nodeId, item]));
    for (const observation of snapshot.graphNodeStateObservations) {
      const item = itemsByNodeId.get(observation.nodeId);
      if (item == null) {
        throw new StateSnapshotSemanticError(
          `graph node状態観測のitemがありません。対象: ${observation.nodeId}`,
        );
      }
      const repository = snapshotRepositoriesById.get(item.repositoryId);
      if (repository?.freshness !== "stale") {
        throw new StateSnapshotSemanticError(
          `graph node状態観測のrepositoryはstaleでなければなりません。対象: ${observation.nodeId}`,
        );
      }
      assertUtcDateTime(observation.observedAt, "graph node状態観測時刻");
      if (observation.observedAt <= item.observedAt) {
        throw new StateSnapshotSemanticError(
          `graph node状態観測時刻はitem観測時刻より後にしてください。対象: ${observation.nodeId}`,
        );
      }
      if (observation.observedAt > snapshot.generatedAt) {
        throw new StateSnapshotSemanticError(
          `graph node状態観測時刻はsnapshot generatedAt以前にしてください。対象: ${observation.nodeId}`,
        );
      }
      if (observation.state === item.state) {
        throw new StateSnapshotSemanticError(
          `graph node状態観測はitem状態と異なる場合だけ保存してください。対象: ${observation.nodeId}`,
        );
      }
      if (item.type === "issue" && observation.state === "merged") {
        throw new StateSnapshotSemanticError(
          `Issueのgraph node状態観測をmergedにはできません。対象: ${observation.nodeId}`,
        );
      }
    }
  }
  for (const item of snapshot.items) {
    if (!repositoryIds.has(item.repositoryId)) {
      throw new StateSnapshotSemanticError(
        "itemのrepositoryIdがsnapshotのrepository一覧にありません",
      );
    }
    assertAiAnalysisSemantics(
      item.aiAnalysis,
      elementSchemaVersion,
      adoptedElementsFormat,
      requireApplications,
      false,
    );
    if ("aiDependencies" in item) {
      assertAiAnalysisApplicationsMatchTrackedItemValues(item);
    }
    if ("personalReminderCauses" in item) {
      const legacyPersonalReminder = isLegacyPersonalReminder(item);
      assertPersonalReminderCausesSemantics(item, personalReminderCauseIds, legacyPersonalReminder);
      assertPersonalReminderCausePlanningSemantics(item, legacyPersonalReminder);
    }
    if (isTerminalStatus(item.status) && item.waitingOn.length !== 0) {
      throw new StateSnapshotSemanticError("terminal itemにwaitingOnを保存できません");
    }
    if (isTerminalStatus(item.status) && item.severityContext.waitClass !== "notApplicable") {
      throw new StateSnapshotSemanticError(
        "terminal itemのseverity contextはnotApplicableにしてください",
      );
    }
    if (!isTerminalStatus(item.status) && item.severityContext.waitClass === "notApplicable") {
      throw new StateSnapshotSemanticError(
        "継続中itemのseverity contextをnotApplicableにはできません",
      );
    }
    if (
      item.status === "waiting_for_unblock" &&
      item.severityContext.waitClass !== "blockedParent"
    ) {
      throw new StateSnapshotSemanticError(
        "waiting_for_unblock itemのseverity contextはblockedParentにしてください",
      );
    }
    if (
      item.status !== "waiting_for_unblock" &&
      item.severityContext.waitClass === "blockedParent"
    ) {
      throw new StateSnapshotSemanticError(
        "waiting_for_unblock以外のitemのseverity contextをblockedParentにはできません",
      );
    }
    if (item.waitingOn.length === 0 && item.primaryWaitingOn.index !== "not_applicable") {
      throw new StateSnapshotSemanticError("waitingOnがないitemにprimaryを保存できません");
    }
    if (item.waitingOn.length > 0 && item.primaryWaitingOn.index !== 0) {
      throw new StateSnapshotSemanticError("waitingOnがあるitemにはprimaryが必要です");
    }
    assertUnique(
      item.assignees.map((assignee) => assignee.nodeId),
      "itemのassignee node ID",
    );
    assertUnique(
      item.inputEvents.map((event) => event.sourceId),
      "itemの入力イベントsource ID",
    );
    for (const dateTime of [
      item.createdAt,
      item.githubUpdatedAt,
      item.lastHumanActivityAt,
      item.lastProgressAt,
      item.statusSince,
      item.ownerSince,
      item.stallSince,
      item.observedAt,
    ]) {
      assertUtcDateTime(dateTime, "itemの日時");
    }
    assertUnique(
      item.importance.factors.map((factor) => factor.kind),
      "itemのimportance factor kind",
    );
    for (let index = 1; index < item.importance.factors.length; index += 1) {
      const previousFactor = item.importance.factors[index - 1];
      const factor = item.importance.factors[index];
      if (previousFactor == null || factor == null) {
        throw new StateSnapshotSemanticError("importance factorの順序を検証できません");
      }
      if (previousFactor.points < factor.points) {
        throw new StateSnapshotSemanticError("importance factorはpointsの降順にしてください");
      }
    }
    const importanceScore = Math.min(
      100,
      Math.max(
        0,
        Math.round(item.importance.factors.reduce((sum, factor) => sum + factor.points, 0)),
      ),
    );
    if (item.importance.score !== importanceScore) {
      throw new StateSnapshotSemanticError("importance scoreがfactorの合計と一致しません");
    }
    if (item.deadlineAssessment.status === "available") {
      try {
        validateDeadlineDate(item.deadlineAssessment.value.date, "itemの期限日");
      } catch (error: unknown) {
        if (!(error instanceof RangeError)) {
          throw error;
        }
        throw new StateSnapshotSemanticError("itemの期限日は実在する日付にしてください");
      }
    }
  }
  const graphNodeIds = new Set([
    ...snapshot.items.map((item) => item.nodeId),
    ...snapshot.externalReferences.map((reference) => reference.nodeId),
  ]);
  const effectiveGraphStates = effectiveGraphStateByNodeId(snapshot);
  const openGraphNodeIds = new Set<GraphNodeId>([
    ...snapshot.items
      .filter((item) => effectiveGraphStateForNode(effectiveGraphStates, item.nodeId) === "open")
      .map((item) => item.nodeId),
    ...snapshot.externalReferences
      .filter((reference) => reference.state === "open")
      .map((reference) => reference.nodeId),
  ]);
  const itemsByNodeId = new Map<string, SnapshotItemForRelationValidation>(
    snapshot.items.map((item) => [item.nodeId, item]),
  );
  const externalReferencesByNodeId = new Map<string, ExternalGhostNode>(
    snapshot.externalReferences.map((reference) => [reference.nodeId, reference]),
  );
  const staleRepositoryIds = new Set(
    snapshot.repositories
      .filter((repository) => repository.freshness === "stale")
      .map((repository) => repository.id),
  );
  const staleGraphNodeIds = new Set<GraphNodeId>(
    snapshot.items
      .filter((item) => staleRepositoryIds.has(item.repositoryId))
      .map((item) => item.nodeId),
  );
  const relationsById = new Map(snapshot.relations.map((relation) => [relation.id, relation]));
  const activeBlocksArcKeys = new Set(
    snapshot.relations
      .filter((relation) => relation.active && relation.type === "blocks")
      .map((relation) => blocksArcKey(relation.fromNodeId, relation.toNodeId)),
  );
  const notDependentOpenBlockerNodeIdsByTargetNodeId = new Map<GraphNodeId, Set<GraphNodeId>>();
  for (const relation of snapshot.relations) {
    if (
      !relation.active ||
      relation.type !== "blocks" ||
      relation.provenance !== "native" ||
      !openGraphNodeIds.has(relation.fromNodeId) ||
      !openGraphNodeIds.has(relation.toNodeId) ||
      !("aiDependency" in relation) ||
      typeof relation.aiDependency !== "object" ||
      !("status" in relation.aiDependency) ||
      relation.aiDependency.status !== "not_dependent"
    ) {
      continue;
    }
    const blockerNodeIds = notDependentOpenBlockerNodeIdsByTargetNodeId.get(relation.toNodeId);
    if (blockerNodeIds == null) {
      notDependentOpenBlockerNodeIdsByTargetNodeId.set(
        relation.toNodeId,
        new Set([relation.fromNodeId]),
      );
    } else {
      blockerNodeIds.add(relation.fromNodeId);
    }
  }
  for (const relation of snapshot.relations) {
    if (!graphNodeIds.has(relation.fromNodeId) || !graphNodeIds.has(relation.toNodeId)) {
      throw new StateSnapshotSemanticError("relationがsnapshotにないnodeを参照しています");
    }
    if (requireImplementsEndpointTypes) {
      assertImplementsRelationEndpointTypes(relation, itemsByNodeId, externalReferencesByNodeId);
    }
    assertUtcDateTime(relation.firstSeenAt, "relation firstSeenAt");
    assertUtcDateTime(relation.lastConfirmedAt, "relation lastConfirmedAt");
    if ("aiDependency" in relation) {
      assertRelationAiDependencySemantics(relation.aiDependency, "relationのAI依存");
      if (relation.provenance === "native" && relation.aiDependency.status !== "not_dependent") {
        throw new StateSnapshotSemanticError(
          "native relationのAI依存はnot_dependentでなければなりません",
        );
      }
      assertInferredRelationAiDependencySemantics(
        relation,
        itemsByNodeId,
        !relation.active ||
          staleGraphNodeIds.has(relation.fromNodeId) ||
          staleGraphNodeIds.has(relation.toNodeId),
      );
    }
    if (!relation.active) {
      if (!("removedAt" in relation)) {
        throw new StateSnapshotSemanticError("inactive relationのremovedAtがありません");
      }
      assertUtcDateTime(relation.removedAt, "relation removedAt");
    }
  }
  const relationCandidateDependencies: {
    description: string;
    dependency: AiAnalysisDependency;
    targetNodeId?: GraphNodeId;
  }[] = [];
  for (const item of snapshot.items) {
    if ("aiDependencies" in item) {
      for (const element of AI_ANALYSIS_DEPENDENCY_ELEMENTS) {
        relationCandidateDependencies.push({
          description: `item ${item.nodeId}の${element} AI依存`,
          dependency: item.aiDependencies[element],
          ...(element === "blockers" ? { targetNodeId: item.nodeId } : {}),
        });
      }
    }
    if ("personalReminderCauses" in item) {
      for (const cause of item.personalReminderCauses) {
        if (!("aiDependencies" in cause) || !("aiDependency" in cause.currentInput)) {
          continue;
        }
        relationCandidateDependencies.push(
          {
            description: `personal reminder cause ${cause.causeId}のpresence AI依存`,
            dependency: cause.aiDependencies.presence,
          },
          {
            description: `personal reminder cause ${cause.causeId}のresponse membership AI依存`,
            dependency: cause.aiDependencies.responseMembership,
          },
          {
            description: `personal reminder cause ${cause.causeId}のresponsible AI依存`,
            dependency: cause.aiDependencies.responsible,
          },
          {
            description: `personal reminder cause ${cause.causeId}のaction AI依存`,
            dependency: cause.aiDependencies.action,
          },
          {
            description: `personal reminder cause ${cause.causeId}のevidence AI依存`,
            dependency: cause.aiDependencies.evidence,
          },
          {
            description: `personal reminder cause ${cause.causeId}のcurrent input AI依存`,
            dependency: cause.currentInput.aiDependency,
          },
        );
      }
      if (
        item.personalReminderCausePlanning.status === "completed" &&
        "causeSetAiDependency" in item.personalReminderCausePlanning
      ) {
        relationCandidateDependencies.push({
          description: `item ${item.nodeId}のpersonal reminder cause set AI依存`,
          dependency: item.personalReminderCausePlanning.causeSetAiDependency,
          targetNodeId: item.nodeId,
        });
      }
    }
  }
  for (const relation of snapshot.relations) {
    if ("aiDependency" in relation) {
      relationCandidateDependencies.push({
        description: `relation ${relation.id}のAI依存`,
        dependency: relation.aiDependency,
      });
    }
  }
  assertRelationCandidateProducerDefinitions(
    relationCandidateDependencies,
    itemsByNodeId,
    relationsById,
  );
  for (const item of snapshot.items) {
    if ("personalReminderCauses" in item) {
      assertPersonalReminderDependenciesSemantics(item, itemsByNodeId, relationsById);
    }
  }
  const expectedBlockerDependenciesByNodeId = expectedBlockersAiDependencies(snapshot);
  const expectedBlockerAnalysis = expectedSnapshotBlockerAnalysis(snapshot);
  const expectedRelationSetDependenciesByNodeId = expectedRelationSetAiDependencies(snapshot);
  const expectedDownstreamImpactDependenciesByNodeId =
    expectedDownstreamImpactAiDependencies(snapshot);
  for (const item of snapshot.items) {
    if (!("aiDependencies" in item)) {
      continue;
    }
    assertTrackedItemAiDependenciesSemantics(
      item.aiDependencies,
      "itemのAI依存",
      item,
      itemsByNodeId,
      relationsById,
      activeBlocksArcKeys,
      notDependentOpenBlockerNodeIdsByTargetNodeId,
      staleGraphNodeIds.has(item.nodeId),
    );
    if (expectedDownstreamImpactDependenciesByNodeId != null) {
      const expectedDownstreamImpact = expectedDownstreamImpactDependenciesByNodeId.get(
        item.nodeId,
      );
      if (expectedDownstreamImpact == null) {
        throw new StateSnapshotSemanticError(
          `item ${item.nodeId}のdownstream impact AI依存の検証対象がありません`,
        );
      }
      assertGraphDerivedAiDependencyLowerBounds(item, expectedDownstreamImpact);
    }
    const relationSetIsProducerlessMigration =
      item.aiDependencies.relationSet.status === "unknown" &&
      item.aiDependencies.relationSet.reasons.length === 1 &&
      item.aiDependencies.relationSet.reasons[0] === "migration" &&
      item.aiDependencies.relationSet.producers == null;
    if (!relationSetIsProducerlessMigration) {
      const expectedRelationSet = expectedRelationSetDependenciesByNodeId.get(item.nodeId);
      if (expectedRelationSet == null) {
        throw new StateSnapshotSemanticError(
          `item ${item.nodeId}のrelation set AI依存の検証対象がありません`,
        );
      }
      if (
        !relationSetDependencySatisfiesExpected(
          expectedRelationSet,
          item.aiDependencies.relationSet,
          relationsById,
        )
      ) {
        throw new StateSnapshotSemanticError(
          `item ${item.nodeId}のrelation set AI依存がactive incident relation supportと一致しません`,
        );
      }
    }
    const expectedBlockers = expectedBlockerDependenciesByNodeId.get(item.nodeId);
    if (expectedBlockers == null) {
      throw new StateSnapshotSemanticError(
        `item ${item.nodeId}のblockers AI依存の検証対象がありません`,
      );
    }
    if (
      !blockerDependencySatisfiesExpected(
        expectedBlockers,
        item.aiDependencies.blockers,
        item.nodeId,
        itemsByNodeId,
        relationsById,
        activeBlocksArcKeys,
      )
    ) {
      throw new StateSnapshotSemanticError(
        `item ${item.nodeId}のblockers AI依存がactive/open relation supportと一致しません`,
      );
    }
    if (expectedBlockerAnalysis != null) {
      const expectedBlockerSetDependency =
        expectedBlockerAnalysis.blockerSetDependenciesByNodeId.get(item.nodeId);
      if (expectedBlockerSetDependency == null) {
        throw new StateSnapshotSemanticError(
          `item ${item.nodeId}のblocker set AI依存を再構成できません`,
        );
      }
      if (
        !aiAnalysisDependencyContainsRecordedLowerBound(
          expectedBlockerSetDependency,
          item.aiDependencies.blockers,
        )
      ) {
        throw new StateSnapshotSemanticError(
          `item ${item.nodeId}のblockers AI依存がblocker setの導出元を含んでいません`,
        );
      }
      const staleBlockerTopologyFallback =
        staleGraphNodeIds.has(item.nodeId) && hasCanonicalStaleBlockerTopologyDependencies(item);
      if (!staleBlockerTopologyFallback) {
        assertAuthoritativeBlockerStateCompleteness(
          item,
          expectedBlockerAnalysis.blockersByBlockedNodeId.get(item.nodeId) ?? [],
        );
        assertBlockerValueDependencyLowerBounds(
          item,
          expectedSnapshotBlockerValueAiDependencies(
            item,
            expectedBlockerAnalysis,
            effectiveGraphStateForNode(effectiveGraphStates, item.nodeId),
          ),
        );
      }
    }
  }
}
