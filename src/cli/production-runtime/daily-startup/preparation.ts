import { prepareRun } from "../../../application/tracking-run/prepare-run.js";
import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import type { ProductionTypes } from "../contracts.js";

/** 同じbase revisionの前回stateと検証済み設定からrunを準備する。 */
export function createPrepareRunStage(): DailyTransactionDependencies<ProductionTypes>["prepareRun"] {
  return ({ request, identity, configuration, state }) =>
    prepareRun({
      request,
      identity,
      config: configuration.config,
      configDigest: configuration.configDigest,
      baseState: Object.freeze({
        revision: configuration.baseStateHead,
        snapshot: state.snapshot,
        history: state.history,
        aiCache: state.aiCache,
        personalReminderAiCache: state.personalReminderAiCache,
        notificationLedger: state.notificationLedger,
        previousState: state.previousState,
      }),
    });
}
