import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import { buildDailyPages, deployDailyPages } from "../../run-publication/daily-stage-handlers.js";
import type { ProductionRuntimeAdapters } from "../adapters.js";
import type { ProductionTypes } from "../contracts.js";

type ProductionDailyDependencies = DailyTransactionDependencies<ProductionTypes>;
type PagesRuntimeAdapters = Pick<
  ProductionRuntimeAdapters,
  | "pagesOutputDirectory"
  | "writePublicData"
  | "buildWebOutput"
  | "createStateBranchAdapter"
  | "repositoryPath"
  | "now"
  | "writeJsonArtifact"
>;

/** 初期保存済みrunのPages生成を既存公開処理へ接続する。 */
export function createBuildPagesStage(
  adapters: PagesRuntimeAdapters,
): ProductionDailyDependencies["buildPages"] {
  return (input) => buildDailyPages({ adapters }, input);
}

/** 初回Pages intentをproduction portまたはsandbox記録へ接続する。 */
export function createDeployPagesStage(
  adapters: Pick<
    ProductionRuntimeAdapters,
    | "repositoryPath"
    | "createStateBranchAdapter"
    | "deployProductionPages"
    | "now"
    | "writeJsonArtifact"
  >,
): ProductionDailyDependencies["deployPages"] {
  return (input) => deployDailyPages({ adapters }, input);
}
