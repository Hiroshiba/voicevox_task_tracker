import {
  type PublicDetailsDto,
  type PublicGraphEdgeDto,
  type PublicGraphNodeDto,
  type PublicItemSummaryDto,
  type PublicSummaryDto,
} from "../../src/pages/public-dto.js";
import { assertNonNullable, UnreachableError } from "../../src/util/index.js";
import { severityLabel, statusLabel } from "./model.js";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const BASE_GRAPH_NODE_SIZE = 72;

/** グラフnodeの表示サイズ上限。 */
export const MAX_GRAPH_NODE_SIZE = 132;

type GraphNodeKind = PublicGraphNodeDto["kind"] | "dependency_cycle";
type GraphNodeSeverity = PublicItemSummaryDto["severity"] | "cycle";
type RelationType = PublicGraphEdgeDto["type"];
type RelationProvenance = PublicGraphEdgeDto["provenance"];

/** グラフnodeから遷移できるGitHubリンク。 */
export type GraphNodeLink =
  | Readonly<{
      status: "available";
      url: string;
    }>
  | Readonly<{
      status: "unavailable";
    }>;

/** グラフと代替表で共有するnode表現。 */
export type GraphViewNode = Readonly<{
  id: string;
  sourceNodeIds: readonly string[];
  kind: GraphNodeKind;
  reference: string;
  title: string;
  repositoryText: string;
  statusText: string;
  stateText: string;
  severity: GraphNodeSeverity;
  frontier: boolean;
  cycleIds: readonly string[];
  collapsedCycle: boolean;
  stallDays: number;
  impactOpenNodeCount: number;
  impactRepositoryCount: number;
  size: number;
  width: number;
  height: number;
  link: GraphNodeLink;
}>;

/** 自動レイアウトへ渡すedge表現。 */
export type GraphViewEdge = Readonly<{
  id: string;
  fromNodeId: string;
  toNodeId: string;
  type: RelationType;
  typeLabel: string;
  provenance: RelationProvenance;
  provenanceLabel: string;
  authorityLabel: "確定関係" | "推定関係";
  authoritative: boolean;
  evidence: PublicGraphEdgeDto["evidence"];
}>;

/** cycleの折り畳み状態と構成node。 */
export type GraphViewCycle = Readonly<{
  id: string;
  expanded: boolean;
  visible: boolean;
  memberNodes: readonly GraphViewNode[];
  edgeIds: readonly string[];
}>;

/** 選択したclusterの描画用データと表形式データ。 */
export type GraphClusterView = Readonly<{
  clusterKind: "component" | "repository";
  clusterId: string;
  displayNodes: readonly GraphViewNode[];
  displayEdges: readonly GraphViewEdge[];
  sourceNodes: readonly GraphViewNode[];
  sourceEdges: readonly GraphViewEdge[];
  cycles: readonly GraphViewCycle[];
  renderedNodeCount: number;
  representedSourceNodeCount: number;
  omittedSourceNodeCount: number;
  maxInitialNodes: number;
}>;

/** component一覧へ表示する集計値。 */
export type GraphComponentListItem = Readonly<{
  id: string;
  ordinal: number;
  repositoryText: string;
  nodeCount: number;
  edgeCount: number;
  frontierCount: number;
  cycleCount: number;
}>;

/** repository cluster一覧へ表示する集計値。 */
export type GraphRepositoryListItem = Readonly<{
  id: string;
  ordinal: number;
  repositoryText: string;
  nodeCount: number;
  edgeCount: number;
  frontierCount: number;
  cycleCount: number;
}>;

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function finiteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name}は0以上の有限数にしてください`);
  }
}

/** 停滞日数と影響範囲から単調増加かつ上限付きのnodeサイズを返す。 */
export function calculateGraphNodeSize(
  stallDays: number,
  impactOpenNodeCount: number,
  impactRepositoryCount: number,
): number {
  finiteNonNegative(stallDays, "停滞日数");
  finiteNonNegative(impactOpenNodeCount, "影響項目数");
  finiteNonNegative(impactRepositoryCount, "影響リポジトリ数");
  const stallContribution = Math.log2(stallDays + 1) * 8;
  const itemImpactContribution = Math.log2(impactOpenNodeCount + 1) * 5;
  const repositoryImpactContribution = Math.log2(impactRepositoryCount + 1) * 4;
  return Math.min(
    MAX_GRAPH_NODE_SIZE,
    BASE_GRAPH_NODE_SIZE +
      stallContribution +
      itemImpactContribution +
      repositoryImpactContribution,
  );
}

/** graph node種別の色に依存しない表示名を返す。 */
export function graphNodeKindLabel(kind: GraphNodeKind): string {
  switch (kind) {
    case "issue":
      return "Issue";
    case "pull_request":
      return "Pull Request";
    case "external_reference":
      return "外部参照";
    case "dependency_cycle":
      return "依存cycle";
    default:
      throw new UnreachableError(kind);
  }
}

/** edge種別の表示名を返す。 */
export function relationTypeLabel(type: RelationType): string {
  switch (type) {
    case "blocks":
      return "blocks";
    case "parent_of":
      return "parent_of";
    case "implements":
      return "implements";
    case "related_to":
      return "related_to";
    case "duplicates":
      return "duplicates";
    default:
      throw new UnreachableError(type);
  }
}

/** edge provenanceの表示名を返す。 */
export function relationProvenanceLabel(provenance: RelationProvenance): string {
  switch (provenance) {
    case "native":
      return "GitHub native";
    case "explicit_text":
      return "明示テキスト";
    case "closing_keyword":
      return "close keyword";
    case "checklist":
      return "checklist";
    case "cross_reference":
      return "相互参照";
    case "ai_inference":
      return "AI推定";
    default:
      throw new UnreachableError(provenance);
  }
}

function stateLabel(state: PublicGraphNodeDto["state"]): string {
  switch (state) {
    case "open":
      return "open";
    case "closed":
      return "closed";
    case "merged":
      return "merged";
    default:
      throw new UnreachableError(state);
  }
}

function severityRank(severity: GraphNodeSeverity): number {
  switch (severity) {
    case "none":
      return 0;
    case "watch":
      return 1;
    case "urgent":
      return 2;
    case "critical":
      return 3;
    case "cycle":
      return 4;
    default:
      throw new UnreachableError(severity);
  }
}

function createTrackedGraphNode(
  node: Extract<PublicGraphNodeDto, Readonly<{ kind: "issue" | "pull_request" }>>,
  item: PublicItemSummaryDto,
  repositoryText: string,
  frontierNodeIds: ReadonlySet<string>,
  cycleIds: readonly string[],
  now: Date,
): GraphViewNode {
  if (node.kind !== item.type) {
    throw new TypeError(`graph node ${node.nodeId}の種別がsummaryと一致しません`);
  }
  if (node.repositoryId !== item.repositoryId) {
    throw new TypeError(`graph node ${node.nodeId}のrepositoryがsummaryと一致しません`);
  }
  const stallDays = (now.getTime() - Date.parse(item.stallSince)) / MILLISECONDS_PER_DAY;
  finiteNonNegative(stallDays, `graph node ${node.nodeId}の停滞日数`);
  const size = calculateGraphNodeSize(
    stallDays,
    item.downstreamImpact.openNodeCount,
    item.downstreamImpact.repositoryCount,
  );
  return {
    id: node.nodeId,
    sourceNodeIds: [node.nodeId],
    kind: node.kind,
    reference: item.displayReference,
    title: item.title,
    repositoryText,
    statusText: statusLabel(item.status),
    stateText: stateLabel(node.state),
    severity: item.severity,
    frontier: frontierNodeIds.has(node.nodeId),
    cycleIds,
    collapsedCycle: false,
    stallDays,
    impactOpenNodeCount: item.downstreamImpact.openNodeCount,
    impactRepositoryCount: item.downstreamImpact.repositoryCount,
    size,
    width: size * 2.15,
    height: size,
    link: {
      status: "available",
      url: item.url,
    },
  };
}

function createExternalGraphNode(
  node: Extract<PublicGraphNodeDto, Readonly<{ kind: "external_reference" }>>,
  frontierNodeIds: ReadonlySet<string>,
  cycleIds: readonly string[],
): GraphViewNode {
  const size = calculateGraphNodeSize(0, 0, 0);
  return {
    id: node.nodeId,
    sourceNodeIds: [node.nodeId],
    kind: node.kind,
    reference: node.displayReference,
    title: node.title,
    repositoryText: node.repositoryFullName,
    statusText: "外部参照",
    stateText: stateLabel(node.state),
    severity: "none",
    frontier: frontierNodeIds.has(node.nodeId),
    cycleIds,
    collapsedCycle: false,
    stallDays: 0,
    impactOpenNodeCount: 0,
    impactRepositoryCount: 0,
    size,
    width: size * 1.55,
    height: size * 1.15,
    link: {
      status: "available",
      url: node.url,
    },
  };
}

function createCollapsedCycleNode(
  cycleId: string,
  memberNodes: readonly GraphViewNode[],
): GraphViewNode {
  const firstMember = memberNodes[0];
  assertNonNullable(firstMember, `cycle ${cycleId}に構成nodeがありません`);
  const repositoryText = [...new Set(memberNodes.map((node) => node.repositoryText))]
    .sort(compareStrings)
    .join("、");
  const size = Math.min(MAX_GRAPH_NODE_SIZE, Math.max(...memberNodes.map((node) => node.size)) + 8);
  return {
    id: `cycle:${cycleId}`,
    sourceNodeIds: memberNodes.map((node) => node.id),
    kind: "dependency_cycle",
    reference: "dependency cycle",
    title: `${memberNodes.length.toString()}件のblocks循環`,
    repositoryText,
    statusText: "循環依存",
    stateText: memberNodes.some((node) => node.stateText === "open") ? "open" : "closed",
    severity: "cycle",
    frontier: memberNodes.some((node) => node.frontier),
    cycleIds: [cycleId],
    collapsedCycle: true,
    stallDays: Math.max(...memberNodes.map((node) => node.stallDays)),
    impactOpenNodeCount: Math.max(...memberNodes.map((node) => node.impactOpenNodeCount)),
    impactRepositoryCount: Math.max(...memberNodes.map((node) => node.impactRepositoryCount)),
    size,
    width: size * 2.15,
    height: size,
    link: {
      status: "unavailable",
    },
  };
}

function createEdgeView(
  edge: PublicGraphEdgeDto,
  fromNodeId: string,
  toNodeId: string,
): GraphViewEdge {
  const authoritative = edge.provenance === "native";
  return {
    id: edge.id,
    fromNodeId,
    toNodeId,
    type: edge.type,
    typeLabel: relationTypeLabel(edge.type),
    provenance: edge.provenance,
    provenanceLabel: relationProvenanceLabel(edge.provenance),
    authorityLabel: authoritative ? "確定関係" : "推定関係",
    authoritative,
    evidence: edge.evidence,
  };
}

function compareNodePriority(left: GraphViewNode, right: GraphViewNode): number {
  const cycleOrder = Number(right.collapsedCycle) - Number(left.collapsedCycle);
  if (cycleOrder !== 0) {
    return cycleOrder;
  }
  const frontierOrder = Number(right.frontier) - Number(left.frontier);
  if (frontierOrder !== 0) {
    return frontierOrder;
  }
  const severityOrder = severityRank(right.severity) - severityRank(left.severity);
  if (severityOrder !== 0) {
    return severityOrder;
  }
  const repositoryImpactOrder = right.impactRepositoryCount - left.impactRepositoryCount;
  if (repositoryImpactOrder !== 0) {
    return repositoryImpactOrder;
  }
  const itemImpactOrder = right.impactOpenNodeCount - left.impactOpenNodeCount;
  if (itemImpactOrder !== 0) {
    return itemImpactOrder;
  }
  const stallOrder = right.stallDays - left.stallDays;
  if (stallOrder !== 0) {
    return stallOrder;
  }
  return compareStrings(left.id, right.id);
}

function compareComponents(
  left: PublicSummaryDto["graph"]["components"][number],
  right: PublicSummaryDto["graph"]["components"][number],
): number {
  const repositoryOrder = right.repositoryIds.length - left.repositoryIds.length;
  if (repositoryOrder !== 0) {
    return repositoryOrder;
  }
  const cycleOrder = right.cycleCount - left.cycleCount;
  if (cycleOrder !== 0) {
    return cycleOrder;
  }
  const nodeOrder = right.nodeCount - left.nodeCount;
  if (nodeOrder !== 0) {
    return nodeOrder;
  }
  return compareStrings(left.id, right.id);
}

/** summaryの軽量索引から初期表示用component一覧を作る。 */
export function createGraphComponentList(
  summary: PublicSummaryDto,
): readonly GraphComponentListItem[] {
  const repositoriesById = new Map(
    summary.repositories.map((repository) => [repository.id, repository]),
  );
  return [...summary.graph.components].sort(compareComponents).map((component, index) => ({
    id: component.id,
    ordinal: index + 1,
    repositoryText: component.repositoryIds
      .map((repositoryId) => {
        const repository = repositoriesById.get(repositoryId);
        assertNonNullable(
          repository,
          `component ${component.id}のrepository ${repositoryId}がありません`,
        );
        return repository.fullName;
      })
      .join("、"),
    nodeCount: component.nodeCount,
    edgeCount: component.edgeCount,
    frontierCount: component.frontierCount,
    cycleCount: component.cycleCount,
  }));
}

/** summaryの軽量索引から初期表示用repository cluster一覧を作る。 */
export function createGraphRepositoryList(
  summary: PublicSummaryDto,
): readonly GraphRepositoryListItem[] {
  if (!summary.graph.clusterByRepository) {
    if (summary.graph.repositoryClusters.length !== 0) {
      throw new TypeError("repository cluster無効時にcluster索引を公開できません");
    }
    return [];
  }
  const repositoriesById = new Map(
    summary.repositories.map((repository) => [repository.id, repository]),
  );
  return summary.graph.repositoryClusters
    .map((cluster) => {
      const repository = repositoriesById.get(cluster.repositoryId);
      assertNonNullable(
        repository,
        `repository cluster ${cluster.repositoryId}のrepositoryがありません`,
      );
      if (cluster.nodeCount !== repository.itemCount) {
        throw new TypeError(
          `repository cluster ${cluster.repositoryId}のnode数がrepository集計と一致しません`,
        );
      }
      return {
        id: cluster.repositoryId,
        repositoryText: repository.fullName,
        nodeCount: cluster.nodeCount,
        edgeCount: cluster.edgeCount,
        frontierCount: cluster.frontierCount,
        cycleCount: cluster.cycleCount,
      };
    })
    .sort((left, right) => compareStrings(left.repositoryText, right.repositoryText))
    .map((cluster, index) => ({
      ...cluster,
      ordinal: index + 1,
    }));
}

/** summaryと遅延取得したdetailsが同じ生成runか検証する。 */
export function assertPublicDetailsMatchSummary(
  summary: PublicSummaryDto,
  details: PublicDetailsDto,
): void {
  if (summary.runId !== details.runId || summary.generatedAt !== details.generatedAt) {
    throw new TypeError("summaryとdetailsの生成runが一致しません");
  }
}

function createUniqueMap<Value extends Readonly<{ id: string }>>(
  values: readonly Value[],
  name: string,
): ReadonlyMap<string, Value> {
  const result = new Map<string, Value>();
  for (const value of values) {
    if (result.has(value.id)) {
      throw new TypeError(`${name}のID ${value.id}が重複しています`);
    }
    result.set(value.id, value);
  }
  return result;
}

function cycleIdsByNodeId(
  cycles: readonly PublicDetailsDto["graph"]["cycles"][number][],
): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, string[]>();
  for (const cycle of cycles) {
    for (const nodeId of cycle.nodeIds) {
      const existing = result.get(nodeId);
      if (existing != null) {
        throw new TypeError(`graph node ${nodeId}が複数のdependency cycleに含まれています`);
      }
      result.set(nodeId, [cycle.id]);
    }
  }
  return result;
}

function clusterCycles(
  clusterNodeIds: ReadonlySet<string>,
  cycles: readonly PublicDetailsDto["graph"]["cycles"][number][],
  clusterKind: GraphClusterView["clusterKind"],
): readonly PublicDetailsDto["graph"]["cycles"][number][] {
  return cycles.filter((cycle) => {
    const includedCount = cycle.nodeIds.filter((nodeId) => clusterNodeIds.has(nodeId)).length;
    if (
      clusterKind === "component" &&
      includedCount !== 0 &&
      includedCount !== cycle.nodeIds.length
    ) {
      throw new TypeError(`dependency cycle ${cycle.id}がcomponent境界をまたいでいます`);
    }
    return includedCount === cycle.nodeIds.length;
  });
}

function createSourceNodes(
  summary: PublicSummaryDto,
  details: PublicDetailsDto,
  clusterNodeIds: readonly string[],
  cycles: readonly PublicDetailsDto["graph"]["cycles"][number][],
  now: Date,
): readonly GraphViewNode[] {
  const graphNodesById = new Map(details.graph.nodes.map((node) => [node.nodeId, node]));
  const itemsByNodeId = new Map(summary.items.map((item) => [item.nodeId, item]));
  const repositoriesById = new Map(
    summary.repositories.map((repository) => [repository.id, repository]),
  );
  const frontierNodeIds = new Set(details.graph.frontierNodeIds);
  const nodeCycleIds = cycleIdsByNodeId(cycles);

  return clusterNodeIds.map((nodeId) => {
    const node = graphNodesById.get(nodeId);
    assertNonNullable(node, `clusterのgraph node ${nodeId}がありません`);
    const cycleIds = nodeCycleIds.get(nodeId) ?? Object.freeze([]);
    if (node.kind === "external_reference") {
      return createExternalGraphNode(node, frontierNodeIds, cycleIds);
    }
    const item = itemsByNodeId.get(node.nodeId);
    assertNonNullable(item, `graph node ${node.nodeId}のsummary itemがありません`);
    const repository = repositoriesById.get(node.repositoryId);
    assertNonNullable(
      repository,
      `graph node ${node.nodeId}のrepository ${node.repositoryId}がありません`,
    );
    return createTrackedGraphNode(node, item, repository.fullName, frontierNodeIds, cycleIds, now);
  });
}

function selectDisplayNodes(
  sourceNodes: readonly GraphViewNode[],
  cycles: readonly PublicDetailsDto["graph"]["cycles"][number][],
  expandedCycleIds: ReadonlySet<string>,
  maxInitialNodes: number,
): readonly GraphViewNode[] {
  const sourceNodesById = new Map(sourceNodes.map((node) => [node.id, node]));
  const cycleMemberIds = new Set(cycles.flatMap((cycle) => cycle.nodeIds));
  const candidates: GraphViewNode[] = sourceNodes.filter((node) => !cycleMemberIds.has(node.id));
  const requiredExpandedNodes: GraphViewNode[] = [];

  for (const cycle of cycles) {
    const memberNodes = cycle.nodeIds.map((nodeId) => {
      const node = sourceNodesById.get(nodeId);
      assertNonNullable(node, `cycle ${cycle.id}の構成node ${nodeId}がありません`);
      return node;
    });
    if (expandedCycleIds.has(cycle.id)) {
      requiredExpandedNodes.push(...memberNodes);
    } else {
      candidates.push(createCollapsedCycleNode(cycle.id, memberNodes));
    }
  }

  requiredExpandedNodes.sort(compareNodePriority);
  candidates.sort(compareNodePriority);
  const requiredIds = new Set(requiredExpandedNodes.map((node) => node.id));
  const nonRequiredCandidates = candidates.filter((node) => !requiredIds.has(node.id));
  const remainingCapacity = Math.max(0, maxInitialNodes - requiredExpandedNodes.length);
  return [...requiredExpandedNodes, ...nonRequiredCandidates.slice(0, remainingCapacity)].sort(
    (left, right) => compareStrings(left.id, right.id),
  );
}

function validateMaxInitialNodes(value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError("maxInitialNodesは正の整数にしてください");
  }
}

type GraphClusterDefinition = Readonly<{
  kind: GraphClusterView["clusterKind"];
  id: string;
  nodeIds: readonly string[];
  edgeIds: readonly string[];
}>;

function createGraphClusterView(
  summary: PublicSummaryDto,
  details: PublicDetailsDto,
  cluster: GraphClusterDefinition,
  expandedCycleIds: ReadonlySet<string>,
  now: Date,
): GraphClusterView {
  const clusterNodeIds = new Set(cluster.nodeIds);
  const cycles = clusterCycles(clusterNodeIds, details.graph.cycles, cluster.kind);
  const sourceNodes = createSourceNodes(summary, details, cluster.nodeIds, cycles, now);
  const displayNodes = selectDisplayNodes(
    sourceNodes,
    cycles,
    expandedCycleIds,
    summary.graph.maxNodes,
  );
  const displayNodeIdBySourceNodeId = new Map<string, string>();
  for (const node of displayNodes) {
    for (const sourceNodeId of node.sourceNodeIds) {
      if (displayNodeIdBySourceNodeId.has(sourceNodeId)) {
        throw new TypeError(`source node ${sourceNodeId}の描画先が重複しています`);
      }
      displayNodeIdBySourceNodeId.set(sourceNodeId, node.id);
    }
  }
  const representedSourceNodeIds = new Set(displayNodeIdBySourceNodeId.keys());
  const graphEdgesById = createUniqueMap(details.graph.edges, "graph edge");
  const activeClusterEdges = cluster.edgeIds.map((edgeId) => {
    const edge = graphEdgesById.get(edgeId);
    assertNonNullable(edge, `cluster ${cluster.id}のedge ${edgeId}がありません`);
    if (!edge.active) {
      throw new TypeError(`cluster ${cluster.id}が非active edge ${edgeId}を参照しています`);
    }
    if (!clusterNodeIds.has(edge.fromNodeId) || !clusterNodeIds.has(edge.toNodeId)) {
      throw new TypeError(`cluster ${cluster.id}のedge ${edgeId}が境界外を参照しています`);
    }
    return edge;
  });
  const sourceEdges = activeClusterEdges
    .filter(
      (edge) =>
        representedSourceNodeIds.has(edge.fromNodeId) &&
        representedSourceNodeIds.has(edge.toNodeId),
    )
    .map((edge) => createEdgeView(edge, edge.fromNodeId, edge.toNodeId));
  const displayEdges = activeClusterEdges.flatMap((edge) => {
    const fromNodeId = displayNodeIdBySourceNodeId.get(edge.fromNodeId);
    const toNodeId = displayNodeIdBySourceNodeId.get(edge.toNodeId);
    if (fromNodeId == null || toNodeId == null || fromNodeId === toNodeId) {
      return [];
    }
    return [createEdgeView(edge, fromNodeId, toNodeId)];
  });
  const sourceNodesById = new Map(sourceNodes.map((node) => [node.id, node]));
  const graphCycles = cycles.map((cycle) => ({
    id: cycle.id,
    expanded: expandedCycleIds.has(cycle.id),
    visible: cycle.nodeIds.some((nodeId) => representedSourceNodeIds.has(nodeId)),
    memberNodes: cycle.nodeIds.map((nodeId) => {
      const node = sourceNodesById.get(nodeId);
      assertNonNullable(node, `cycle ${cycle.id}の表示node ${nodeId}がありません`);
      return node;
    }),
    edgeIds: [...cycle.edgeIds],
  }));

  return {
    clusterKind: cluster.kind,
    clusterId: cluster.id,
    displayNodes,
    displayEdges,
    sourceNodes: sourceNodes
      .filter((node) => representedSourceNodeIds.has(node.id))
      .sort((left, right) => compareStrings(left.id, right.id)),
    sourceEdges,
    cycles: graphCycles,
    renderedNodeCount: displayNodes.length,
    representedSourceNodeCount: representedSourceNodeIds.size,
    omittedSourceNodeCount: cluster.nodeIds.length - representedSourceNodeIds.size,
    maxInitialNodes: summary.graph.maxNodes,
  };
}

/** 選択componentをcycle縮約と設定上限を適用した描画モデルへ変換する。 */
export function createComponentGraphView(
  summary: PublicSummaryDto,
  details: PublicDetailsDto,
  componentId: string,
  expandedCycleIds: ReadonlySet<string>,
  now: Date,
): GraphClusterView {
  assertPublicDetailsMatchSummary(summary, details);
  validateMaxInitialNodes(summary.graph.maxNodes);
  const componentSummary = summary.graph.components.find(
    (component) => component.id === componentId,
  );
  const component = details.graph.components.find((candidate) => candidate.id === componentId);
  assertNonNullable(componentSummary, `summaryにcomponent ${componentId}がありません`);
  assertNonNullable(component, `detailsにcomponent ${componentId}がありません`);
  if (
    componentSummary.nodeCount !== component.nodeIds.length ||
    componentSummary.edgeCount !== component.edgeIds.length
  ) {
    throw new TypeError(`component ${componentId}のsummaryとdetailsが一致しません`);
  }

  return createGraphClusterView(
    summary,
    details,
    {
      kind: "component",
      id: componentId,
      nodeIds: component.nodeIds,
      edgeIds: component.edgeIds,
    },
    expandedCycleIds,
    now,
  );
}

/** 選択repositoryをcycle縮約と設定上限を適用した描画モデルへ変換する。 */
export function createRepositoryGraphView(
  summary: PublicSummaryDto,
  details: PublicDetailsDto,
  repositoryId: string,
  expandedCycleIds: ReadonlySet<string>,
  now: Date,
): GraphClusterView {
  assertPublicDetailsMatchSummary(summary, details);
  validateMaxInitialNodes(summary.graph.maxNodes);
  if (!summary.graph.clusterByRepository) {
    throw new TypeError("repository clusterは設定で無効です");
  }
  const clusterSummary = summary.graph.repositoryClusters.find(
    (cluster) => cluster.repositoryId === repositoryId,
  );
  const cluster = details.graph.repositoryClusters.find(
    (candidate) => candidate.repositoryId === repositoryId,
  );
  assertNonNullable(clusterSummary, `summaryにrepository cluster ${repositoryId}がありません`);
  assertNonNullable(cluster, `detailsにrepository cluster ${repositoryId}がありません`);
  if (
    clusterSummary.nodeCount !== cluster.nodeIds.length ||
    clusterSummary.edgeCount !== cluster.edgeIds.length
  ) {
    throw new TypeError(`repository cluster ${repositoryId}のsummaryとdetailsが一致しません`);
  }
  const graphNodesById = new Map(details.graph.nodes.map((node) => [node.nodeId, node]));
  for (const nodeId of cluster.nodeIds) {
    const node = graphNodesById.get(nodeId);
    assertNonNullable(node, `repository cluster ${repositoryId}のnode ${nodeId}がありません`);
    if (node.kind === "external_reference" || node.repositoryId !== repositoryId) {
      throw new TypeError(
        `repository cluster ${repositoryId}に別repositoryのnode ${nodeId}が含まれています`,
      );
    }
  }
  return createGraphClusterView(
    summary,
    details,
    {
      kind: "repository",
      id: repositoryId,
      nodeIds: cluster.nodeIds,
      edgeIds: cluster.edgeIds,
    },
    expandedCycleIds,
    now,
  );
}

/** node severityを凡例とCSSで使う表示名へ変換する。 */
export function graphNodeSeverityLabel(severity: GraphNodeSeverity): string {
  return severity === "cycle" ? "循環依存" : severityLabel(severity);
}
