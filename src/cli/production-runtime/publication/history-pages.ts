import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import {
  buildDailyNotificationHistoryPages,
  deployDailyNotificationHistoryPages,
} from "../../run-publication/daily-history-pages.js";
import type { ProductionRuntimeAdapters } from "../adapters.js";
import type { ProductionTypes } from "../contracts.js";

type ProductionDailyDependencies = DailyTransactionDependencies<ProductionTypes>;

/** 最終stateから履歴Pagesのbuildを接続する。 */
export function createBuildNotificationHistoryPagesStage(
  adapters: Pick<
    ProductionRuntimeAdapters,
    | "repositoryPath"
    | "pagesOutputDirectory"
    | "createStateBranchAdapter"
    | "writePublicData"
    | "buildWebOutput"
    | "writeJsonArtifact"
    | "now"
  >,
): ProductionDailyDependencies["buildNotificationHistoryPages"] {
  return (input) => buildDailyNotificationHistoryPages(adapters, input);
}

/** 同じ履歴Pages intentの公開直前検査とeffect結果を接続する。 */
export function createDeployNotificationHistoryPagesStage(
  adapters: Pick<
    ProductionRuntimeAdapters,
    | "repositoryPath"
    | "createStateBranchAdapter"
    | "deployProductionPages"
    | "writeJsonArtifact"
    | "now"
  >,
): ProductionDailyDependencies["deployNotificationHistoryPages"] {
  return (input) => deployDailyNotificationHistoryPages(adapters, input);
}
