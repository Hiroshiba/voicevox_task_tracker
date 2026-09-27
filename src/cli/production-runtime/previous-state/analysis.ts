import { hashCanonicalJson } from "../../../canonical-json/index.js";
import {
  type AiAnalysisDependency,
  type AiAnalysisDependencyElement,
  type AiAnalysisDependencyProducer,
} from "../../../domain/ai-analysis-dependencies.js";
import { createGitHubNodeId, type GitHubNodeId } from "../../../domain/index.js";
import type { SnapshotTrackedItem } from "../../../persistence/index.js";
import { normalizedBlockerRelationEndpointNodeIds } from "../../relation-driven-analysis-targets.js";
import type { RuntimeState } from "../contracts.js";
import { previousSnapshot } from "./snapshot.js";

const STALE_BLOCKER_TOPOLOGY_DEPENDENCY_ELEMENTS = Object.freeze([
  "status",
  "waitingOn",
  "primaryWaitingOn",
  "nextAction",
  "confidence",
  "evidence",
  "uncertainties",
  "lastProgressAt",
  "stallSince",
] satisfies readonly AiAnalysisDependencyElement[]);

type PreviousRelationCandidateDependencyProducer = Extract<
  AiAnalysisDependencyProducer,
  { kind: "relation_candidate" }
>;

type PreviousPersonalReminderRelationCandidateDependency = Readonly<{
  consumerNodeId: GitHubNodeId;
  producer: PreviousRelationCandidateDependencyProducer;
}>;

function personalReminderAiDependencies(
  item: SnapshotTrackedItem,
): readonly AiAnalysisDependency[] {
  return Object.freeze([
    ...(item.personalReminderCausePlanning.status === "completed"
      ? [item.personalReminderCausePlanning.causeSetAiDependency]
      : []),
    ...item.personalReminderCauses.flatMap((cause) => [
      ...Object.values(cause.aiDependencies),
      cause.currentInput.aiDependency,
    ]),
  ]);
}

/** 前回の関係候補依存の生成元を参照する。 */
export function previousRelationCandidateDependencyProducers(
  state: RuntimeState,
): readonly PreviousRelationCandidateDependencyProducer[] {
  const producersByCandidateId = new Map<string, PreviousRelationCandidateDependencyProducer>();
  const snapshot = previousSnapshot(state);
  const dependencies = [
    ...(snapshot?.items ?? []).flatMap((item) => [
      ...Object.values(item.aiDependencies),
      ...personalReminderAiDependencies(item),
    ]),
    ...(snapshot?.relations ?? []).map((relation) => relation.aiDependency),
  ];
  for (const dependency of dependencies) {
    if (dependency.status === "not_dependent" || dependency.producers == null) {
      continue;
    }
    for (const producer of dependency.producers) {
      if (producer.kind !== "relation_candidate") {
        continue;
      }
      const existing = producersByCandidateId.get(producer.candidateId);
      if (existing != null && hashCanonicalJson(existing) !== hashCanonicalJson(producer)) {
        throw new TypeError(
          `前回snapshotのrelation candidate producer定義が一致しません。対象: ${producer.candidateId}`,
        );
      }
      producersByCandidateId.set(producer.candidateId, producer);
    }
  }
  return Object.freeze([...producersByCandidateId.values()]);
}

/** 前回の個人催促の関係候補依存を参照する。 */
export function previousPersonalReminderRelationCandidateDependencies(
  state: RuntimeState,
): readonly PreviousPersonalReminderRelationCandidateDependency[] {
  const producersByCandidateId = new Map<string, PreviousRelationCandidateDependencyProducer>();
  const dependenciesByConsumerAndCandidate = new Map<
    string,
    PreviousPersonalReminderRelationCandidateDependency
  >();
  for (const item of previousSnapshot(state)?.items ?? []) {
    const dependencies = personalReminderAiDependencies(item);
    for (const dependency of dependencies) {
      if (dependency.status === "not_dependent" || dependency.producers == null) {
        continue;
      }
      for (const producer of dependency.producers) {
        if (producer.kind !== "relation_candidate") {
          continue;
        }
        const endpointNodeIds = normalizedBlockerRelationEndpointNodeIds(producer.endpointNodeIds);
        if (!endpointNodeIds.includes(producer.producer.nodeId)) {
          throw new TypeError(
            `前回snapshotのpersonal reminder relation candidate producer nodeがendpointと一致しません。対象: ${producer.candidateId}`,
          );
        }
        const normalizedProducer = Object.freeze({ ...producer, endpointNodeIds });
        const existingProducer = producersByCandidateId.get(producer.candidateId);
        if (existingProducer != null) {
          if (
            existingProducer.producer.nodeId !== normalizedProducer.producer.nodeId ||
            existingProducer.endpointNodeIds[0] !== normalizedProducer.endpointNodeIds[0] ||
            existingProducer.endpointNodeIds[1] !== normalizedProducer.endpointNodeIds[1]
          ) {
            throw new TypeError(
              `前回snapshotのpersonal reminder relation candidate producer定義が一致しません。対象: ${producer.candidateId}`,
            );
          }
        } else {
          producersByCandidateId.set(producer.candidateId, normalizedProducer);
        }
        const dependencyKey = JSON.stringify([item.nodeId, producer.candidateId]);
        if (!dependenciesByConsumerAndCandidate.has(dependencyKey)) {
          dependenciesByConsumerAndCandidate.set(
            dependencyKey,
            Object.freeze({
              consumerNodeId: item.nodeId,
              producer: normalizedProducer,
            }),
          );
        }
      }
    }
  }
  return Object.freeze(
    [...dependenciesByConsumerAndCandidate.values()].sort((left, right) => {
      const candidateOrder = left.producer.candidateId.localeCompare(right.producer.candidateId);
      return candidateOrder !== 0
        ? candidateOrder
        : left.consumerNodeId.localeCompare(right.consumerNodeId);
    }),
  );
}

/** 前回の個人催促の関係候補依存先を参照する。 */
export function previousPersonalReminderRelationCandidateConsumerNodeIds(
  state: RuntimeState,
): ReadonlySet<GitHubNodeId> {
  return new Set(
    previousPersonalReminderRelationCandidateDependencies(state).map(
      (dependency) => dependency.consumerNodeId,
    ),
  );
}

/** 前回の古いリポジトリの阻害関係対象を参照する。 */
export function previousStaleRepositoryBlockerTopologyNodeIds(
  state: RuntimeState,
): ReadonlySet<GitHubNodeId> {
  const nodeIds = new Set<GitHubNodeId>();
  for (const item of previousSnapshot(state)?.items ?? []) {
    const hasMarker = STALE_BLOCKER_TOPOLOGY_DEPENDENCY_ELEMENTS.every((element) => {
      const dependency = item.aiDependencies[element];
      return dependency.status === "unknown" && dependency.reasons.includes("stale_repository");
    });
    if (hasMarker) {
      nodeIds.add(item.nodeId);
    }
  }
  return nodeIds;
}

/** 前回のグラフに隣接する追跡項目を参照する。 */
export function previousGraphAdjacentNodeIds(state: RuntimeState): ReadonlySet<GitHubNodeId> {
  const nodeIds = new Set<GitHubNodeId>();
  const snapshot = previousSnapshot(state);
  const trackedNodeIds = new Set<string>(snapshot?.items.map((item) => item.nodeId) ?? []);
  for (const relation of snapshot?.relations ?? []) {
    if (!relation.active) {
      continue;
    }
    if (trackedNodeIds.has(relation.fromNodeId)) {
      nodeIds.add(createGitHubNodeId(relation.fromNodeId));
    }
    if (trackedNodeIds.has(relation.toNodeId)) {
      nodeIds.add(createGitHubNodeId(relation.toNodeId));
    }
  }
  for (const producer of previousRelationCandidateDependencyProducers(state)) {
    for (const endpointNodeId of producer.endpointNodeIds) {
      if (trackedNodeIds.has(endpointNodeId)) {
        nodeIds.add(createGitHubNodeId(endpointNodeId));
      }
    }
  }
  return nodeIds;
}
