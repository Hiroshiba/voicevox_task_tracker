import type { TrackingStartAtState, UtcIsoDateTime } from "../../domain/index.js";
import { resolveConfiguredTrackingStartAt } from "../../application/tracking-run/stages/collection-tracking-request.js";
import type { RuntimeConfiguration, RuntimeState } from "./contracts.js";
import { previousSnapshot } from "./previous-state/snapshot.js";

export function pendingSnapshotTrackingStartAt(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  evaluatedAt: UtcIsoDateTime,
): TrackingStartAtState {
  return resolveConfiguredTrackingStartAt(
    configuration.config,
    previousSnapshot(state)?.trackingStartAt ??
      Object.freeze({
        status: "not_fixed",
      }),
    Object.freeze({
      outcome: "incomplete",
      finishedAt: evaluatedAt,
    }),
  );
}
