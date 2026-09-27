import type { GenericAiPlannedRun } from "../../../application/tracking-run/stages/generic-ai-plan.js";
import type {
  AnalysisElementPlanning,
  CodexAnalysisInput,
  PreparedAiAnalysisCandidate,
} from "../../../codex/index.js";
import type { GitHubNodeId } from "../../../domain/index.js";

/** 汎用AI計画から未移行の実行器へ同じ候補と入力を投影する。 */
export function projectLegacyGenericAiPlanning(planned: GenericAiPlannedRun): Readonly<{
  candidates: readonly PreparedAiAnalysisCandidate[];
  inputByNodeId: ReadonlyMap<GitHubNodeId, CodexAnalysisInput>;
  elementPlanningByNodeId: ReadonlyMap<GitHubNodeId, AnalysisElementPlanning>;
}> {
  return Object.freeze({
    candidates: Object.freeze(planned.data.plan.items.map((item) => item.candidate)),
    inputByNodeId: new Map(
      planned.data.plan.items.map((item) => [item.nodeId, item.candidate.input]),
    ),
    elementPlanningByNodeId: new Map(
      planned.data.plan.items.map((item) => [item.nodeId, item.planning]),
    ),
  });
}
