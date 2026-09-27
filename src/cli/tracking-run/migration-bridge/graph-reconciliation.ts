import type { GraphReconciledRun } from "../../../application/tracking-run/stages/graph-reconciliation.js";
import type { GraphResult, ReducedAnalysis } from "../../production-runtime/contracts.js";

/** 最終graph段階の正規配列を未移行consumerの索引へ投影する。 */
export function projectLegacyGraphReconciliation(
  reconciled: GraphReconciledRun,
): Readonly<{ reduction: ReducedAnalysis; graph: GraphResult }> {
  const reduction = reconciled.data.reduction;
  const graph = reconciled.data.graph;
  return Object.freeze({
    reduction: Object.freeze({
      ...reduction,
      stalenessByNodeId: new Map(reduction.stalenessByNodeId),
      retainedNotificationRecommendations: new Map(reduction.retainedNotificationRecommendations),
    }),
    graph: Object.freeze({
      ...graph,
      effectiveStateByNodeId: new Map(graph.effectiveStateByNodeId),
      relationCandidateAiDependencies: new Map(graph.relationCandidateAiDependencies),
      openNodeIds: new Set(graph.openNodeIds),
    }),
  });
}
