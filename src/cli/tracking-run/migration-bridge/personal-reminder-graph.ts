import type { GraphReconciledRun } from "../../../application/tracking-run/stages/graph-reconciliation.js";
import type { AiAnalysisDependencyReconciliationContext } from "../../../domain/ai-analysis-dependencies.js";

/** 最終項目と関係の確定AI依存を未移行の照合入力へ投影する。 */
export function projectFinalAiDependencyContext(
  reconciled: GraphReconciledRun,
): AiAnalysisDependencyReconciliationContext {
  const { finalItems, graph, context } = reconciled.data;
  return Object.freeze({
    applicationsByNodeId: new Map(
      finalItems.map((item) => [item.nodeId, item.aiAnalysis.applications]),
    ),
    relationsById: new Map(graph.edges.map((edge) => [edge.id, edge])),
    candidatesById: new Map(
      context.candidateRelations.map((candidate) => [
        candidate.candidateId,
        Object.freeze({
          endpointNodeIds: candidate.endpointNodeIds,
          ownerNodeId: candidate.ownerNodeId,
          aiDependency: candidate.aiDependency,
        }),
      ]),
    ),
  });
}
