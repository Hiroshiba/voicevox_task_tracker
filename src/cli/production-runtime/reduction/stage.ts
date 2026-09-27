import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import {
  projectLegacyAnalyzedCollection,
  projectLegacyDeterministicAnalysis,
} from "../../tracking-run/migration-bridge/deterministic.js";
import type {
  CodexAnalysis,
  CollectedItems,
  DeterministicAnalysis,
  ProductionTypes,
  ReducedAnalysis,
  RepositoryInventory,
  RuntimeConfiguration,
  RuntimeState,
} from "../contracts.js";
import { reconcileCurrentGraph } from "../graph/stage.js";
import { reduceAnalysisPass } from "./item-reduction.js";
import type { GenericAiAdoptedRun } from "../../../application/tracking-run/stages/generic-ai-adoption.js";

function reduceAllAnalyses(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  deterministicAnalysis: DeterministicAnalysis,
  codexAnalysis: CodexAnalysis,
  adopted: GenericAiAdoptedRun,
): ReducedAnalysis {
  const initialReduction = reduceAnalysisPass(
    configuration,
    state,
    inventory,
    collection,
    deterministicAnalysis,
    codexAnalysis,
    adopted,
    undefined,
  );
  const provisionalGraph = reconcileCurrentGraph(
    configuration,
    state,
    collection,
    initialReduction,
  );
  return reduceAnalysisPass(
    configuration,
    state,
    inventory,
    collection,
    deterministicAnalysis,
    codexAnalysis,
    adopted,
    provisionalGraph,
  );
}

/** 解析結果の統合段階を作る。 */
export function createReduceAnalysisStage(): DailyTransactionDependencies<ProductionTypes>["reduceAnalysis"] {
  return ({
    configuration,
    state,
    repositoryInventory,
    deterministicallyAnalyzed,
    codexAnalysis,
    genericAiAdopted,
  }) =>
    Promise.resolve(
      reduceAllAnalyses(
        configuration,
        state,
        repositoryInventory,
        projectLegacyAnalyzedCollection(deterministicallyAnalyzed),
        projectLegacyDeterministicAnalysis(deterministicallyAnalyzed),
        codexAnalysis,
        genericAiAdopted,
      ),
    );
}
