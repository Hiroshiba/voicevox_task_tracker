import { readBaseStateIngress } from "../../../infrastructure/tracking-run/base-state-ingress.js";
import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import type { StateRuntimeAdapters } from "../adapters.js";
import type { ProductionTypes } from "../contracts.js";

/** 前回stateの読取段階を既存adapterへ接続する。 */
export function createLoadStateStage(
  adapters: StateRuntimeAdapters,
): DailyTransactionDependencies<ProductionTypes>["loadState"] {
  return async ({ configuration }) => {
    const stateAdapter = adapters.createStateBranchAdapter();
    return readBaseStateIngress(
      stateAdapter,
      configuration.target.state,
      configuration.config.staleness.timezone,
      configuration.baseStateHead,
    );
  };
}
