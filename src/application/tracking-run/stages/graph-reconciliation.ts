import type { StageState } from "../contracts/run-core.js";
import type { GenericAiAdoptedRun } from "./generic-ai-adoption.js";
import type { GenericAiItemAdoption } from "./generic-ai-adoption-contracts.js";
import type {
  GraphFinalItem,
  GraphReconciliationResult,
  GraphReduction,
} from "./graph-reconciliation-contracts.js";

/** 最終関係、グラフ指標、項目値とAI依存が確定したrun。 */
export type GraphReconciledRun = StageState<
  "graph_reconciled",
  Readonly<{
    approvedRepositories: GenericAiAdoptedRun["data"]["approvedRepositories"];
    allowlistDigest: GenericAiAdoptedRun["data"]["allowlistDigest"];
    collection: GenericAiAdoptedRun["data"]["collection"];
    sourceCatalog: GenericAiAdoptedRun["data"]["sourceCatalog"];
    facts: GenericAiAdoptedRun["data"]["facts"];
    aiItems: readonly GenericAiItemAdoption[];
    reduction: GraphReduction;
    graph: GraphReconciliationResult;
    finalItems: readonly GraphFinalItem[];
  }>
>;
