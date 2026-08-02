import { type GitHubNodeId } from "../domain/index.js";
import { UnreachableError } from "../util/index.js";
import {
  type CandidateRelation,
  type RelationCandidate,
  type RelationCandidateNode,
} from "./relation-candidate-types.js";

type RelationExpansionPlanInput = Readonly<{
  collectedCandidateNodeIds: ReadonlySet<GitHubNodeId>;
  trackingRootNodeIds: ReadonlySet<GitHubNodeId>;
  relationCandidates: readonly RelationCandidate[];
  nativeDepthByNodeId: ReadonlyMap<GitHubNodeId, number>;
  requestedNodeIds: ReadonlySet<GitHubNodeId>;
  maximumNativeDepth: number;
}>;

type RelationExpansionRequest = Readonly<{
  nodeId: GitHubNodeId;
  nativeDepth: number;
}>;

type RelationExpansionDraft = RelationExpansionRequest &
  Readonly<{
    repositoryFullName: string;
    number: number;
  }>;

function relationNodes(
  relation: CandidateRelation,
): readonly [RelationCandidateNode, RelationCandidateNode] {
  switch (relation.type) {
    case "blocks":
      return Object.freeze([relation.blocker, relation.blocked]);
    case "parent_of":
      return Object.freeze([relation.parent, relation.subtask]);
    case "implements":
      return Object.freeze([relation.implementation, relation.target]);
    case "unclassified":
      return Object.freeze([relation.referencing, relation.referenced]);
  }
}

function validateInput(input: RelationExpansionPlanInput): void {
  if (!Number.isSafeInteger(input.maximumNativeDepth) || input.maximumNativeDepth < 0) {
    throw new RangeError("native relationの追跡深度上限は0以上の安全な整数にしてください");
  }
  for (const depth of input.nativeDepthByNodeId.values()) {
    if (!Number.isSafeInteger(depth) || depth < 0) {
      throw new RangeError("nodeごとのnative深度は0以上の安全な整数にしてください");
    }
  }
}

function currentNativeDepth(
  input: RelationExpansionPlanInput,
  node: RelationCandidateNode,
): number | undefined {
  if (node.scope !== "organization" || !input.collectedCandidateNodeIds.has(node.nodeId)) {
    return undefined;
  }
  if (input.trackingRootNodeIds.has(node.nodeId)) {
    return 0;
  }
  return input.nativeDepthByNodeId.get(node.nodeId);
}

function addRequest(
  input: RelationExpansionPlanInput,
  requestsByNodeId: Map<GitHubNodeId, RelationExpansionDraft>,
  node: RelationCandidateNode,
  nativeDepth: number,
): void {
  if (
    node.scope !== "organization" ||
    input.collectedCandidateNodeIds.has(node.nodeId) ||
    input.requestedNodeIds.has(node.nodeId)
  ) {
    return;
  }
  const repositoryFullName = `${node.repositoryOwner}/${node.repositoryName}`;
  const existing = requestsByNodeId.get(node.nodeId);
  if (existing == null) {
    requestsByNodeId.set(
      node.nodeId,
      Object.freeze({
        nodeId: node.nodeId,
        nativeDepth,
        repositoryFullName,
        number: node.number,
      }),
    );
    return;
  }
  if (existing.repositoryFullName !== repositoryFullName || existing.number !== node.number) {
    throw new TypeError("同じGitHub node IDに異なるrepositoryまたは番号が指定されています");
  }
  if (nativeDepth < existing.nativeDepth) {
    requestsByNodeId.set(
      node.nodeId,
      Object.freeze({
        nodeId: existing.nodeId,
        nativeDepth,
        repositoryFullName: existing.repositoryFullName,
        number: existing.number,
      }),
    );
  }
}

function addNativeNeighborRequest(
  input: RelationExpansionPlanInput,
  requestsByNodeId: Map<GitHubNodeId, RelationExpansionDraft>,
  currentNode: RelationCandidateNode,
  neighborNode: RelationCandidateNode,
): void {
  const depth = currentNativeDepth(input, currentNode);
  if (depth == null || depth >= input.maximumNativeDepth) {
    return;
  }
  addRequest(input, requestsByNodeId, neighborNode, depth + 1);
}

function addNativeRequests(
  input: RelationExpansionPlanInput,
  requestsByNodeId: Map<GitHubNodeId, RelationExpansionDraft>,
  relation: CandidateRelation,
): void {
  const [leftNode, rightNode] = relationNodes(relation);
  addNativeNeighborRequest(input, requestsByNodeId, leftNode, rightNode);
  addNativeNeighborRequest(input, requestsByNodeId, rightNode, leftNode);
}

function isCollectedTrackingRoot(
  input: RelationExpansionPlanInput,
  node: RelationCandidateNode,
): boolean {
  return (
    node.scope === "organization" &&
    input.collectedCandidateNodeIds.has(node.nodeId) &&
    input.trackingRootNodeIds.has(node.nodeId)
  );
}

function addOneHopReferenceRequests(
  input: RelationExpansionPlanInput,
  requestsByNodeId: Map<GitHubNodeId, RelationExpansionDraft>,
  relation: CandidateRelation,
): void {
  const [leftNode, rightNode] = relationNodes(relation);
  if (isCollectedTrackingRoot(input, leftNode)) {
    addRequest(input, requestsByNodeId, rightNode, 0);
  }
  if (isCollectedTrackingRoot(input, rightNode)) {
    addRequest(input, requestsByNodeId, leftNode, 0);
  }
}

function compareRequests(left: RelationExpansionDraft, right: RelationExpansionDraft): -1 | 0 | 1 {
  if (left.repositoryFullName !== right.repositoryFullName) {
    return left.repositoryFullName < right.repositoryFullName ? -1 : 1;
  }
  if (left.number !== right.number) {
    return left.number < right.number ? -1 : 1;
  }
  if (left.nodeId !== right.nodeId) {
    return left.nodeId < right.nodeId ? -1 : 1;
  }
  return 0;
}

/** 取得済み候補と関係候補から次に個別列挙するOrganization内項目を計画する。 */
export function planRelationExpansion(
  input: RelationExpansionPlanInput,
): readonly RelationExpansionRequest[] {
  validateInput(input);
  const requestsByNodeId = new Map<GitHubNodeId, RelationExpansionDraft>();
  for (const candidate of input.relationCandidates) {
    switch (candidate.provenance) {
      case "native":
        addNativeRequests(input, requestsByNodeId, candidate.relation);
        break;
      case "explicit_text":
      case "closing_keyword":
      case "checklist":
      case "cross_reference":
        addOneHopReferenceRequests(input, requestsByNodeId, candidate.relation);
        break;
      default:
        throw new UnreachableError(candidate);
    }
  }
  const requests = [...requestsByNodeId.values()].sort(compareRequests).map((request) =>
    Object.freeze({
      nodeId: request.nodeId,
      nativeDepth: request.nativeDepth,
    }),
  );
  return Object.freeze(requests);
}
