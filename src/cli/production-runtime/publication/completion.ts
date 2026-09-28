import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import { finalizeDailyRun } from "../../run-publication/finalization-stage.js";
import type { ProductionRuntimeAdapters } from "../adapters.js";
import type { ProductionTypes } from "../contracts.js";

type ProductionDailyDependencies = DailyTransactionDependencies<ProductionTypes>;
type CompletionRuntimeAdapters = Pick<
  ProductionRuntimeAdapters,
  "environment" | "createStateBranchAdapter" | "discordHttpClient" | "diagnosticsRecorder" | "now"
>;

/** 日次runの最終CASを共通stageへ接続する。 */
export function createFinalizeRunStage(
  adapters: CompletionRuntimeAdapters,
): ProductionDailyDependencies["finalizeRun"] {
  return (input) => finalizeDailyRun(adapters, input);
}
