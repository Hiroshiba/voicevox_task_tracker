import { projectPreviousSnapshot, readBaseStateIngress } from "../../base-state-ingress.js";
import { projectExcludedPullRequestSnapshot } from "../../excluded-pull-request-snapshot.js";
import type { SequentialRunDependencies } from "../../sequential-run-contracts.js";

import type { StateRuntimeAdapters } from "../adapters.js";

/** 前回stateの読取段階を既存adapterへ接続する。 */
export function createLoadStateStage(
  adapters: StateRuntimeAdapters,
): SequentialRunDependencies["loadState"] {
  return async ({ configuration }) => {
    const stateAdapter = adapters.createStateBranchAdapter();
    const ingress = await readBaseStateIngress(
      stateAdapter,
      configuration.target.state,
      configuration.config.staleness.timezone,
      configuration.baseStateHead,
    );
    const snapshot =
      ingress.snapshot.status === "available"
        ? Object.freeze({
            ...ingress.snapshot,
            snapshot: projectExcludedPullRequestSnapshot(ingress.snapshot.snapshot),
          })
        : ingress.snapshot;
    return Object.freeze({
      ...ingress,
      rawSnapshot: ingress.snapshot,
      snapshot,
      previousState: Object.freeze({
        ...ingress.previousState,
        snapshot: projectPreviousSnapshot(snapshot),
      }),
    });
  };
}
