import { describe, expect, it } from "vitest";

import {
  buildSourceId,
  createExternalReferenceNodeId,
  createGitHubNodeId,
  type GitHubItemUrl,
  type GitHubNodeId,
} from "../src/domain/index.js";
import {
  buildRelationCandidateId,
  planRelationExpansion,
  type CandidateBlocksRelation,
  type CandidateImplementsRelation,
  type CandidateParentRelation,
  type CandidateUnclassifiedRelation,
  type CrossReferenceRelationCandidate,
  type ExternalRelationCandidateNode,
  type NativeRelationCandidate,
  type OrganizationRelationCandidateNode,
  type RelationCandidate,
  type RelationCandidateNode,
} from "../src/graph/index.js";

type CreateNodeOptions = Readonly<{
  nodeId: string;
  repository: string;
  number: number;
}>;

type AdditionalOneHopProvenance = Exclude<
  RelationCandidate["provenance"],
  "native" | "cross_reference"
>;

const ADDITIONAL_ONE_HOP_PROVENANCES: readonly AdditionalOneHopProvenance[] = Object.freeze([
  "explicit_text",
  "closing_keyword",
  "checklist",
]);

type PlanOptions = Readonly<{
  collectedNodes: readonly OrganizationRelationCandidateNode[];
  trackingRootNodeIds: readonly GitHubNodeId[];
  relationCandidates: readonly RelationCandidate[];
  nativeDepths: readonly (readonly [GitHubNodeId, number])[];
  requestedNodeIds: readonly GitHubNodeId[];
  maximumNativeDepth: number;
}>;

function createNode(options: CreateNodeOptions): OrganizationRelationCandidateNode {
  const url =
    `https://github.com/VOICEVOX/${options.repository}/issues/${options.number.toString()}` satisfies GitHubItemUrl;
  return {
    scope: "organization",
    kind: "issue",
    nodeId: createGitHubNodeId(options.nodeId),
    repositoryOwner: "VOICEVOX",
    repositoryName: options.repository,
    number: options.number,
    url,
    state: "open",
  };
}

function createExternalNode(options: CreateNodeOptions): ExternalRelationCandidateNode {
  const githubNodeId = createGitHubNodeId(options.nodeId);
  const url =
    `https://github.com/OUTSIDE/${options.repository}/issues/${options.number.toString()}` satisfies GitHubItemUrl;
  return {
    scope: "external_public",
    kind: "external_reference",
    nodeId: createExternalReferenceNodeId(`external:github:${githubNodeId}`),
    githubNodeId,
    githubItemType: "issue",
    repositoryOwner: "OUTSIDE",
    repositoryName: options.repository,
    number: options.number,
    url,
    state: "open",
  };
}

function createNativeCandidate(
  leftNode: RelationCandidateNode,
  rightNode: RelationCandidateNode,
): NativeRelationCandidate {
  const relation = {
    type: "blocks",
    blocker: leftNode,
    blocked: rightNode,
  } satisfies CandidateBlocksRelation;
  return {
    id: buildRelationCandidateId("native", relation),
    authority: "authoritative",
    provenance: "native",
    relation,
    sourceIds: [
      buildSourceId("github_native_dependency", `${leftNode.nodeId}:${rightNode.nodeId}`),
    ],
  };
}

function createCrossReferenceCandidate(
  referencingNode: RelationCandidateNode,
  referencedNode: RelationCandidateNode,
): CrossReferenceRelationCandidate {
  const relation = {
    type: "unclassified",
    referencing: referencingNode,
    referenced: referencedNode,
  } satisfies CandidateUnclassifiedRelation;
  return {
    id: buildRelationCandidateId("cross_reference", relation),
    authority: "inferred",
    provenance: "cross_reference",
    relation,
    sourceIds: [
      buildSourceId("github_cross_reference", `${referencingNode.nodeId}:${referencedNode.nodeId}`),
    ],
  };
}

function createAdditionalOneHopCandidate(
  provenance: AdditionalOneHopProvenance,
  leftNode: RelationCandidateNode,
  rightNode: RelationCandidateNode,
): RelationCandidate {
  switch (provenance) {
    case "explicit_text": {
      const relation = {
        type: "unclassified",
        referencing: leftNode,
        referenced: rightNode,
      } satisfies CandidateUnclassifiedRelation;
      return {
        id: buildRelationCandidateId(provenance, relation),
        authority: "inferred",
        provenance,
        relation,
        sourceIds: [buildSourceId(provenance, `${leftNode.nodeId}:${rightNode.nodeId}`)],
      };
    }
    case "closing_keyword": {
      const relation = {
        type: "implements",
        implementation: leftNode,
        target: rightNode,
      } satisfies CandidateImplementsRelation;
      return {
        id: buildRelationCandidateId(provenance, relation),
        authority: "inferred",
        provenance,
        relation,
        sourceIds: [buildSourceId(provenance, `${leftNode.nodeId}:${rightNode.nodeId}`)],
      };
    }
    case "checklist": {
      const relation = {
        type: "parent_of",
        parent: leftNode,
        subtask: rightNode,
      } satisfies CandidateParentRelation;
      return {
        id: buildRelationCandidateId(provenance, relation),
        authority: "inferred",
        provenance,
        relation,
        sourceIds: [buildSourceId(provenance, `${leftNode.nodeId}:${rightNode.nodeId}`)],
      };
    }
  }
}

function plan(options: PlanOptions): ReturnType<typeof planRelationExpansion> {
  return planRelationExpansion({
    collectedCandidateNodeIds: new Set(options.collectedNodes.map((node) => node.nodeId)),
    trackingRootNodeIds: new Set(options.trackingRootNodeIds),
    relationCandidates: options.relationCandidates,
    nativeDepthByNodeId: new Map(options.nativeDepths),
    requestedNodeIds: new Set(options.requestedNodeIds),
    maximumNativeDepth: options.maximumNativeDepth,
  });
}

describe("関係先の反復取得計画", () => {
  it("native relationを深度上限まで辿り上限の先を返さない", () => {
    const root = createNode({ nodeId: "I_root", repository: "tracker", number: 1 });
    const depth1 = createNode({ nodeId: "I_depth_1", repository: "tracker", number: 2 });
    const depth2 = createNode({ nodeId: "I_depth_2", repository: "tracker", number: 3 });
    const depth3 = createNode({ nodeId: "I_depth_3", repository: "tracker", number: 4 });
    const depth4 = createNode({ nodeId: "I_depth_4", repository: "tracker", number: 5 });
    const relationCandidates = [
      createNativeCandidate(root, depth1),
      createNativeCandidate(depth1, depth2),
      createNativeCandidate(depth2, depth3),
      createNativeCandidate(depth3, depth4),
    ];

    expect(
      plan({
        collectedNodes: [root],
        trackingRootNodeIds: [root.nodeId],
        relationCandidates,
        nativeDepths: [[root.nodeId, 0]],
        requestedNodeIds: [],
        maximumNativeDepth: 3,
      }),
    ).toEqual([{ nodeId: depth1.nodeId, nativeDepth: 1 }]);
    expect(
      plan({
        collectedNodes: [root, depth1],
        trackingRootNodeIds: [root.nodeId],
        relationCandidates,
        nativeDepths: [
          [root.nodeId, 0],
          [depth1.nodeId, 1],
        ],
        requestedNodeIds: [depth1.nodeId],
        maximumNativeDepth: 3,
      }),
    ).toEqual([{ nodeId: depth2.nodeId, nativeDepth: 2 }]);
    expect(
      plan({
        collectedNodes: [root, depth1, depth2],
        trackingRootNodeIds: [root.nodeId],
        relationCandidates,
        nativeDepths: [
          [root.nodeId, 0],
          [depth1.nodeId, 1],
          [depth2.nodeId, 2],
        ],
        requestedNodeIds: [depth1.nodeId, depth2.nodeId],
        maximumNativeDepth: 3,
      }),
    ).toEqual([{ nodeId: depth3.nodeId, nativeDepth: 3 }]);
    expect(
      plan({
        collectedNodes: [root, depth1, depth2, depth3],
        trackingRootNodeIds: [root.nodeId],
        relationCandidates,
        nativeDepths: [
          [root.nodeId, 0],
          [depth1.nodeId, 1],
          [depth2.nodeId, 2],
          [depth3.nodeId, 3],
        ],
        requestedNodeIds: [depth1.nodeId, depth2.nodeId, depth3.nodeId],
        maximumNativeDepth: 3,
      }),
    ).toEqual([]);
  });

  it("cross-referenceを追跡根から1 hopだけ辿る", () => {
    const root = createNode({ nodeId: "I_root", repository: "tracker", number: 1 });
    const firstHop = createNode({ nodeId: "I_first", repository: "tracker", number: 2 });
    const secondHop = createNode({ nodeId: "I_second", repository: "tracker", number: 3 });
    const relationCandidates = [
      createCrossReferenceCandidate(root, firstHop),
      createCrossReferenceCandidate(firstHop, secondHop),
    ];

    expect(
      plan({
        collectedNodes: [root],
        trackingRootNodeIds: [root.nodeId],
        relationCandidates,
        nativeDepths: [[root.nodeId, 0]],
        requestedNodeIds: [],
        maximumNativeDepth: 3,
      }),
    ).toEqual([{ nodeId: firstHop.nodeId, nativeDepth: 0 }]);
    expect(
      plan({
        collectedNodes: [root, firstHop],
        trackingRootNodeIds: [root.nodeId],
        relationCandidates,
        nativeDepths: [
          [root.nodeId, 0],
          [firstHop.nodeId, 0],
        ],
        requestedNodeIds: [firstHop.nodeId],
        maximumNativeDepth: 3,
      }),
    ).toEqual([]);
  });

  it.each(ADDITIONAL_ONE_HOP_PROVENANCES)("%sを追跡根から1 hop展開する", (provenance) => {
    const root = createNode({ nodeId: "I_root", repository: "tracker", number: 1 });
    const target = createNode({ nodeId: "I_target", repository: "tracker", number: 2 });

    expect(
      plan({
        collectedNodes: [root],
        trackingRootNodeIds: [root.nodeId],
        relationCandidates: [createAdditionalOneHopCandidate(provenance, root, target)],
        nativeDepths: [[root.nodeId, 0]],
        requestedNodeIds: [],
        maximumNativeDepth: 3,
      }),
    ).toEqual([{ nodeId: target.nodeId, nativeDepth: 0 }]);
  });

  it.each(ADDITIONAL_ONE_HOP_PROVENANCES)("%sを追跡根でないnodeから展開しない", (provenance) => {
    const root = createNode({ nodeId: "I_root", repository: "tracker", number: 1 });
    const nonRoot = createNode({ nodeId: "I_non_root", repository: "tracker", number: 2 });
    const target = createNode({ nodeId: "I_target", repository: "tracker", number: 3 });

    expect(
      plan({
        collectedNodes: [root, nonRoot],
        trackingRootNodeIds: [root.nodeId],
        relationCandidates: [createAdditionalOneHopCandidate(provenance, nonRoot, target)],
        nativeDepths: [
          [root.nodeId, 0],
          [nonRoot.nodeId, 0],
        ],
        requestedNodeIds: [],
        maximumNativeDepth: 3,
      }),
    ).toEqual([]);
  });

  it("循環と複数edgeがあってもnodeを1件にまとめ最短native深度を採用する", () => {
    const root = createNode({ nodeId: "I_root", repository: "tracker", number: 1 });
    const branch = createNode({ nodeId: "I_branch", repository: "tracker", number: 2 });
    const target = createNode({ nodeId: "I_target", repository: "tracker", number: 3 });

    expect(
      plan({
        collectedNodes: [root, branch],
        trackingRootNodeIds: [root.nodeId],
        relationCandidates: [
          createNativeCandidate(branch, target),
          createNativeCandidate(root, branch),
          createNativeCandidate(branch, root),
          createNativeCandidate(target, root),
          createNativeCandidate(root, target),
        ],
        nativeDepths: [
          [root.nodeId, 0],
          [branch.nodeId, 2],
        ],
        requestedNodeIds: [],
        maximumNativeDepth: 3,
      }),
    ).toEqual([{ nodeId: target.nodeId, nativeDepth: 1 }]);
  });

  it("取得済みと要求済みのnodeを返さない", () => {
    const root = createNode({ nodeId: "I_root", repository: "tracker", number: 1 });
    const collected = createNode({ nodeId: "I_collected", repository: "tracker", number: 2 });
    const requested = createNode({ nodeId: "I_requested", repository: "tracker", number: 3 });
    const pending = createNode({ nodeId: "I_pending", repository: "tracker", number: 4 });

    expect(
      plan({
        collectedNodes: [root, collected],
        trackingRootNodeIds: [root.nodeId],
        relationCandidates: [
          createNativeCandidate(root, collected),
          createNativeCandidate(root, requested),
          createNativeCandidate(root, pending),
        ],
        nativeDepths: [[root.nodeId, 0]],
        requestedNodeIds: [requested.nodeId],
        maximumNativeDepth: 3,
      }),
    ).toEqual([{ nodeId: pending.nodeId, nativeDepth: 1 }]);
  });

  it("Organization外のnodeを返さない", () => {
    const root = createNode({ nodeId: "I_root", repository: "tracker", number: 1 });
    const external = createExternalNode({
      nodeId: "I_external",
      repository: "outside",
      number: 2,
    });

    expect(
      plan({
        collectedNodes: [root],
        trackingRootNodeIds: [root.nodeId],
        relationCandidates: [
          createNativeCandidate(root, external),
          createCrossReferenceCandidate(external, root),
        ],
        nativeDepths: [[root.nodeId, 0]],
        requestedNodeIds: [],
        maximumNativeDepth: 3,
      }),
    ).toEqual([]);
  });

  it("repository full name、番号、node IDの順で決定論的に並べる", () => {
    const root = createNode({ nodeId: "I_root", repository: "root", number: 1 });
    const repositoryAFirst = createNode({ nodeId: "I_z", repository: "a", number: 1 });
    const repositoryASecondA = createNode({ nodeId: "I_a", repository: "a", number: 2 });
    const repositoryASecondB = createNode({ nodeId: "I_b", repository: "a", number: 2 });
    const repositoryBFirst = createNode({ nodeId: "I_0", repository: "b", number: 1 });
    const relationCandidates = [
      createNativeCandidate(root, repositoryBFirst),
      createNativeCandidate(root, repositoryASecondB),
      createNativeCandidate(root, repositoryAFirst),
      createNativeCandidate(root, repositoryASecondA),
    ];
    const expected = [
      { nodeId: repositoryAFirst.nodeId, nativeDepth: 1 },
      { nodeId: repositoryASecondA.nodeId, nativeDepth: 1 },
      { nodeId: repositoryASecondB.nodeId, nativeDepth: 1 },
      { nodeId: repositoryBFirst.nodeId, nativeDepth: 1 },
    ];
    const commonOptions = {
      collectedNodes: [root],
      trackingRootNodeIds: [root.nodeId],
      nativeDepths: [[root.nodeId, 0]],
      requestedNodeIds: [],
      maximumNativeDepth: 3,
    } satisfies Omit<PlanOptions, "relationCandidates">;

    expect(plan({ ...commonOptions, relationCandidates })).toEqual(expected);
    expect(plan({ ...commonOptions, relationCandidates: relationCandidates.toReversed() })).toEqual(
      expected,
    );
  });
});
