import { z } from "zod";

import type { GitHubNodeId, GraphNodeId } from "../../../domain/types.js";
import type { RunEvaluatedAt } from "../contracts/evaluation-time.js";
import type { SourceId } from "../../../domain/source-id.js";
import { buildRelationCandidateId } from "../../../graph/relation-candidate-id.js";
import {
  relationAssessmentOwnerNodeId,
  relationNodes,
} from "../../../graph/relation-candidate-endpoints.js";
import type { RelationCandidate } from "../../../graph/relation-candidate-types.js";
import {
  createDeterministicallyAnalyzedStageProof,
  type StageProofFor,
} from "../contracts/proofs.js";
import type { PreparedBaseStateShape } from "../prepare-run.js";
import type { CollectedRun } from "./collection.js";

const candidateIdSchema = z
  .string()
  .regex(/^rel:[0-9a-f]{64}$/u)
  .brand<"CandidateId">();

/** 項目・source・個人原因のIDと混同しない関係候補ID。 */
export type CandidateId = z.output<typeof candidateIdSchema>;

/** 関係候補の正規端点と判定担当。 */
export type DeterministicRelationFact = Readonly<{
  id: CandidateId;
  candidate: RelationCandidate;
  endpoints: readonly [GraphNodeId, GraphNodeId];
  decisionOwner: GraphNodeId;
  sourceIds: readonly SourceId[];
  authority: RelationCandidate["authority"];
  provenance: RelationCandidate["provenance"];
}>;

export type DeterministicCollection = Readonly<{
  evaluatedAt: RunEvaluatedAt;
  relationCandidates: readonly RelationCandidate[];
  observedItems: readonly Readonly<{ nodeId: GitHubNodeId; state: "open" | "closed" }>[];
  staleItems: readonly Readonly<{
    nodeId: GitHubNodeId;
    previousObservation: Readonly<{ state: "open" | "closed" }>;
  }>[];
  details: readonly Readonly<{ nodeId: GitHubNodeId }>[];
  trackedNodeIds: readonly GitHubNodeId[];
  analysisNodeIds: readonly GitHubNodeId[];
  changedNodeIds: readonly GitHubNodeId[];
}>;

export type AnalyzedItem = Readonly<{ item: Readonly<{ nodeId: GitHubNodeId }> }>;

/** 決定論的に確定した項目、収集集合、関係候補のfacts。 */
export type DeterministicFacts<Item extends AnalyzedItem> = Readonly<{
  items: readonly Item[];
  relations: readonly DeterministicRelationFact[];
  trackedNodeIds: readonly GitHubNodeId[];
  terminalNodeIds: readonly GitHubNodeId[];
  staleNodeIds: readonly GitHubNodeId[];
  refetchedNodeIds: readonly GitHubNodeId[];
  analysisNodeIds: readonly GitHubNodeId[];
  changedNodeIds: readonly GitHubNodeId[];
}>;

/** 決定論的な初期項目判定を行うpure port。 */
export type DeterministicAnalysisPort<
  BaseState extends PreparedBaseStateShape,
  Collection extends DeterministicCollection = DeterministicCollection,
  Item extends AnalyzedItem = AnalyzedItem,
> = Readonly<{
  analyze: (collected: CollectedRun<BaseState, Collection>) => readonly Item[];
}>;

/** 決定論的な初期判定と候補factsが確定したrun。 */
export type DeterministicallyAnalyzedRun<
  BaseState extends PreparedBaseStateShape,
  Collection extends DeterministicCollection = DeterministicCollection,
  Item extends AnalyzedItem = AnalyzedItem,
> = Readonly<{
  stage: "deterministically_analyzed";
  core: CollectedRun<BaseState, Collection>["core"];
  data: Readonly<{
    approvedRepositories: CollectedRun<BaseState, Collection>["data"]["approvedRepositories"];
    allowlistDigest: CollectedRun<BaseState, Collection>["data"]["allowlistDigest"];
    collection: Omit<Collection, "relationCandidates">;
    sourceCatalog: readonly SourceId[];
    facts: DeterministicFacts<Item>;
  }>;
  proof: StageProofFor<"deterministically_analyzed">;
}>;

function relationFacts(
  candidates: readonly RelationCandidate[],
  sourceCatalog: readonly SourceId[],
): readonly DeterministicRelationFact[] {
  const sourceIds = new Set(sourceCatalog);
  const facts = candidates.map((candidate) => {
    if (candidate.id !== buildRelationCandidateId(candidate.provenance, candidate.relation)) {
      throw new TypeError("関係候補IDが正規関係と一致しません");
    }
    for (const sourceId of candidate.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        throw new TypeError("関係候補のsourceが収集catalogにありません");
      }
    }
    const endpoints = relationNodes(candidate.relation);
    return Object.freeze({
      id: candidateIdSchema.parse(candidate.id),
      candidate,
      endpoints: Object.freeze([endpoints[0].nodeId, endpoints[1].nodeId] satisfies [
        GraphNodeId,
        GraphNodeId,
      ]),
      decisionOwner: relationAssessmentOwnerNodeId(candidate),
      sourceIds: candidate.sourceIds,
      authority: candidate.authority,
      provenance: candidate.provenance,
    });
  });
  if (new Set(facts.map((fact) => fact.id)).size !== facts.length) {
    throw new TypeError("関係候補IDが重複しています");
  }
  return Object.freeze(facts);
}

function orderedNodeIds(nodeIds: Iterable<GitHubNodeId>): readonly GitHubNodeId[] {
  return Object.freeze([...new Set(nodeIds)].sort());
}

/** 収集済み入力から初期判定と関係候補factsを一度だけ確定する。 */
export function analyzeDeterministically<
  BaseState extends PreparedBaseStateShape,
  Collection extends DeterministicCollection,
  Item extends AnalyzedItem,
>(
  collected: CollectedRun<BaseState, Collection>,
  port: DeterministicAnalysisPort<BaseState, Collection, Item>,
): DeterministicallyAnalyzedRun<BaseState, Collection, Item> {
  const items = Object.freeze([...port.analyze(collected)]);
  const analyzedNodeIds = items.map((item) => item.item.nodeId);
  if (
    new Set(analyzedNodeIds).size !== analyzedNodeIds.length ||
    analyzedNodeIds.length !== collected.data.collection.analysisNodeIds.length ||
    analyzedNodeIds.some((nodeId) => !collected.data.collection.analysisNodeIds.includes(nodeId))
  ) {
    throw new TypeError("決定論的分析対象が収集済み分析集合と一致しません");
  }
  const { relationCandidates, ...collection } = collected.data.collection;
  const facts = Object.freeze({
    items,
    relations: relationFacts(relationCandidates, collected.data.sourceCatalog),
    trackedNodeIds: orderedNodeIds(collection.trackedNodeIds),
    terminalNodeIds: orderedNodeIds([
      ...collection.observedItems
        .filter((item) => item.state === "closed")
        .map((item) => item.nodeId),
      ...collection.staleItems
        .filter((item) => item.previousObservation.state === "closed")
        .map((item) => item.nodeId),
    ]),
    staleNodeIds: orderedNodeIds(collection.staleItems.map((item) => item.nodeId)),
    refetchedNodeIds: orderedNodeIds(collection.details.map((detail) => detail.nodeId)),
    analysisNodeIds: orderedNodeIds(collection.analysisNodeIds),
    changedNodeIds: orderedNodeIds(collection.changedNodeIds),
  }) satisfies DeterministicFacts<Item>;
  return Object.freeze({
    stage: "deterministically_analyzed",
    core: collected.core,
    data: Object.freeze({
      approvedRepositories: collected.data.approvedRepositories,
      allowlistDigest: collected.data.allowlistDigest,
      collection,
      sourceCatalog: collected.data.sourceCatalog,
      facts,
    }),
    proof: createDeterministicallyAnalyzedStageProof(),
  });
}
