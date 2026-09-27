import type { GraphReconciledRun } from "../../../application/tracking-run/stages/graph-reconciliation.js";
import type { AiAnalysisDependencyReconciliationContext } from "../../../domain/ai-analysis-dependencies.js";
import type { ReconciledGraphEdge } from "../../../graph/index.js";
import type { PersonalReminderRuntimeGraph } from "../../personal-reminder-runtime.js";

/** 最終graphの確定文脈を未移行の個人催促入力へ投影する。 */
export function projectPersonalReminderGraphContext(
  reconciled: GraphReconciledRun,
): PersonalReminderRuntimeGraph {
  const { graph, context } = reconciled.data;
  return Object.freeze({
    activeRelations: Object.freeze(
      graph.edges.filter(
        (edge): edge is ReconciledGraphEdge & Readonly<{ active: true }> => edge.active,
      ),
    ),
    candidateRelations: context.candidateRelations,
    candidateResolutions: graph.candidateResolutions,
    endpointStates: new Map(context.endpointStates),
    candidateEndpointItemsByNodeId: new Map(context.candidateEndpointItems),
    externalReferences: Object.freeze(
      graph.externalReferences.map((reference) =>
        Object.freeze({
          nodeId: reference.nodeId,
          url: reference.url,
          title: reference.title,
          state: reference.state,
        }),
      ),
    ),
  });
}

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
