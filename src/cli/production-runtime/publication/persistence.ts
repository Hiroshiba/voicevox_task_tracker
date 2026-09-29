import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import {
  commitDailyCheckpoint,
  persistDailyState,
  prepareDailyCheckpoint,
} from "../../run-publication/daily-stage-handlers.js";
import { readCommittedInitialState } from "../../run-publication/committed-state.js";
import type { ProductionTypes } from "../contracts.js";
import type { ProductionRuntimeAdapters } from "../adapters.js";

type ProductionDailyDependencies = DailyTransactionDependencies<ProductionTypes>;

/** 直列runのcheckpoint codec往復とbindingを接続する。 */
export function createPrepareCheckpointStage(
  adapters: Pick<
    ProductionRuntimeAdapters,
    "repositoryPath" | "environment" | "createStateBranchAdapter" | "now"
  >,
): ProductionDailyDependencies["prepareCheckpoint"] {
  return (input) => prepareDailyCheckpoint({ adapters }, input);
}

/** 検証済みcheckpointを初回stateへcommitする。 */
export function createCommitPreparedCheckpointStage(
  adapters: Pick<ProductionRuntimeAdapters, "createStateBranchAdapter" | "now">,
): ProductionDailyDependencies["commitPreparedCheckpoint"] {
  return (input, checkpoint) => commitDailyCheckpoint({ adapters }, input, checkpoint);
}

/** 初回commit後のexact stateを再読込する。 */
export function createReadCommittedStateStage(
  adapters: Pick<ProductionRuntimeAdapters, "createStateBranchAdapter" | "now">,
): ProductionDailyDependencies["readCommittedState"] {
  return ({ configuration, reference }) =>
    readCommittedInitialState({
      adapter: adapters.createStateBranchAdapter(),
      configuration: configuration.target.state,
      knownSecrets: configuration.credentials.knownSecrets,
      reference,
      now: adapters.now,
    });
}

/** 完全性検証済みrunの初期保存を既存公開処理へ接続する。 */
export function createPersistStateStage(
  adapters: Pick<
    ProductionRuntimeAdapters,
    "repositoryPath" | "environment" | "createStateBranchAdapter" | "now"
  >,
): ProductionDailyDependencies["persistState"] {
  return (input) => persistDailyState({ adapters }, input);
}
